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

const FINGERS = [[1, 2], [2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16], [17, 18], [18, 19], [19, 20]];
const PALM = [0, 1, 2, 5, 9, 13, 17];
const MAX_W = 720;        // canvas width cap: the camera crop is only ~450-580 px wide, more pixels only cost fill rate
const ALPHA = 0.95;       // a resting hand
const PINCH_ALPHA = 0.4;  // a pinching (holding) hand: the piece in your fingers shows through

export function createRealHands(video, { scale = 0.6 } = {}) {
  const cv = document.createElement('canvas');
  cv.id = 'realhands';
  cv.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const size = () => {
    const k = Math.min(1, MAX_W / innerWidth);
    cv.width = Math.round(innerWidth * k);
    cv.height = Math.round(innerHeight * k);
  };
  size();
  addEventListener('resize', size);

  // Off-screen buffers at camera-crop resolution. iOS Safari ignores globalCompositeOperation when the source is a
  // <video>, so the video is only ever drawn plainly into `frame`; the masking is canvas-to-canvas in `mask`.
  const frame = document.createElement('canvas'), fctx = frame.getContext('2d');
  const mask = document.createElement('canvas'), mctx = mask.getContext('2d');
  let fresh = false; // `frame` holds the image the current landmarks were found in

  function maskPath(c, P, span) {
    c.beginPath();
    PALM.forEach((i, k) => (k ? c.lineTo(P[i][0], P[i][1]) : c.moveTo(P[i][0], P[i][1])));
    c.closePath();
    c.fill();
    c.beginPath();
    for (const [a, b] of FINGERS) { c.moveTo(P[a][0], P[a][1]); c.lineTo(P[b][0], P[b][1]); }
    // a finger is ~0.2 of wrist-to-knuckle; the round caps already reach ~1 cm past the tip landmarks
    c.lineWidth = span * 0.21;
    c.stroke();
  }

  /** Copy the camera crop (cam from hands.js) into `frame`. hands.js calls it right before each detection. */
  function snap(cam) {
    const vw = video.videoWidth || video.width, vh = video.videoHeight || video.height;
    if (!cam || !vw || !vh) return false;
    const fw = Math.max(2, Math.round(cam.sx * vw)), fh = Math.max(2, Math.round(cam.sy * vh));
    if (frame.width !== fw || frame.height !== fh) { frame.width = mask.width = fw; frame.height = mask.height = fh; }
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, fw, fh);
    if (cam.mirror) { fctx.translate(fw, 0); fctx.scale(-1, 1); }
    fctx.drawImage(video, cam.cx * vw, cam.cy * vh, cam.sx * vw, cam.sy * vh, 0, 0, fw, fh);
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    return (fresh = true);
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
    const fw = frame.width, fh = frame.height, kx = ew / fw, ky = H / fh; // frame px -> eye px

    for (const h of hands) {
      const P = h.pts.map((p) => [p.x * fw, p.y * fh]);
      const span = Math.hypot(P[0][0] - P[9][0], P[0][1] - P[9][1]) || 1;
      // 1) this hand's mask, feathered with a blurred shadow of itself, then the camera kept inside it
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
      mctx.globalCompositeOperation = 'source-over';

      // 2) into each eye, shrunk by `scale` around the point between thumb and index tips
      const ax = (P[4][0] + P[8][0]) / 2, ay = (P[4][1] + P[8][1]) / 2;
      ctx.globalAlpha = h.pinch ? PINCH_ALPHA : ALPHA;
      for (const x0 of stereo ? [0, W / 2] : [0]) {
        // frame px p -> eye px e = x0 + kx p; scaled about the anchor A: A + scale (e - A)
        ctx.setTransform(scale * kx, 0, 0, scale * ky, x0 + kx * ax * (1 - scale), ky * ay * (1 - scale));
        ctx.drawImage(mask, 0, 0);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;

      // 3) a glowing dot between thumb and index while pinching (the smoothed pinch point that grabs)
      if (!h.pinch) continue;
      for (const x0 of stereo ? [0, W / 2] : [0]) {
        const cx = x0 + h.x * ew, cy = h.y * H, r = Math.max(5, span * kx * scale * 0.2);
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
