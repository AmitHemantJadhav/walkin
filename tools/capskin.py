"""Give the invented surfaces a material instead of a flat colour.

meshclose.py closes the holes the scanner left, which is what lets a piece be turned round instead
of showing the inside of its own front. But a cap has no texture of its own: it got one flat colour
sampled from the piece, and side by side that reads as a slab stuck on the furniture, which is why
capping was limited to undersides nobody sees.

This fills that in. For each piece it crops a patch of the piece's *real* texture, asks an image
model to continue that material as a flat swatch, appends the swatch to the piece's atlas and maps
the cap faces onto it. The measured surfaces keep every one of their own pixels - only the geometry
we invented gets invented pixels, which is the honest version of what CoStar asked for.

Runs against the relay in serve.py, so the key stays on the server. Image generation is rate limited
to 2/min there, so this is a slow offline pass; its output is committed into data/ like the rest of
the export and costs nothing at runtime.

Usage: python tools/capskin.py [model-id] [how-many-pieces]
"""
import base64
import io
import json
import os
import sys
import time

import numpy as np
from PIL import Image

RELAY = os.environ.get('WALKIN_RELAY', 'http://localhost:8000')
IMAGE_MODEL = 'gemini-3.1-flash-image'      # the same one agent.js uses for wallpaper tiles
SWATCH = 384                                 # px in the atlas; caps are flat, they do not need more
FILLER = np.array([150., 145., 140.])        # build_atlas paints unused atlas space this colour
PAUSE = 31                                   # seconds between calls: the relay allows 2 images/min


def _post(req, timeout=120):
    import urllib.request
    url = f'{RELAY}/api/gemini?model={IMAGE_MODEL}'
    r = urllib.request.urlopen(urllib.request.Request(
        url, json.dumps(req).encode(), {'Content-Type': 'application/json'}), timeout=timeout)
    return json.loads(r.read())


