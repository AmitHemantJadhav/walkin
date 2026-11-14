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


def close(V, F, facing=-0.5):
    """Cap the holes in (V, F).

    Returns (cap_positions, cap_faces, open_before, open_after). cap_faces index into cap_positions,
    which are new vertices - existing vertices and their UVs are never touched.

    `facing` is why this is not simply "cap everything". A cap has no texture of its own: it gets a
    flat colour sampled from the piece, which is invisible on an underside and an obvious pasted-on
    slab anywhere you can see it. Compared side by side, the living room piano looks clearly *worse*
    capped, and the sofa looks fine - because 97% of the sofa's cap area faces the floor and the
    piano's faces sideways. So by default only holes pointing downwards (normal z below `facing`)
    are filled: the undersides nobody sees, which are also what makes a piece look hollow from below.
    Pass facing=1.0 to cap everything, which is what you want if a piece is going to be turned round
    and you would rather see a flat back than the inside of its own front.
    """
    vid, nw = weld(V)
    pos = np.zeros((nw, 3))
    pos[vid] = V
    loops = boundary_loops(F, vid)
    open_before = sum(len(L) for L in loops)
    centroid = pos.mean(axis=0)

    tris = []
    for L in loops:
        got = cap_loop(L, pos, centroid)
        if not got:
            continue
        if facing < 1.0:
            a, b, c = pos[[t[0] for t in got]], pos[[t[1] for t in got]], pos[[t[2] for t in got]]
            n = np.cross(b - a, c - a)
            ln = np.linalg.norm(n, axis=1)
            ok = ln > 1e-12
            if not ok.any():
                continue
            area = ln[ok] / 2
            nz = n[ok, 2] / ln[ok]
            # weight by area: one stray triangle should not decide a whole loop
            if (area * (nz < facing)).sum() <= 0.5 * area.sum():
                continue
        tris.extend(got)
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
    # The packer fills unused atlas space with (150,145,140). About a quarter of a sheet is that
    # filler, so a plain median can land on it and cap a piece with grey instead of its own material.
    real = a[(np.abs(a - np.array([150., 145., 140.])).max(axis=1) > 6)]
    if len(real) < 16:
        real = a
    target = np.median(real, axis=0)
    a = real
    full = np.asarray(small, float).reshape(-1, 3)
    bg = np.abs(full - np.array([150., 145., 140.])).max(axis=1) <= 6
    cost = ((full - target) ** 2).sum(axis=1)
    cost[bg] = np.inf                                # never point a cap at the filler
    k = int(np.argmin(cost))
    sw = small.size[0]
    u = ((k % sw) + 0.5) / sw
    v = ((k // sw) + 0.5) / small.size[1]
    return (float(u), float(1.0 - v))               # the loader flips Y


def orient(V, F):
    """Make every triangle in a piece wind the same way, so it can be drawn front-faces-only.

    Drawing these pieces DoubleSide costs 4.09 ms of GPU fill at the worst scan point in La Mirada
    and FrontSide costs 0.14 ms - a 29x difference, because at close range the furniture covers most
    of the screen and every pixel gets shaded twice. FrontSide straight off the MatterPak leaves
    white holes, though: 0.3-2.2% of shared edges are traversed the same way by both their triangles,
    which means those two disagree about which side is out.

    So: walk the surface, flipping any neighbour that disagrees, then flip the whole shell if it
    ended up inside out. Flipping a triangle only reorders its three indices, so per-vertex UVs are
    untouched.
    """
    from collections import defaultdict, deque

    vid, _ = weld(V)
    edge = defaultdict(list)
    for fi, f in enumerate(F):
        w = (vid[f[0]], vid[f[1]], vid[f[2]])
        for k in range(3):
            a, b = w[k], w[(k + 1) % 3]
            edge[(a, b) if a < b else (b, a)].append((fi, a, b))

    out = F.copy()
    flip = np.zeros(len(F), bool)
    seen = np.zeros(len(F), bool)
    for seed in range(len(F)):
        if seen[seed]:
            continue
        seen[seed] = True
        q = deque([seed])
        comp = [seed]
        while q:
            fi = q.popleft()
            w = (vid[out[fi][0]], vid[out[fi][1]], vid[out[fi][2]])
            for k in range(3):
                a, b = w[k], w[(k + 1) % 3]
                for fj, aj, bj in edge[(a, b) if a < b else (b, a)]:
                    if fj == fi or seen[fj]:
                        continue
                    wj = (vid[out[fj][0]], vid[out[fj][1]], vid[out[fj][2]])
                    same = any(wj[m] == a and wj[(m + 1) % 3] == b for m in range(3))
                    if same:                      # both traverse a->b: one of them is inside out
                        out[fj] = out[fj][[0, 2, 1]]
                        flip[fj] = True
                    seen[fj] = True
                    q.append(fj)
                    comp.append(fj)
        # does this shell face outwards? compare its normals against the way out of its own middle
        idx = np.array(comp)
        T = V[out[idx]]
        n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0])
        ln = np.linalg.norm(n, axis=1)
        ok = ln > 1e-12
        if ok.any():
            c = T.reshape(-1, 3).mean(axis=0)
            away = T[:, 0] - c
            s = float((n[ok] * away[ok]).sum())
            if s < 0:
                out[idx] = out[idx][:, [0, 2, 1]]
    return out
