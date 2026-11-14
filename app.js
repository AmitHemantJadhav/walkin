// Walk-In: walk a Matterport house (empty or as scanned) and place real-size furniture in it.
// World frame = Matterport model frame: metres, Z up. Every pano is drawn around the camera with its own rotation,
// so furniture placed once lines up from every scan position.
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { StereoEffect } from 'three/addons/effects/StereoEffect.js';
import { FURNITURE, buildFurniture } from './furniture.js';
import { createRealHands } from './realhands.js';

const params = new URLSearchParams(location.search);
const MODEL = params.get('m') || 'zvKHR9DHNjJ';
const BASE = `data/${MODEL}/`;
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ load house
let house;
try {
  house = await (await fetch(BASE + 'house.json')).json();
} catch (e) {
  $('loading').textContent = `Couldn't load ${BASE}house.json. Run: python prep_house.py ${MODEL}`;
  throw e;
}
const panoById = new Map(house.panos.map((p) => [p.id, p]));
$('house').textContent = `${house.name || MODEL} · ${house.panos.length} scan points · ${house.rooms.length} rooms`;

// ------------------------------------------------------------------ renderer, scene, camera
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const stereo = new StereoEffect(renderer);
stereo.setSize(innerWidth, innerHeight);

// Adaptive resolution state (A1). Declared here, before any event handler that touches it (see tickPerf below).
const MAX_PR = Math.min(devicePixelRatio, 2), MIN_PR = Math.min(0.75, MAX_PR);
// Hand detection blocks the main thread each time it runs, so its rate backs off too (after resolution reaches 1x).
// 30 Hz = the camera's own rate, so the top step costs nothing on a laptop.
const HAND_HZ_MAX = 30, HAND_HZ_MIN = 15;
const perf = { frames: 0, hands: 0, t0: performance.now(), pr: MAX_PR, cap: MAX_PR, handCap: HAND_HZ_MAX, slow: 0, fast: 0 };
function setPixelRatio(pr) {
  perf.pr = THREE.MathUtils.clamp(Math.round(pr * 4) / 4, MIN_PR, MAX_PR);
  renderer.setPixelRatio(perf.pr);
  console.log(`[perf] pixel ratio ${perf.pr}`);
}
function resetPerfCap() { perf.cap = MAX_PR; perf.handCap = HAND_HZ_MAX; perf.slow = perf.fast = 0; }

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 500);
camera.up.set(0, 0, 1);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f72, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(2, -3, 6);
scene.add(sun);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  stereo.setSize(innerWidth, innerHeight);
  resetPerfCap();
});

// ------------------------------------------------------------------ calibration: pano-local frame -> model frame
// The 360 images are equirectangular in a pano-local frame (y up, z forward). Each pano's API `rotation` turns it into
// the model frame. The axis convention isn't documented, so it is adjustable in Debug mode (Q, M, [ ], , .).
// Verified on La Mirada (4 scan points in 4 rooms): quaternion as given, mirror on, yaw 90.
const CAL_KEY = 'walkin.cal.v2';
const cal = Object.assign({ qMode: 1, yaw: 90, mirror: 1 }, JSON.parse(localStorage.getItem(CAL_KEY) || '{}'));
if (params.get('cal')) Object.assign(cal, JSON.parse(params.get('cal')));
const AXES = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1); // local y -> model z

function invLocalToModel(p) {
  const q = new THREE.Quaternion();
  if (p.rot && cal.qMode) {
    q.set(p.rot[0], p.rot[1], p.rot[2], p.rot[3]).normalize();
    if (cal.qMode === 2) q.invert();
  }
  const M = new THREE.Matrix4().makeRotationFromQuaternion(q)
    .multiply(AXES)
    .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(cal.yaw)))
    .multiply(new THREE.Matrix4().makeScale(cal.mirror ? -1 : 1, 1, 1));
  return new THREE.Matrix3().setFromMatrix4(M).invert();
}

// ------------------------------------------------------------------ the pano sphere (cross-fades between two panos)
const texLoader = new THREE.TextureLoader();
// Least recently used first. A 2k pano is ~8 MB on the GPU, so keep the last TEX_CACHE_MAX and dispose older ones
// (never the two on screen). A failed load is dropped from the cache so the next try fetches it again.
const TEX_CACHE_MAX = 12;
const texCache = new Map(); // url -> Promise<Texture>
const texReady = new Map(); // url -> Texture, once loaded
function loadTex(url) {
  let p = texCache.get(url);
  if (p) { texCache.delete(url); texCache.set(url, p); return p; } // mark as most recently used
  p = new Promise((res, rej) => texLoader.load(BASE + url, (t) => {
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.wrapS = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace; // show the photo's bytes as they are
    res(t);
  }, undefined, rej));
  p.then((t) => texReady.set(url, t), () => { if (texCache.get(url) === p) texCache.delete(url); });
  texCache.set(url, p);
  for (const [u] of texCache) {
    if (texCache.size <= TEX_CACHE_MAX) break;
    const t = texReady.get(u), U = panoMat.uniforms;
    if (!t || t === U.texA.value || t === U.texB.value) continue; // still loading, or on screen
    texCache.delete(u); texReady.delete(u); t.dispose();
  }
  return p;
}

