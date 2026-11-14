// A8 (#25): your real hands, cut out of the hand-camera video, instead of a skeleton (like passthrough hands).
// Mask per hand: thick round-capped strokes along the finger bones plus the palm, about one finger wide and
// feathered. That follows the fingers more closely than a convex hull, which would also show the room between spread fingers.
// The camera image is cut out by that mask off-screen (never compositing a <video>: iOS Safari ignores that) and
// drawn on a small 2D canvas over the 3D view, once per detection frame.
// It uses the same crop and mirror as hands.js, so the pixels sit on the landmarks that drive pinch and grab.
// In the headset (side-by-side) it is drawn once per eye.

const FINGERS = [[1, 2], [2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16], [17, 18], [18, 19], [19, 20]];
const PALM = [0, 1, 2, 5, 9, 13, 17];
const MAX_W = 720; // canvas width cap: the camera crop is only ~450 px wide, more pixels would only cost fill rate

export function createRealHands(video) {
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

  // Off-screen buffers, one eye in size. iOS Safari ignores globalCompositeOperation when the source is a <video>
  // (it paints the whole camera frame, so the house vanished behind it the moment a hand appeared). So the video is
  // only ever drawn plainly into `frame`, and all the masking is canvas-to-canvas, which every browser composites.
  // Both eyes show the same hand, so it is built once and drawn twice in the headset.
  const frame = document.createElement('canvas'), fctx = frame.getContext('2d');
  const mask = document.createElement('canvas'), mctx = mask.getContext('2d');
  const TIPS = [[3, 4], [7, 8], [11, 12], [15, 16], [19, 20]];

  function maskPath(c, P, span) {
    c.beginPath();
    PALM.forEach((i, k) => (k ? c.lineTo(P[i][0], P[i][1]) : c.moveTo(P[i][0], P[i][1])));
    c.closePath();
    c.fill();
    c.beginPath();
    for (const [a, b] of FINGERS) { c.moveTo(P[a][0], P[a][1]); c.lineTo(P[b][0], P[b][1]); }
    for (const [a, b] of TIPS) {           // a little past the tip landmark, so fingertips aren't clipped
      const dx = P[b][0] - P[a][0], dy = P[b][1] - P[a][1], L = Math.hypot(dx, dy) || 1;
      c.moveTo(P[b][0], P[b][1]); c.lineTo(P[b][0] + (dx / L) * span * 0.05, P[b][1] + (dy / L) * span * 0.05);
    }
    c.lineWidth = span * 0.24; // a finger is ~0.2 of wrist-to-knuckle; a little margin for tracking lag, not a halo
    c.stroke();
  }

  /**
   * hands: the list from hands.js ({pts: 21 × {x, y} in 0..1 screen units, x, y = pinch point, pinch}).
   * cam: {mirror, cx, cy, sx, sy} from hands.js (the camera rectangle the view shows, in 0..1 image units).
   * stereo: draw once per eye (side-by-side headset view).
   */
  function draw(hands, cam, stereo) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, cv.width, cv.height);
    const vw = video.videoWidth || video.width, vh = video.videoHeight || video.height;
    if (!hands.length || !cam || !vw || !vh) return;
    const W = cv.width, H = cv.height, ew = stereo ? W / 2 : W;
    const iw = Math.max(1, Math.round(ew)), ih = Math.max(1, Math.round(H));
    if (frame.width !== iw || frame.height !== ih) { frame.width = mask.width = iw; frame.height = mask.height = ih; }

    // 1) the camera crop for one eye: the only place a video is drawn, plainly
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.globalCompositeOperation = 'source-over';
    fctx.clearRect(0, 0, iw, ih);
    if (cam.mirror) { fctx.translate(iw, 0); fctx.scale(-1, 1); }
    fctx.drawImage(video, cam.cx * vw, cam.cy * vh, cam.sx * vw, cam.sy * vh, 0, 0, iw, ih);
    fctx.setTransform(1, 0, 0, 1, 0, 0);

    // 2) the hand mask, feathered with a blurred shadow of itself
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.globalCompositeOperation = 'source-over';
    mctx.clearRect(0, 0, iw, ih);
    mctx.fillStyle = mctx.strokeStyle = mctx.shadowColor = '#fff';
    mctx.lineCap = mctx.lineJoin = 'round';
    const hs = hands.map((h) => {
      const P = h.pts.map((p) => [p.x * iw, p.y * ih]);
      return { h, P, span: Math.hypot(P[0][0] - P[9][0], P[0][1] - P[9][1]) || 1 };
    });
    for (const { P, span } of hs) { mctx.shadowBlur = span * 0.06; maskPath(mctx, P, span); }
    mctx.shadowBlur = 0;

    // 3) keep the camera only where the hand is (canvas-to-canvas)
    fctx.globalCompositeOperation = 'destination-in';
    fctx.drawImage(mask, 0, 0);
    fctx.globalCompositeOperation = 'source-over';

    // 4) the cut-out hand into each eye, and a glowing dot between thumb and index while pinching
    for (const x0 of stereo ? [0, W / 2] : [0]) {
      ctx.drawImage(frame, x0, 0, ew, H);
      for (const { h, span } of hs) {
        if (!h.pinch) continue;
        const cx = x0 + h.x * ew, cy = h.y * H, r = Math.max(6, span * 0.16);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, 'rgba(255,240,170,1)');
        g.addColorStop(0.35, 'rgba(255,196,0,.9)');
        g.addColorStop(1, 'rgba(255,196,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  return { draw, clear: () => draw([], null, false), canvas: cv };
}
