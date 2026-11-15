"""Find the home's own furniture by subtracting the empty house from the furnished one.

Matterport scans the house twice over: the MatterPak carries a textured mesh of the real space, and
the defurnished view carries a mesh of the same space emptied. A triangle that is in the first and
not near the second is furniture. That gives real 3D geometry — which, unlike the pano cut-outs in
`realfurniture.js`, you can walk around and rotate (#104).

    python3 tools/meshdiff.py check zvKHR9DHNjJ      # do the two meshes agree on a frame?
    python3 tools/meshdiff.py run   zvKHR9DHNjJ      # write data/<id>/furniture.json + pieces
"""
import json
import os
import sys
import time

import numpy as np

import meshclose
import meshquality


def load_obj(path, want_uv=False):
    """Vertices and triangles of an OBJ, with UVs and the material each face uses if asked.

    Fast enough on a 26 MB file without a parser library. `want_uv` also returns, per face, the index
    of the `usemtl` group it belongs to — the MatterPak splits its texture across 89 of them, so that
    is how a face finds its JPEG.
    """
    verts, faces, uvs, fuv, fmat, mats = [], [], [], [], [], []
    cur = -1
    with open(path, 'r', errors='replace') as f:
        for line in f:
            if line.startswith('v '):
                p = line.split()
                verts.append((float(p[1]), float(p[2]), float(p[3])))
            elif want_uv and line.startswith('vt '):
                p = line.split()
                uvs.append((float(p[1]), float(p[2])))
            elif want_uv and line.startswith('usemtl '):
                name = line.split(None, 1)[1].strip()
                if name not in mats:
                    mats.append(name)
                cur = mats.index(name)
            elif line.startswith('f '):
                p = line.split()[1:]
                idx, tex = [], []
                for tok in p:
                    bits = tok.split('/')
                    i = int(bits[0])
                    idx.append(i - 1 if i > 0 else len(verts) + i)
                    if want_uv and len(bits) > 1 and bits[1]:
                        t = int(bits[1])
                        tex.append(t - 1 if t > 0 else len(uvs) + t)
                for k in range(1, len(idx) - 1):
                    faces.append((idx[0], idx[k], idx[k + 1]))
                    if want_uv:
                        fuv.append((tex[0], tex[k], tex[k + 1]) if len(tex) == len(idx) else (0, 0, 0))
                        fmat.append(cur)
    out = [np.asarray(verts, np.float32), np.asarray(faces, np.int32)]
    if want_uv:
        out += [np.asarray(uvs, np.float32), np.asarray(fuv, np.int32),
                np.asarray(fmat, np.int32), mats]
    return out


def paths(model):
    pak = os.path.join('data', model, 'pak')
    objs = [f for f in os.listdir(pak) if f.endswith('.obj')] if os.path.isdir(pak) else []
    if not objs:
        sys.exit(f'no MatterPak OBJ in {pak} — run tools/matterpak.py fetch {model}')
    full = os.path.join(pak, max(objs, key=lambda f: os.path.getsize(os.path.join(pak, f))))
    empty = os.path.join('data', model, 'mesh', 'defurnished_50k.obj')
    if not os.path.exists(empty):
        sys.exit(f'no defurnished mesh at {empty}')
    return full, empty


def describe(name, V, F):
    lo, hi = V.min(axis=0), V.max(axis=0)
    print(f'  {name}: {len(V):,} verts  {len(F):,} tris  '
          f'extent {hi[0]-lo[0]:.1f} x {hi[1]-lo[1]:.1f} x {hi[2]-lo[2]:.1f} m')
    print(f'      min ({lo[0]:7.2f},{lo[1]:7.2f},{lo[2]:7.2f})  max ({hi[0]:7.2f},{hi[1]:7.2f},{hi[2]:7.2f})')
    return lo, hi


