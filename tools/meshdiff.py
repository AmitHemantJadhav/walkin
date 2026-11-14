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
ATLAS_MIN, ATLAS_MAX = 64, 1024


def build_atlas(piece_tris, Ff, Tf, Ftf, Fmat, mats, pak, cache, max_side=ATLAS_MAX, pad=2):
    """One small texture per piece, holding only the parts of the MatterPak's textures it actually uses.

    Baking a colour per vertex was the first attempt and it is only as sharp as the mesh is dense — which
    varies from 33 to 399 vertices per square metre across this house, so a sofa the scanner saw well looks
    right and one in a bedroom corner turns to mush. The texels exist; the mesh just has nowhere to put them.

    So instead: for each texture a piece touches, take the bounding box of the UVs that use it, crop that
    region at source resolution, and shelf-pack the crops into one image. UVs are rewritten into atlas
    space, so the piece still draws in a single call. A sofa typically touches 3 textures and uses a small
    part of each, so its atlas is a few hundred pixels across rather than 3 × 2048².
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
        uv = Tf[np.asarray([Ftf[f] for f in fis], np.int32).reshape(-1)]
        u0, v0 = np.clip(uv.min(axis=0), 0, 1)
        u1, v1 = np.clip(uv.max(axis=0), 0, 1)
        W, H = im.width, im.height
        # v is bottom-up in OBJ and top-down in an image
        x0 = max(0, int(u0 * W) - pad); x1 = min(W, int(np.ceil(u1 * W)) + pad)
        y0 = max(0, int((1 - v1) * H) - pad); y1 = min(H, int(np.ceil((1 - v0) * H)) + pad)
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        crops.append(dict(mi=mi, fis=fis, box=(x0, y0, x1, y1),
                          w=x1 - x0, h=y1 - y0, img=im.crop((x0, y0, x1, y1)),
                          uv0=(x0 / W, 1 - y1 / H), uv1=(x1 / W, 1 - y0 / H)))
    if not crops:
        return None

    # shelf pack, tallest first, into a square-ish sheet
    crops.sort(key=lambda c: -c['h'])
    total = sum(c['w'] * c['h'] for c in crops)
    sheet_w = max(c['w'] for c in crops)
    sheet_w = min(max(sheet_w, int(np.sqrt(total) * 1.15)), max_side)
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


def run(model, cut=0.20, min_tris=80, min_size=0.18, export=False):
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
        if close_holes:
            cap_pos, cap_idx, open_before, open_after = meshclose.close(pos, idx)
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
            closed=bool(close_holes and open_after == 0),
            pos=[offset, len(parts[0])],
            uv=[offset + len(parts[0]), len(parts[1])],
            idx=[offset + len(parts[0]) + len(parts[1]), len(parts[2])],
        )
        offset += sum(len(b) for b in parts)
        blobs += parts
        index.append(rec)

    bin_path = os.path.join(out_dir, 'furniture.bin')
    with open(bin_path, 'wb') as f:
        for b in blobs:
            f.write(b)
    meta = dict(model=model, built=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                cut=cut, floorZ=round(float(floor_z), 3), textured=True, pieces=index)
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
