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

// The middle 70% of the camera image covers the whole screen, so you don't have to reach the edges.
const CROP = 0.15, SPAN = 0.7;
const toScreen = (v) => (v - CROP) / SPAN;

export async function startHands({ video, facingMode = 'user', onHands }) {
  const lm = await getLandmarker();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
  });
  video.srcObject = stream;
  await video.play();

  const mirror = facingMode === 'user';
  const pinching = {}; // hysteresis per hand
  let running = true, last = -1;
  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    if (video.readyState < 2 || video.currentTime === last) return;
    last = video.currentTime;
    const r = lm.detectForVideo(video, performance.now());
    const hands = (r.landmarks || []).map((L, i) => {
      // MediaPipe labels assume a mirrored (selfie) image; flip for the back camera
      let side = ((r.handednesses || r.handedness || [])[i] || [])[0]?.categoryName || `h${i}`;
      if (!mirror && (side === 'Left' || side === 'Right')) side = side === 'Left' ? 'Right' : 'Left';
      const pts = L.map((p) => ({ x: toScreen(mirror ? 1 - p.x : p.x), y: toScreen(p.y), z: p.z }));
      const d = (a, b) => Math.hypot(L[a].x - L[b].x, L[a].y - L[b].y);
      const size = d(0, 9) || 1e-3;                 // wrist to middle knuckle, in camera-image units
      const ratio = d(4, 8) / size;                  // thumb tip to index tip, relative to hand size
      const was = pinching[side] || false;
      const pinch = was ? ratio < 0.45 : ratio < 0.28;
      pinching[side] = pinch;
      return { side, pts, size, pinch, x: (pts[4].x + pts[8].x) / 2, y: (pts[4].y + pts[8].y) / 2 };
    });
    for (const k of Object.keys(pinching)) if (!hands.some((h) => h.side === k)) delete pinching[k];
    onHands(hands);
  }
  loop();
  return {
    facingMode,
    stop() { running = false; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; },
  };
}