def check(model):
    full, empty = paths(model)
    t = time.time()
    Vf, Ff = load_obj(full)
    Ve, Fe = load_obj(empty)
    print(f'loaded in {time.time()-t:.1f}s')
    describe('furnished  ', Vf, Ff)
    describe('defurnished', Ve, Fe)
    house = json.load(open(os.path.join('data', model, 'house.json')))
    pts = np.array([p['pos'] for p in house['panos']], float)
    for name, V in (('furnished', Vf), ('defurnished', Ve)):
        lo, hi = V.min(axis=0) - 0.3, V.max(axis=0) + 0.3
        inside = np.all((pts >= lo) & (pts <= hi), axis=1).sum()
        print(f'  scan points inside the {name} box: {inside}/{len(pts)}')


def sample_mesh(V, F, step=0.04):
    """Points scattered over a mesh's triangles, dense enough that nearest-point distance is meaningful.

    The defurnished mesh is only 7.5k triangles for a whole house — walls are a handful of big flat
    polygons — so its *vertices* are far too sparse to measure against. Scatter points across each
    face instead, roughly every `step` metres.
    """
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    out = [a, b, c, (a + b + c) / 3.0]
    ab, ac = b - a, c - a
    area = 0.5 * np.linalg.norm(np.cross(ab, ac), axis=1)
    n = np.clip((area / (step * step)).astype(int), 0, 400)
    for k in np.unique(n[n > 0]):
        sel = n == k
        A, AB, AC = a[sel], ab[sel], ac[sel]
        u = np.random.rand(len(A), k, 1).astype(np.float32)
        v = np.random.rand(len(A), k, 1).astype(np.float32)
        flip = (u + v) > 1
        u = np.where(flip, 1 - u, u)
        v = np.where(flip, 1 - v, v)
        out.append((A[:, None, :] + AB[:, None, :] * u + AC[:, None, :] * v).reshape(-1, 3))
    return np.concatenate(out).astype(np.float32)