const panoMat = new THREE.ShaderMaterial({
  uniforms: {
    texA: { value: null }, texB: { value: null }, invA: { value: new THREE.Matrix3() }, invB: { value: new THREE.Matrix3() },
    mixAB: { value: 0 },
  },
  vertexShader: `varying vec3 vDir;
    void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D texA, texB; uniform mat3 invA, invB; uniform float mixAB; varying vec3 vDir;
    vec4 pano(sampler2D t, mat3 inv, vec3 d) {
      vec3 l = normalize(inv * d);
      float lon = atan(l.x, l.z);
      float lat = asin(clamp(l.y, -1.0, 1.0));
      return texture2D(t, vec2(lon / 6.28318530718 + 0.5, 0.5 + lat / 3.14159265359));
    }
    void main() {
      vec4 a = pano(texA, invA, vDir);
      gl_FragColor = mixAB > 0.001 ? mix(a, pano(texB, invB, vDir), mixAB) : a;
    }`,
  side: THREE.BackSide, depthTest: false, depthWrite: false,
});
const sphere = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), panoMat); // vDir is per pixel, so 64x32 is exact enough
sphere.frustumCulled = false;
sphere.renderOrder = -10;
scene.add(sphere);

// ------------------------------------------------------------------ occluders: the empty-house mesh (or walls) hide furniture behind walls
const occluderMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
const occluderDebugMat = new THREE.MeshBasicMaterial({ color: 0x33ccff, wireframe: true, transparent: true, opacity: 0.06 });
const occluders = new THREE.Group();
occluders.renderOrder = 0;
scene.add(occluders);
let meshOccluder = null;

function placeMesh(obj) {
  // Find the rotation that puts the scan positions inside the mesh (OBJ exports are often Y-up).
  const pts = house.panos.map((p) => new THREE.Vector3(...p.pos));
  const options = [new THREE.Matrix4(), new THREE.Matrix4().makeRotationX(Math.PI / 2), new THREE.Matrix4().makeRotationX(-Math.PI / 2)];
  let best = null;
  for (const R of options) {
    obj.matrix.copy(R); obj.matrixAutoUpdate = false; obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj).expandByScalar(0.3);
    const score = pts.filter((v) => box.containsPoint(v)).length;
    if (!best || score > best.score) best = { R, score };
  }
  obj.matrix.copy(best.R); obj.updateMatrixWorld(true);
  return best.score / pts.length;
}

async function loadOccluderMesh() {
  const m = (house.meshes || []).find((x) => /defurnished/i.test(x.file)) || (house.meshes || [])[0];
  if (!m) return false;
  try {
    const obj = await new OBJLoader().loadAsync(BASE + m.file);
    obj.traverse((c) => { if (c.isMesh) { c.material = occluderMat; c.renderOrder = 0; } });
    const fit = placeMesh(obj);
    console.log(`occluder ${m.file}: ${(fit * 100).toFixed(0)}% of scan points inside`);
    if (fit < 0.5) return false;
    meshOccluder = obj;
    occluders.add(obj);
    return true;
  } catch (e) {
    console.warn('mesh load failed', e);
    return false;
  }
}

function buildWallOccluders(floorId, floorZ) {
  occluders.clear();
  const f = house.floors.find((x) => x.id === floorId) || house.floors[0];
  if (!f) return;
  const H = 2.7;
  for (const w of f.walls) {
    if (w.type !== 'wall') continue;
    const a = new THREE.Vector2(...w.a), b = new THREE.Vector2(...w.b);
    const len = a.distanceTo(b);
    if (len < 0.05) continue;
    // split the wall around its doorways: [from, to, bottom, top] pieces along the wall
    const pieces = [];
    let cursor = 0;
    for (const o of [...(w.openings || [])].sort((x, y) => x.at - y.at)) {
      const c = o.at * len, half = (o.width || 0.9) / 2;
      if (c - half > cursor) pieces.push([cursor, c - half, 0, H]);
      const top = (o.bottom || 0) + (o.height || 2.05);
      if (top < H) pieces.push([c - half, c + half, top, H]);
      cursor = Math.max(cursor, c + half);
    }
    if (cursor < len) pieces.push([cursor, len, 0, H]);
    const dir = b.clone().sub(a).normalize();
    for (const [s, e, z0, z1] of pieces) {
      if (e - s < 0.02) continue;
      const box = new THREE.Mesh(new THREE.BoxGeometry(e - s, w.thickness || 0.12, z1 - z0), occluderMat);
      const mid = a.clone().addScaledVector(dir, (s + e) / 2);
      box.position.set(mid.x, mid.y, floorZ + (z0 + z1) / 2);
      box.rotation.z = Math.atan2(dir.y, dir.x);
      occluders.add(box);
    }
  }
}

// ------------------------------------------------------------------ debug overlay: walls drawn as lines
const wallLines = new THREE.Group();
scene.add(wallLines);
function buildWallLines(floorId, floorZ) {
  wallLines.clear();
  const f = house.floors.find((x) => x.id === floorId) || house.floors[0];
  if (!f) return;
  const pts = [];
  for (const w of f.walls) {
    for (const z of [floorZ + 0.01, floorZ + 2.4]) pts.push(w.a[0], w.a[1], z, w.b[0], w.b[1], z);
    pts.push(w.a[0], w.a[1], floorZ, w.a[0], w.a[1], floorZ + 2.4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xff3d00, depthTest: false }));
  lines.renderOrder = 20;
  wallLines.add(lines);
}

