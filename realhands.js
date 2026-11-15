// A8 (#25): your real hands, cut out of the hand-camera video, instead of a skeleton (like passthrough hands).
// Mask per hand: thick round-capped strokes along the finger bones plus the palm, about one finger wide and
// feathered. That follows the fingers more closely than a convex hull, which would also show the room between spread fingers.
// The camera image is cut out by that mask off-screen (never compositing a <video>: iOS Safari ignores that) and
// drawn on a small 2D canvas over the 3D view, once per detection frame. In the headset (side-by-side) it is drawn
// once per eye.
//
// What it looked like on an iPhone, and what changed:
// - The hand was huge: a hand 30 cm from the phone filled half the screen and hid the piece it was holding. It is now
//   drawn smaller (`scale`, 0.6 by default, ?handscale=0.8 to tune), shrunk around the point between thumb and
//   index tips. That is the point that grabs, so the cut-out still pinches exactly where the cursor is.
// - You could not see what you were holding: while a hand pinches it fades to PINCH_ALPHA.
// - Grey ghost blobs around fast fingers: detection takes 20-50 ms on a phone and the <video> moves on meanwhile,
//   so cutting the live video afterwards put the mask where the hand had been a frame earlier. hands.js now calls
//   snap() right before each detection, and the cut uses that copy. The mask is also a little tighter.
// - Fingers cut off by a straight line: the screen shows only the middle of the camera image, and shrinking the hand
//   pulled the edge of that crop into the view. snap() now copies the whole camera image, and the hand fades out
//   softly at the camera's own edges instead.

const FINGERS = [[1, 2], [2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16], [17, 18], [18, 19], [19, 20]];
const PALM = [0, 1, 2, 5, 9, 13, 17];
const MAX_W = 1280;       // canvas width cap: 720 was visibly soft on an iPhone screen (Amit, in the headset)
const FRAME_W = 640;      // camera copy width: the whole 640 px camera frame, so the hand is as sharp as the camera allows
const TIPS = new Set([4, 8, 12, 16, 20]);
const ALPHA = 0.95;       // a resting hand
const PINCH_ALPHA = 0.7;  // a pinching (holding) hand: the piece shows through a little (0.4 read as the hand vanishing)