def components(F, keep):
    """Group kept triangles into connected pieces, joined where they share a vertex."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    idx = np.where(keep)[0]
    tri = F[idx]
    nv = int(tri.max()) + 1
    rows = np.repeat(np.arange(len(tri)), 3)
    cols = tri.reshape(-1)
    M = coo_matrix((np.ones(len(rows), np.int8), (rows, cols)), shape=(len(tri), nv)).tocsr()
    n, lab = connected_components(M @ M.T, directed=False)
    return idx, lab, n


def bake_colours(V, F, T, Ftf, Fmat, mats, pak, verts_wanted):
    """A colour per vertex, read out of the MatterPak's textures.

    Shipping the textures themselves would be ~50 MB for 45 JPEGs, which is far too much to load in a
    browser for a handful of sofas. The mesh is dense — a sofa is thousands of triangles — so a colour
    per vertex carries the look at a fraction of the size.
    """
    from PIL import Image
    want = set(int(v) for v in verts_wanted)
    acc = {}
    cache = {}
    for fi in range(len(F)):
        tri = F[fi]
        if not (tri[0] in want or tri[1] in want or tri[2] in want):
            continue
        mi = int(Fmat[fi])
        if mi < 0 or mi >= len(mats):
            continue
        name = mats[mi]
        if name not in cache:
            p = os.path.join(pak, os.path.basename(name))
            try:
                im = Image.open(p).convert('RGB')
                cache[name] = (np.asarray(im), im.width, im.height)
            except Exception:
                cache[name] = None
        tex = cache[name]
        if tex is None:
            continue
        arr, w, h = tex
        for k in range(3):
            vi = int(tri[k])
            if vi not in want:
                continue
            u, v = T[Ftf[fi][k]]
            x = int(np.clip(u, 0, 1) * (w - 1))
            y = int((1 - np.clip(v, 0, 1)) * (h - 1))
            c = arr[y, x]
            prev = acc.get(vi)
            acc[vi] = c if prev is None else ((prev.astype(int) + c) // 2).astype(np.uint8)
    return acc


# How much texture a piece deserves, in pixels per metre of its longest side. 512 means a 2 m sofa gets
# a 1024 px sheet and a 10 cm ornament gets 64 — the first version sized the sheet from the source texels
# instead, and gave that ornament 1413 x 1546 and 357 KB, which is most of where 8.2 MB of atlases went.
PX_PER_M = 512
SLIVER = 8          # longest edge over thickness: above this a triangle is a bridge, not a surface
ATLAS_MIN, ATLAS_MAX = 64, 1024


def _uv_islands(fis, Ftf):
    """Faces that share a UV vertex belong to the same island.

    Matterport's UV layout is fragmented - a piece's triangles are scattered across the whole sheet,
    so the bounding box of its UVs is the entire texture and cropping it crops nothing. Islands are
    the unit that is actually compact: on this house a piece has 281-1652 of them, median 24 px.
    """
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    rows, cols = [], []
    vt2f = {}
    for k, f in enumerate(fis):
        for c in Ftf[f]:
            vt2f.setdefault(int(c), []).append(k)
    for lst in vt2f.values():
        first = lst[0]
        for a in lst[1:]:
            rows.append(first)
            cols.append(a)
    if not rows:
        return np.arange(len(fis), dtype=np.int64), len(fis)   # no shared UV vertex: each face alone
    m = coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(len(fis), len(fis)))
    ncomp, lab = connected_components(m, directed=False)
    return lab, ncomp


def build_atlas(piece_tris, Ff, Tf, Ftf, Fmat, mats, pak, cache, max_side=ATLAS_MAX, pad=2):
    """One small texture per piece, holding only the parts of the MatterPak's textures it really uses.

    Baking a colour per vertex was the first attempt and it is only as sharp as the mesh is dense -
    33 to 399 vertices per square metre across this house - so the texels existed but the mesh had
    nowhere to put them.

    The second attempt cropped the UV *bounding box* per material, which was worse than it looked:
    Matterport scatters a piece's triangles over the whole sheet, so that box was the entire 2048x2048
    texture, four of them got rescaled by 0.13 to fit one sheet, and the furniture was drawn at 44-82
    px per metre when the data holds about 316. This packs per UV island instead, which is the unit
    that is genuinely small, and gets the full resolution the MatterPak has.
    """
    from PIL import Image
    groups = {}
    for fi in piece_tris:
        mi = int(Fmat[fi])
        if 0 <= mi < len(mats):
            groups.setdefault(mi, []).append(fi)

    crops = []
    for mi, fis in groups.items():
        name = os.path.basename(mats[mi])
        if name not in cache:
            path = os.path.join(pak, name)
            cache[name] = Image.open(path).convert('RGB') if os.path.exists(path) else None
        im = cache[name]
        if im is None:
            continue
        W, H = im.width, im.height
        fis = np.asarray(fis)
        lab, ncomp = _uv_islands(fis, Ftf)
        for c in range(ncomp):
            sel = fis[lab == c]
            if not len(sel):
                continue
            uv = Tf[np.asarray([Ftf[f] for f in sel], np.int32).reshape(-1)]
            u0, v0 = np.clip(uv.min(axis=0), 0, 1)
            u1, v1 = np.clip(uv.max(axis=0), 0, 1)
            # v is bottom-up in OBJ and top-down in an image
            x0 = max(0, int(u0 * W) - pad); x1 = min(W, int(np.ceil(u1 * W)) + pad)
            y0 = max(0, int((1 - v1) * H) - pad); y1 = min(H, int(np.ceil((1 - v0) * H)) + pad)
            if x1 - x0 < 2 or y1 - y0 < 2:
                continue
            crops.append(dict(mi=mi, fis=list(sel), box=(x0, y0, x1, y1),
                              w=x1 - x0, h=y1 - y0, img=im.crop((x0, y0, x1, y1)),
                              uv0=(x0 / W, 1 - y1 / H), uv1=(x1 / W, 1 - y0 / H)))
    if not crops:
        return None

    # shelf pack, tallest first, into a square-ish sheet
    crops.sort(key=lambda c: -c['h'])
    total = sum(c['w'] * c['h'] for c in crops)
    sheet_w = max(max(c['w'] for c in crops), int(np.sqrt(total) * 1.15))
    x = y = shelf = 0
    for c in crops:
        if x + c['w'] > sheet_w and x > 0:
            x = 0; y += shelf; shelf = 0
        c['x'], c['y'] = x, y
        x += c['w']; shelf = max(shelf, c['h'])
    sheet_h = y + shelf
    scale = 1.0
    if max(sheet_w, sheet_h) > max_side:                  # one piece should never need a huge sheet
        scale = max_side / max(sheet_w, sheet_h)
    atlas_img = Image.new('RGB', (max(1, int(sheet_w * scale)), max(1, int(sheet_h * scale))), (150, 145, 140))
    for c in crops:
        im = c['img']
        if scale != 1.0:
            im = im.resize((max(1, int(c['w'] * scale)), max(1, int(c['h'] * scale))))
        atlas_img.paste(im, (int(c['x'] * scale), int(c['y'] * scale)))
    return dict(image=atlas_img, crops=crops, sheet=(sheet_w, sheet_h), scale=scale)


def atlas_uv(uv, crops_by_face, fi, sheet):
    """A source UV, moved into the piece's atlas."""
    c = crops_by_face[fi]
    sw, sh = sheet
    u = (uv[0] - c['uv0'][0]) / max(1e-9, c['uv1'][0] - c['uv0'][0])
    v = (uv[1] - c['uv0'][1]) / max(1e-9, c['uv1'][1] - c['uv0'][1])
    u = np.clip(u, 0, 1); v = np.clip(v, 0, 1)
    px = c['x'] + u * c['w']
    py = c['y'] + (1 - v) * c['h']
    return (px / sw, 1 - py / sh)