// ------------------------------------------------------------------ navigation pucks
const pucks = new THREE.Group();
scene.add(pucks);
const puckGeo = new THREE.RingGeometry(0.22, 0.3, 40);
const puckMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }); // hidden by furniture and walls, not by the floor
function buildPucks(p) {
  pucks.clear();
  let ids = p.neighbors && p.neighbors.length ? p.neighbors : house.panos
    .filter((q) => q.id !== p.id && q.floor === p.floor && Math.hypot(q.pos[0] - p.pos[0], q.pos[1] - p.pos[1]) < 6).map((q) => q.id);
  for (const id of ids) {
    const q = panoById.get(id);
    if (!q || !q.img) continue;
    const m = new THREE.Mesh(puckGeo, puckMat);
    m.position.set(q.pos[0], q.pos[1], q.floorZ + 0.03);
    m.userData.pano = q.id;
    m.renderOrder = 15;
    pucks.add(m);
  }
}

// ------------------------------------------------------------------ rooms
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function roomAt(x, y, floorId) {
  return house.rooms.find((r) => r.poly && r.poly.length > 2 && (!floorId || !r.floor || r.floor === floorId) && pointInPoly(x, y, r.poly));
}
const fmt = (v) => (v == null ? '?' : v.toFixed(1));
function roomText(r) {
  if (!r) return 'Hallway / unlabelled space';
  const d = r.dims || {};
  return `${r.label} · ${fmt(d.width)} × ${fmt(d.depth)} m${d.areaFloor ? ` · ${d.areaFloor.toFixed(1)} m²` : ''}`;
}

// ------------------------------------------------------------------ moving between panos
let current = null, showEmpty = true, transitioning = false;
const view = { yaw: 0, pitch: 0 };
const camPos = new THREE.Vector3();

function imgFor(p) { return (showEmpty && p.imgEmpty) || p.img; }

async function goTo(id, instant = false) {
  const p = panoById.get(id);
  if (!p || transitioning || (current && current.id === id)) return false;
  transitioning = true;
  try {
    await moveTo(p, instant);
    return true;
  } catch (e) {
    if (!current) throw e; // the first pano must load; later failures (Wi-Fi or tunnel blip, 404) keep you where you are
    console.warn(`[goTo] couldn't load ${p.id}; staying on ${current.id}`, e);
    return false;
  } finally {
    transitioning = false; // a failed load must not freeze navigation
  }
}

async function moveTo(p, instant) {
  const tex = await loadTex(imgFor(p));
  const inv = invLocalToModel(p);
  const from = camPos.clone(), to = new THREE.Vector3(...p.pos);
  const floorChanged = !current || current.floor !== p.floor;
  if (instant || !current) {
    panoMat.uniforms.texA.value = tex; panoMat.uniforms.invA.value = inv; panoMat.uniforms.mixAB.value = 0;
    camPos.copy(to);
  } else {
    panoMat.uniforms.texB.value = tex; panoMat.uniforms.invB.value = inv;
    const t0 = performance.now(), dur = 550;
    await new Promise((done) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / dur), e = k * k * (3 - 2 * k);
        camPos.lerpVectors(from, to, e);
        panoMat.uniforms.mixAB.value = e;
        if (k < 1) requestAnimationFrame(step); else done();
      };
      step();
    });
    panoMat.uniforms.texA.value = tex; panoMat.uniforms.invA.value = inv; panoMat.uniforms.mixAB.value = 0;
  }
  current = p;
  buildPucks(p);
  if (floorChanged) {
    buildWallLines(p.floor, p.floorZ);
    if (!meshOccluder) buildWallOccluders(p.floor, p.floorZ);
  }
  $('room').textContent = roomText(roomAt(p.pos[0], p.pos[1], p.floor));
  // preload neighbours
  for (const m of pucks.children) { const q = panoById.get(m.userData.pano); if (q) loadTex(imgFor(q)).catch(() => {}); }
  updateDebug();
}

async function refreshImages() {
  if (!current) return;
  panoMat.uniforms.texA.value = await loadTex(imgFor(current));
  panoMat.uniforms.invA.value = invLocalToModel(current);
}

// ------------------------------------------------------------------ furniture
const furniture = new THREE.Group();
scene.add(furniture);
let selected = null;
const selBox = new THREE.Box3Helper(new THREE.Box3(), 0x3ccf8e);
selBox.visible = false;
selBox.renderOrder = 30;
selBox.material.depthTest = false;
scene.add(selBox);

function floorZ() { return current ? current.floorZ : 0; }

function addFurniture(kind) {
  const item = buildFurniture(kind);
  const dir = new THREE.Vector3(Math.cos(view.yaw), Math.sin(view.yaw), 0);
  const pos = camPos.clone().addScaledVector(dir, 2.0);
  item.position.set(pos.x, pos.y, floorZ() + 0.004);
  item.rotation.z = view.yaw - Math.PI / 2; // front (-y) faces the viewer
  item.userData.floor = current && current.floor;
  furniture.add(item);
  select(item);
}

