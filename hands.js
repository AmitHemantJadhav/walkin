// Hand tracking with MediaPipe (up to two hands). For each hand it reports the 21 landmarks mapped to the screen
// (0..1), a hand-size measure for depth, the pinch point, and whether that hand is pinching.
const VER = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

let landmarkerPromise = null;
async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import(`${CDN}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO', numHands: 2,
        minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4,
      });
      try { return await vision.HandLandmarker.createFromOptions(fileset, opts('GPU')); }
      catch { return await vision.HandLandmarker.createFromOptions(fileset, opts('CPU')); }
    })();
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

// maxHz caps how often detection runs: detectForVideo blocks the main thread (~10-20 ms on a phone), so on a
// phone every skipped detection is render time back. stats.ms is the smoothed cost of one detection.
// aspect(): width / height of the view the hands are drawn in (one eye in the headset).
export async function startHands({ video, facingMode = 'user', onHands, maxHz = 30, aspect = () => innerWidth / innerHeight }) {
  const lm = await getLandmarker();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
  });
  video.srcObject = stream;
  await video.play();

  const mirror = facingMode === 'user';
  const pinching = {}; // hysteresis per hand
  const stats = { maxHz, ms: 0 };
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
    const r = lm.detectForVideo(video, t);
    stats.ms = stats.ms ? stats.ms * 0.9 + (performance.now() - t) * 0.1 : performance.now() - t;
    // how screen units map back to the video (realhands.js draws the same rectangle)
    const cam = { mirror, ...cropFor(aspect(), video.videoWidth, video.videoHeight) };
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
      return { side, pts, size, pinch, x: (pts[4].x + pts[8].x) / 2, y: (pts[4].y + pts[8].y) / 2 };
    });
    for (const k of Object.keys(pinching)) if (!hands.some((h) => h.side === k)) delete pinching[k];
    onHands(hands, cam);
  }
  loop();
  return {
    facingMode, stats,
    setMaxHz(hz) { stats.maxHz = hz; },
    stop() { running = false; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; },
  };
}
