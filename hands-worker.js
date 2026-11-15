// Hand detection off the main thread. On a phone detectForVideo blocks for 10-25 ms each time; on the main thread,
// 20-30 times a second, that was most of every frame and the whole app felt laggy. Here it blocks only this worker:
// hands.js sends each camera frame as an ImageBitmap and gets the landmarks back, one frame in flight at a time.
// If anything here fails, hands.js falls back to detecting on the main thread as before (?handworker=off forces that).

// MediaPipe's loader pulls its wasm glue in with importScripts(), which module workers do not have. A synchronous
// fetch + global eval does the same job (allowed in workers), so the glue's globals (ModuleFactory) land on `self`.
self.importScripts = (...urls) => {
  for (const u of urls) {
    const x = new XMLHttpRequest();
    x.open('GET', u, false);
    x.send();
    if (x.status >= 400) throw new Error(`importScripts ${u}: ${x.status}`);
    (0, eval)(`${x.responseText}\n//# sourceURL=${u}`);
  }
};

let lm = null;

async function init({ lib, model, delegate = null }) {
  const vision = await import(`${lib}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${lib}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: model, delegate },
    runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4,
  });
  // GPU needs WebGL2 on an OffscreenCanvas (Safari 17+); the CPU path is still off the main thread
  if (delegate) { lm = await vision.HandLandmarker.createFromOptions(fileset, opts(delegate)); return delegate; }
  try { lm = await vision.HandLandmarker.createFromOptions(fileset, opts('GPU')); return 'GPU'; }
  catch { lm = await vision.HandLandmarker.createFromOptions(fileset, opts('CPU')); return 'CPU'; }
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try { postMessage({ type: 'ready', delegate: await init(m) }); }
    catch (err) { postMessage({ type: 'error', message: String((err && err.message) || err) }); }
    return;
  }
  if (m.type === 'frame') {
    const t1 = performance.now();
    try {
      const r = lm.detectForVideo(m.bitmap, m.t);
      postMessage({ type: 'result', id: m.id, ms: performance.now() - t1,
        landmarks: r.landmarks, worldLandmarks: r.worldLandmarks, handedness: r.handedness || r.handednesses });
    } catch (err) {
      postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
    } finally {
      m.bitmap.close();
    }
  }
};
