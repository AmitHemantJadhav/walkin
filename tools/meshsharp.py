#!/usr/bin/env python3
"""Give the sides the scanner never saw the texture of the sides it did.

A MatterPak texture is sharp where a camera looked straight at a surface and a smear where it did
not: the back of a sofa against a wall, the underside of a table, the far side of a piano. In place
that never shows, because the photo behind the piece is the piece. Move or turn it and the smear is
the first thing you see - the user's "it blurs out when I move it".

No model invents anything here. Every piece carries its own material on the sides that were seen,
so the smeared texels borrow it: for each smeared patch of the atlas, keep its own low frequencies
(its shading, its colour) and add the fine grain of a sharp patch of the same piece in the same
colour. The back of the sofa becomes the sofa's fabric with the back's shading; it was always the
right colour, it just had no weave.

Only the *fine* band is borrowed (about 1-3 px, a weave or a wood grain at the atlases' ~250 px/m),
and only from donors whose detail is mostly in that band: a tufting seam or a cushion edge has
energy at every scale and would paste as a stripe, a weave has it in the fine band alone. The first
version borrowed the whole high-pass from any sharp block and the sofa came out scratched.

Order per house: meshdiff export -> superres (optional) -> meshsharp -> capskin (optional).
Runs on the atlases tools/meshdiff.py (and superres) wrote, in place, and keeps the originals once in
furniture-tex-orig/ so a run can be compared or undone. Idempotent: an atlas already marked done in
furniture.json is skipped unless --force.

  python tools/meshsharp.py zvKHR9DHNjJ            # sharpen one house
  python tools/meshsharp.py zvKHR9DHNjJ --report   # numbers only, write nothing
"""
import argparse
import json
import os
import shutil
import sys
import time

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, binary_dilation, uniform_filter, label as cc_label

FILLER = np.array([150, 145, 140], np.float32)   # meshdiff's atlas background: not a texel
BLOCK = 16          # px: about 6 cm at ~250 px/m, a few weave cycles
STRIDE = 8          # half-block overlap, blended with a raised-cosine window
FINE = (0.7, 1.8)   # px: the band that is weave and grain
COARSE = (1.8, 4.5) # px: the band that is seams and edges
E_SIGMA = 5.0       # px: the window detail energy is measured over
SMEAR = 0.35        # a texel is smeared when its fine energy is under this fraction of the sharp median
CANDIDATES = 400    # texture-like sharp blocks to choose a donor from (nearest colour)
GAIN_MAX = 1.0      # never amplify a donor's grain


def texels(img):
    """Which pixels are the piece and which are meshdiff's filler.

    Not by colour alone: the filler is (150, 145, 140) and so, near enough, is a grey sofa. The
    filler is the flat background the islands sit in, so it is the colour-matching pixels that are
    also flat *and* connected to the image border; a grey cushion in the middle of an island is
    neither.
    """
    H, W, _ = img.shape
    near = (np.abs(img - FILLER).max(axis=-1) <= 5)
    mean = np.stack([uniform_filter(img[..., c], 3) for c in range(3)], axis=-1)
    sq = np.stack([uniform_filter(img[..., c] ** 2, 3) for c in range(3)], axis=-1)
    flat = np.sqrt(np.maximum(sq - mean ** 2, 0)).max(axis=-1) < 3.0
    cand = near & flat
    lab, n = cc_label(cand)
    if n == 0:
        return np.ones((H, W), bool)
    border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    border = border[border > 0]
    filler = np.isin(lab, border)
    filler = binary_dilation(filler, iterations=1)       # the seam pixel the filler bleeds into
    return ~filler


def _band(img, s0, s1):
    a = np.stack([gaussian_filter(img[..., c], s0) for c in range(3)], axis=-1)
    b = np.stack([gaussian_filter(img[..., c], s1) for c in range(3)], axis=-1)
    return a - b, b


def _window(n):
    w = 0.5 - 0.5 * np.cos(2 * np.pi * (np.arange(n) + 0.5) / n)
    return np.outer(w, w)