# Per-house flap settings. Four different rules failed to tell a flap from a real part across both
# houses - edge length gutted the piano, sliver aspect holed the sofa, grazing angle does not separate
# at all (even the worst 1% of triangles had a camera 74 degrees off normal), and compactness has the
# small patches reading *more* compact than the big ones, 0.50 against 0.44. The patch-area rule works
# and does not travel. So it is tuned per house by eye, and a house nobody has checked gets nothing.
TUNED = {
    'zvKHR9DHNjJ': dict(flap_frac=0.003),   # La Mirada, the demo house: swept room by room,
                                            # sofa and piano both verified by eye. Clear win.   # La Mirada, the demo house: swept room by room, sofa and
                                            # piano both verified. Clear win.
}

FLAP_FOLD = 40      # degrees: above this the surface is not continuing, it is folding over


def drop_flaps(Vf, Ff, idx, lab, n, fold_deg, frac, floor_m2=0.0010):
    """Remove the torn flaps photogrammetry leaves hanging off a piece.

    Strip the texture off the living room sofa and its geometry is visibly ragged - shards and thin
    flaps standing proud of the arms and the front edge. Textured, they catch the light as pale
    streaks lying across the upholstery, which was the most visible defect left on any piece.

    They defeat per-triangle tests, because a flap is a *cluster*, not one bad triangle: cutting on
    edge length gutted the piano's front, and cutting on sliver aspect punched holes in that sofa.
    So segment each piece instead - join neighbouring triangles only where the surface stays smooth
    - and drop whole patches too small to be real.

    The threshold has to be a fraction of the piece, not an absolute area. At a flat 200 cm2 this
    took 34% of La Mirada's triangles and improved it, but 43% of Gale Street's, whose mesh is
    sparser, and left its sofa and armchairs full of holes. A share of the piece's own surface
    adapts; the floor just stops it running away on a tiny piece.

    OFF BY DEFAULT, and that is a deliberate call rather than laziness. At 0.3% it is a clear,
    visible win on La Mirada - the sofa's torn front edge and arm flaps go and the piano keeps its
    front - and it is still a regression on Gale Street's sofa at the same setting. Three different
    geometry filters have now helped one house and hurt another, so this one does not get to run
    unasked. Pass flap_frac to turn it on for a house somebody has actually looked at.
    """
    from collections import defaultdict
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    out = np.zeros(len(Ff), bool)
    dropped = 0
    kept = 0
    for i in range(n):
        tri = idx[lab == i]
        F = Ff[tri]
        T = Vf[F]
        nrm = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0])
        ln = np.linalg.norm(nrm, axis=1)
        ok = ln > 1e-12
        nrm = nrm / np.maximum(ln, 1e-12)[:, None]
        area = ln / 2
        total = float(area.sum())

        emap = defaultdict(list)
        for k, f in enumerate(F):
            for a in range(3):
                e = (min(f[a], f[(a + 1) % 3]), max(f[a], f[(a + 1) % 3]))
                emap[e].append(k)
        cth = np.cos(np.radians(fold_deg))
        rows, cols = [], []
        for fs in emap.values():
            if len(fs) == 2 and ok[fs[0]] and ok[fs[1]] and float(np.dot(nrm[fs[0]], nrm[fs[1]])) >= cth:
                rows.append(fs[0])
                cols.append(fs[1])
        if rows:
            m = coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(len(F), len(F)))
            ncomp, cl = connected_components(m, directed=False)
            sizes = np.zeros(ncomp)
            np.add.at(sizes, cl, area)
            limit = max(frac * total, floor_m2)
            bad = np.isin(cl, np.where(sizes < limit)[0])
        else:
            bad = np.zeros(len(F), bool)
        out[tri[~bad]] = True
        dropped += int(bad.sum())
        kept += len(tri)
    print(f'dropped {dropped:,} triangles in flaps under {frac*100:.1f}% of their own piece '
          f'({100*dropped/max(kept,1):.1f}% of kept)')
    return out