function select(item) {
  selected = item;
  checkFit();
}

function footprint(item) {
  const { w, d } = FURNITURE[item.userData.kind];
  const c = Math.cos(item.rotation.z), s = Math.sin(item.rotation.z);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
    .map(([x, y]) => [item.position.x + x * c - y * s, item.position.y + x * s + y * c]);
}

function checkFit() {
  const el = $('fit');
  if (!selected) { selBox.visible = false; el.textContent = ''; return; }
  const spec = FURNITURE[selected.userData.kind];
  const room = roomAt(selected.position.x, selected.position.y, selected.userData.floor);
  const ok = !!room && footprint(selected).every(([x, y]) => pointInPoly(x, y, room.poly));
  selBox.box.setFromObject(selected);
  selBox.material.color.set(ok ? 0x3ccf8e : 0xff5a5f);
  selBox.visible = true;
  el.className = ok ? 'ok' : 'bad';
  el.textContent = `${spec.name} ${spec.w.toFixed(2)} × ${spec.d.toFixed(2)} m — ` +
    (ok ? `fits in the ${room.label.toLowerCase()}` : room ? `doesn't fit in the ${room.label.toLowerCase()}` : 'outside a room');
}

function rotateSelected(deg = 45) {
  if (!selected) return;
  selected.rotation.z += THREE.MathUtils.degToRad(deg);
  checkFit();
}

// ------------------------------------------------------------------ pointer: look around, drag furniture, click pucks
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
function setNDC(x, y) { ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera); }
function hitFloor() {
  floorPlane.constant = -floorZ();
  const p = new THREE.Vector3();
  return ray.ray.intersectPlane(floorPlane, p) ? p : null;
}
function hitFurniture() {
  const h = ray.intersectObjects(furniture.children, true)[0];
  if (!h) return null;
  let o = h.object;
  while (o.parent && o.parent !== furniture) o = o.parent;
  return o;
}

let drag = null; // {mode:'look'|'item', ...}
const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  setNDC(e.clientX, e.clientY);
  const item = hitFurniture();
  if (item) {
    select(item);
    const f = hitFloor();
    drag = { mode: 'item', item, off: f ? new THREE.Vector2(item.position.x - f.x, item.position.y - f.y) : new THREE.Vector2() };
  } else {
    drag = { mode: 'look', x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, yaw: view.yaw, pitch: view.pitch };
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.mode === 'item') {
    setNDC(e.clientX, e.clientY);
    const f = hitFloor();
    if (f) { drag.item.position.x = f.x + drag.off.x; drag.item.position.y = f.y + drag.off.y; checkFit(); }
  } else if (!gyro.on) {
    const k = (camera.fov / 75) * 0.0045;
    view.yaw = drag.yaw + (e.clientX - drag.x) * k;
    view.pitch = THREE.MathUtils.clamp(drag.pitch + (e.clientY - drag.y) * k, -1.45, 1.45);
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (drag && drag.mode === 'look' && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) {
    setNDC(e.clientX, e.clientY);
    const h = ray.intersectObjects(pucks.children)[0];
    if (h) goTo(h.object.userData.pano);
    else { selected = null; checkFit(); }
  }
  drag = null;
});
canvas.addEventListener('dblclick', (e) => {
  setNDC(e.clientX, e.clientY);
  const item = hitFurniture();
  if (item) { select(item); rotateSelected(45); }
});
canvas.addEventListener('wheel', (e) => {
  camera.fov = THREE.MathUtils.clamp(camera.fov + e.deltaY * 0.03, 35, 95);
  camera.updateProjectionMatrix();
}, { passive: true });

// ------------------------------------------------------------------ gyro (phone orientation)
const gyro = { on: false, q: new THREE.Quaternion(), offset: 0, have: false };
const _euler = new THREE.Euler(), _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _zee = new THREE.Vector3(0, 0, 1), _q0 = new THREE.Quaternion();
const yUpToZUp = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
function onOrient(ev) {
  if (ev.alpha == null) return;
  const d = THREE.MathUtils.degToRad;
  const orient = d(screen.orientation ? screen.orientation.angle : window.orientation || 0);
  _euler.set(d(ev.beta), d(ev.alpha), -d(ev.gamma), 'YXZ');
  gyro.q.setFromEuler(_euler).multiply(_q1).multiply(_q0.setFromAxisAngle(_zee, -orient));
  gyro.q.premultiply(yUpToZUp);
  gyro.have = true;
}
async function toggleGyro() {
  if (!gyro.on) {
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      const r = await DeviceOrientationEvent.requestPermission().catch(() => 'denied');
      if (r !== 'granted') { alert('Motion access was denied. On iPhone this needs HTTPS and a tap to allow.'); return; }
    }
    addEventListener('deviceorientation', onOrient);
    gyro.on = true;
    gyro.offset = null; // set on first reading so you keep facing the same way
  } else {
    removeEventListener('deviceorientation', onOrient);
    gyro.on = false;
  }
  $('bGyro').classList.toggle('on', gyro.on);
}

