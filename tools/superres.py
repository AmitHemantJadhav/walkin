#!/usr/bin/env python3
"""Sharpen the sides the scanner did see: learned super-resolution of each piece's atlas.

The MatterPak texture holds about 250-320 texels per metre. That is crisp at two metres and soft at
arm's length, and no filter can add what was not captured - but a super-resolution network can
re-draw a soft photo at twice the size with the edges and grain a photo like it would have, and
unlike an image model it keeps every pixel where it was: the weave stays on the seat, the seam
stays on the edge, nothing is invented that is not local. Real-ESRGAN x2 (Wang et al., 2021), the
plain RRDBNet, run here without the basicsr package (its architecture is sixty lines and the
package does not build on current PyTorch), on Metal if there is one.

Preprocessing only: it rewrites furniture-tex/*.jpg at up to MAX_SIDE a side (texture memory is the
only cost, and phones halve the atlases anyway). Nothing runs at demo time. UVs are normalised so a
uniform rescale leaves them right; the material square's pixel record is rescaled to match.

Order per house: meshdiff export -> superres -> meshsharp -> capskin. It must see the scan's own
texels: run after meshsharp it sharpened meshsharp's borrowed grain into visible strokes, run before
it the wood came out as wood. So it refuses an atlas meshsharp has already touched (re-export), and
meshsharp then keeps its originals at this resolution. Idempotent (`superRes` per piece).

  python tools/superres.py zvKHR9DHNjJ            # all pieces not yet done
  python tools/superres.py zvKHR9DHNjJ --force    # redo
  python tools/superres.py --check                # weights + device, no house
"""
import argparse
import json
import os
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

WEIGHTS_URL = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth'
WEIGHTS = os.path.join(os.path.expanduser('~'), '.cache', 'walkin', 'RealESRGAN_x2plus.pth')
MAX_SIDE = 1600       # px: the atlas after this step is at most this tall or wide
TILE = 256            # px of input per network pass
PAD = 16              # px overlap between tiles, cut away after
FILLER = (150, 145, 140)


def weights():
    if not os.path.exists(WEIGHTS):
        os.makedirs(os.path.dirname(WEIGHTS), exist_ok=True)
        print(f'fetching Real-ESRGAN x2 weights (67 MB) to {WEIGHTS} ...', flush=True)
        urllib.request.urlretrieve(WEIGHTS_URL, WEIGHTS)
    return WEIGHTS


def build(device):
    """RRDBNet as in Real-ESRGAN x2plus: pixel-unshuffle in, 23 RRDBs, two nearest x2 ups."""
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    class RDB(nn.Module):
        def __init__(self, nf=64, gc=32):
            super().__init__()
            self.conv1 = nn.Conv2d(nf, gc, 3, 1, 1)
            self.conv2 = nn.Conv2d(nf + gc, gc, 3, 1, 1)
            self.conv3 = nn.Conv2d(nf + 2 * gc, gc, 3, 1, 1)
            self.conv4 = nn.Conv2d(nf + 3 * gc, gc, 3, 1, 1)
            self.conv5 = nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1)
            self.lrelu = nn.LeakyReLU(0.2, inplace=True)

        def forward(self, x):
            x1 = self.lrelu(self.conv1(x))
            x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
            x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
            x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
            x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
            return x5 * 0.2 + x

    class RRDB(nn.Module):
        def __init__(self, nf=64, gc=32):
            super().__init__()
            self.rdb1, self.rdb2, self.rdb3 = RDB(nf, gc), RDB(nf, gc), RDB(nf, gc)

        def forward(self, x):
            return self.rdb3(self.rdb2(self.rdb1(x))) * 0.2 + x

    class RRDBNet(nn.Module):
        def __init__(self, nf=64, nb=23, gc=32):
            super().__init__()
            self.conv_first = nn.Conv2d(3 * 4, nf, 3, 1, 1)          # x2: pixel-unshuffle gives 12 ch
            self.body = nn.Sequential(*[RRDB(nf, gc) for _ in range(nb)])
            self.conv_body = nn.Conv2d(nf, nf, 3, 1, 1)
            self.conv_up1 = nn.Conv2d(nf, nf, 3, 1, 1)
            self.conv_up2 = nn.Conv2d(nf, nf, 3, 1, 1)
            self.conv_hr = nn.Conv2d(nf, nf, 3, 1, 1)
            self.conv_last = nn.Conv2d(nf, 3, 3, 1, 1)
            self.lrelu = nn.LeakyReLU(0.2, inplace=True)

        def forward(self, x):
            feat = F.pixel_unshuffle(x, 2)
            feat = self.conv_first(feat)
            feat = feat + self.conv_body(self.body(feat))
            feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode='nearest')))
            feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode='nearest')))
            return self.conv_last(self.lrelu(self.conv_hr(feat)))

    net = RRDBNet()
    sd = torch.load(weights(), map_location='cpu', weights_only=True)
    sd = sd.get('params_ema', sd.get('params', sd))
    net.load_state_dict(sd, strict=True)
    return net.eval().to(device)


