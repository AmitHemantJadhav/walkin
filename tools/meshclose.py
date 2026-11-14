"""Close the holes in a cut-out piece, so it can be turned round.

meshdiff.py gives us only the surfaces the scanner could see. A sofa against a wall has no back, so
turning it shows the inside of its front: on La Mirada the median piece has 59% of its surface and 8
of 41 have under half. This fills the holes.

The method is deliberately dull. Find the edges that belong to one face only, chain them into loops,
fit a plane through each loop, triangulate it there, and wind the result to face away from the piece.
No Poisson, no new dependency - numpy and scipy are already in the pipeline, and a flat lid is what
the backs of most furniture actually look like. It costs +7% triangles across the whole house and
takes the median piece from 59% to 89% of its hull.

What it cannot do is invent *texture*. The caps are given a UV that lands on a representative pixel
of the piece's own atlas, so a capped sofa reads as that sofa's fabric rather than as a grey hole.
Generating the unseen side properly is a separate question (PR #117).
"""
from collections import defaultdict

import numpy as np
from scipy.spatial import Delaunay

MIN_LOOP = 3          # a loop needs at least a triangle's worth of corners
MAX_LOOP = 2000       # a pathological loop is not worth the Delaunay


def weld(V, nd=5):
    """Vertices at the same position share an id. The atlas splits them at every texture seam, and
    without this every seam would read as a hole."""
    key, vid = {}, np.empty(len(V), np.int64)
    for i, v in enumerate(np.round(V, nd)):
        vid[i] = key.setdefault((v[0], v[1], v[2]), len(key))
    return vid, len(key)


def boundary_loops(F, vid):
    """Edges used by exactly one face, chained into loops of welded vertex ids."""
    use = defaultdict(int)
    for f in F:
        w = (vid[f[0]], vid[f[1]], vid[f[2]])
        for k in range(3):
            a, b = w[k], w[(k + 1) % 3]
            use[(a, b) if a < b else (b, a)] += 1
    adj = defaultdict(list)
    for (a, b), n in use.items():
        if n == 1:
            adj[a].append(b)
            adj[b].append(a)
    loops, seen = [], set()
    for start in adj:
        if start in seen:
            continue
        loop, cur, prev = [start], start, None
        seen.add(start)
        while True:
            nxt = [x for x in adj[cur] if x != prev and x not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            seen.add(cur)
            loop.append(cur)
        if MIN_LOOP <= len(loop) <= MAX_LOOP:
            loops.append(loop)
    return loops


def _inside(p, poly):
    """Ray-crossing test, so a Delaunay triangle outside a concave loop is dropped."""
    x, y = p
    hit = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            if x < x1 + (y - y1) * (x2 - x1) / (y2 - y1 + 1e-30):
                hit = not hit
    return hit


def cap_loop(loop, pos, centroid):
    """Triangulate one loop on its own best-fit plane, wound to face away from the piece."""
    P = pos[loop]
    c = P.mean(axis=0)
    _, _, vt = np.linalg.svd(P - c, full_matrices=False)
    n = vt[2]
    if np.dot(n, c - centroid) < 0:
        n = -n                                       # outward, not into the piece
    xy = np.stack([(P - c) @ vt[0], (P - c) @ vt[1]], axis=1)
    try:
        simp = Delaunay(xy).simplices
    except Exception:
        return []                                    # degenerate loop: leave the hole
    out = []
    for t in simp:
        if not _inside(xy[t].mean(axis=0), xy):
            continue
        a, b, cc = P[t[0]], P[t[1]], P[t[2]]
        if np.dot(np.cross(b - a, cc - a), n) < 0:
            t = (t[0], t[2], t[1])
        out.append((loop[t[0]], loop[t[1]], loop[t[2]]))
    return out


def close(V, F):
    """Cap every hole in (V, F).

    Returns (cap_positions, cap_faces, open_before, open_after). cap_faces index into cap_positions,
    which are new vertices - existing vertices and their UVs are never touched.
    """
    vid, nw = weld(V)
    pos = np.zeros((nw, 3))
    pos[vid] = V
    loops = boundary_loops(F, vid)
    open_before = sum(len(L) for L in loops)
    centroid = pos.mean(axis=0)

    tris = []
    for L in loops:
        tris.extend(cap_loop(L, pos, centroid))
    if not tris:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint32), open_before, open_before

    used = sorted({i for t in tris for i in t})
    remap = {w: k for k, w in enumerate(used)}
    cap_pos = pos[used].astype(np.float32)
    cap_faces = np.array([[remap[a], remap[b], remap[c]] for a, b, c in tris], np.uint32)

    # how much hole is left, counting the caps in
    all_F = np.vstack([F, cap_faces + len(V)])
    all_V = np.vstack([V, cap_pos])
    vid2, _ = weld(all_V)
    open_after = sum(len(L) for L in boundary_loops(all_F, vid2))
    return cap_pos, cap_faces, open_before, open_after


def representative_uv(image, sample=64):
    """A UV landing on a pixel whose colour is typical of this piece, so caps read as its material."""
    if image is None:
        return (0.5, 0.5)
    im = image.convert('RGB')
    w, h = im.size
    small = im.resize((min(sample, w), min(sample, h)))
    a = np.asarray(small, float).reshape(-1, 3)
    target = np.median(a, axis=0)
    k = int(np.argmin(((a - target) ** 2).sum(axis=1)))
    sw = small.size[0]
    u = ((k % sw) + 0.5) / sw
    v = ((k // sw) + 0.5) / small.size[1]
    return (float(u), float(1.0 - v))               # the loader flips Y