// ------------------------------------------------------------------ headset (side by side)
let vr = false;
async function toggleVR(force) {
  vr = force ?? !vr;
  document.body.classList.toggle('vr', vr);
  if (vr) {
    if (!gyro.on) await toggleGyro();
    try { await document.documentElement.requestFullscreen?.(); } catch {}
    try { await screen.orientation?.lock?.('landscape'); } catch {}
  } else {
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch {}
  }
  renderer.setSize(innerWidth, innerHeight);
  stereo.setSize(innerWidth, innerHeight);
  if (handsApi) {
    const want = vr ? 'environment' : handCam;
    if (handsApi.facingMode !== want) await restartHands(want); else showCamPreview(want);
  }
  resetPerfCap();
}

// ------------------------------------------------------------------ hands: two tracked hands, drawn in 3D in front of you
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
const skinMat = new THREE.MeshStandardMaterial({ color: 0xf0c3a2, roughness: 0.55, transparent: true, opacity: 0.93 });
const pinchMat = new THREE.MeshStandardMaterial({ color: 0xffc400, emissive: 0x664400, roughness: 0.4 });
const jointGeo = new THREE.SphereGeometry(1, 12, 10);
const boneGeo = new THREE.CylinderGeometry(1, 1, 1, 10);
const handViz = {}, handCursors = {}, grabs = {}, prevPinch = {}, aims = {};
// A2: a pinch grabs the nearest piece within 0.4 m of the pinch point (no need to hit it exactly), and teleports
// only after the hand has pointed at the same puck for 300 ms (the cursor turns green), so a missed grab never jumps.
const GRAB_RADIUS = 0.4, PUCK_RADIUS = 0.45, PUCK_DWELL_MS = 300;
let handsApi = null, handsList = [], twist = null;
let handRay = null; // walkin.handRay: {origin, dir, side} of the active hand (pinching, else the first seen), or null
let handCam = 'user'; // handheld: front camera sees your hand; in the headset we switch to the back camera
// A8: 'real' = your hands cut out of the camera (realhands.js); 'skeleton' = 3D joints. Debug shows the skeleton too.
let handStyle = 'real';
const realHands = createRealHands($('handcam'));
function setHandStyle(s) {
  handStyle = s === 'skeleton' ? 'skeleton' : 'real';
  if (handStyle !== 'real') realHands.clear();
  const b = $('bHandStyle');
  if (b) b.textContent = handStyle === 'real' ? '🖐 Real hands' : '🦴 Skeleton';
}

function makeHandViz() {
  const g = new THREE.Group();
  g.userData.joints = Array.from({ length: 21 }, (_, i) => {
    const m = new THREE.Mesh(jointGeo, skinMat);
    m.scale.setScalar(i === 0 ? 0.016 : [4, 8, 12, 16, 20].includes(i) ? 0.0085 : 0.0105);
    m.renderOrder = 50; g.add(m); return m;
  });
  g.userData.bones = BONES.map(() => { const m = new THREE.Mesh(boneGeo, skinMat); m.renderOrder = 50; g.add(m); return m; });
  g.visible = false;
  scene.add(g);
  return g;
}
function makeCursor() {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.1, 32),
    new THREE.MeshBasicMaterial({ color: 0x00e5ff, depthTest: false, transparent: true, opacity: 0.9 }));
  m.renderOrder = 40; m.visible = false; scene.add(m); return m;
}

const _hv = new THREE.Vector3(), _yAxis = new THREE.Vector3(0, 1, 0);
function screenToWorld(sx, sy, depth, out) {
  return out.set(sx * 2 - 1, -(sy * 2 - 1), 0.5).unproject(camera).sub(camera.position).normalize()
    .multiplyScalar(depth).add(camera.position);
}
function drawHands() {
  const seen = new Set();
  for (const h of handStyle === 'skeleton' || debug ? handsList : []) {
    seen.add(h.side);
    const g = handViz[h.side] || (handViz[h.side] = makeHandViz());
    g.visible = true;
    // metric distance to the camera from hands.js (world landmarks); else bigger in the image = closer
    const d = THREE.MathUtils.clamp(h.depth ?? 0.42 * (0.2 / h.size), 0.22, 0.8);
    const P = h.pts.map((p, i) => screenToWorld(p.x, p.y, d * (1 + p.z * 1.2), g.userData.joints[i].position));
    for (const i of [4, 8]) g.userData.joints[i].material = h.pinch ? pinchMat : skinMat;
    BONES.forEach(([a, b], k) => {
      const m = g.userData.bones[k];
      m.position.copy(P[a]).add(P[b]).multiplyScalar(0.5);
      _hv.subVectors(P[b], P[a]);
      const len = _hv.length();
      m.scale.set(a === 0 ? 0.008 : 0.0065, len, a === 0 ? 0.008 : 0.0065);
      if (len > 1e-5) m.quaternion.setFromUnitVectors(_yAxis, _hv.divideScalar(len));
    });
  }
  for (const [side, g] of Object.entries(handViz)) if (!seen.has(side)) g.visible = false;
}

