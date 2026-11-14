MediaPipe Tasks Vision 0.10.14 (npm @mediapipe/tasks-vision@0.10.14, Apache-2.0) and the HandLandmarker model
(hand_landmarker/float16/1, Apache-2.0), byte-identical to what jsdelivr and storage.googleapis.com serve.
Vendored so hand tracking works without CDN access (R10, #34). hands.js tries these first and falls back to the CDN.
Only the SIMD wasm build is included (every current iPhone and desktop browser has WebAssembly SIMD); a browser
without SIMD asks for vision_wasm_nosimd_internal.*, gets a 404 here, and hands.js falls back to the CDN.
