"""How complete, and how clean, is each piece that meshdiff.py cut out?

Two numbers per piece, both measured off the shipped furniture.bin so they describe exactly what the
viewer renders:

  captured %  mesh surface area / convex hull area. The scanner only ever saw the sides it could see,
              so a piece against a wall has no back. Over 100% does not mean "more than complete" --
              it means the surface wanders further than the hull, which is photogrammetry noise.

  fold deg    mean angle between neighbouring triangles. A flat table top should be near zero. High
              values are the lumpy, melted look. Vertices are welded by position first, because the
              texture atlas splits them at every seam and that would otherwise read as a hole.

Usage: python tools/meshquality.py [model-id]
"""
import json
import os
import sys
from collections import defaultdict

import numpy as np
from scipy.spatial import ConvexHull

MODEL = sys.argv[1] if len(sys.argv) > 1 else 'zvKHR9DHNjJ'


def weld(V):
    """Map each vertex to an id shared by every vertex at the same position."""
    key, vid = {}, np.empty(len(V), np.int64)
    for i, v in enumerate(np.round(V, 5)):
        vid[i] = key.setdefault((v[0], v[1], v[2]), len(key))
    return vid


def measure(V, F):
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    n = np.cross(b - a, c - a)
    ln = np.linalg.norm(n, axis=1)
    ok = ln > 1e-12
    n[ok] /= ln[ok][:, None]
    area = float(ln.sum() / 2)

    vid = weld(V)
    edges = defaultdict(list)
    for fi, f in enumerate(F):
        w = [vid[f[0]], vid[f[1]], vid[f[2]]]
        for k in range(3):
            edges[(min(w[k], w[(k + 1) % 3]), max(w[k], w[(k + 1) % 3]))].append(fi)

    angs = [np.degrees(np.arccos(np.clip(np.dot(n[fs[0]], n[fs[1]]), -1, 1)))
            for fs in edges.values() if len(fs) == 2 and ok[fs[0]] and ok[fs[1]]]
    boundary = sum(1 for fs in edges.values() if len(fs) == 1)

    try:
        captured = area / ConvexHull(V).area
    except Exception:
        captured = float('nan')
    return captured, (float(np.mean(angs)) if angs else float('nan')), boundary, area


def main():
    d = json.load(open(os.path.join('data', MODEL, 'furniture.json')))
    buf = np.fromfile(os.path.join('data', MODEL, 'furniture.bin'), dtype=np.uint8)

    rows = []
    for p in d['pieces']:
        po, pl = p['pos']
        io, il = p['idx']
        V = buf[po:po + pl].view(np.float32).reshape(-1, 3).astype(np.float64)
        F = buf[io:io + il].view(np.uint32).reshape(-1, 3)
        cap, fold, boundary, area = measure(V, F)
        rows.append((p['i'], p.get('room') or 'none', cap, fold, boundary, area, p['tris']))

    rows.sort(key=lambda r: r[2])
    print(f"{'#':>3} {'room':<13} {'captured %':>10} {'fold deg':>8} {'open edges':>10} {'m2':>6} {'tris':>6}")
    for i, room, cap, fold, boundary, area, tris in rows:
        print(f'{i:>3} {room:<13} {100*cap:>10.0f} {fold:>8.1f} {boundary:>10} {area:>6.2f} {tris:>6}')

    cap = np.array([r[2] for r in rows])
    fold = np.array([r[3] for r in rows])
    print(f'\n{len(rows)} pieces')
    print(f'captured: median {100*np.median(cap):.0f}%  worst {100*cap.min():.0f}%  best {100*cap.max():.0f}%')
    print(f'under half their surface: {int((cap < 0.5).sum())}')
    print(f'noisy (captured > 100%, surface wanders past its own hull): {int((cap > 1.0).sum())}')
    print(f'fold: median {np.median(fold):.1f} deg  worst {fold.max():.1f} deg')


if __name__ == '__main__':
    main()