const _gbox = new THREE.Box3();
function nearestFurniture(f) { // the piece whose footprint is closest to floor point f, if within GRAB_RADIUS
  let best = null, bestD = GRAB_RADIUS;
  for (const o of furniture.children) {
    if (!o.userData?.kind || o.visible === false) continue;
    _gbox.setFromObject(o);
    const d = Math.hypot(Math.max(_gbox.min.x - f.x, 0, f.x - _gbox.max.x), Math.max(_gbox.min.y - f.y, 0, f.y - _gbox.max.y));
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}
function puckAt(f) { return f ? pucks.children.find((m) => Math.hypot(m.position.x - f.x, m.position.y - f.y) < PUCK_RADIUS) || null : null; }

function onHands(list, cam) {
  perf.hands++;
  handsList = list;
  realHands.draw(handStyle === 'real' ? list : [], cam, vr);
  camera.updateMatrixWorld();
  const present = new Set(list.map((h) => h.side));
  for (const side of Object.keys(handCursors)) if (!present.has(side)) handCursors[side].visible = false;
  for (const side of Object.keys(grabs)) if (!present.has(side)) delete grabs[side];
  for (const side of Object.keys(prevPinch)) if (!present.has(side)) delete prevPinch[side];
  for (const side of Object.keys(aims)) if (!present.has(side)) delete aims[side];

  const act = list.find((h) => h.pinch) || list[0];
  if (act) {
    ndc.set(act.x * 2 - 1, -(act.y * 2 - 1));
    ray.setFromCamera(ndc, camera);
    handRay = { origin: ray.ray.origin.toArray(), dir: ray.ray.direction.toArray(), side: act.side };
  } else handRay = null;

  for (const h of list) {
    ndc.set(h.x * 2 - 1, -(h.y * 2 - 1));
    ray.setFromCamera(ndc, camera);
    const f = hitFloor();
    h.floor = f;
    const cur = handCursors[h.side] || (handCursors[h.side] = makeCursor());
    cur.visible = !!f;
    if (f) cur.position.set(f.x, f.y, f.z + 0.02);
    const near = puckAt(f), now = performance.now();
    if (aims[h.side]?.puck !== near) aims[h.side] = { puck: near, since: now };
    const puckReady = !!near && now - aims[h.side].since >= PUCK_DWELL_MS;
    cur.material.color.set(h.pinch ? 0xffc400 : puckReady ? 0x3dff8a : 0x00e5ff);
    cur.scale.setScalar(h.pinch ? 0.7 : 1);

    if (h.pinch && !prevPinch[h.side]) {
      // pinch started: grab the piece you point at; a held aim at a puck (300 ms) means teleport; otherwise grab
      // the nearest piece within 0.4 m, or the selected piece if it's close
      let item = hitFurniture();
      if (!item && !puckReady && f) item = nearestFurniture(f);
      if (!item && !puckReady && selected && f && Math.hypot(selected.position.x - f.x, selected.position.y - f.y) < 1.2) item = selected;
      if (item && f) {
        select(item);
        grabs[h.side] = { item, off: new THREE.Vector2(item.position.x - f.x, item.position.y - f.y) };
      } else if (puckReady) {
        aims[h.side] = null;
        goTo(near.userData.pano);
      }
    } else if (!h.pinch) {
      delete grabs[h.side];
    }
    prevPinch[h.side] = h.pinch;
  }

  // both hands on the same piece: twist to rotate it, move both to carry it
  const [ga, gb] = Object.values(grabs);
  const ha = list.find((h) => grabs[h.side] === ga), hb = list.find((h) => grabs[h.side] === gb);
  if (ga && gb && ga.item === gb.item && ha?.floor && hb?.floor) {
    const angle = Math.atan2(hb.floor.y - ha.floor.y, hb.floor.x - ha.floor.x);
    const mid = new THREE.Vector2((ha.floor.x + hb.floor.x) / 2, (ha.floor.y + hb.floor.y) / 2);
    if (!twist || twist.item !== ga.item) {
      twist = { item: ga.item, a0: angle, r0: ga.item.rotation.z, off: new THREE.Vector2(ga.item.position.x - mid.x, ga.item.position.y - mid.y) };
    }
    ga.item.rotation.z = twist.r0 + (angle - twist.a0);
    ga.item.position.x = mid.x + twist.off.x;
    ga.item.position.y = mid.y + twist.off.y;
    checkFit();
    return;
  }
  twist = null;
  for (const h of list) {
    const g = grabs[h.side];
    if (g && h.floor) {
      g.item.position.x = h.floor.x + g.off.x;
      g.item.position.y = h.floor.y + g.off.y;
      checkFit();
    }
  }
}

function showCamPreview(mode) {
  const v = $('handcam');
  v.style.display = handsApi && !vr ? 'block' : 'none';
  v.style.transform = mode === 'user' ? 'scaleX(-1)' : 'none';
}
async function restartHands(mode) {
  if (handsApi) handsApi.stop();
  const { startHands } = await import(`./hands.js?v=${Date.now()}`); // never use a cached copy
  handsApi = await startHands({ video: $('handcam'), facingMode: mode, onHands, maxHz: HAND_HZ_MAX,
    aspect: () => (vr ? innerWidth / 2 : innerWidth) / innerHeight }); // one eye in the headset
  showCamPreview(mode);
  resetPerfCap(); // loading the hand model stalls a few frames; don't let that pin the resolution low
}
async function toggleHands() {
  const btn = $('bHands');
  if (handsApi) {
    handsApi.stop(); handsApi = null; handsList = []; handRay = null;
    realHands.clear();
    Object.values(handViz).forEach((g) => (g.visible = false));
    Object.values(handCursors).forEach((c) => (c.visible = false));
    btn.classList.remove('on'); showCamPreview(handCam);
    resetPerfCap();
    return;
  }
  btn.textContent = '✋ Loading…';
  try {
    await restartHands(vr ? 'environment' : handCam);
    btn.classList.add('on');
  } catch (e) {
    alert('Hand tracking failed to start: ' + e.message + '\n(Camera needs HTTPS or localhost.)');
  }
  btn.textContent = '✋ Hands';
}
async function toggleCam() {
  handCam = handCam === 'user' ? 'environment' : 'user';
  $('bCam').textContent = handCam === 'user' ? '📷 Front' : '📷 Back';
  if (handsApi && !vr) await restartHands(handCam);
}

// ------------------------------------------------------------------ debug / calibration
let debug = false;
function updateDebug() {
  const el = $('debug');
  el.style.display = debug ? 'block' : 'none';
  wallLines.visible = debug;
  if (meshOccluder) meshOccluder.traverse((c) => { if (c.isMesh) c.material = debug ? occluderDebugMat : occluderMat; });
  if (!debug || !current) return;
  const q = current.rot ? current.rot.map((v) => v.toFixed(3)).join(', ') : 'none';
  el.textContent =
`ALIGN: orange lines are the walls from the API.
Turn them until they sit on the walls in the photo.
  Q  quaternion: ${['off', 'as given', 'inverted'][cal.qMode]}
  M  mirror: ${cal.mirror ? 'on' : 'off'}
  [ ]  yaw -/+90°   , .  yaw -/+2°   → ${cal.yaw}°
Check a 2nd scan point after it lines up.
cal=${JSON.stringify(cal)}

pano ${current.label}  ${current.id}
pos ${current.pos.map((v) => v.toFixed(2)).join(', ')}  floor z ${current.floorZ.toFixed(2)}
rot ${q}
occluder: ${meshOccluder ? 'empty-house mesh' : 'walls'}`;
}
async function applyCal() {
  localStorage.setItem(CAL_KEY, JSON.stringify(cal));
  if (current) panoMat.uniforms.invA.value = invLocalToModel(current);
  updateDebug();
}
addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') return rotateSelected(e.shiftKey ? -45 : 45);
  if (e.key === 'Delete' || e.key === 'Backspace') return deleteSelected();
  if (!debug) return;
  if (e.key === 'q' || e.key === 'Q') cal.qMode = (cal.qMode + 1) % 3;
  else if (e.key === 'm' || e.key === 'M') cal.mirror = cal.mirror ? 0 : 1;
  else if (e.key === '[') cal.yaw -= 90;
  else if (e.key === ']') cal.yaw += 90;
  else if (e.key === ',') cal.yaw -= 2;
  else if (e.key === '.') cal.yaw += 2;
  else return;
  cal.yaw = ((cal.yaw % 360) + 360) % 360;
  applyCal();
});