def run(model, cut=0.20, min_tris=80, min_size=0.18, export=False, max_edge=0.12, flap_frac=None):
    if flap_frac is None:
        flap_frac = TUNED.get(model, {}).get('flap_frac', 0.0)
        if flap_frac:
            print(f'{model} is tuned: dropping flaps under {flap_frac*100:.1f}% of a piece')
    full, empty = paths(model)
    t0 = time.time()
    Vf, Ff, Tf, Ftf, Fmat, mats = load_obj(full, want_uv=True)
    Ve, Fe = load_obj(empty)
    print(f'loaded {len(Ff):,} furnished tris, {len(Fe):,} empty tris in {time.time()-t0:.1f}s')

    from scipy.spatial import cKDTree
    t0 = time.time()
    pts = sample_mesh(Ve, Fe)
    tree = cKDTree(pts)
    print(f'sampled the empty house into {len(pts):,} points in {time.time()-t0:.1f}s')

    cen = Vf[Ff].mean(axis=1)
    t0 = time.time()
    d, _ = tree.query(cen, workers=-1)
    print(f'measured {len(cen):,} triangles in {time.time()-t0:.1f}s')
    keep = d > cut
    print(f'{keep.sum():,} triangles are more than {cut*100:.0f} cm off the empty house '
          f'({100*keep.mean():.1f}%)')

    # Photogrammetry bridges gaps it could not see into, and those bridges come out as single long
    # triangles that stick off a piece as spikes - the piano's silhouette was torn by them. On this
    # house the median kept triangle has a 6.5 cm longest edge and the 99th percentile is 35 cm, so
    # the tail is a different population, not the top of a smooth distribution.
    # Photogrammetry bridges gaps it could not see into, and those bridges come out as long thin
    # triangles that stick off a piece as spikes - they tore the piano's silhouette. Cutting on edge
    # length alone is wrong: a flat panel is legitimately a few big triangles, and a 20 cm limit
    # punched the whole front out of that same piano. A spike is long *and* thin, so measure the
    # triangle's thickness (twice its area over its longest edge) and drop only the slivers.
    if max_edge:
        T = Vf[Ff]
        elong = np.stack([np.linalg.norm(T[:, 1] - T[:, 0], axis=1),
                          np.linalg.norm(T[:, 2] - T[:, 1], axis=1),
                          np.linalg.norm(T[:, 0] - T[:, 2], axis=1)], axis=1).max(axis=1)
        area = np.linalg.norm(np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]), axis=1) / 2
        thick = 2 * area / np.maximum(elong, 1e-9)
        before = int(keep.sum())
        keep &= ~((elong > max_edge) & (elong / np.maximum(thick, 1e-9) > SLIVER))
        print(f'dropped {before - int(keep.sum()):,} spikes longer than {max_edge*100:.0f} cm and '
              f'{SLIVER}x thinner than they are long '
              f'({100*(before-int(keep.sum()))/max(before,1):.1f}%)')

    # The spikes that survive are the ones under 12 cm. Cutting them everywhere holed the sofa's seat
    # (an interior sliver is still surface); a spike that hangs off the piece's open edge is not. So a
    # second pass takes the thin triangles (6 cm, 6x) that own a boundary edge of what is kept, and
    # repeats, since removing one exposes the next in the chain. Three rounds took the sectional's
    # base spikes and nothing from its seat.
    if max_edge:
        for _ in range(3):
            kept = np.flatnonzero(keep)
            E = np.sort(Ff[kept][:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1)
            _, inv, cnt = np.unique(E, axis=0, return_inverse=True, return_counts=True)
            open_edge = (cnt[inv] == 1).reshape(-1, 3).any(axis=1)
            thin = (elong[kept] > 0.06) & (elong[kept] / np.maximum(thick[kept], 1e-9) > 6)
            drop = kept[open_edge & thin]
            if not len(drop):
                break
            keep[drop] = False
        print(f'then dropped the thin triangles on open edges: {len(Ff) - int((~keep).sum()) - 0:,} kept')

    idx, lab, n = components(Ff, keep)
    if flap_frac:
        keep = drop_flaps(Vf, Ff, idx, lab, n, FLAP_FOLD, flap_frac)
        idx, lab, n = components(Ff, keep)
    print(f'{n} connected components')

    house = json.load(open(os.path.join('data', model, 'house.json')))
    floor_z = float(np.median([p['floorZ'] for p in house['panos'] if p.get('floorZ') is not None]))
    # Each floor's own height, so a piece can say which storey it is on. Without this the viewer stands
    # every piece on the floor of whichever pano you happen to be at, and in a two-storey house the
    # upstairs furniture lands downstairs. Amit's catch on #108; La Mirada is one storey so it never bit.
    floors = []
    for f in house.get('floors') or []:
        zs = [q['floorZ'] for q in house['panos']
              if q.get('floor') == f.get('id') and q.get('floorZ') is not None]
        if zs:
            floors.append((f['id'], float(np.median(zs))))

    pieces = []
    for i in range(n):
        tri = idx[lab == i]
        if len(tri) < min_tris:
            continue
        v = np.unique(Ff[tri])
        P = Vf[v]
        lo, hi = P.min(axis=0), P.max(axis=0)
        size = hi - lo
        if max(size[0], size[1]) < min_size or size[2] < 0.12:
            continue
        if lo[2] > floor_z + 1.6:
            continue                       # hanging high up: a light or a picture, not furniture
        # Furniture stands on a floor, inside the house. Something that belongs to no room *and* floats
        # well clear of the floor is reconstruction noise — on La Mirada those were two lumps at y=5.07
        # and y=-6.04, outside the floor plan's -5.8..4.9 and hanging 0.8-0.9 m up: foliage and fence
        # seen through the windows. A roomless piece that sits ON the floor is kept, because the room
        # polygons don't cover thresholds and hallway corners.
        cx, cy = float((lo[0] + hi[0]) / 2), float((lo[1] + hi[1]) / 2)
        if _room_of(cx, cy, house) is None and lo[2] - floor_z > 0.5:
            continue
        pieces.append(dict(tris=tri, lo=lo, hi=hi, n=len(tri)))

    pieces.sort(key=lambda p: -p['n'])
    print(f'{len(pieces)} pieces after filtering\n')
    print(f'{"tris":>7} {"w x d x h (m)":>22}  {"stands at":>18}  off floor')
    for p in pieces[:14]:
        s = p['hi'] - p['lo']
        c = (p['hi'] + p['lo']) / 2
        print(f'{p["n"]:>7} {s[0]:7.2f} x{s[1]:6.2f} x{s[2]:6.2f}  '
              f'({c[0]:7.2f},{c[1]:7.2f})  {p["lo"][2]-floor_z:6.2f}')

    if not export:
        return pieces
    return write(model, pieces, Vf, Ff, Tf, Ftf, Fmat, mats, floor_z, house, cut, floors)


def _room_of(x, y, house):
    for r in house.get('rooms', []):
        poly = r.get('poly')
        if not poly:
            continue
        c = False
        for i in range(len(poly)):
            xi, yi = poly[i]
            xj, yj = poly[i - 1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                c = not c
        if c:
            return r.get('label')
    return None


def write(model, pieces, Vf, Ff, Tf, Ftf, Fmat, mats, floor_z, house, cut, floors=(), close_holes=True):
    """One binary of geometry plus a JSON index and a small texture per piece."""
    pak = os.path.join('data', model, 'pak')
    out_dir = os.path.join('data', model)
    tex_dir = os.path.join(out_dir, 'furniture-tex')
    os.makedirs(tex_dir, exist_ok=True)
    for f in os.listdir(tex_dir):
        os.remove(os.path.join(tex_dir, f))

    blobs, index = [], []
    offset = 0
    cache = {}
    t0 = time.time()
    tex_bytes = 0
    for i, p in enumerate(pieces):
        tri_ids = p['tris']
        tri = Ff[tri_ids]
        longest = float(max(p['hi'][0] - p['lo'][0], p['hi'][1] - p['lo'][1], p['hi'][2] - p['lo'][2]))
        side = int(np.clip(round(longest * PX_PER_M), ATLAS_MIN, ATLAS_MAX))
        built = build_atlas(tri_ids, Ff, Tf, Ftf, Fmat, mats, pak, cache, max_side=side)
        lo, hi = p['lo'], p['hi']
        centre = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]], np.float32)

        # A vertex can sit on two textures at once, so the atlas forces one vertex per (vertex, face-group).
        # Splitting them is cheaper than it sounds: the mesh is already dense and this only duplicates the
        # seams. Without it a seam vertex would read from whichever crop happened to win.
        crops_by_face = {}
        if built:
            for c in built['crops']:
                for fi in c['fis']:
                    crops_by_face[fi] = c
        pos_list, uv_list, idx_list = [], [], []
        seen = {}
        for k, fi in enumerate(tri_ids):
            c = crops_by_face.get(fi)
            face = []
            for corner in range(3):
                vi = int(tri[k][corner])
                key = (vi, id(c))
                if key not in seen:
                    seen[key] = len(pos_list)
                    pos_list.append(Vf[vi] - centre)
                    if c is not None and built:
                        face_uv = Tf[Ftf[fi][corner]]
                        uv_list.append(atlas_uv(face_uv, crops_by_face, fi, built['sheet']))
                    else:
                        uv_list.append((0.5, 0.5))
                face.append(seen[key])
            idx_list.append(face)

        pos = np.asarray(pos_list, np.float32)
        uv = np.asarray(uv_list, np.float32)
        idx = np.asarray(idx_list, np.uint32)

        # The scanner only saw the sides it could see, so a piece against a wall has no back and
        # turning it shows the inside of its front. Cap the holes on their own planes and give the new
        # faces a UV that lands on a typical pixel of this piece's atlas, so a capped sofa reads as
        # that sofa's fabric. Caps are new vertices: nothing already built here is disturbed.
        # Make the whole piece wind the same way, so the viewer can draw it front-faces-only. That is
        # worth 4.09 ms of GPU fill at the worst scan point in this house against 0.14 ms - at close
        # range furniture covers most of the screen and DoubleSide shades every pixel of it twice.
        idx = meshclose.orient(pos.astype(np.float64), idx)

        # Measure the piece as scanned, before any caps go on: a flat lid meeting a crumpled rim
        # reads as a huge fold angle and would hide the thing we actually want to know.
        captured, fold, _, _ = meshquality.measure(pos.astype(np.float64), idx)
        if close_holes:
            # Cap everything, not just the undersides. A cap used to be a flat colour and read as a
            # pasted-on slab, which is why it was limited to holes facing the floor. tools/capskin.py
            # now gives the caps the piece's own material, so closing the back is worth doing: a
            # piece can be turned round and show a back instead of the inside of its own front.
            cap_pos, cap_idx, open_before, open_after = meshclose.close(pos, idx, facing=1.0)
        else:
            cap_pos, cap_idx, open_before, open_after = None, (), 0, 0
        if close_holes and len(cap_idx):
            flat = meshclose.representative_uv(built['image'] if built else None)
            idx = np.vstack([idx, cap_idx + len(pos)]).astype(np.uint32)
            pos = np.vstack([pos, cap_pos]).astype(np.float32)
            uv = np.vstack([uv, np.tile(flat, (len(cap_pos), 1))]).astype(np.float32)
        else:
            open_after = open_before

        tex_name = None
        if built:
            tex_name = f'p{i}.jpg'
            path = os.path.join(tex_dir, tex_name)
            built['image'].save(path, quality=85, optimize=True)
            tex_bytes += os.path.getsize(path)

        def pad4(b):
            return b + b'\x00' * ((4 - len(b) % 4) % 4)
        parts = [pad4(pos.tobytes()), pad4(uv.tobytes()), pad4(idx.tobytes())]
        rec = dict(
            i=i, verts=int(len(pos)), tris=int(len(idx)),
            at=[round(float(centre[0]), 3), round(float(centre[1]), 3), round(float(centre[2]), 3)],
            size=[round(float(hi[0] - lo[0]), 3), round(float(hi[1] - lo[1]), 3), round(float(hi[2] - lo[2]), 3)],
            floorGap=round(float(lo[2] - floor_z), 3),
            room=_room_of(float((lo[0] + hi[0]) / 2), float((lo[1] + hi[1]) / 2), house),
            floor=(min(floors, key=lambda f: abs(f[1] - float(lo[2])))[0] if floors else None),
            tex=tex_name,
            capped=int(len(cap_idx)) if close_holes else 0,
            capVerts=int(len(cap_pos)) if (close_holes and cap_pos is not None) else 0,
            openEdge=round(float(open_after) / max(int(len(idx)) * 1.5, 1), 4),
            fold=(None if fold != fold else round(float(fold), 1)),
            captured=(None if captured != captured else round(float(captured), 3)),
            closed=bool(close_holes and open_after == 0),
            pos=[offset, len(parts[0])],
            uv=[offset + len(parts[0]), len(parts[1])],
            idx=[offset + len(parts[0]) + len(parts[1]), len(parts[2])],
        )
        offset += sum(len(b) for b in parts)
        blobs += parts
        index.append(rec)

    # fold is not comparable between houses: La Mirada's median is 30 degrees and Gale Street's is
    # 35, so a fixed cut drops a third of one house and three fifths of the other. Rank each piece
    # inside its own house instead, and a caller can ask for "the worst quarter" and mean it anywhere.
    folds = sorted(r['fold'] for r in index if r['fold'] is not None)
    for r in index:
        r['foldRank'] = (None if r['fold'] is None or not folds
                         else round(sum(1 for f in folds if f < r['fold']) / len(folds), 3))

    bin_path = os.path.join(out_dir, 'furniture.bin')
    with open(bin_path, 'wb') as f:
        for b in blobs:
            f.write(b)
    meta = dict(model=model, built=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                cut=cut, floorZ=round(float(floor_z), 3), textured=True, oriented=True, pieces=index)
    with open(os.path.join(out_dir, 'furniture.json'), 'w') as f:
        json.dump(meta, f)
    mb = os.path.getsize(bin_path) / 1e6
    print(f'built {len(index)} atlases in {time.time()-t0:.1f}s')
    print(f'wrote {bin_path} ({mb:.1f} MB) + {tex_bytes/1e6:.1f} MB of textures, {len(index)} pieces')
    print(f'  {sum(1 for r in index if r["room"])}/{len(index)} inside a room on the floor plan')
    print(f'  {sum(1 for r in index if r["tex"])}/{len(index)} have a texture')
    if close_holes:
        caps = sum(r['capped'] for r in index)
        tris = sum(r['tris'] for r in index)
        print(f'  closed {sum(1 for r in index if r["closed"])}/{len(index)} pieces, '
              f'+{caps} cap triangles ({100*caps/max(tris-caps,1):.0f}% more)')
    return pieces


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'check'
    model = sys.argv[2] if len(sys.argv) > 2 else 'zvKHR9DHNjJ'
    if cmd == 'check':
        check(model)
    elif cmd == 'run':
        run(model)
    elif cmd == 'export':
        run(model, export=True)
    else:
        sys.exit(f'unknown command {cmd}')
