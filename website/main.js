// Walk-In landing page. The scroll is a camera move: website/frames/f_###.jpg were rendered by tools/render.html
// (Vexcel aerial -> Matterport dollhouse -> the front door -> the real 360 photo inside). three.js draws them on
// one full-screen quad and blends each frame into the next, GSAP ScrollTrigger turns the scroll into a frame position
// with a little lag (scrub), so it plays like video instead of stepping through pictures.
import * as THREE from 'three';

const N = 300;                                   // frames in website/frames
const FRAME = (i) => `frames/f_${String(i).padStart(3, '0')}.jpg`;
const END_AT = 0.9;                              // the last frame is reached here; the rest of the scroll holds on it
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
gsap.registerPlugin(ScrollTrigger);

// ------------------------------------------------------------------ load the frames
// All 300 files are downloaded up front (~80 MB of JPEG), but only the frames around the scroll position are decoded
// (300 decoded 1080p frames would be ~2.5 GB). Decoding runs off the main thread (createImageBitmap) a little ahead of
// where the scroll is heading, so the GPU upload never waits on a decode: that's what keeps the scroll from hitching.
const blobs = new Array(N), bitmaps = new Map(), decoding = new Map();
const AHEAD = 24, BEHIND = 10;
const loaderFill = document.getElementById('loader-fill'), loaderPct = document.getElementById('loader-pct');
async function fetchFrame(i) {
  try { const r = await fetch(FRAME(i)); if (r.ok) blobs[i] = await r.blob(); } catch (e) { /* stays missing */ }
}
function decode(i) {
  if (i < 0 || i >= N || bitmaps.has(i) || decoding.has(i) || !blobs[i]) return;
  const job = createImageBitmap(blobs[i], { imageOrientation: 'flipY' })
    .then((bm) => { bitmaps.set(i, bm); }).catch(() => {}).finally(() => decoding.delete(i));
  decoding.set(i, job);
}
let lastCenter = 0;
function keepWindow(center, dir) {          // decode ahead in the direction of travel, drop what's far behind
  const lo = center - (dir >= 0 ? BEHIND : AHEAD), hi = center + (dir >= 0 ? AHEAD : BEHIND);
  for (let d = 0; d <= Math.max(AHEAD, BEHIND); d++) {   // nearest first
    if (center + d <= hi) decode(center + d);
    if (center - d >= lo) decode(center - d);
  }
  for (const [i, bm] of bitmaps) {
    if ((i < lo - 4 || i > hi + 4) && i !== shownA && i !== shownB) { bm.close(); bitmaps.delete(i); }
  }
}
async function loadAll() {                    // frame 0 is already in (fetched before the page shows)
  let done = 1;
  const queue = Array.from({ length: N - 1 }, (_, k) => k + 1);
  const worker = async () => {
    while (queue.length) {
      await fetchFrame(queue.shift());
      done++;
      const p = Math.round((done / N) * 100);
      loaderFill.style.width = `${p}%`;
      loaderPct.textContent = `${p}%`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

// ------------------------------------------------------------------ three.js: one quad, two frames, blended
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));   // the frames are 1080p: more pixels than that add nothing
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
// One GPU texture per frame, uploaded once (a little ahead of the scroll) and kept in a small cache. Stepping to the
// next frame then only swaps which two textures the shader reads: no 1080p upload in the middle of a scroll step.
const GPU_MAX = 14;
const gpu = new Map();                           // frame -> THREE.Texture, oldest first
function gpuTex(i, upload = true) {
  let t = gpu.get(i);
  if (t) { gpu.delete(i); gpu.set(i, t); return t; }  // most recent last
  if (!upload || !bitmaps.has(i)) return null;
  t = new THREE.Texture(bitmaps.get(i));
  t.colorSpace = THREE.SRGBColorSpace; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
  t.flipY = false;                               // bitmaps are flipped at decode
  t.userData.size = [t.image.width, t.image.height];   // the bitmap is freed later; the GPU copy stays
  t.needsUpdate = true;
  renderer.initTexture(t);                       // upload now, not at draw time
  gpu.set(i, t);
  while (gpu.size > GPU_MAX) {
    const [old, ot] = gpu.entries().next().value;
    if (old === shownA || old === shownB) { gpu.delete(old); gpu.set(old, ot); break; }
    ot.dispose(); gpu.delete(old);
  }
  return t;
}
const uniforms = {
  a: { value: null }, b: { value: null }, mixAB: { value: 0 },
  screen: { value: new THREE.Vector2(1, 1) }, img: { value: new THREE.Vector2(16, 9) },
  time: { value: 0 }, grain: { value: reduce ? 0 : 1 }, dim: { value: 0 }, zoom: { value: 1 },
};
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms,
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
    uniform sampler2D a, b; uniform float mixAB, time, grain, dim, zoom; uniform vec2 screen, img; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      // cover the screen like object-fit: cover, with a slow push-in
      float rs = screen.x / screen.y, ri = img.x / img.y;
      vec2 s = rs > ri ? vec2(1.0, ri / rs) : vec2(rs / ri, 1.0);
      vec2 uv = (vUv - 0.5) * s / zoom + 0.5;
      vec3 c = mix(texture2D(a, uv).rgb, texture2D(b, uv).rgb, mixAB);
      vec2 q = vUv - 0.5;
      c *= mix(1.0, smoothstep(0.95, 0.25, length(q * vec2(1.0, 0.8))), 0.55);   // vignette
      c += (hash(vUv * screen + fract(time) * 91.7) - 0.5) * 0.045 * grain;      // film grain
      c = mix(c, vec3(0.035, 0.04, 0.05), dim);
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }`,
  depthTest: false,
})));

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  uniforms.screen.value.set(innerWidth, innerHeight);
}
addEventListener('resize', resize);
resize();

let shownA = -1, shownB = -1, dir = 1;
const ready = (i) => gpu.has(i) || bitmaps.has(i);
function nearestLoaded(i) {                       // a decode not done yet: show the closest frame that is
  for (let d = 0; d < N; d++) {
    if (ready(i - d)) return i - d;
    if (ready(i + d)) return i + d;
  }
  return -1;
}
function setFrame(f) {
  f = Math.max(0, Math.min(N - 1, f));
  const i = Math.floor(f), j = Math.min(N - 1, i + 1);
  if (i !== lastCenter) { dir = Math.sign(i - lastCenter) || dir; keepWindow(i, dir); lastCenter = i; }
  const ia = nearestLoaded(i);
  if (ia < 0) return;
  const ib = ready(j) ? j : ia;
  const ta = gpuTex(ia), tb = gpuTex(ib);
  if (!ta) return;
  shownA = ia; shownB = ib;
  uniforms.a.value = ta; uniforms.b.value = tb || ta;
  uniforms.mixAB.value = ib === ia || ia !== i ? 0 : f - i;
  uniforms.img.value.set(...ta.userData.size);
  // one upload per frame at most, for the frame after next in the direction we're going
  const next = i + 2 * dir;
  if (next >= 0 && next < N && !gpu.has(next)) gpuTex(next);
}

const state = { frame: 0 };
renderer.setAnimationLoop((t) => {
  uniforms.time.value = t / 1000;
  setFrame(state.frame);
  renderer.render(scene, cam);
});

// ------------------------------------------------------------------ the scroll
function buildScroll() {
  const tl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: '#fly', start: 'top top', end: 'bottom bottom',
      scrub: reduce ? true : 1.1,                 // the lag that makes it glide
      onUpdate: (st) => { document.getElementById('progress-fill').style.transform = `scaleX(${st.progress})`; },
    },
  });
  tl.to(state, { frame: N - 1, duration: END_AT }, 0)
    .to(uniforms.zoom, { value: 1.04, duration: 1 }, 0)
    // captions: in, hold, out
    // captions, timed to the frames (scroll = frame / 299 × 0.9): aerial 0–60, dollhouse 65–121, the walk up 140–220,
    // the porch photo 225–255 (sharp, looking through the open door), inside after that
    .to('.beat-hero', { autoAlpha: 0, y: -40, duration: 0.035 }, 0.005)
    .fromTo('.beat-a', { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 0.03 }, 0.04)
    .to('.beat-a', { autoAlpha: 0, y: -30, duration: 0.03 }, 0.15)
    .fromTo('.beat-b', { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 0.03 }, 0.2)
    .to('.beat-b', { autoAlpha: 0, y: -30, duration: 0.03 }, 0.34)
    .fromTo('.beat-c', { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 0.03 }, 0.66)
    .to('.beat-c', { autoAlpha: 0, y: -30, duration: 0.03 }, 0.77)
    .to(uniforms.dim, { value: 0.3, duration: 0.05 }, END_AT - 0.03)        // settle the room behind the play button
    .fromTo('.beat-end', { autoAlpha: 0, scale: 0.86 }, { autoAlpha: 1, scale: 1, duration: 0.06, ease: 'back.out(2)' }, END_AT - 0.02);

  // past the flight, the panels slide over a dimmed frame
  gsap.fromTo(uniforms.dim, { value: 0.3 }, { value: 0.82, ease: 'none', immediateRender: false, scrollTrigger: { trigger: '#features', start: 'top bottom', end: 'top 30%', scrub: true } });
  gsap.utils.toArray('.card, .stack li, .section-title').forEach((el) => {
    gsap.from(el, { autoAlpha: 0, y: 40, duration: 0.8, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 88%' } });
  });
}

// ------------------------------------------------------------------ the video
const modal = document.getElementById('video'), video = document.getElementById('demo'), soon = modal.querySelector('.soon');
function openVideo() {
  modal.hidden = false;
  gsap.fromTo(modal, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.35 });
  gsap.fromTo(modal.querySelector('.frame'), { scale: 0.92, y: 20 }, { scale: 1, y: 0, duration: 0.5, ease: 'power3.out' });
  if (!video.getAttribute('src')) video.src = video.dataset.src;
  video.play().catch(() => {});
}
function closeVideo() {
  video.pause();
  gsap.to(modal, { autoAlpha: 0, duration: 0.25, onComplete: () => { modal.hidden = true; } });
}
video.addEventListener('error', () => { video.hidden = true; soon.hidden = false; });
document.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', openVideo));
modal.querySelector('.close').addEventListener('click', closeVideo);
modal.addEventListener('click', (e) => { if (e.target === modal) closeVideo(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeVideo(); });

// ------------------------------------------------------------------ go
await fetchFrame(0);
decode(0);
await decoding.get(0);
keepWindow(0, 1);
setFrame(0);
buildScroll();
gsap.from('.beat-hero > *', { autoAlpha: 0, y: 24, stagger: 0.09, duration: 0.9, ease: 'power3.out', delay: 0.15 });
loadAll().then(() => {
  keepWindow(Math.round(state.frame), 1);
  gsap.to('#loader', { autoAlpha: 0, duration: 0.5, onComplete: () => document.getElementById('loader').remove() });
  ScrollTrigger.refresh();
});
setTimeout(() => {                               // don't hold the page hostage on a slow link: the scroll falls back
  const l = document.getElementById('loader');   // to the nearest loaded frame until the rest arrive
  if (l) gsap.to(l, { autoAlpha: 0, duration: 0.5 });
}, 6000);