function deleteSelected() {
  if (!selected) return;
  furniture.remove(selected);
  selected = null;
  checkFit();
}

// ------------------------------------------------------------------ frame rate (A1): readout in Debug, adaptive resolution
// The readout shows with Debug on (it stays visible in the headset) or always with ?fps in the URL.
// Resolution drops 0.25x after 2 s under 45 fps and climbs back after 4 s over 57 fps, but never back to a
// level that was too slow, until the mode changes (headset, hands, resize).
// (MAX_PR, perf, setPixelRatio and resetPerfCap are declared next to the renderer at the top.)
// In the headset the readout is drawn once per eye: a second copy sits in the right half of the screen.
const fpsEls = [0, 1].map((i) => {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:${i ? 'calc(50% + 8px)' : '8px'};bottom:8px;z-index:6;padding:3px 7px;`
    + 'border-radius:6px;pointer-events:none;font:11px/1.35 ui-monospace,Menlo,monospace;color:#fff;'
    + 'background:rgba(0,0,0,.6);white-space:pre;display:none';
  document.body.appendChild(el);
  return el;
});
const fpsAlways = params.has('fps');

function tickPerf() {
  perf.frames++;
  const now = performance.now(), dt = now - perf.t0;
  if (dt < 1000) return;
  const fps = (perf.frames * 1000) / dt, handHz = (perf.hands * 1000) / dt;
  perf.frames = perf.hands = 0; perf.t0 = now;
  if (dt > 2000 || document.hidden) return; // the tab was in the background: not a real measurement
  perf.slow = fps < 45 ? perf.slow + 1 : 0;
  perf.fast = fps > 57 ? perf.fast + 1 : 0;
  // Too slow: resolution steps down to 1x first, then hand detection 5 Hz at a time, then resolution again.
  // Fast enough: resolution climbs back first, then the hand rate (each never above the last level that was slow).
  const handHzNow = handsApi?.stats?.maxHz;
  if (perf.slow >= 2) {
    perf.slow = 0;
    if (handHzNow > HAND_HZ_MIN && perf.pr <= 1) {
      perf.handCap = handHzNow - 5; handsApi.setMaxHz(perf.handCap); console.log(`[perf] hand detection ${perf.handCap} Hz`);
    } else if (perf.pr > MIN_PR) { perf.cap = perf.pr - 0.25; setPixelRatio(perf.cap); }
  } else if (perf.fast >= 4) {
    perf.fast = 0;
    if (perf.pr < perf.cap) setPixelRatio(perf.pr + 0.25);
    else if (handHzNow < perf.handCap) { handsApi.setMaxHz(handHzNow + 5); console.log(`[perf] hand detection ${handHzNow + 5} Hz`); }
  }
  const show = debug || fpsAlways;
  fpsEls.forEach((el, i) => { el.style.display = show && (i === 0 || vr) ? 'block' : 'none'; });
  if (!show) return;
  const px = renderer.getDrawingBufferSize(new THREE.Vector2());
  const text = `${fps.toFixed(0)} fps · ${perf.pr}x (${px.x}×${px.y})${vr ? ' · headset' : ''}\n`
    + `hands ${handsApi ? `${handHz.toFixed(0)}/s (max ${handsApi.stats?.maxHz}), ${(handsApi.stats?.ms ?? 0).toFixed(0)} ms each, `
      + `${handsList.length} seen${handsList.map((h) => (h.depth ? ` ${h.side[0]} ${(h.depth * 100).toFixed(0)} cm` : '')).join('')}` : 'off'} · `
    + `${renderer.info.render.calls} draws${vr ? '/eye' : ''}, ${(renderer.info.render.triangles / 1000).toFixed(0)}k tris`;
  fpsEls.forEach((el) => { el.textContent = text; });
}

// ------------------------------------------------------------------ buttons
document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => addFurniture(b.dataset.add)));
$('bRotate').onclick = () => rotateSelected(45);
$('bDelete').onclick = deleteSelected;
$('bGyro').onclick = toggleGyro;
$('bVR').onclick = () => toggleVR();
$('exitvr').onclick = () => toggleVR(false);
$('bHands').onclick = toggleHands;
$('bCam').onclick = toggleCam;
if ($('bHandStyle')) $('bHandStyle').onclick = () => setHandStyle(handStyle === 'real' ? 'skeleton' : 'real');
$('bDebug').onclick = () => { debug = !debug; $('bDebug').classList.toggle('on', debug); updateDebug(); };
$('bEmpty').onclick = async () => {
  showEmpty = !showEmpty;
  $('bEmpty').classList.toggle('on', showEmpty);
  $('bEmpty').textContent = showEmpty ? 'Empty' : 'As scanned';
  await refreshImages();
};
if (!house.panos.some((p) => p.imgEmpty)) { showEmpty = false; $('bEmpty').textContent = 'As scanned'; $('bEmpty').classList.remove('on'); }

// ------------------------------------------------------------------ main loop
const _dir = new THREE.Vector3(), _fwd = new THREE.Vector3();
function frame() {
  requestAnimationFrame(frame);
  camera.position.copy(camPos);
  if (gyro.on && gyro.have) {
    if (gyro.offset === null) {
      _fwd.set(0, 0, -1).applyQuaternion(gyro.q);
      gyro.offset = view.yaw - Math.atan2(_fwd.y, _fwd.x);
    }
    camera.quaternion.setFromAxisAngle(_zee, gyro.offset).multiply(gyro.q);
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    view.yaw = Math.atan2(_fwd.y, _fwd.x);
  } else {
    _dir.set(Math.cos(view.pitch) * Math.cos(view.yaw), Math.cos(view.pitch) * Math.sin(view.yaw), Math.sin(view.pitch));
    camera.lookAt(_dir.add(camPos));
  }
  sphere.position.copy(camPos);
  camera.updateMatrixWorld();
  drawHands();
  if (selected && selBox.visible) selBox.box.setFromObject(selected);
  if (vr) stereo.render(scene, camera); else renderer.render(scene, camera);
  tickPerf();
}

// ------------------------------------------------------------------ start
const start = params.get('p') && panoById.get(params.get('p'))
  || (() => { // start in the biggest room
    const big = [...house.rooms].sort((a, b) => ((b.dims || {}).areaFloor || 0) - ((a.dims || {}).areaFloor || 0))[0];
    return (big && house.panos.find((p) => p.img && roomAt(p.pos[0], p.pos[1], p.floor) === big)) || house.panos.find((p) => p.img);
  })();
await loadOccluderMesh();
await goTo(start.id, true);
$('loading').remove();
frame();
window.walkin = { house, cal, goTo, addFurniture, furniture, camera, scene, view, roomAt, select, checkFit, FURNITURE,
  get current() { return current; }, get selected() { return selected; },
  get handRay() { return handRay; },
  get hands() { return handsList; }, // latest tracked hands: {side, pts[21] in 0..1 screen units, x, y, pinch}
  get handStyle() { return handStyle; },
  set handStyle(s) { setHandStyle(s); },
}; // hooks for agent.js and other modules
dispatchEvent(new Event('walkin:ready')); // modules can wait for this instead of polling for window.walkin
