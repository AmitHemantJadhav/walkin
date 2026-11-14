#!/usr/bin/env python3
"""Seamless wall tiles for walkin.setWallMaterial, drawn here so the demo has something to show if the
generated texture (R4) is slow or the key is missing.

    python3 tools/make_tiles.py        ->  models/textures/*.jpg  (512 x 512, one tile = 1 m x 1 m)

Each tile wraps in both directions, so the wall quad can repeat it at any real-world size.
"""
import os
import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "textures")
N = 512                       # pixels per tile
rng = np.random.default_rng(7)


def noise(scale, amp):
    """Smooth tiling noise: low-frequency random field, wrapped by construction."""
    small = rng.random((scale, scale))
    img = Image.fromarray((small * 255).astype(np.uint8)).resize((N, N), Image.BICUBIC)
    a = np.asarray(img, dtype=float) / 255.0
    return (a - a.mean()) * amp


def brick(course_h=0.08, brick_w=0.21, mortar=0.012, base=(150, 74, 56), mortar_rgb=(206, 198, 186)):
    """A running-bond brick wall, 1 m x 1 m, with the courses offset by half a brick."""
    img = np.zeros((N, N, 3), dtype=float)
    img[:, :] = mortar_rgb
    rows = max(1, int(round(1.0 / course_h)))
    course_px = N / rows
    mortar_px = mortar * N
    for r in range(rows):
        y0 = int(round(r * course_px + mortar_px / 2))
        y1 = int(round((r + 1) * course_px - mortar_px / 2))
        if y1 <= y0:
            continue
        offset = (r % 2) * (brick_w / 2)
        x = -brick_w + offset
        while x < 1.0 + brick_w:
            x0 = int(round((x + mortar / 2) * N))
            x1 = int(round((x + brick_w - mortar / 2) * N))
            x += brick_w
            if x1 <= x0:
                continue
            shade = 1.0 + rng.normal(0, 0.05)          # every brick a slightly different colour
            colour = np.clip(np.array(base, dtype=float) * shade, 0, 255)
            for a, b in ((x0, x1), (x0 + N, x1 + N), (x0 - N, x1 - N)):   # wrap across the seam
                a2, b2 = max(0, a), min(N, b)
                if b2 > a2:
                    img[y0:y1, a2:b2] = colour
    img += noise(32, 26)[:, :, None]                   # grain
    img += noise(8, 10)[:, :, None]                    # patchiness
    return np.clip(img, 0, 255).astype(np.uint8)


def plaster(base=(222, 216, 206)):
    img = np.zeros((N, N, 3), dtype=float)
    img[:, :] = base
    img += noise(64, 10)[:, :, None]
    img += noise(10, 6)[:, :, None]
    return np.clip(img, 0, 255).astype(np.uint8)


def panelling(base=(132, 96, 64), stile=0.06):
    """Vertical tongue-and-groove boards, 1 m x 1 m."""
    img = np.zeros((N, N, 3), dtype=float)
    img[:, :] = base
    boards = max(1, int(round(1.0 / 0.125)))
    for b in range(boards):
        x0 = int(round(b * N / boards))
        x1 = int(round((b + 1) * N / boards))
        img[:, x0:x1] *= 1.0 + rng.normal(0, 0.04)
        img[:, x0:min(N, x0 + 3)] *= 0.72               # the groove between boards
    img += noise(128, 14)[:, :, None]                   # grain along the boards
    return np.clip(img, 0, 255).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, data in (("brick_red", brick()),
                       ("brick_white", brick(base=(214, 208, 200), mortar_rgb=(176, 170, 162))),
                       ("plaster", plaster()),
                       ("panelling", panelling())):
        path = os.path.abspath(os.path.join(OUT, f"{name}.jpg"))
        Image.fromarray(data).save(path, quality=86)
        print(f"  {name}.jpg  {os.path.getsize(path) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
