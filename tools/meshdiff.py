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
    return write(model, pieces, Vf, Ff, Tf, Ftf, Fmat, mats, floor_z, house, cut)


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


def write(model, pieces, Vf, Ff, Tf, Ftf, Fmat, mats, floor_z, house, cut):
    """One binary of geometry plus a JSON index, so the browser does no work beyond a fetch."""
    pak = os.path.join('data', model, 'pak')
    out_dir = os.path.join('data', model)
    t0 = time.time()
    wanted = np.unique(np.concatenate([np.unique(Ff[p['tris']]) for p in pieces]))
    colours = bake_colours(Vf, Ff, Tf, Ftf, Fmat, mats, pak, wanted)
    print(f'baked {len(colours):,} vertex colours in {time.time()-t0:.1f}s')

    blobs, index = [], []
    offset = 0
    for i, p in enumerate(pieces):
        tri = Ff[p['tris']]
        vids = np.unique(tri)
        remap = {int(v): k for k, v in enumerate(vids)}
        pos = Vf[vids].astype(np.float32)
        # stand the piece on its own origin: the viewer places it by position like any other piece
        lo, hi = p['lo'], p['hi']
        centre = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]], np.float32)
        pos = pos - centre
        col = np.zeros((len(vids), 3), np.uint8)
        for k, v in enumerate(vids):
            c = colours.get(int(v))
            col[k] = c if c is not None else (170, 165, 160)
        idx = np.array([[remap[int(a)] for a in t] for t in tri], np.uint32)
        # Pad each section to 4 bytes. Colours are 3 bytes a vertex, so without this the index array
        # can start on an odd offset and a Uint32Array view over it throws in the browser.
        def pad4(b):
            return b + b'\x00' * ((4 - len(b) % 4) % 4)
        parts = [pad4(pos.tobytes()), pad4(col.tobytes()), pad4(idx.tobytes())]
        rec = dict(
            i=i, verts=int(len(vids)), tris=int(len(tri)),
            at=[round(float(centre[0]), 3), round(float(centre[1]), 3), round(float(centre[2]), 3)],
            size=[round(float(hi[0] - lo[0]), 3), round(float(hi[1] - lo[1]), 3), round(float(hi[2] - lo[2]), 3)],
            floorGap=round(float(lo[2] - floor_z), 3),
            room=_room_of(float((lo[0] + hi[0]) / 2), float((lo[1] + hi[1]) / 2), house),
            pos=[offset, len(parts[0])],
            col=[offset + len(parts[0]), len(parts[1])],
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
                cut=cut, floorZ=round(float(floor_z), 3), pieces=index)
    with open(os.path.join(out_dir, 'furniture.json'), 'w') as f:
        json.dump(meta, f)
    mb = os.path.getsize(bin_path) / 1e6
    print(f'wrote {bin_path} ({mb:.1f} MB) and furniture.json, {len(index)} pieces')
    named = sum(1 for r in index if r['room'])
    print(f'  {named}/{len(index)} inside a room on the floor plan')
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
