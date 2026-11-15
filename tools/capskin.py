#!/usr/bin/env python3
"""Give the invented surfaces a real material: the piece's own, continued by an image model.

tools/meshclose.py closes a piece's missing side with new faces, and tools/meshsharp.py gives those
faces a square of the piece's own grain, mirror-tiled (the "material square", bottom-left of the
atlas). That square is honest but mechanical: a mirrored 96 px patch. This replaces it with a swatch
an image model continues from a crop of the piece's *real* texture - the same weave, the same wood,
as a flat evenly lit sheet - pasted over the square in place. Nothing else changes: the measured
surfaces keep every pixel they had, the UVs already point at the square, and furniture.bin is not
touched. A piece without a square (no caps) is skipped.

Preprocessing only. Runs once per export per house; at demo time nothing here is called.

Where the images come from, in this order:
  1. the Gemini API directly, with GEMINI_API_KEY from the environment or ./.env (the normal case:
     one key, your own quota, no relay in the way);
  2. the serve.py relay at WALKIN_RELAY (http://localhost:8000) if no key is in reach - it has the
     key, but limits images to 2/min, so this is slow.
Either way a refusal (429, 5xx, a timeout) is retried with backoff, honouring Retry-After, and a
piece that still fails keeps its mirrored square - the demo never depends on this having run.

A returned image is checked before it is used: it must be an image, big enough, and its colour must
be near the crop's (the model sometimes draws an object instead of a material). Its brightness is
then matched to the crop, so the back of the sofa is the front's fabric in the front's light.

Idempotent: a skinned piece is recorded in furniture.json (`capSkin`) and skipped; meshsharp clears
that mark whenever it rebuilds a square, so the order is always meshdiff export -> meshsharp ->
capskin, and any of the three can be rerun.

  python tools/capskin.py zvKHR9DHNjJ               # skin every capped piece that is not yet skinned
  python tools/capskin.py zvKHR9DHNjJ --dry          # say what would be done, call nothing
  python tools/capskin.py zvKHR9DHNjJ --max 6        # only the six pieces with the most cap area
  python tools/capskin.py zvKHR9DHNjJ --force        # redo pieces already skinned
"""
import argparse
import base64
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import meshsharp  # noqa: E402  (texels(), TILE)

IMAGE_MODEL = os.environ.get('GEMINI_IMAGE_MODEL') or 'gemini-3.1-flash-image'
RELAY = os.environ.get('WALKIN_RELAY', 'http://localhost:8000')
GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
CROP = 320            # px of real texture shown to the model
TRIES = 6
MAX_WAIT = 120        # s: the longest single backoff
MIN_IMAGE = 256       # px: anything smaller is not a swatch
MAX_COLOUR_DIST = 70  # mean RGB distance between swatch and crop above which the swatch is refused


