// A8 (#25): your real hands, cut out of the hand-camera video, instead of a skeleton (like passthrough hands).
// Mask per hand: thick round-capped strokes along the finger bones plus the palm, about one finger wide and
// feathered. That follows the fingers more closely than a convex hull, which would also show the room between spread fingers.
// The camera image is drawn through that mask on a small 2D canvas over the 3D view, once per detection frame.
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

  function maskPath(P, span) {
    ctx.beginPath();
    PALM.forEach((i, k) => (k ? ctx.lineTo(P[i][0], P[i][1]) : ctx.moveTo(P[i][0], P[i][1])));
    ctx.closePath();
    ctx.fill();
    for (const [a, b] of FINGERS) { ctx.moveTo(P[a][0], P[a][1]); ctx.lineTo(P[b][0], P[b][1]); }
    ctx.lineWidth = span * 0.3; // a finger is ~0.2 of wrist-to-knuckle; the rest is margin for tracking lag
    ctx.stroke();
  }

  /**
   * hands: the list from hands.js ({pts: 21 × {x, y} in 0..1 screen units, x, y = pinch point, pinch}).
   * cam: {mirror, crop, span} from hands.js. stereo: draw once per eye (side-by-side headset view).
   */
  function draw(hands, cam, stereo) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, cv.width, cv.height);
    const vw = video.videoWidth || video.width, vh = video.videoHeight || video.height;
    if (!hands.length || !cam || !vw || !vh) return;
    const W = cv.width, H = cv.height;
    for (const [x0, ew] of stereo ? [[0, W / 2], [W / 2, W / 2]] : [[0, W]]) {
      const hs = hands.map((h) => {
        const P = h.pts.map((p) => [x0 + p.x * ew, p.y * H]);
        return { h, P, span: Math.hypot(P[0][0] - P[9][0], P[0][1] - P[9][1]) || 1 };
      });
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, 0, ew, H); ctx.clip(); // keep this eye's compositing inside its half
      // 1) the mask, feathered with a blurred shadow of itself
      ctx.fillStyle = ctx.strokeStyle = ctx.shadowColor = '#fff';
      ctx.lineCap = ctx.lineJoin = 'round';
      for (const { P, span } of hs) { ctx.shadowBlur = span * 0.12; maskPath(P, span); }
      ctx.shadowBlur = 0;
      // 2) the camera image, kept only where the mask is (source-in multiplies by the mask's alpha)
      ctx.globalCompositeOperation = 'source-in';
      if (cam.mirror) { ctx.translate(2 * x0 + ew, 0); ctx.scale(-1, 1); }
      ctx.drawImage(video, cam.crop * vw, cam.crop * vh, cam.span * vw, cam.span * vh, x0, 0, ew, H);
      ctx.restore();
      // 3) a glowing dot between thumb and index while pinching
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