def device_name():
    import torch
    if torch.backends.mps.is_available():
        return 'mps'
    if torch.cuda.is_available():
        return 'cuda'
    return 'cpu'


def upscale(net, img, device, half=None):
    """img: HxWx3 uint8 -> 2H x 2W x 3 uint8, tiled with overlap so any size fits in memory."""
    import torch
    if half is None:
        half = False          # fp16 measured slower on Metal (3.5 s vs 2.5 s an atlas) and no sharper
    if half is True:
        out = upscale(net.half(), img, device, half='do')
        net.float()
        if np.isfinite(out).all():
            return (out * 255 + 0.5).astype(np.uint8)
        return upscale(net, img, device, half=False)              # fp16 overflowed: redo in fp32
    H, W, _ = img.shape
    dtype = torch.float16 if half == 'do' else torch.float32
    x = torch.from_numpy(np.ascontiguousarray(img)).permute(2, 0, 1).float().div_(255.0).unsqueeze(0).to(dtype)
    out = np.zeros((2 * H, 2 * W, 3), np.float32)
    with torch.no_grad():
        for y in range(0, H, TILE):
            for xx in range(0, W, TILE):
                y0, y1 = max(0, y - PAD), min(H, y + TILE + PAD)
                x0, x1 = max(0, xx - PAD), min(W, xx + TILE + PAD)
                tile = x[:, :, y0:y1, x0:x1].to(device)
                # the net needs even sizes for the unshuffle; pad by reflection, cut after
                ph, pw = (y1 - y0) % 2, (x1 - x0) % 2
                if ph or pw:
                    tile = torch.nn.functional.pad(tile, (0, pw, 0, ph), mode='reflect')
                sr = net(tile).float().clamp_(0, 1)[0].permute(1, 2, 0).cpu().numpy()
                sr = sr[:2 * (y1 - y0), :2 * (x1 - x0)]
                # keep the inner part of the tile (without the overlap) at output scale
                iy0, ix0 = 2 * (y - y0), 2 * (xx - x0)
                iy1, ix1 = iy0 + 2 * min(TILE, H - y), ix0 + 2 * min(TILE, W - xx)
                out[2 * y:2 * y + (iy1 - iy0), 2 * xx:2 * xx + (ix1 - ix0)] = sr[iy0:iy1, ix0:ix1]
    if half == 'do':
        return out                                                # caller checks for NaN first
    return (out * 255 + 0.5).astype(np.uint8)


def run(model, force=False):
    import torch
    base = os.path.join('data', model)
    meta_path = os.path.join(base, 'furniture.json')
    if not os.path.exists(meta_path):
        sys.exit(f'{meta_path} not found: run tools/meshdiff.py export {model} and tools/meshsharp.py {model} first')
    meta = json.load(open(meta_path))
    tex_dir = os.path.join(base, 'furniture-tex')
    if any(p.get('sharpened') for p in meta['pieces']):
        sys.exit('these atlases were already through meshsharp; superres must run before it: '
                 f'python tools/meshdiff.py export {model}, then superres, then meshsharp')
    todo = [p for p in meta['pieces'] if p.get('tex') and (force or not p.get('superRes'))]
    print(f'{model}: {len(todo)} atlases to super-resolve, {len(meta["pieces"]) - len(todo)} already done')
    if not todo:
        return
    dev = device_name()
    net = build(dev)
    print(f'  Real-ESRGAN x2 on {dev}')
    t0 = time.time()
    for p in todo:
        path = os.path.join(tex_dir, p['tex'])
        im = Image.open(path).convert('RGB')
        W, H = im.size
        t1 = time.time()
        sr = upscale(net, np.asarray(im, np.uint8), dev)
        scale = min(2.0, MAX_SIDE / max(W, H))               # never over MAX_SIDE a side
        if scale < 2.0:
            sr = np.asarray(Image.fromarray(sr).resize((max(1, int(round(W * scale))), max(1, int(round(H * scale)))),
                                                      Image.LANCZOS))
        out = Image.fromarray(sr)
        out.save(path, quality=90, optimize=True)
        if p.get('capSquare'):
            x, y, s = p['capSquare']
            p['capSquare'] = [int(round(x * scale)), int(round(y * scale)), int(round(s * scale))]
        p['superRes'] = round(scale, 3)
        json.dump(meta, open(meta_path, 'w'))
        print(f"  p{p['i']:<3} {W}x{H} -> {out.width}x{out.height}  {time.time()-t1:4.1f}s  {p.get('room') or '-'}", flush=True)
    meta['superRes'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    json.dump(meta, open(meta_path, 'w'))
    print(f'done {len(todo)} atlases in {time.time()-t0:.0f}s')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('model', nargs='?')
    ap.add_argument('--force', action='store_true', help='redo atlases already done')
    ap.add_argument('--check', action='store_true', help='weights and device only')
    a = ap.parse_args()
    if a.check:
        import torch
        print('torch', torch.__version__, 'device', device_name(), 'weights', weights())
        build(device_name())
        print('OK: the network loads')
        sys.exit(0)
    if not a.model:
        ap.error('model id required (or --check)')
    run(a.model, force=a.force)