def env(name):
    """Process environment first, then ./.env and ../.env, the way prep_house.py reads keys."""
    if os.environ.get(name):
        return os.environ[name]
    for path in ('.env', os.path.join('..', '.env')):
        if os.path.exists(path):
            for line in open(path):
                line = line.strip()
                if line.startswith(name + '='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    return ''


class Gemini:
    """One image per call, direct or through the relay, with backoff."""

    def __init__(self, key, relay):
        self.key, self.relay = key, relay
        self.calls = 0
        self.where = 'Gemini directly' if key else f'the relay at {relay}'

    def _url(self):
        if self.key:
            return GEMINI_URL.format(model=IMAGE_MODEL), {'x-goog-api-key': self.key}
        return f'{self.relay}/api/gemini?model={IMAGE_MODEL}', {}

    def generate(self, req, timeout=120):
        url, headers = self._url()
        headers = {'Content-Type': 'application/json', **headers}
        wait = 20
        for attempt in range(1, TRIES + 1):
            try:
                r = urllib.request.urlopen(urllib.request.Request(url, json.dumps(req).encode(), headers),
                                           timeout=timeout)
                self.calls += 1
                return json.loads(r.read())
            except urllib.error.HTTPError as e:
                body = e.read()[:300].decode('utf-8', 'replace')
                retry_after = e.headers.get('Retry-After')
                if e.code in (400, 401, 403, 404):
                    raise RuntimeError(f'HTTP {e.code} from {self.where}: {body}')   # not transient
                if e.code == 429 and 'billing' in body and attempt >= 2:
                    # a per-minute limit says "retry in N s"; "check your plan and billing" is the
                    # day's (or the tier's) quota, and waiting on it wastes the run
                    raise RuntimeError(f'HTTP 429 quota exhausted on {self.where}: {body[:160]}')
                if attempt == TRIES:
                    raise RuntimeError(f'HTTP {e.code} after {TRIES} tries: {body}')
                pause = min(MAX_WAIT, int(retry_after) if (retry_after or '').isdigit() else wait)
                print(f'    HTTP {e.code}, waiting {pause}s ({attempt}/{TRIES})', flush=True)
                time.sleep(pause)
                wait = min(MAX_WAIT, wait * 1.7)
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                if attempt == TRIES:
                    raise RuntimeError(f'{type(e).__name__} after {TRIES} tries: {str(e)[:120]}')
                print(f'    {type(e).__name__}, waiting {wait}s ({attempt}/{TRIES})', flush=True)
                time.sleep(wait)
                wait = min(MAX_WAIT, wait * 1.7)


def material_crop(atlas, square, want=CROP):
    """A square of ONE contiguous patch of this piece's real texture, outside the material square.

    An atlas is hundreds of UV islands packed together, so an arbitrary window is a collage of
    unrelated fragments, and asked to continue that the model produced more collage. Take the
    biggest island and the fullest square window inside it.
    """
    from scipy import ndimage
    a = np.asarray(atlas.convert('RGB'), np.float32)
    real = meshsharp.texels(a)
    x0, y0, s = square
    real[y0:y0 + s, x0:x0 + s] = False                    # never show the model its own square
    lab, n = ndimage.label(real)
    if n == 0:
        return None, 0.0
    sizes = ndimage.sum(real, lab, range(1, n + 1))
    big = int(np.argmax(sizes)) + 1
    mask = (lab == big)
    ys, xs = np.where(mask)
    by0, by1, bx0, bx1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    side = int(min(want, by1 - by0, bx1 - bx0))
    if side < 48:
        return None, 0.0
    # slide a side x side window inside the island's box for the one with the most real texels
    integ = np.pad(mask[by0:by1, bx0:bx1].astype(np.int32), ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    best, best_n = None, -1
    for y in range(0, by1 - by0 - side + 1, 8):
        for x in range(0, bx1 - bx0 - side + 1, 8):
            cnt = integ[y + side, x + side] - integ[y, x + side] - integ[y + side, x] + integ[y, x]
            if cnt > best_n:
                best_n, best = cnt, (x, y)
    x, y = best
    cover = best_n / float(side * side)
    crop = atlas.crop((bx0 + x, by0 + y, bx0 + x + side, by0 + y + side))
    return crop, cover


def ask_swatch(api, crop, hint):
    buf = io.BytesIO()
    crop.save(buf, format='PNG')
    prompt = (
        'This image is a patch of the real surface of a piece of furniture, photographed in a home. '
        'Produce a flat, evenly lit, seamless swatch of the SAME material, continuing its colour, '
        'weave and grain at the same scale. It must look like more of this exact material. Fill the '
        'whole frame with the material only: no object, no edges, no background, no shadow, no text.'
        + (f' For context, the piece is {hint}.' if hint else ''))
    req = {'contents': [{'role': 'user', 'parts': [
        {'inlineData': {'mimeType': 'image/png', 'data': base64.b64encode(buf.getvalue()).decode()}},
        {'text': prompt}]},
    ]}
    d = api.generate(req)
    for part in (d.get('candidates') or [{}])[0].get('content', {}).get('parts', []):
        if 'inlineData' in part:
            try:
                return Image.open(io.BytesIO(base64.b64decode(part['inlineData']['data']))).convert('RGB')
            except Exception:
                return None
    return None


def accept(swatch, crop, size):
    """A swatch we can use: big enough, the crop's colour, matched to the crop's brightness."""
    if swatch is None or min(swatch.size) < MIN_IMAGE:
        return None, 'no image' if swatch is None else f'too small {swatch.size}'
    s = min(swatch.size)
    swatch = swatch.crop(((swatch.width - s) // 2, (swatch.height - s) // 2,
                          (swatch.width + s) // 2, (swatch.height + s) // 2)).resize((size, size), Image.LANCZOS)
    sw = np.asarray(swatch, np.float32)
    cr = np.asarray(crop, np.float32)
    m_sw, m_cr = sw.reshape(-1, 3).mean(axis=0), cr.reshape(-1, 3).mean(axis=0)
    dist = float(np.linalg.norm(m_sw - m_cr))
    if dist > MAX_COLOUR_DIST:
        return None, f'colour off by {dist:.0f}'
    gain = np.clip((m_cr + 8) / (m_sw + 8), 0.7, 1.4)   # the front's light on the back
    out = np.clip(sw * gain, 0, 255).astype(np.uint8)
    return Image.fromarray(out), f'colour off by {dist:.0f}'


def probe():
    """One tiny image request: is the key/model/billing good before a long run?"""
    api = Gemini(env('GEMINI_API_KEY'), RELAY)
    print(f'probing {IMAGE_MODEL} via {api.where} ...')
    req = {'contents': [{'role': 'user', 'parts': [{'text': 'A flat seamless swatch of grey woven linen, filling the frame.'}]}]}
    t0 = time.time()
    try:
        d = api.generate(req, timeout=90)
    except RuntimeError as e:
        print(f'FAIL: {e}')
        return 1
    parts = (d.get('candidates') or [{}])[0].get('content', {}).get('parts', [])
    ok = any('inlineData' in p for p in parts)
    print(f'{"OK" if ok else "FAIL"}: {"an image came back" if ok else "no image in the reply"} in {time.time()-t0:.0f}s')
    return 0 if ok else 1


def run(model, force=False, dry=False, max_pieces=None):
    base = os.path.join('data', model)
    meta_path = os.path.join(base, 'furniture.json')
    if not os.path.exists(meta_path):
        sys.exit(f'{meta_path} not found: run tools/meshdiff.py export {model} and tools/meshsharp.py {model} first')
    meta = json.load(open(meta_path))
    tex_dir = os.path.join(base, 'furniture-tex')
    todo = [p for p in meta['pieces'] if p.get('capSquare') and (force or not p.get('capSkin'))]
    todo.sort(key=lambda p: -(p.get('capped') or 0))
    if max_pieces:
        todo = todo[:max_pieces]
    skipped = sum(1 for p in meta['pieces'] if p.get('capSquare') and p.get('capSkin')) if not force else 0
    no_square = sum(1 for p in meta['pieces'] if not p.get('capSquare'))
    print(f'{model}: {len(todo)} pieces to skin, {skipped} already done, {no_square} have no caps')
    if dry or not todo:
        return
    key = env('GEMINI_API_KEY')
    api = Gemini(key, RELAY)
    print(f'  images from {api.where}, model {IMAGE_MODEL}')
    done, t0 = 0, time.time()
    for n, p in enumerate(todo):
        path = os.path.join(tex_dir, p['tex'])
        atlas = Image.open(path).convert('RGB')
        x0, y0, size = p['capSquare']
        if y0 + size > atlas.height or x0 + size > atlas.width:
            print(f'  p{p["i"]}: atlas {atlas.size} has no room for its square {p["capSquare"]}; rerun meshsharp')
            continue
        crop, cover = material_crop(atlas, (x0, y0, size))
        if crop is None:
            print(f'  p{p["i"]}: no clean patch of real texture to continue; keeping the mirrored square')
            continue
        hint = (p.get('room') or '').lower() + ' furniture' if p.get('room') else None
        try:
            raw = ask_swatch(api, crop, hint)
        except RuntimeError as e:
            print(f'  p{p["i"]}: {e}; keeping the mirrored square', flush=True)
            if 'HTTP 40' in str(e):
                print('  stopping: that is not transient (key, model name or billing)')
                break
            continue
        sw, why = accept(raw, crop, size)
        if sw is None:
            print(f'  p{p["i"]}: swatch refused ({why}); keeping the mirrored square', flush=True)
            continue
        atlas.paste(sw, (x0, y0))
        atlas.save(path, quality=88, optimize=True)
        p['capSkin'] = True
        p['capSkinModel'] = IMAGE_MODEL
        done += 1
        json.dump(meta, open(meta_path, 'w'))        # after every piece: a stopped run loses nothing
        print(f'  p{p["i"]:<3} {(p.get("room") or "-"):<12} {p["capped"]:>4} cap tris skinned '
              f'(crop {100*cover:.0f}% real, {why})', flush=True)
    print(f'skinned {done}/{len(todo)} in {time.time()-t0:.0f}s, {api.calls} image calls')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('model', nargs='?', default=None)
    ap.add_argument('--probe', action='store_true', help='one test image, then exit: checks the key, model and billing')
    ap.add_argument('--force', action='store_true', help='redo pieces already skinned')
    ap.add_argument('--dry', action='store_true', help='report only, call nothing')
    ap.add_argument('--max', type=int, default=None, help='only this many pieces, most cap area first')
    a = ap.parse_args()
    if a.probe:
        sys.exit(probe())
    if not a.model:
        ap.error('model id required (or --probe)')
    run(a.model, force=a.force, dry=a.dry, max_pieces=a.max)