def sharpen(img, report_only=False):
    """img: HxWx3 float32 in 0..255. Returns (out, stats)."""
    H, W, _ = img.shape
    valid = texels(img)
    fine, _ = _band(img, *FINE)
    coarse, low = _band(img, *COARSE)        # low = everything slower than the coarse band
    e_fine = np.sqrt(gaussian_filter((fine ** 2).sum(axis=-1), E_SIGMA))
    e_coarse = np.sqrt(gaussian_filter((coarse ** 2).sum(axis=-1), E_SIGMA))
    ev = e_fine[valid]
    if ev.size < BLOCK * BLOCK * 4:
        return img, dict(valid=int(valid.sum()), smear=0.0, blocks=0, donors=0)
    sharp_med = float(np.median(ev[ev >= np.percentile(ev, 50)]))
    smear = valid & (e_fine < SMEAR * sharp_med)
    smear_frac = float(smear.sum()) / max(1, int(valid.sum()))
    stats = dict(valid=int(valid.sum()), smear=round(smear_frac, 3), sharpMed=round(sharp_med, 2),
                 blocks=0, donors=0)
    if report_only or smear_frac < 0.01:
        return img, stats

    ys = np.arange(0, H - BLOCK + 1, STRIDE)
    xs = np.arange(0, W - BLOCK + 1, STRIDE)
    c0 = BLOCK // 2
    vsum = uniform_filter(valid.astype(np.float32), BLOCK, mode='constant')
    fsum = uniform_filter(e_fine, BLOCK, mode='constant')
    csum = uniform_filter(e_coarse, BLOCK, mode='constant')
    ssum = uniform_filter(smear.astype(np.float32), BLOCK, mode='constant')
    # donors: wholly valid, clearly sharp, and texture-like (fine band at least as strong as coarse)
    cand = []
    for y in ys:
        for x in xs:
            yy, xx = y + c0, x + c0
            if vsum[yy, xx] > 0.999 and fsum[yy, xx] > 0.9 * sharp_med and fsum[yy, xx] > 1.0 * csum[yy, xx]:
                cand.append((fsum[yy, xx] / max(csum[yy, xx], 1e-3), y, x))
    if not cand:
        return img, stats
    cand.sort(reverse=True)                  # the most weave-like first
    cand = cand[:CANDIDATES]
    d_yx = np.array([(y, x) for _, y, x in cand])
    d_col = np.stack([low[y:y + BLOCK, x:x + BLOCK].reshape(-1, 3).mean(axis=0) for _, y, x in cand])
    d_e = np.array([e_fine[y:y + BLOCK, x:x + BLOCK].mean() for _, y, x in cand])
    stats['donors'] = len(cand)

    acc = np.zeros((H, W, 3), np.float32)
    wacc = np.zeros((H, W), np.float32)
    win = _window(BLOCK)
    rng = np.random.default_rng(7)
    n_blocks = 0
    for y in ys:
        for x in xs:
            if ssum[y + c0, x + c0] < 0.15:          # under 15% smeared: leave the block alone
                continue
            col = low[y:y + BLOCK, x:x + BLOCK].reshape(-1, 3).mean(axis=0)
            dist = ((d_col - col) ** 2).sum(axis=1)
            # one of the three nearest in colour, at random, so a run of blocks does not tile one donor
            near = np.argsort(dist)[:3]
            k = int(near[rng.integers(len(near))])
            dy, dx = d_yx[k]
            grain = fine[dy:dy + BLOCK, dx:dx + BLOCK]
            if rng.random() < 0.5:
                grain = grain[::-1]                  # flip half of them: no visible repeat
            if rng.random() < 0.5:
                grain = grain[:, ::-1]
            gain = min(GAIN_MAX, 0.8 * sharp_med / max(d_e[k], 1e-3))
            gain *= float(np.clip((col.mean() + 40) / (d_col[k].mean() + 40), 0.5, 1.2))
            m = gaussian_filter(smear[y:y + BLOCK, x:x + BLOCK].astype(np.float32), 1.5)
            patch = img[y:y + BLOCK, x:x + BLOCK] + grain * gain
            acc[y:y + BLOCK, x:x + BLOCK] += patch * (win * m)[..., None]
            wacc[y:y + BLOCK, x:x + BLOCK] += win * m
            n_blocks += 1
    stats['blocks'] = n_blocks
    got = wacc > 1e-3
    blend = np.clip(wacc, 0, 1)[..., None]
    mixed = np.where(got[..., None], acc / np.maximum(wacc, 1e-3)[..., None], img)
    out = img * (1 - blend) + mixed * blend
    # a light unsharp mask over every real texel: the JPEG softened what the scanner did see
    usm_low = np.stack([gaussian_filter(out[..., c], 1.0) for c in range(3)], axis=-1)
    usm = out + 0.3 * (out - usm_low)
    out = np.where(valid[..., None], usm, out)
    return np.clip(out, 0, 255), stats


TILE = 512          # px: the square of the piece's own material a cap is textured with
TILE_SRC = 96       # px: the donor window the square is mirror-tiled from (seamless by construction)


