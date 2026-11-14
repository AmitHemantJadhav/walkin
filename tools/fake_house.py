#!/usr/bin/env python3
"""Local test fixture: writes data/fixture/ with a two-room house and synthetic equirectangular panos,
so the viewer can be run without Matterport keys. data/ is git-ignored - this never gets committed.

The panos are ray-traced through the same local->model mapping app.js uses with the verified calibration
{qMode:1, yaw:90, mirror:1}, so walls, floor and the furniture line up exactly as they do on a real house:
    d = (l.z, -l.x, l.y)      (world direction for a pano-local direction l)
    l = (-d.y, d.z, d.x)      (the inverse, used to render each texel)

Usage:  python3 tools/fake_house.py          then open http://localhost:8000/?m=fixture
"""
import json, math, os, sys
import numpy as np
from PIL import Image

W, H = 2048, 1024                      # equirect size (same aspect as a 2k skybox stitch)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "fixture")
OUT = os.path.abspath(OUT)
FLOOR_Z, CEIL_Z = 0.0, 2.6
EYE = 1.5                               # camera height of a scan point

# ---------------------------------------------------------------- the house: two rooms sharing a wall with a door
#   living room  x in [0, 5.2], y in [0, 4.0]          bedroom  x in [5.2, 9.0], y in [0, 3.4]
LIVING = [[0, 0], [5.2, 0], [5.2, 4.0], [0, 4.0]]
BEDROOM = [[5.2, 0], [9.0, 0], [9.0, 3.4], [5.2, 3.4]]
DOOR = dict(x=5.2, y0=1.2, y1=2.1)      # opening in the shared wall
WINDOWS = [                             # (x0, y0, x1, y1, z0, z1) bright rectangles on a wall
    (0.0, 1.0, 0.0, 2.8, 0.9, 2.1),     # living room, west wall
    (9.0, 0.9, 9.0, 2.4, 0.9, 2.1),     # bedroom, east wall
]

# (x0, y0, x1, y1, tint) - each outer wall gets its own tint so left/right and mirroring are obvious
WALLS = [
    (0, 0, 9.0, 0, (236, 196, 196)),        # south  (y = 0)        pink
    (0, 4.0, 5.2, 4.0, (196, 232, 200)),    # north  (y = 4.0)      green
    (5.2, 3.4, 9.0, 3.4, (196, 232, 200)),  # north  (y = 3.4)      green
    (0, 0, 0, 4.0, (198, 212, 238)),        # west   (x = 0)        blue
    (9.0, 0, 9.0, 3.4, (240, 232, 190)),    # east   (x = 9.0)      yellow
    (5.2, 0, 5.2, 4.0, (226, 220, 209)),    # the shared wall with the doorway
]

PANOS = [
    dict(id="liv1", label="Living room", pos=[2.4, 2.0, EYE]),
    dict(id="liv2", label="Living room window", pos=[1.2, 1.2, EYE]),
    dict(id="bed1", label="Bedroom", pos=[7.0, 1.7, EYE]),
]
NEIGHBORS = {"liv1": ["liv2", "bed1"], "liv2": ["liv1"], "bed1": ["liv1"]}

# ---------------------------------------------------------------- colours (sRGB, roughly a warm daylit interior)
C_FLOOR = np.array([138, 104, 72], float)      # wood
C_WALL = np.array([226, 220, 209], float)      # warm white
C_CEIL = np.array([238, 236, 232], float)
C_WINDOW = np.array([245, 248, 252], float)
C_SKIRT = np.array([244, 242, 238], float)