def material_crop(atlas, want=320):
    """A square of ONE contiguous patch of this piece's real texture.

    Not just "the window with the least filler": an atlas is hundreds of separate UV islands packed
    together, so an arbitrary window is a collage of unrelated fragments. Asked to continue that, the
    image model faithfully produced more collage. Find the biggest single island instead and crop
    inside it, so the model is shown an actual piece of material.
    """
    from scipy import ndimage

    a = np.asarray(atlas.convert('RGB'), float)
    real = np.abs(a - FILLER).max(axis=2) > 6
    lab, n = ndimage.label(real)
    if n == 0:
        return atlas.crop((0, 0, min(want, atlas.width), min(want, atlas.height))), 0.0
    sizes = ndimage.sum(real, lab, range(1, n + 1))
    big = int(np.argmax(sizes)) + 1
    mask = lab == big
    ys, xs = np.where(mask)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    side = min(want, y1 - y0, x1 - x0)
    if side < 24:                                   # no island big enough: fall back to the sheet
        side = min(want, atlas.height, atlas.width)
        return atlas.crop((0, 0, side, side)), float(real.mean())
    # slide inside that island's box for the squarest, fullest window
    sub = mask[y0:y1, x0:x1].astype(float)
    ii = np.pad(sub.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    best, pos = -1.0, (0, 0)
    for y in range(0, sub.shape[0] - side + 1, max(4, side // 10)):
        for x in range(0, sub.shape[1] - side + 1, max(4, side // 10)):
            v = ii[y + side, x + side] - ii[y, x + side] - ii[y + side, x] + ii[y, x]
            if v > best:
                best, pos = v, (x, y)
    x, y = pos
    return (atlas.crop((x0 + x, y0 + y, x0 + x + side, y0 + y + side)),
            best / (side * side))


def swatch_for(atlas, hint):
    """Ask the image model to continue this piece's material as a flat swatch."""
    crop, cover = material_crop(atlas)
    buf = io.BytesIO()
    crop.save(buf, format='PNG')
    prompt = (
        'This image is a patch of the real surface of a piece of furniture, photographed in a home. '
        'Produce a flat, evenly lit swatch of the SAME material, continuing its colour, weave and '
        'grain. It must look like more of this exact material. Fill the whole frame with the '
        'material only: no object, no edges, no background, no shadow, no text.'
        + (f' For context, the piece is a {hint}.' if hint else ''))
    req = {'contents': [{'role': 'user', 'parts': [
        {'inlineData': {'mimeType': 'image/png', 'data': base64.b64encode(buf.getvalue()).decode()}},
        {'text': prompt}]}]}
    d = _post(req)
    for p in (d.get('candidates') or [{}])[0].get('content', {}).get('parts', []):
        if 'inlineData' in p:
            im = Image.open(io.BytesIO(base64.b64decode(p['inlineData']['data']))).convert('RGB')
            # crop to a centre square before resizing, so the material is not squashed
            s = min(im.size)
            im = im.crop(((im.width - s) // 2, (im.height - s) // 2,
                          (im.width + s) // 2, (im.height + s) // 2))
            return im.resize((SWATCH, SWATCH), Image.LANCZOS), cover
    return None, cover


def plane_uv(P):
    """Flatten cap vertices onto their own best-fit plane and normalise to the unit square."""
    c = P.mean(axis=0)
    _, _, vt = np.linalg.svd(P - c, full_matrices=False)
    xy = np.stack([(P - c) @ vt[0], (P - c) @ vt[1]], axis=1)
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    span = np.maximum(hi - lo, 1e-6)
    return (xy - lo) / span


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else 'zvKHR9DHNjJ'
    want = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    out = os.path.join('data', model)
    meta = json.load(open(os.path.join(out, 'furniture.json')))
    buf = np.fromfile(os.path.join(out, 'furniture.bin'), dtype=np.uint8)
    tex_dir = os.path.join(out, 'furniture-tex')

    todo = sorted([p for p in meta['pieces'] if p.get('capVerts')],
                  key=lambda p: -p['capped'])[:want]
    print(f'{model}: skinning the caps of {len(todo)} of {len(meta["pieces"])} pieces '
          f'(~{PAUSE*len(todo)/60:.0f} min at the relay\'s 2 images/min)')

    done = 0
    for n, p in enumerate(todo):
        path = os.path.join(tex_dir, p['tex'])
        atlas = Image.open(path).convert('RGB')
        try:
            sw, cover = swatch_for(atlas, p.get('room', '').lower() + ' furniture' if p.get('room') else None)
        except Exception as e:
            print(f'  #{p["i"]}: generation failed ({type(e).__name__}: {str(e)[:80]}), left flat')
            sw = None
        if sw is None:
            if n < len(todo) - 1:
                time.sleep(PAUSE)
            continue

        W, H = atlas.size
        newH = H + SWATCH
        canvas = Image.new('RGB', (max(W, SWATCH), newH), tuple(FILLER.astype(int)))
        canvas.paste(atlas, (0, 0))
        canvas.paste(sw, (0, H))
        newW = canvas.size[0]

        po, pl = p['pos']
        uo, ul = p['uv']
        V = buf[po:po + pl].view(np.float32).reshape(-1, 3).astype(np.float64)
        UV = buf[uo:uo + ul].view(np.float32).reshape(-1, 2).copy()

        # existing pixels keep their place: only the sheet got taller, and wider if the swatch is
        UV[:, 0] *= W / newW
        UV[:, 1] = 1.0 - (1.0 - UV[:, 1]) * (H / newH)

        k = p['capVerts']
        st = plane_uv(V[-k:])
        pad = 2.0 / SWATCH                      # keep off the very edge, bilinear reaches outside
        st = pad + st * (1 - 2 * pad)
        UV[-k:, 0] = st[:, 0] * (SWATCH / newW)
        UV[-k:, 1] = (1.0 - H / newH) * st[:, 1]

        canvas.save(path, quality=88, optimize=True)
        buf[uo:uo + ul] = np.frombuffer(UV.astype(np.float32).tobytes(), dtype=np.uint8)
        p['tex'] = p['tex']
        p['capSkin'] = True
        done += 1
        print(f'  #{p["i"]:>2} {(p.get("room") or ""):<13} atlas {W}x{H} -> {newW}x{newH}, '
              f'{p["capped"]} cap tris skinned (crop was {100*cover:.0f}% real texture)')
        if n < len(todo) - 1:
            time.sleep(PAUSE)

    buf.tofile(os.path.join(out, 'furniture.bin'))
    meta['capSkin'] = done
    json.dump(meta, open(os.path.join(out, 'furniture.json'), 'w'))
    print(f'skinned {done} pieces; furniture.bin and furniture.json rewritten')


if __name__ == '__main__':
    main()