def material_tile(img, valid, size=TILE, src=TILE_SRC):
    """A seamless square of this piece's own dominant material, or None if it has no clean patch."""
    H, W, _ = img.shape
    if H < src or W < src:
        return None
    fine, _ = _band(img, *FINE)
    coarse, low = _band(img, *COARSE)
    e_fine = np.sqrt(gaussian_filter((fine ** 2).sum(axis=-1), E_SIGMA))
    e_coarse = np.sqrt(gaussian_filter((coarse ** 2).sum(axis=-1), E_SIGMA))
    vsum = uniform_filter(valid.astype(np.float32), src, mode='constant')
    fsum = uniform_filter(e_fine, src, mode='constant')
    csum = uniform_filter(e_coarse, src, mode='constant')
    med_col = np.median(img[valid].reshape(-1, 3), axis=0)
    # mean colour of each window, and how far it is from the piece's median colour
    msum = np.stack([uniform_filter(img[..., c], src, mode='constant') for c in range(3)], axis=-1)
    # how uniform the window is in colour: a window across two islands (dark fabric, light wall) is
    # valid everywhere and useless as a tile
    sq = np.stack([uniform_filter(low[..., c] ** 2, src, mode='constant') for c in range(3)], axis=-1)
    lmean = np.stack([uniform_filter(low[..., c], src, mode='constant') for c in range(3)], axis=-1)
    lstd = np.sqrt(np.maximum(sq - lmean ** 2, 0)).sum(axis=-1)
    c0 = src // 2
    ys = np.arange(c0, H - c0, 8)
    xs = np.arange(c0, W - c0, 8)
    ev = e_fine[valid]
    sharp_med = float(np.median(ev[ev >= np.percentile(ev, 50)])) if ev.size else 0.0
    best, best_score = None, -1e9
    for y in ys:
        for x in xs:
            if vsum[y, x] < 0.999 or lstd[y, x] > 75 or fsum[y, x] < 0.6 * sharp_med:
                continue
            # the *plainest* patch that still has grain: the least seams and edges, the least shading,
            # the piece's usual colour. The first version scored texture-likeness and chose a window
            # of tufted cushions, which mirror-tiled into a kaleidoscope.
            score = -3.0 * csum[y, x] - 0.5 * lstd[y, x] - 0.05 * np.abs(msum[y, x] - med_col).sum()
            if score > best_score:
                best_score, best = score, (y - c0, x - c0)
    if best is None:
        return None
    y, x = best
    win = img[y:y + src, x:x + src]
    # take the window's grain, flatten its shading to the window mean so the tile does not carry one
    # patch's light, and mirror-tile it: every seam is a reflection, so there is none
    grain = win - np.stack([gaussian_filter(win[..., c], 20.0) for c in range(3)], axis=-1)
    flat = np.clip(win.reshape(-1, 3).mean(axis=0) + grain, 0, 255)
    row = np.concatenate([flat, flat[:, ::-1]], axis=1)
    quad = np.concatenate([row, row[::-1]], axis=0)                      # 2x2, seamless
    reps = int(np.ceil(size / quad.shape[0]))
    tile = np.tile(quad, (reps, reps, 1))[:size, :size]
    return tile


def cap_uvs(pos, faces, L):
    """Planar UVs in 0..1 for cap vertices: each vertex projected on the two axes its faces lie in,
    L metres across the whole tile, so nothing wraps inside a triangle."""
    n = len(pos)
    axis_votes = np.zeros((n, 3))
    a, b, c = pos[faces[:, 0]], pos[faces[:, 1]], pos[faces[:, 2]]
    nrm = np.abs(np.cross(b - a, c - a))
    for k in range(3):
        np.add.at(axis_votes, faces[:, k], nrm)
    drop = axis_votes.argmax(axis=1)                    # the axis the vertex's faces are flattest in
    uv = np.zeros((n, 2), np.float32)
    lo = pos.min(axis=0)
    for v in range(n):
        keep = [i for i in range(3) if i != drop[v]]
        uv[v] = ((pos[v, keep[0]] - lo[keep[0]]) / L, (pos[v, keep[1]] - lo[keep[1]]) / L)
    return np.clip(uv, 0, 1)