def trace(origin, d):
    """Colour seen from `origin` looking along unit directions `d` (…,3). Axis-aligned box rooms."""
    ox, oy, oz = origin
    dx, dy, dz = d[..., 0], d[..., 1], d[..., 2]
    eps = 1e-9
    t_best = np.full(dx.shape, np.inf)
    col = np.zeros(dx.shape + (3,))

    def hit(t, mask, colour):
        better = mask & (t > 1e-4) & (t < t_best)
        t_best[better] = t[better]
        col[better] = colour[better] if colour.ndim == col.ndim else colour

    # which room a point belongs to, used to clip walls and the floor plan
    def in_house(x, y):
        return ((x >= -0.01) & (x <= 5.21) & (y >= -0.01) & (y <= 4.01)) | \
               ((x > 5.19) & (x <= 9.01) & (y >= -0.01) & (y <= 3.41))

    # floor and ceiling
    for z, base in ((FLOOR_Z, C_FLOOR), (CEIL_Z, C_CEIL)):
        t = (z - oz) / np.where(np.abs(dz) < eps, eps, dz)
        x, y = ox + t * dx, oy + t * dy
        m = (t > 1e-4) & in_house(x, y)
        if base is C_FLOOR:
            # 1 m checker aligned to world x/y, with a grid line on every whole metre: anything that is
            # drawn in model space (wall overlay, furniture footprints) can be measured against it.
            checker = ((np.floor(x) + np.floor(y)) % 2 == 0).astype(float)
            shade = 0.86 + 0.14 * checker
            fx, fy = np.abs(x - np.round(x)), np.abs(y - np.round(y))
            line = (fx < 0.015) | (fy < 0.015)
            c = base[None, None, :] * shade[..., None]
            c = np.where(line[..., None], np.array([70, 52, 36])[None, None, :], c)
            origin_tile = (x > 0) & (x < 1) & (y > 0) & (y < 1)          # the (0..1, 0..1) tile is teal
            c = np.where(origin_tile[..., None], np.array([40, 120, 120])[None, None, :], c)
        else:
            c = np.broadcast_to(base, col.shape).copy()
        hit(t, m, c)

    # vertical walls
    for (x0, y0, x1, y1, tint) in WALLS:
        if x0 == x1:                                          # wall along y
            t = (x0 - ox) / np.where(np.abs(dx) < eps, eps, dx)
            y, z = oy + t * dy, oz + t * dz
            m = (t > 1e-4) & (y >= min(y0, y1) - 0.01) & (y <= max(y0, y1) + 0.01) & (z >= FLOOR_Z) & (z <= CEIL_Z)
            if x0 == DOOR["x"]:                               # cut the doorway out of the shared wall
                m &= ~((y > DOOR["y0"]) & (y < DOOR["y1"]) & (z < 2.05))
            u, v = y, z
        else:                                                 # wall along x
            t = (y0 - oy) / np.where(np.abs(dy) < eps, eps, dy)
            x, z = ox + t * dx, oz + t * dz
            m = (t > 1e-4) & (x >= min(x0, x1) - 0.01) & (x <= max(x0, x1) + 0.01) & (z >= FLOOR_Z) & (z <= CEIL_Z)
            u, v = x, z
        shade = 0.88 + 0.12 * np.clip(v / CEIL_Z, 0, 1)       # a little falloff towards the floor
        c = np.array(tint, float)[None, None, :] * shade[..., None]
        c = np.where((v < 0.09)[..., None], C_SKIRT[None, None, :], c)   # skirting board
        for (wx0, wy0, wx1, wy1, wz0, wz1) in WINDOWS:        # bright windows
            if wx0 == wx1 and x0 == x1 and abs(wx0 - x0) < 0.01:
                inw = (u > min(wy0, wy1)) & (u < max(wy0, wy1)) & (v > wz0) & (v < wz1)
                c = np.where(inw[..., None], C_WINDOW[None, None, :], c)
        hit(t, m, c)

    col[~np.isfinite(t_best)] = np.array([20, 20, 24])
    return np.clip(col, 0, 255).astype(np.uint8)


def render(pos):
    u = (np.arange(W) + 0.5) / W
    v = 1.0 - (np.arange(H) + 0.5) / H          # row 0 is the top of the jpg, and three flips Y
    uu, vv = np.meshgrid(u, v)
    lon = (uu - 0.5) * 2 * math.pi
    lat = (vv - 0.5) * math.pi
    lx = np.sin(lon) * np.cos(lat)
    ly = np.sin(lat)
    lz = np.cos(lon) * np.cos(lat)
    d = np.stack([lz, -lx, ly], axis=-1)        # pano-local -> model, cal {qMode:1, yaw:90, mirror:1}
    return Image.fromarray(trace(pos, d))


def main():
    os.makedirs(os.path.join(OUT, "panos"), exist_ok=True)
    for p in PANOS:
        img = render(p["pos"])
        img.save(os.path.join(OUT, "panos", f"{p['id']}.jpg"), quality=88)
        img.save(os.path.join(OUT, "panos", f"{p['id']}_empty.jpg"), quality=88)
        print("  pano", p["id"])

    walls = []
    for (x0, y0, x1, y1, _tint) in WALLS:
        openings = []
        if x0 == x1 == DOOR["x"]:
            length = abs(y1 - y0)
            openings.append(dict(type="doorway", width=DOOR["y1"] - DOOR["y0"], height=2.05, bottom=0.0,
                                 at=((DOOR["y0"] + DOOR["y1"]) / 2 - min(y0, y1)) / length))
        walls.append(dict(a=[x0, y0], b=[x1, y1], type="wall", thickness=0.12, openings=openings))

    house = dict(
        model="fixture", name="Fixture house (synthetic)",
        panos=[dict(id=p["id"], label=p["label"], pos=p["pos"], floorZ=FLOOR_Z, rot=[0, 0, 0, 1], floor="f0",
                    neighbors=NEIGHBORS[p["id"]], img=f"panos/{p['id']}.jpg",
                    imgEmpty=f"panos/{p['id']}_empty.jpg") for p in PANOS],
        floors=[dict(id="f0", label="Floor 1", sequence=0, walls=walls)],
        rooms=[
            dict(id="r_living", label="Living Room", floor="f0", poly=LIVING,
                 dims=dict(areaFloor=20.8, width=5.2, depth=4.0, height=2.6)),
            dict(id="r_bed", label="Bedroom", floor="f0", poly=BEDROOM,
                 dims=dict(areaFloor=12.9, width=3.8, depth=3.4, height=2.6)),
        ],
        plans=[], meshes=[], created="fixture",
    )
    with open(os.path.join(OUT, "house.json"), "w") as f:
        json.dump(house, f)
    print("wrote", os.path.join(OUT, "house.json"))


if __name__ == "__main__":
    main()
