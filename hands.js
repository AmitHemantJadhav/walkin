// Hand tracking with MediaPipe (up to two hands). For each hand it reports the 21 landmarks mapped to the screen
// (0..1), a hand-size measure for depth, the pinch point, and whether that hand is pinching.
// Local copies first (vendor/mediapipe, byte-identical to the CDN, see its README) so hands work without venue
// Wi-Fi reaching jsdelivr / googleapis; the CDN only if a local file is missing or fails to load.
const VER = '0.10.14';
const LOCAL = {
  lib: new URL(`./vendor/mediapipe/tasks-vision@${VER}`, import.meta.url).href,
  model: new URL('./vendor/mediapipe/hand_landmarker.task', import.meta.url).href,
};
const CDN = {
  lib: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`,
  model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};
let handsSource = null; // 'local' | 'cdn', shown in the Debug line via stats.src

async function createLandmarker({ lib, model }) {
  const vision = await import(`${lib}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${lib}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: model, delegate },
    runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4,
  });
  try { return await vision.HandLandmarker.createFromOptions(fileset, opts('GPU')); }
  catch { return await vision.HandLandmarker.createFromOptions(fileset, opts('CPU')); }
}

let landmarkerPromise = null;
async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = createLandmarker(LOCAL).then((lm) => { handsSource = 'local'; return lm; }, (e) => {
      console.warn('[hands] local MediaPipe failed, using the CDN:', e);
      return createLandmarker(CDN).then((lm) => { handsSource = 'cdn'; return lm; });
    });
  }
  return landmarkerPromise;
}

// The middle 70% of the camera image (in height) covers the whole view, so you don't have to reach the edges.
// The crop has the view's own aspect, so hands keep their real proportions instead of being stretched to the
// screen: wider on a 16:10 laptop, narrower per eye in the headset. Never more than 90% of the image either way.
const SPAN = 0.7, MAX_SPAN = 0.9;
export function cropFor(viewAspect, vw, vh) {
  const va = vw / vh || 4 / 3;
  let sy = SPAN, sx = (SPAN * viewAspect) / va;
  if (sx > MAX_SPAN) { sx = MAX_SPAN; sy = (MAX_SPAN * va) / viewAspect; }
  return { cx: (1 - sx) / 2, cy: (1 - sy) / 2, sx, sy };
}

// One Euro filter (Casiez et al. 2012): heavy smoothing when the hand is still, little lag when it moves fast.
// beta is in the signal's own units per second: the pinch point is in screen units (0..1), depth in metres.
export class OneEuro {
  constructor(minCutoff = 1.0, beta = 4, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: 0 });
  }
  filter(x, t) { // t in seconds
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(t - this.t, 1e-3);
    const alpha = (fc) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
    this.t = t;
    this.dx += alpha(this.dCutoff) * ((x - this.x) / dt - this.dx);
    this.x += alpha(this.minCutoff + this.beta * Math.abs(this.dx)) * (x - this.x);
    return this.x;
  }
}

// Metric distance from the camera to the hand. MediaPipe's world landmarks are in metres, so a palm bone's real
// length over its length in the image gives the distance: depth = focal_px × world_m / image_px. A bone tilted
// away from the camera looks shorter and over-estimates the distance, so take the smallest estimate of a few.
// hfovDeg: horizontal field of view of the camera (laptop webcams and iPhone cameras are about 60-70°).
const PALM = [[0, 5], [0, 9], [0, 17], [5, 17]];
export function handDepth(L, W, vw, vh, hfovDeg = 63) {
  if (!W || !vw || !vh) return null;
  const f = vw / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  let best = Infinity;
  for (const [a, b] of PALM) {
    const img = Math.hypot((L[a].x - L[b].x) * vw, (L[a].y - L[b].y) * vh);
    const world = Math.hypot(W[a].x - W[b].x, W[a].y - W[b].y, W[a].z - W[b].z);
    if (img > 4 && world > 0.02) best = Math.min(best, (f * world) / img);
  }
  return Number.isFinite(best) ? best : null;
}

