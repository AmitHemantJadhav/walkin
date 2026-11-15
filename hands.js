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
// With viewVfov (the 3D camera's vertical field of view) and camHfov (the hand camera's, along the video width),
// the mapping is by angle instead: each camera pixel lands in the direction it really comes from, so a hand shows at
// its real size and place (passthrough). The camera then covers only the middle of a wider view: sx/sy > 1.
// ?handmap=crop in app.js keeps the old zoomed crop.
//
// reach (the default with the back camera): the camera sees ~63° and the view is far wider (~117° across a phone in
// landscape), so by angle alone a hand only shows - and can only point - inside a window in the middle of the
// screen, and fades out at that window's edge. With reach the screen spans the middle REACH of the camera instead,
// so the hand reaches every edge (and the buttons along them) while it is still whole in the camera image. `gain`
// says how much that magnifies the camera; realhands.js draws the hand 1/gain smaller about the pinch point, so it
// keeps its real size and only its movement is amplified (like mouse acceleration). ?handmap=true turns reach off.
const REACH = 0.85;
export function cropFor(viewAspect, vw, vh, viewVfov, camHfov, reach = false) {
  if (viewVfov && camHfov && vw && vh) {
    // camHfov is along the camera's long side (a phone held upright delivers a portrait video)
    const tV = Math.tan((viewVfov * Math.PI) / 360), tL = Math.tan((camHfov * Math.PI) / 360);
    const tW = vw >= vh ? tL : (tL * vw) / vh, tH = (tW * vh) / vw; // half-angle tangents across and up the video
    let sx = (tV * viewAspect) / tW, sy = tV / tH, gain = 1;
    const k = Math.max(sx, sy) / REACH;
    if (reach && k > 1) { sx /= k; sy /= k; gain = k; }
    return { cx: (1 - sx) / 2, cy: (1 - sy) / 2, sx, sy, gain };
  }
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

// Detection in a worker (hands-worker.js), so it never blocks rendering. Resolves to null when the worker can't run
// MediaPipe here (no module workers, no OffscreenCanvas, ...): then detection stays on the main thread as before.
const USE_WORKER = !/[?&]handworker=off\b/.test(location.search);
const IDLE_HZ = 10; // no hand in view: look for one 10 times a second, not 30 (most of a demo has no hands up)
function startWorker() {
  if (!USE_WORKER || typeof Worker === 'undefined' || typeof createImageBitmap === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let w;
    try { w = new Worker(new URL('./hands-worker.js', import.meta.url), { type: 'module' }); }
    catch { resolve(null); return; }
    const fail = (why) => { clearTimeout(to); w.terminate(); console.warn('[hands] worker unavailable, detecting on the main thread:', why); resolve(null); };
    const to = setTimeout(() => fail('timeout'), 20000);
    w.onerror = (e) => fail(e.message || 'error');
    w.onmessage = (e) => {
      if (e.data.type === 'ready') { clearTimeout(to); w.onerror = null; w.onmessage = null; resolve({ w, delegate: e.data.delegate }); }
      else if (e.data.type === 'error') fail(e.data.message);
    };
    w.postMessage({ type: 'init', lib: LOCAL.lib, model: LOCAL.model });
  });
}