export function createRealHands(video, { scale = 0.6, seg = true } = {}) {
  const cv = document.createElement('canvas');
  cv.id = 'realhands';
  // sized in px from innerWidth/innerHeight like the 3D canvas, not 100vw/100vh: on iPhone Safari 100vh is the
  // large viewport (behind the toolbars), which stretched the hand downwards, away from the cursor
  cv.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const size = () => {
    const k = Math.min(1, MAX_W / innerWidth);
    cv.width = Math.round(innerWidth * k);
    cv.height = Math.round(innerHeight * k);
    cv.style.width = innerWidth + 'px';
    cv.style.height = innerHeight + 'px';
  };
  size();
  addEventListener('resize', size);

  // Off-screen buffers, the whole camera image (not just the crop the view shows: a shrunk hand can reach past the
  // crop). iOS Safari ignores globalCompositeOperation when the source is a <video>, so the video is only ever drawn
  // plainly into `frame`; the masking is canvas-to-canvas in `mask`. `edge` fades the hand out at the camera's edges.
  const frame = document.createElement('canvas'), fctx = frame.getContext('2d', { willReadFrequently: true });
  const mask = document.createElement('canvas'), mctx = mask.getContext('2d', { willReadFrequently: true });
  const skin = {}; // per hand: running skin colour model {m: [cb, cr], c: [cbb, cbr, crr]}
  const edge = document.createElement('canvas'), ectx = edge.getContext('2d');
  let fresh = false; // `frame` holds the image the current landmarks were found in

  function buildEdge(w, h) {
    edge.width = w; edge.height = h;
    const m = Math.round(Math.min(w, h) * 0.03);
    ectx.fillStyle = ectx.shadowColor = '#fff';
    ectx.shadowBlur = m;
    ectx.fillRect(m, m, w - 2 * m, h - 2 * m);
  }

  function maskPath(c, P, span, widthK = 0.21, tipK = null) {
    c.beginPath();
    PALM.forEach((i, k) => (k ? c.lineTo(P[i][0], P[i][1]) : c.moveTo(P[i][0], P[i][1])));
    c.closePath();
    c.fill();
    c.beginPath();
    for (const [a, b] of FINGERS) {
      let [x, y] = P[b];
      if (TIPS.has(b)) { // tipK: fraction of the last bone added past the tip (negative: stop short)
        const dx = x - P[a][0], dy = y - P[a][1], L = Math.hypot(dx, dy) || 1;
        const k = tipK == null ? -Math.min(0.04 * span, L * 0.4) / L : tipK;
        x += dx * k; y += dy * k;
      }
      c.moveTo(P[a][0], P[a][1]); c.lineTo(x, y);
    }
    c.lineWidth = span * widthK; // a finger is ~0.2 of wrist-to-knuckle
    c.stroke();
  }

  /** Copy the camera image (mirrored like the view) into `frame`. hands.js calls it right before each detection. */
  function snap(cam) {
    const vw = video.videoWidth || video.width, vh = video.videoHeight || video.height;
    if (!cam || !vw || !vh) return false;
    const fw = Math.min(vw, FRAME_W), fh = Math.max(2, Math.round((vh * fw) / vw));
    if (frame.width !== fw || frame.height !== fh) {
      frame.width = mask.width = fw; frame.height = mask.height = fh;
      buildEdge(fw, fh);
    }
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, fw, fh);
    if (cam.mirror) { fctx.translate(fw, 0); fctx.scale(-1, 1); }
    fctx.drawImage(video, 0, 0, fw, fh);
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    return (fresh = true);
  }

  /**
   * Cut this hand by its own skin colour (after "Lightweight real time hand segmentation leveraging MediaPipe
   * landmark detection", 2023): a thin skeleton of the landmarks is surely hand, so its pixels give the skin colour
   * (mean and covariance of Cb/Cr, kept as a running average per hand). Around it, a generous band (wider strokes,
   * fingertips extended) is "maybe hand", and a band pixel is kept when its colour is close to that skin
   * (Mahalanobis distance), with a soft ramp so the edge follows the real outline instead of a blurred guess.
   * Runs on the CPU, only inside the hand's box. Leaves the cut-out in `mask`; false when it can't (then the
   * landmark-only mask is used).
   */
  function segment(h, P, span, fw, fh) {
    const pad = span * 0.45;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of P) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(fw, Math.ceil(x1 + pad)); y1 = Math.min(fh, Math.ceil(y1 + pad));
    const bw = x1 - x0, bh = y1 - y0;
    if (bw < 8 || bh < 8) return false;
    const draw = (widthK, tipK) => {
      mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.globalCompositeOperation = 'source-over';
      mctx.clearRect(x0, y0, bw, bh); mctx.shadowBlur = 0;
      mctx.fillStyle = mctx.strokeStyle = '#fff'; mctx.lineCap = mctx.lineJoin = 'round';
      maskPath(mctx, P, span, widthK, tipK);
      return mctx.getImageData(x0, y0, bw, bh).data;
    };
    const core = draw(0.1, -0.15), band = draw(0.36, 0.35);
    const img = fctx.getImageData(x0, y0, bw, bh), px = img.data, n = bw * bh;
    const CB = (r, g, b) => 128 - 0.1687 * r - 0.3313 * g + 0.5 * b, CR = (r, g, b) => 128 + 0.5 * r - 0.4187 * g - 0.0813 * b;
    // skin model from the skeleton pixels
    let k = 0, sb = 0, sr = 0, sbb = 0, sbr = 0, srr = 0;
    for (let i = 0; i < n; i += 3) {
      if (core[i * 4 + 3] < 128) continue;
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], y = 0.299 * r + 0.587 * g + 0.114 * b;
      if (y < 25 || y > 245) continue; // too dark or blown out to say anything about colour
      const cb = CB(r, g, b), cr = CR(r, g, b);
      k++; sb += cb; sr += cr; sbb += cb * cb; sbr += cb * cr; srr += cr * cr;
    }
    if (k < 30) return false;
    const mb = sb / k, mr = sr / k, cbb = sbb / k - mb * mb + 6, cbr = sbr / k - mb * mr, crr = srr / k - mr * mr + 6;
    const M = skin[h.side] || (skin[h.side] = { m: [mb, mr], c: [cbb, cbr, crr] });
    const a = 0.3; // running average: steadier colour, still adapts to the light
    M.m[0] += a * (mb - M.m[0]); M.m[1] += a * (mr - M.m[1]);
    M.c[0] += a * (cbb - M.c[0]); M.c[1] += a * (cbr - M.c[1]); M.c[2] += a * (crr - M.c[2]);
    const det = M.c[0] * M.c[2] - M.c[1] * M.c[1];
    if (!(det > 1e-6)) return false;
    const i00 = M.c[2] / det, i01 = -M.c[1] / det, i11 = M.c[0] / det;
    const T1 = 6, T2 = 16; // squared distance: <= T1 skin, >= T2 not skin, a soft ramp between
    const al = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) {
      if (band[i * 4 + 3] < 128) continue;
      if (core[i * 4 + 3] >= 128) { al[i] = 255; continue; }
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      const db = CB(r, g, b) - M.m[0], dr = CR(r, g, b) - M.m[1];
      const d2 = db * (i00 * db + i01 * dr) + dr * (i01 * db + i11 * dr);
      al[i] = d2 <= T1 ? 255 : d2 >= T2 ? 0 : (255 * (T2 - d2)) / (T2 - T1);
    }
    // a 3×3 box filter: anti-aliased edge, lone specks of skin-coloured background fade out
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let sum = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= bh) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= bw) continue; sum += al[yy * bw + xx]; c++; }
        }
        px[(y * bw + x) * 4 + 3] = sum / c;
      }
    }
    mctx.clearRect(0, 0, fw, fh);
    mctx.putImageData(img, x0, y0);
    return true;
  }

  /**
   * hands: the list from hands.js ({pts: 21 × {x, y} in 0..1 screen units, x, y = pinch point, pinch}).
   * cam: {mirror, cx, cy, sx, sy} from hands.js (the camera rectangle the view shows, in 0..1 image units).
   * stereo: draw once per eye (side-by-side headset view).
   */
  function draw(hands, cam, stereo) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const had = fresh;
    fresh = false;
    if (!hands.length || !cam) return;
    if (!had && !snap(cam)) return; // no copy from hands.js for this detection: the live frame is close enough
    fresh = false;
    const W = cv.width, H = cv.height, ew = stereo ? W / 2 : W;
    // frame px -> eye px (before shrinking): the crop cam.{cx, cy, sx, sy} of the frame fills the eye
    const fw = frame.width, fh = frame.height;
    const kx = ew / (fw * cam.sx), ky = H / (fh * cam.sy), ox = (-ew * cam.cx) / cam.sx, oy = (-H * cam.cy) / cam.sy;

    for (const h of hands) {
      const P = h.pts.map((p) => [(cam.cx + p.x * cam.sx) * fw, (cam.cy + p.y * cam.sy) * fh]);
      const span = Math.hypot(P[0][0] - P[9][0], P[0][1] - P[9][1]) || 1;
      // 1) this hand cut out by its skin colour; if that can't run, the landmark mask feathered with a blurred
      //    shadow of itself, and the camera kept inside it
      if (seg && segment(h, P, span, fw, fh)) {
        mctx.globalCompositeOperation = 'destination-in';
        mctx.drawImage(edge, 0, 0);
        mctx.globalCompositeOperation = 'source-over';
      } else {
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.globalCompositeOperation = 'source-over';
      mctx.clearRect(0, 0, fw, fh);
      mctx.fillStyle = mctx.strokeStyle = mctx.shadowColor = '#fff';
      mctx.lineCap = mctx.lineJoin = 'round';
      mctx.shadowBlur = span * 0.05;
      maskPath(mctx, P, span);
      mctx.shadowBlur = 0;
      mctx.globalCompositeOperation = 'source-in';
      mctx.drawImage(frame, 0, 0);
      mctx.globalCompositeOperation = 'destination-in';
      mctx.drawImage(edge, 0, 0);
      mctx.globalCompositeOperation = 'source-over';
      }

      // 2) into each eye, shrunk by `scale` around the point between thumb and index tips
      const ax = (P[4][0] + P[8][0]) / 2, ay = (P[4][1] + P[8][1]) / 2;
      const sc = scale / (cam.gain || 1); // reach magnifies the camera by gain: draw the hand back at its real size
      ctx.globalAlpha = h.pinch ? PINCH_ALPHA : ALPHA;
      for (const x0 of stereo ? [0, W / 2] : [0]) {
        // frame px q -> eye px e = x0 + ox + kx q, then shrunk about the anchor A: A + scale (e - A).
        // Clipped to this eye: the whole camera image is bigger than the eye.
        const Ax = x0 + ox + kx * ax, Ay = oy + ky * ay;
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, 0, ew, H); ctx.clip();
        ctx.setTransform(sc * kx, 0, 0, sc * ky, Ax * (1 - sc) + sc * (x0 + ox), Ay * (1 - sc) + sc * oy);
        ctx.drawImage(mask, 0, 0);
        ctx.restore();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;

      // 3) a glowing dot between thumb and index while pinching (the smoothed pinch point that grabs)
      if (!h.pinch) continue;
      for (const x0 of stereo ? [0, W / 2] : [0]) {
        const cx = x0 + h.x * ew, cy = h.y * H, r = Math.max(5, span * kx * sc * 0.2);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, 'rgba(255,240,170,1)');
        g.addColorStop(0.35, 'rgba(255,196,0,.9)');
        g.addColorStop(1, 'rgba(255,196,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  return {
    draw, snap, canvas: cv,
    clear: () => draw([], null, false),
    get scale() { return scale; },
    setScale(s) { scale = Math.min(1, Math.max(0.3, Number(s) || 0.6)); },
  };
}