// maxHz caps how often detection runs: detectForVideo blocks the main thread (~10-20 ms on a phone), so on a
// phone every skipped detection is render time back. stats.ms is the smoothed cost of one detection.
// aspect(): width / height of the view the hands are drawn in (one eye in the headset).
// onFrame(cam): called right before each detection, so realhands.js can copy the very image the landmarks come from.
export async function startHands({ video, facingMode = 'user', onHands, onFrame, maxHz = 30, aspect = () => innerWidth / innerHeight }) {
  const lm = await getLandmarker();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
  });
  video.srcObject = stream;
  await video.play();

  const mirror = facingMode === 'user';
  const pinching = {}; // hysteresis per hand
  const filters = {};  // One Euro filters per hand
  const stats = { maxHz, ms: 0, hfov: 63, src: handsSource };
  let running = true, last = -1, nextRun = 0;
  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    if (video.readyState < 2 || video.currentTime === last) return;
    const t = performance.now();
    if (t < nextRun - 4) return; // 4 ms slack for display-frame jitter
    // schedule from the due time, not from now, so 25 Hz on a 60 Hz display averages 25 instead of rounding to 20
    nextRun = Math.max(nextRun + 1000 / stats.maxHz, t);
    last = video.currentTime;
    // how screen units map back to the video (realhands.js draws the same rectangle)
    const cam = { mirror, ...cropFor(aspect(), video.videoWidth, video.videoHeight) };
    onFrame?.(cam);
    const t1 = performance.now(); // stats.ms is the detection alone
    const r = lm.detectForVideo(video, t);
    stats.ms = stats.ms ? stats.ms * 0.9 + (performance.now() - t1) * 0.1 : performance.now() - t1;
    const toScreen = (p) => ({ x: ((mirror ? 1 - p.x : p.x) - cam.cx) / cam.sx, y: (p.y - cam.cy) / cam.sy, z: p.z });
    const hands = (r.landmarks || []).map((L, i) => {
      // MediaPipe labels assume a mirrored (selfie) image; flip for the back camera
      let side = ((r.handednesses || r.handedness || [])[i] || [])[0]?.categoryName || `h${i}`;
      if (!mirror && (side === 'Left' || side === 'Right')) side = side === 'Left' ? 'Right' : 'Left';
      const pts = L.map(toScreen);
      const d = (a, b) => Math.hypot(L[a].x - L[b].x, L[a].y - L[b].y);
      const size = d(0, 9) || 1e-3;                 // wrist to middle knuckle, in camera-image units
      const ratio = d(4, 8) / size;                  // thumb tip to index tip, relative to hand size
      const was = pinching[side] || false;
      const pinch = was ? ratio < 0.45 : ratio < 0.28;
      pinching[side] = pinch;
      // pts stay raw so realhands.js cuts the camera pixels exactly where they are; the pinch point and the
      // depth drive interaction, so those are smoothed
      const fl = filters[side] || (filters[side] = { x: new OneEuro(1, 4), y: new OneEuro(1, 4), d: new OneEuro(0.8, 3) });
      const s = t / 1000;
      const raw = handDepth(L, (r.worldLandmarks || [])[i], video.videoWidth, video.videoHeight, stats.hfov);
      const depth = raw == null ? null : fl.d.filter(raw, s);
      return { side, pts, size, pinch, depth,
        x: fl.x.filter((pts[4].x + pts[8].x) / 2, s), y: fl.y.filter((pts[4].y + pts[8].y) / 2, s) };
    });
    for (const k of Object.keys(pinching)) if (!hands.some((h) => h.side === k)) delete pinching[k];
    for (const k of Object.keys(filters)) if (!hands.some((h) => h.side === k)) delete filters[k];
    onHands(hands, cam);
  }
  loop();
  return {
    facingMode, stats,
    setMaxHz(hz) { stats.maxHz = hz; },
    setFov(deg) { stats.hfov = deg; }, // calibrate depth: hold a hand 50 cm from the camera, tune until depth ≈ 0.5
    stop() { running = false; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; },
  };
}