// maxHz caps how often detection runs: detectForVideo blocks the main thread (~10-20 ms on a phone), so on a
// phone every skipped detection is render time back. stats.ms is the smoothed cost of one detection.
// aspect(): width / height of the view the hands are drawn in (one eye in the headset).
// onFrame(cam): called right before each detection, so realhands.js can copy the very image the landmarks come from.
export async function startHands({ video, facingMode = 'user', onHands, onFrame, maxHz = 30, aspect = () => innerWidth / innerHeight, viewFov = null, reach = false }) {
  let wk = await startWorker();
  let lm = wk ? null : await getLandmarker();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
  });
  video.srcObject = stream;
  await video.play();

  const mirror = facingMode === 'user';
  const pinching = {}; // hysteresis per hand
  const filters = {};  // One Euro filters per hand
  const stats = { maxHz, ms: 0, hfov: 63, src: wk ? `worker-${wk.delegate}` : handsSource };
  let running = true, last = -1, nextRun = 0, seen = 0, busy = false, seq = 0, pending = null, results = 0;
  if (wk) {
    wk.w.onmessage = (e) => {
      const m = e.data;
      busy = false;
      if (!running || !pending || m.id !== pending.id) return;
      if (m.type === 'error') { console.warn('[hands] worker:', m.message); return; }
      stats.ms = stats.ms ? stats.ms * 0.9 + m.ms * 0.1 : m.ms;
      handle(m, pending.cam, pending.t);
      // safety net: if this phone's worker is slow (its GPU path can be), go back to the main thread
      if (++results === 60 && stats.ms > 60) {
        console.warn(`[hands] worker detection ${stats.ms.toFixed(0)} ms, switching to the main thread`);
        wk.w.terminate(); wk = null; stats.src = handsSource || 'main';
        getLandmarker().then((l) => { lm = l; stats.src = handsSource; });
      }
    };
  }
  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    if (video.readyState < 2 || video.currentTime === last) return;
    const t = performance.now();
    if (t < nextRun - 4) return; // 4 ms slack for display-frame jitter
    if (busy) return; // the worker still has the last frame
    // schedule from the due time, not from now, so 25 Hz on a 60 Hz display averages 25 instead of rounding to 20
    const hz = seen ? stats.maxHz : Math.min(stats.maxHz, IDLE_HZ);
    nextRun = Math.max(nextRun + 1000 / hz, t);
    last = video.currentTime;
    // how screen units map back to the video (realhands.js draws the same rectangle)
    const cam = { mirror, ...cropFor(aspect(), video.videoWidth, video.videoHeight, viewFov && viewFov(), stats.hfov, reach) };
    onFrame?.(cam);
    if (wk) {
      busy = true;
      pending = { id: ++seq, cam, t };
      const id = pending.id;
      createImageBitmap(video).then((bitmap) => {
        if (!running) { bitmap.close(); return; }
        wk.w.postMessage({ type: 'frame', id, t, bitmap }, [bitmap]);
      }, () => { busy = false; });
      return;
    }
    if (!lm) return; // switching from the worker: the main-thread model is still loading
    const t1 = performance.now(); // stats.ms is the detection alone
    const r = lm.detectForVideo(video, t);
    stats.ms = stats.ms ? stats.ms * 0.9 + (performance.now() - t1) * 0.1 : performance.now() - t1;
    handle(r, cam, t);
  }
  function handle(r, cam, t) {
    const toScreen = (p) => ({ x: ((mirror ? 1 - p.x : p.x) - cam.cx) / cam.sx, y: (p.y - cam.cy) / cam.sy, z: p.z });
    const hands = (r.landmarks || []).map((L, i) => {
      // MediaPipe labels assume a mirrored (selfie) image; flip for the back camera
      let side = ((r.handednesses || r.handedness || [])[i] || [])[0]?.categoryName || `h${i}`;
      if (!mirror && (side === 'Left' || side === 'Right')) side = side === 'Left' ? 'Right' : 'Left';
      const pts = L.map(toScreen);
      const d = (a, b) => Math.hypot(L[a].x - L[b].x, L[a].y - L[b].y);
      const size = d(0, 9) || 1e-3;                 // wrist to middle knuckle, in camera-image units
      const ratio = d(4, 8) / size;                  // thumb tip to index tip, relative to hand size
      // pinch with hysteresis, and a closing pinch must be seen twice (or be clearly closed) before it counts,
      // so one noisy frame of a relaxed hand doesn't press a button or grab a sofa
      const st = pinching[side] || (pinching[side] = { on: false, close: 0, hist: [], off: null });
      if (st.on) st.on = ratio < 0.45;
      else { st.close = ratio < 0.28 ? st.close + 1 : 0; st.on = st.close >= 2 || ratio < 0.18; }
      const pinch = st.on;
      // pts stay raw so realhands.js cuts the camera pixels exactly where they are; the pinch point and the
      // depth drive interaction, so those are smoothed. Reach magnifies hand movement (and its jitter) by
      // cam.gain, so the resting smoothing is stronger by the same token (One Euro still follows fast moves).
      const fl = filters[side] || (filters[side] = { x: new OneEuro(1, 4), y: new OneEuro(1, 4), d: new OneEuro(0.8, 3) });
      fl.x.minCutoff = fl.y.minCutoff = 1 / Math.sqrt(cam.gain || 1);
      const s = t / 1000;
      const raw = handDepth(L, (r.worldLandmarks || [])[i], video.videoWidth, video.videoHeight, stats.hfov);
      const depth = raw == null ? null : fl.d.filter(raw, s);
      let x = fl.x.filter((pts[4].x + pts[8].x) / 2, s), y = fl.y.filter((pts[4].y + pts[8].y) / 2, s);
      // Closing thumb and index moves the point between them, so a pinch landed beside what you aimed at. When a
      // pinch starts, take the point from just before the fingers closed and keep that offset for the whole pinch.
      if (pinch && !st.off) { const p0 = st.hist[0] || [x, y]; st.off = [p0[0] - x, p0[1] - y]; }
      if (!pinch) st.off = null;
      st.hist.push([x, y]); if (st.hist.length > 3) st.hist.shift();
      if (st.off) { x += st.off[0]; y += st.off[1]; }
      return { side, pts, size, pinch, depth, x, y };
    });
    for (const k of Object.keys(pinching)) if (!hands.some((h) => h.side === k)) delete pinching[k];
    for (const k of Object.keys(filters)) if (!hands.some((h) => h.side === k)) delete filters[k];
    seen = hands.length;
    onHands(hands, cam);
  }
  loop();
  return {
    facingMode, stats,
    setMaxHz(hz) { stats.maxHz = hz; },
    setFov(deg) { stats.hfov = deg; }, // calibrate depth: hold a hand 50 cm from the camera, tune until depth ≈ 0.5
    stop() { running = false; wk?.w.terminate(); stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; },
  };
}