def tile_caps(model, meta, base, rewritten=()):
    """Give every piece's caps a square of its own material, appended to its atlas.

    tools/meshclose.py caps a missing side with new vertices whose UV lands on one representative
    pixel: a flat colour, which is a flat back. tools/capskin.py asked Gemini for a material instead,
    two images a minute. This does it from the piece itself: the cleanest patch of its own texture,
    mirror-tiled into a seamless square at the atlas's own scale, and the caps mapped onto it in
    metres. The sofa's back is the sofa's fabric; the piano's back is its own wood.
    """
    bin_path = os.path.join(base, 'furniture.bin')
    buf = bytearray(open(bin_path, 'rb').read())
    tex_dir = os.path.join(base, 'furniture-tex')
    n_done = 0
    for p in meta['pieces']:
        if not p.get('tex') or not p.get('capped'):
            continue
        again = bool(p.get('capTile'))                   # a rerun: the UVs are already in place
        if again and p['tex'] not in rewritten:
            continue                                     # atlas untouched this run: it still has its square
        path = os.path.join(tex_dir, p['tex'])
        img = np.asarray(Image.open(path).convert('RGB'), np.float32)
        H, W, _ = img.shape
        if W < TILE:
            continue                                     # a tiny ornament: not worth a 512 square
        tile = material_tile(img, texels(img))
        if tile is None:
            continue
        # the square goes under the atlas; every existing UV moves up to make room
        H2 = H + TILE
        out = np.empty((H2, W, 3), np.float32)
        out[:H] = img
        out[H:] = FILLER
        out[H:H + TILE, :TILE] = tile
        nv = p['verts']
        uv = np.frombuffer(buf, np.float32, nv * 2, p['uv'][0]).reshape(-1, 2).copy()
        if not again:
            uv[:, 1] = 1 - (1 - uv[:, 1]) * (H / H2)             # v = 1 is the top row, unchanged
        pos = np.frombuffer(buf, np.float32, nv * 3, p['pos'][0]).reshape(-1, 3)
        idx = np.frombuffer(buf, np.uint32, p['tris'] * 3, p['idx'][0]).reshape(-1, 3)
        cap_faces = idx[len(idx) - p['capped']:].astype(np.int64)
        cap_v0 = nv - p['capVerts']
        cap_pos = pos[cap_v0:]
        L = max(float(np.ptp(cap_pos, axis=0).max()), 0.5)
        cuv = cap_uvs(cap_pos, cap_faces - cap_v0, L)
        # into the square: u over its TILE columns, v over its TILE rows at the bottom of the image
        if not again:
            uv[cap_v0:, 0] = cuv[:, 0] * (TILE / W)
            uv[cap_v0:, 1] = cuv[:, 1] * (TILE / H2)
            buf[p['uv'][0]:p['uv'][0] + nv * 8] = uv.astype(np.float32).tobytes()
        Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(path, quality=88, optimize=True)
        p['capTile'] = True
        p['capTileM'] = round(L, 2)
        p['capSquare'] = [0, H2 - TILE, TILE]               # x, y, size of the material square
        p['capSkin'] = False                                 # a fresh square: capskin has not seen it
        n_done += 1
        print(f"p{p['i']:<3} caps on their own material: {p['capped']} faces over {L:.1f} m, atlas now {W}x{H2}")
    if n_done:
        open(bin_path, 'wb').write(buf)
    return n_done


def run(model, force=False, report=False):
    base = os.path.join('data', model)
    meta_path = os.path.join(base, 'furniture.json')
    if not os.path.exists(meta_path):
        sys.exit(f'{meta_path} not found: run tools/meshdiff.py {model} --export first')
    meta = json.load(open(meta_path))
    tex_dir = os.path.join(base, 'furniture-tex')
    orig_dir = os.path.join(base, 'furniture-tex-orig')
    stamp = os.path.join(orig_dir, 'built.txt')
    if not report:
        if os.path.isdir(orig_dir) and (not os.path.exists(stamp) or open(stamp).read() != meta.get('built', '')):
            shutil.rmtree(orig_dir)                      # the originals of an older export
        os.makedirs(orig_dir, exist_ok=True)
        open(stamp, 'w').write(meta.get('built', ''))
    t0 = time.time()
    done = 0
    rewritten = set()
    for p in meta['pieces']:
        if not p.get('tex'):
            continue
        if p.get('sharpened') and not force and not report:
            continue
        src = os.path.join(orig_dir, p['tex'])
        cur = os.path.join(tex_dir, p['tex'])
        if not report and not os.path.exists(src):
            shutil.copyfile(cur, src)            # keep the scanner's own once
        im = Image.open(src if os.path.exists(src) else cur).convert('RGB')
        img = np.asarray(im, np.float32)
        out, st = sharpen(img, report_only=report)
        print(f"p{p['i']:<3} {im.width}x{im.height}  smeared {100*st['smear']:5.1f}%  "
              f"blocks {st['blocks']:4d}  donors {st['donors']:3d}  {p.get('room') or '-'}")
        if report:
            continue
        Image.fromarray(out.astype(np.uint8)).save(cur, quality=88, optimize=True)
        rewritten.add(p['tex'])
        p['sharpened'] = True
        p['capSkin'] = False                         # its square (if any) is rebuilt below
        p['smear'] = st['smear']
        done += 1
    if not report:
        tiles = tile_caps(model, meta, base, rewritten)
        meta['sharpened'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        json.dump(meta, open(meta_path, 'w'))
        print(f'sharpened {done} atlases, {tiles} with their caps on their own material, '
              f'in {time.time()-t0:.1f}s; originals in {orig_dir}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('model')
    ap.add_argument('--force', action='store_true', help='redo atlases already marked sharpened')
    ap.add_argument('--report', action='store_true', help='measure only, write nothing')
    a = ap.parse_args()
    run(a.model, force=a.force, report=a.report)
