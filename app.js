// Walk-In: walk a Matterport house (empty or as scanned) and place real-size furniture in it.
// World frame = Matterport model frame: metres, Z up. Every pano is drawn around the camera with its own rotation,
// so furniture placed once lines up from every scan position.
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { StereoEffect } from 'three/addons/effects/StereoEffect.js';
import { FURNITURE, buildFurniture } from './furniture.js';
import { createRealHands } from './realhands.js';
import { createRadial } from './radial.js';
import { liftOff, setDown } from './tabletop.js';

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

// A6 step 2: wall pieces the move's proxy room can hold. 64 puts 99% of level rays on the floor plan's nearest wall
// in the 3 prepped houses (24 did 83%); the loop stops at nSeg and only runs during a move.
const A6_SEGS = 64;
const panoMat = new THREE.ShaderMaterial({
  uniforms: {
    texA: { value: null }, texB: { value: null }, invA: { value: new THREE.Matrix3() }, invB: { value: new THREE.Matrix3() },
    mixAB: { value: 0 },
    // A6: depth-aware move. depthAB = 1 while walking between two panos on the same floor: camP is the moving camera,
    // posA / posB where the two photos were taken, proxy = (floor z, ceiling z, wall radius, -), mid = centre of the walls.
    depthAB: { value: 0 }, camP: { value: new THREE.Vector3() }, posA: { value: new THREE.Vector3() },
    posB: { value: new THREE.Vector3() }, proxy: { value: new THREE.Vector4(0, 2.6, 3, 0) }, mid: { value: new THREE.Vector2() },
    // A6 step 2: the real wall pieces near the path, (ax, ay, bx, by) each, doorways left open; the round wall is the fallback
    segs: { value: Array.from({ length: A6_SEGS }, () => new THREE.Vector4()) }, nSeg: { value: 0 },
  },
  vertexShader: `varying vec3 vDir;
    void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D texA, texB; uniform mat3 invA, invB; uniform float mixAB, depthAB;
    uniform vec3 camP, posA, posB; uniform vec4 proxy; uniform vec2 mid; uniform vec4 segs[${A6_SEGS}]; uniform int nSeg;
    varying vec3 vDir;
    vec4 pano(sampler2D t, mat3 inv, vec3 d) {
      vec3 l = normalize(inv * d);
      float lon = atan(l.x, l.z);
      float lat = asin(clamp(l.y, -1.0, 1.0));
      return texture2D(t, vec2(lon / 6.28318530718 + 0.5, 0.5 + lat / 3.14159265359));
    }
    // Where this pixel's ray from the moving camera meets a simple room: floor and ceiling planes, the floor plan's
    // walls near the path, and a round wall around it for rays that leave through a doorway. Each photo is then read
    // from where it was taken, so the floor slides under you like walking and the photos agree on the walls too.
    vec3 hitRoom(vec3 d) {
      float t = 1000.0;
      if (d.z < -0.0001) t = (proxy.x - camP.z) / d.z;
      else if (d.z > 0.0001) t = (proxy.y - camP.z) / d.z;
      vec2 o = camP.xy - mid, h = d.xy;
      float a = dot(h, h);
      if (a > 0.000001) {
        float b = dot(h, o), c = dot(o, o) - proxy.z * proxy.z;
        t = min(t, (-b + sqrt(max(b * b - a * c, 0.0))) / a);
      }
      for (int i = 0; i < ${A6_SEGS}; i++) { // real walls: nearest crossing of the ray with a wall piece
        if (i >= nSeg) break;
        vec2 sa = segs[i].xy;
        vec2 e = segs[i].zw - sa;
        vec2 w = sa - camP.xy;
        float den = h.x * e.y - h.y * e.x;
        if (abs(den) < 0.000001) continue;
        float tw = (w.x * e.y - w.y * e.x) / den, s = (w.x * h.y - w.y * h.x) / den;
        if (tw > 0.0 && s >= 0.0 && s <= 1.0) t = min(t, tw);
      }
      return camP + d * max(t, 0.01);
    }
    void main() {
      vec3 dA = vDir, dB = vDir;
      if (depthAB > 0.5) { vec3 P = hitRoom(normalize(vDir)); dA = P - posA; dB = P - posB; }
      if (mixAB <= 0.001) gl_FragColor = pano(texA, invA, dA);
      else if (mixAB >= 0.999) gl_FragColor = pano(texB, invB, dB);
      else gl_FragColor = mix(pano(texA, invA, dA), pano(texB, invB, dB), mixAB);
    }`,
  side: THREE.BackSide, depthTest: false, depthWrite: false,
});
const sphere = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), panoMat); // vDir is per pixel, so 64x32 is exact enough
sphere.frustumCulled = false;
sphere.renderOrder = -10;
scene.add(sphere);

// A6 step 3: a black ball around the camera for the blink (both eyes are inside it in the headset). Drawn over the
// pano, furniture and walls; the radial menu stays on top.
const dimmer = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 8), new THREE.MeshBasicMaterial({
  color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false, depthWrite: false }));
dimmer.renderOrder = 45;
dimmer.frustumCulled = false;
dimmer.visible = false;
scene.add(dimmer);
function dimTo(target, ms) {
  const m = dimmer.material, start = m.opacity, t0 = performance.now();
  dimmer.visible = true;
  return new Promise((done) => {
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      m.opacity = start + (target - start) * k * k * (3 - 2 * k);
      if (k < 1) requestAnimationFrame(step); else { dimmer.visible = target > 0; done(); }
    };
    step();
  });
}

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

// A6 step 2: the solid wall pieces of a floor as [ax, ay, bx, by] (doorways and dividers left open, windows kept:
// the photo shows them on the wall).
function solidWalls(floorId) {
  const f = house.floors.find((x) => x.id === floorId), segs = [];
  for (const w of f ? f.walls : []) {
    if (w.type !== 'wall') continue;
    const ax = w.a[0], ay = w.a[1], dx = w.b[0] - ax, dy = w.b[1] - ay, len = Math.hypot(dx, dy);
    if (len < 0.05) continue;
    const piece = (s, e) => { if (e - s > 0.05) segs.push([ax + (dx * s) / len, ay + (dy * s) / len, ax + (dx * e) / len, ay + (dy * e) / len]); };
    let cursor = 0;
    for (const o of [...(w.openings || [])].sort((x, y) => x.at - y.at)) {
      if (o.type === 'window') continue;
      const c = o.at * len, half = (o.width || 0.9) / 2;
      piece(cursor, c - half);
      cursor = Math.max(cursor, c + half);
    }
    piece(cursor, len);
  }
  return segs;
}

// A6 step 3: does the straight path from -> to go through a solid wall piece (not a doorway)?
function crossesWall(floorId, from, to) {
  const hx = to.x - from.x, hy = to.y - from.y;
  return solidWalls(floorId).some(([ax, ay, bx, by]) => {
    const ex = bx - ax, ey = by - ay, den = hx * ey - hy * ex;
    if (Math.abs(den) < 1e-9) return false;
    const wx = ax - from.x, wy = ay - from.y, t = (wx * ey - wy * ex) / den, s = (wx * hy - wy * hx) / den;
    return t > 0.02 && t < 0.98 && s > 0.02 && s < 0.98;
  });
}

// A6 step 2: the wall pieces nearest the path from -> to first, written into `out` as (ax, ay, bx, by). Returns how many.
function wallSegsNear(floorId, from, to, out) {
  const near = (px, py, ax, ay, bx, by) => { // distance from a point to a segment
    const ex = bx - ax, ey = by - ay, L = ex * ex + ey * ey || 1;
    const k = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / L));
    return Math.hypot(px - ax - k * ex, py - ay - k * ey);
  };
  const segs = solidWalls(floorId);
  const pathGap = (s) => Math.min( // distance between a wall piece and the path (the camera only ever stands on it)
    near(from.x, from.y, ...s), near(to.x, to.y, ...s),
    near(s[0], s[1], from.x, from.y, to.x, to.y), near(s[2], s[3], from.x, from.y, to.x, to.y));
  const ranked = segs.map((s) => [pathGap(s), s]).filter(([d]) => d < 12).sort((a, b) => a[0] - b[0]).slice(0, out.length);
  ranked.forEach(([, s], i) => out[i].set(s[0], s[1], s[2], s[3]));
  return ranked.length;
}

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
    if (dimmer.material.opacity > 0.01) dimTo(0, 150); // ...or leave the screen dark mid-blink
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
    const U = panoMat.uniforms;
    U.texB.value = tex; U.invB.value = inv;
    // A6: on the same floor, walk through a simple room (floor, ceiling, walls around the path) instead of
    // cross-fading two flat photos, and take longer for a longer step. ?a6=off keeps the plain fade for every move.
    // A6 step 3: stairs, 10 m+ jumps and moves through a wall (most of the agent's "go to the kitchen") blink instead:
    // a quick dip to dark with the cut in the middle, the usual VR comfort teleport, so nothing slides through a wall.
    const dist = from.distanceTo(to), a6 = params.get('a6') !== 'off';
    const blink = a6 && (floorChanged || dist >= 10 || crossesWall(p.floor, from, to));
    const deep = a6 && !blink && dist > 0.05;
    if (blink) {
      await dimTo(1, 150);
      U.texA.value = tex; U.invA.value = inv; U.mixAB.value = 0; U.depthAB.value = 0;
      camPos.copy(to);
      buildPucks(p); // the new pano's pucks, not the old ones, while it fades in
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // new photo on the GPU while dark
      await dimTo(0, 220);
    } else if (deep) {
      const room = roomAt(to.x, to.y, p.floor) || roomAt(from.x, from.y, p.floor), d = room?.dims || {};
      const ceil = Math.max(p.floorZ + (d.height > 1.8 && d.height < 6 ? d.height : 2.6), Math.max(from.z, to.z) + 0.3);
      const wallR = THREE.MathUtils.clamp(d.width && d.depth ? Math.hypot(d.width, d.depth) / 2 : 3, 2.5, 8);
      U.nSeg.value = params.get('a6') === 'round' ? 0 : wallSegsNear(p.floor, from, to, U.segs.value);
      // with real walls, the round wall only catches rays that leave through a doorway: put it far out
      U.proxy.value.set(p.floorZ, ceil, U.nSeg.value ? 12 : Math.max(wallR, dist / 2 + 1), 0);
      U.mid.value.set((from.x + to.x) / 2, (from.y + to.y) / 2);
      U.posA.value.copy(from); U.posB.value.copy(to); U.camP.value.copy(from);
    }
    U.depthAB.value = deep ? 1 : 0;
    const t0 = performance.now(), dur = THREE.MathUtils.clamp(420 + 160 * dist, 550, 950);
    if (!blink) await new Promise((done) => { // a blink has already cut to the new photo
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / dur), e = k * k * (3 - 2 * k);
        camPos.lerpVectors(from, to, e);
        U.camP.value.copy(camPos);
        // with the photos lined up on the room, hold each one longer and swap in the middle (less ghosting)
        U.mixAB.value = deep ? THREE.MathUtils.smoothstep(e, 0.2, 0.8) : e;
        if (k < 1) requestAnimationFrame(step); else done();
      };
      step();
    });
    U.texA.value = tex; U.invA.value = inv; U.mixAB.value = 0; U.depthAB.value = 0;
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
    liftOff(item); // #58: a plant on a table comes off it into your hand
    const f = hitFloor(), P = phys();
    drag = { mode: 'item', item, off: f ? new THREE.Vector2(item.position.x - f.x, item.position.y - f.y) : new THREE.Vector2(),
      phys: P && P.grab(item, 'mouse') ? P : null };
  } else {
    drag = { mode: 'look', x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, yaw: view.yaw, pitch: view.pitch };
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.mode === 'item') {
    setNDC(e.clientX, e.clientY);
    const f = hitFloor();
    if (f) {
      const x = f.x + drag.off.x, y = f.y + drag.off.y;
      drag.tx = x; drag.ty = y;
      if (drag.phys) drag.phys.moveTarget('mouse', [x, y]); else { drag.item.position.x = x; drag.item.position.y = y; }
      checkFit();
    }
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
  if (drag?.phys) drag.phys.release('mouse'); // mouse sets pieces down where they are: no fling
  if (drag?.mode === 'item' && setDown(drag.item, drag.tx ?? drag.item.position.x, drag.ty ?? drag.item.position.y)) checkFit();
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
// alert() is a modal nobody can dismiss with the phone in the headset (#2). There the message is shown once per
// eye for 10 s (tap to close); otherwise it's a plain alert. Every message is also kept for the ?a1=1 report.
const warnings = [];
function warn(msg) {
  warnings.push(msg);
  console.warn(msg);
  if (!vr) { alert(msg); return; }
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;background:#000c;color:#fff;'
    + 'font:600 18px system-ui;text-align:center;white-space:pre-line';
  for (let i = 0; i < 2; i++) {
    const eye = document.createElement('div');
    eye.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;padding:10%';
    eye.textContent = msg;
    box.appendChild(eye);
  }
  box.onclick = () => box.remove();
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 10000);
}
async function toggleGyro() {
  if (!gyro.on) {
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      const r = await DeviceOrientationEvent.requestPermission().catch(() => 'denied');
      if (r !== 'granted') { warn('Motion access was denied. On iPhone this needs HTTPS and a tap to allow.'); return; }
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
// A2 step 3: with Shaurya's physics.js loaded (walkin.physics, #44) hands and mouse give it a *target* instead of
// setting the position, so a piece stops at walls, lags by its mass and slides if you let go while moving.
// Without it (or with ?physics=off) we set the position directly, as before.
const FLING_MIN = 0.5; // m/s: let go slower than this and the piece is just set down
const phys = () => { const p = window.walkin?.physics; return p && p.enabled ? p : null; };
function trackVel(g, x, y) { // smoothed velocity (m/s) of where the hand wants the piece, for the fling on release
  const t = performance.now(), dt = g.last ? (t - g.last.t) / 1000 : 0;
  if (g.last && dt < 0.005) return;
  if (g.last) {
    const a = Math.min(1, dt / 0.08);
    g.vel[0] += ((x - g.last.x) / dt - g.vel[0]) * a;
    g.vel[1] += ((y - g.last.y) / dt - g.vel[1]) * a;
  }
  g.last = { x, y, t };
}
// A2: push it away, pull it back. While carrying, moving the hand toward / away from the camera (metric depth from
// hands.js) slides the piece along the pointing direction, DEPTH_GAIN metres per metre of hand travel, after a small
// dead zone so depth noise doesn't wobble it. Front camera (handheld): toward the phone = away from you; back camera
// (headset): away from the phone = away. ?dgain=0 turns it off.
// Drift: a single camera's depth wanders a few cm while the hand is held still, and at 6× gain that would walk the
// piece away. So once the hand has been still (within DEPTH_DEAD) for DEPTH_STILL_MS, whatever it has pushed so far
// is kept and the anchor moves to where the hand is now: anything slower than ~DEPTH_DEAD / DEPTH_STILL_MS (3 cm/s)
// never moves the piece, a real push (20+ cm/s) does.
// Drift that never stops (just over 3 cm/s, so the hand is never "still"): each DEPTH_DEAD step is timed, and once
// the hand is already moving, a step slower than DEPTH_SLOW_MS (under ~6 cm/s) right after another slow step is
// folded out like drift. The first step after a still spell always counts (its time includes the still spell), and
// so does one slow step after fast ones (the smoothed depth settling at the end of a real push or pull).
const DEPTH_GAIN = params.has('dgain') ? Number(params.get('dgain')) || 0 : 6, DEPTH_DEAD = 0.015, DEPTH_STILL_MS = 500;
const DEPTH_SLOW_MS = 250;
const deadZone = (v) => Math.sign(v) * Math.max(0, Math.abs(v) - DEPTH_DEAD);
function anchorDepth(g, depth, now) { g.d0 = depth; g.ref = depth; g.refT = now; g.base = 0; g.moving = false; }
function handPush(g, depth, sign, now) { // metres of hand travel away from you since the grab, drift folded out
  if (g.d0 == null && depth != null) anchorDepth(g, depth, now); // grabbed before depth came in: start from here
  if (g.d0 == null || depth == null) return (g.base || 0) * sign;
  if (Math.abs(depth - g.ref) > DEPTH_DEAD) { // moving: one more step, restart the stillness clock
    const slow = now - g.refT > DEPTH_SLOW_MS;
    if (g.moving && slow && g.slow) g.d0 += depth - g.ref; // two slow steps in a row: drift, not a push
    g.ref = depth; g.refT = now; g.moving = true; g.slow = slow;
  } else if (now - g.refT >= DEPTH_STILL_MS) { g.base += deadZone(depth - g.d0); g.d0 = depth; g.refT = now; g.moving = false; }
  return (g.base + deadZone(depth - g.d0)) * sign;
}
function carryPoint(f, cam, push, gain = DEPTH_GAIN) { // floor point the held piece follows: [x, y]
  if (!gain || !push) return [f.x, f.y];
  const dx = f.x - cam.x, dy = f.y - cam.y, r = Math.hypot(dx, dy);
  if (r < 0.05) return [f.x, f.y]; // pointing at your feet: no direction to push along
  const r2 = Math.min(Math.max(r + gain * push, Math.min(r, 0.4)), Math.max(r, 12)); // not behind you, not miles off
  return [cam.x + (dx / r) * r2, cam.y + (dy / r) * r2];
}
const depthSign = () => (handCam === 'user' ? -1 : 1);
function letGo(side, fling) {
  const g = grabs[side];
  if (!g) return;
  const thrown = fling && Math.hypot(g.vel[0], g.vel[1]) > FLING_MIN;
  if (g.phys) g.phys.release(side, thrown ? g.vel : null);
  delete grabs[side];
  // #58: let go over a table and it stands on the table. Not while the other hand still holds it, and not a throw.
  if (!Object.values(grabs).some((o) => o.item === g.item)
    && setDown(g.item, thrown ? null : g.tx ?? g.item.position.x, g.ty ?? g.item.position.y)) checkFit();
}
function moveHeld(g, side, x, y, yaw) {
  trackVel(g, x, y);
  g.tx = x; g.ty = y; // where the hand wants it: a plant stopped beside a table still has the hand over it (#58)
  if (g.phys) { g.phys.moveTarget(side, [x, y], yaw); return; }
  g.item.position.x = x; g.item.position.y = y;
  if (typeof yaw === 'number') g.item.rotation.z = yaw;
}
let handsApi = null, handsList = [], twist = null;
let handRay = null; // walkin.handRay: {origin, dir, side} of the active hand (pinching, else the first seen), or null
let handCam = 'user'; // handheld: front camera sees your hand; in the headset we switch to the back camera
// A8: 'real' = your hands cut out of the camera (realhands.js); 'skeleton' = 3D joints. Debug shows the skeleton too.
let handStyle = 'real';
// passthrough (default): the camera is mapped by angle, so the hand is drawn at its real size and place, no shrink.
// ?handmap=crop: the old zoomed crop (reach the screen edges), where a 0.6 shrink keeps the hand from filling the view.
const HAND_MAP = params.get('handmap') === 'crop' ? 'crop' : 'angle';
const realHands = createRealHands($('handcam'), { scale: Number(params.get('handscale')) || (HAND_MAP === 'crop' ? 0.6 : 1) });
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

// A5: pinch and hold still (HOLD_SLOP of the screen) for HOLD_MS where there is nothing to grab and no puck ->
// radial menu (radial.js). Move toward an option and let go to pick it; let go in the middle to cancel.
const HOLD_MS = 600, HOLD_SLOP = 0.04;
const holds = {};
const placeHere = (kind) => (f) => { // where you pinched, fit-checked by staging.js; else 2 m ahead like the buttons
  const r = f && window.walkin?.placeObject?.(kind, f.x, f.y);
  if (!r || !r.fits) addFurniture(kind);
};
const radial = createRadial({ scene, camera, toWorld: screenToWorld,
  aspect: () => (vr ? innerWidth / 2 : innerWidth) / innerHeight,
  items: [
    { icon: '🛋️', label: 'Sofa', run: placeHere('sofa') },
    { icon: '🛏️', label: 'Bed', run: placeHere('queen') },
    { icon: '🍽️', label: 'Table', run: placeHere('table') },
    { icon: '🪴', label: 'Plant', run: placeHere('plant') },
    { icon: '🏠', label: () => (showEmpty ? 'Scanned' : 'Empty'), run: () => $('bEmpty').click() },
    { icon: '🎙️', label: 'Talk', run: () => window.walkin?.onTalk?.() },
  ] });
function holdMenu(h, now) {
  const hd = holds[h.side];
  if (!hd) return;
  if (radial.side === h.side) { radial.point(h.x, h.y); return; }
  if (radial.side) { hd.t0 = now; hd.x = h.x; hd.y = h.y; return; } // the other hand has it: this hold starts later
  if (Math.hypot(h.x - hd.x, h.y - hd.y) > HOLD_SLOP) delete holds[h.side]; // it moved: not a hold
  else if (now - hd.t0 >= HOLD_MS) {
    for (const s of Object.keys(holds)) if (s !== h.side) delete holds[s]; // so it doesn't pop open again for the other hand
    radial.open(h.side, hd.x, hd.y, hd.floor);
  }
}

function onHands(list, cam) {
  perf.hands++;
  handsList = list;
  realHands.draw(handStyle === 'real' ? list : [], cam, vr);
  camera.updateMatrixWorld();
  const present = new Set(list.map((h) => h.side));
  for (const side of Object.keys(handCursors)) if (!present.has(side)) handCursors[side].visible = false;
  for (const side of Object.keys(grabs)) if (!present.has(side)) letGo(side, false); // lost hand: no fling
  for (const side of Object.keys(prevPinch)) if (!present.has(side)) delete prevPinch[side];
  for (const side of Object.keys(aims)) if (!present.has(side)) delete aims[side];
  for (const side of Object.keys(holds)) if (!present.has(side)) delete holds[side];
  if (radial.side && !present.has(radial.side)) radial.cancel(); // lost the hand: never pick by accident

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
        liftOff(item); // #58
        const P = phys();
        grabs[h.side] = { item, off: new THREE.Vector2(item.position.x - f.x, item.position.y - f.y),
          phys: P && P.grab(item, h.side) ? P : null, vel: [0, 0], last: null };
        anchorDepth(grabs[h.side], h.depth ?? null, now);
      } else if (puckReady) {
        aims[h.side] = null;
        goTo(near.userData.pano);
      } else holds[h.side] = { t0: now, x: h.x, y: h.y, floor: f }; // empty space: maybe a pinch-hold (A5)
    } else if (!h.pinch) {
      letGo(h.side, true);
      delete holds[h.side];
      if (radial.side === h.side) radial.release();
    }
    if (h.pinch) holdMenu(h, now);
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
    const x = mid.x + twist.off.x, y = mid.y + twist.off.y, yaw = twist.r0 + (angle - twist.a0);
    moveHeld(ga, ha.side, x, y, yaw);
    moveHeld(gb, hb.side, x, y, yaw);
    checkFit();
    return;
  }
  if (twist) { // two-hand hold just ended: re-anchor the hand still holding to where the piece is, so it doesn't jump
    for (const h of list) {
      const g = grabs[h.side];
      if (g && g.item === twist.item && h.floor) {
        g.off.set(g.item.position.x - h.floor.x, g.item.position.y - h.floor.y);
        anchorDepth(g, h.depth ?? null, performance.now()); // push / pull starts again from where the hand is now
      }
    }
    twist = null;
  }
  for (const h of list) {
    const g = grabs[h.side];
    if (g && h.floor) {
      g.push = handPush(g, h.depth ?? null, depthSign(), performance.now());
      const [cx, cy] = carryPoint(h.floor, camera.position, g.push);
      moveHeld(g, h.side, cx + g.off.x, cy + g.off.y);
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
    onFrame: (cam) => { if (handStyle === 'real' && handsList.length) realHands.snap(cam); }, // same frame as the landmarks
    viewFov: HAND_MAP === 'angle' ? () => camera.fov : null,
    aspect: () => (vr ? innerWidth / 2 : innerWidth) / innerHeight }); // one eye in the headset
  showCamPreview(mode);
  resetPerfCap(); // loading the hand model stalls a few frames; don't let that pin the resolution low
}
async function toggleHands() {
  const btn = $('bHands');
  if (handsApi) {
    handsApi.stop(); handsApi = null; handsList = []; handRay = null;
    for (const side of Object.keys(grabs)) letGo(side, false); // else physics keeps the piece held by a ghost hand
    radial.cancel();
    for (const side of Object.keys(holds)) delete holds[side];
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
    warn('Hand tracking failed to start: ' + e.message + '\n(Camera needs HTTPS or localhost.)');
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

// A1 needs a number from an iPhone in the headset with hands on, and nobody wearing it has a hand free to write
// it down. So in that mode the page reports its own frame rate: every 10 measured seconds, one HEAD request for
// index.html with the numbers in the query (no body; it only shows up as a line in the server's access log).
// `node tools/fps-report.mjs <server log>` reads them back. ?fpsreport=off stops it.
const fpsReport = { on: params.get('fpsreport') !== 'off', sid: Math.random().toString(36).slice(2, 7), s: [] };
function reportFps(fps, handHz) {
  if (!fpsReport.on || !vr || !handsApi) { fpsReport.s.length = 0; return; }
  fpsReport.s.push(fps);
  if (fpsReport.s.length < 10) return;
  const s = fpsReport.s.sort((a, b) => a - b);
  fpsReport.s = [];
  const ua = navigator.userAgent;
  const px = renderer.getDrawingBufferSize(new THREE.Vector2());
  const q = new URLSearchParams({
    fpsreport: 1, sid: fpsReport.sid,
    dev: /iPhone|iPad/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : 'desktop',
    scr: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    med: s[5].toFixed(0), min: s[0].toFixed(0), pr: perf.pr, px: `${px.x}x${px.y}`,
    hz: handHz.toFixed(0), hms: (handsApi.stats?.ms ?? 0).toFixed(0), src: handsApi.stats?.src ?? '',
    draws: renderer.info.render.calls, ktris: (renderer.info.render.triangles / 1000).toFixed(0),
  });
  fetch(`index.html?${q}`, { method: 'HEAD', cache: 'no-store' }).catch(() => {});
}

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
  reportFps(fps, handHz);
  const show = debug || fpsAlways;
  fpsEls.forEach((el, i) => { el.style.display = show && (i === 0 || vr) ? 'block' : 'none'; });
  if (!show) return;
  const px = renderer.getDrawingBufferSize(new THREE.Vector2());
  const text = `${fps.toFixed(0)} fps · ${perf.pr}x (${px.x}×${px.y})${vr ? ' · headset' : ''}\n`
    + `hands ${handsApi ? `${handsApi.stats?.src ?? ''} ${handHz.toFixed(0)}/s (max ${handsApi.stats?.maxHz}), ${(handsApi.stats?.ms ?? 0).toFixed(0)} ms each, `
      + `${handsList.length} seen${handsList.map((h) => (h.depth ? ` ${h.side[0]} ${(h.depth * 100).toFixed(0)} cm` : '')).join('')}`
      + `${Object.values(grabs).map((g) => (g.push ? ` · pushed ${(g.push * DEPTH_GAIN).toFixed(2)} m` : '')).join('')}` : 'off'} · `
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
// A1 in one tap: ?a1=1 covers the page with "tap to start"; that tap does 🥽 then ✋ (headset, back camera, hands),
// so whoever tests only opens the link, taps once and wears the phone for 30 s. The fps report above sends the
// numbers to the server log. The tap is the user gesture iOS needs for motion access and the camera.
// Each step is caught on its own, so a refused motion prompt still starts hands. The server log gets a
// `HEAD /index.html?a1start=...` line the moment of the tap (step=tap), one when both steps are done (step=done,
// with any error), and one if hands come up only after that (step=late); fps-report prints them. A prompt nobody
// answers leaves its promise pending forever, so each step gets 15 s before the report goes out without it (#2).
// ?a1=off = no overlay.
if (params.has('a1') && params.get('a1') !== 'off') {
  const tip = document.createElement('div');
  tip.textContent = 'A1 test: tap anywhere and allow Motion and Camera, then put the phone in the headset for 30 s';
  tip.style.cssText = 'position:fixed;inset:0;z-index:999;display:flex;align-items:center;justify-content:center;'
    + 'padding:24px;text-align:center;font:600 22px system-ui;color:#fff;background:#000b';
  document.body.appendChild(tip);
  const a1send = (step, err = []) => {
    const q = new URLSearchParams({ a1start: 1, step, sid: fpsReport.sid, vr: +vr, gyro: +gyro.on, hands: +!!handsApi,
      err: err.join('; ').slice(0, 200) });
    fetch(`index.html?${q}`, { method: 'HEAD', cache: 'no-store' }).catch(() => {});
  };
  const within = (p, what) => Promise.race([p, new Promise((_, no) => setTimeout(
    () => no(new Error(`${what} prompt not answered after 15 s`)), 15000))]);
  tip.onclick = async () => {
    tip.remove();
    a1send('tap');
    const err = [], seen = warnings.length;
    try { await within(toggleVR(true), 'motion'); } catch (e) { err.push(`headset: ${e?.message || e}`); }
    let handsP = null;
    if (!handsApi) handsP = toggleHands();
    try { if (handsP) await within(handsP, 'camera'); } catch (e) { err.push(`hands: ${e?.message || e}`); }
    if (!handsApi && handsP) handsP.then(() => { if (handsApi) a1send('late'); });
    const all = [...err, ...warnings.slice(seen)]; // toggleGyro / toggleHands report through warn(), already on screen
    console.log(`[a1] headset ${vr}, gyro ${gyro.on}, hands ${!!handsApi}, fps report ${fpsReport.on ? `on (sid ${fpsReport.sid})` : 'off'}`
      + (all.length ? `, errors: ${all.join('; ')}` : ''));
    a1send('done', all);
    if (err.length) warn(`A1 test could not start everything: ${err.join('; ')}`);
  };
}
$('bEmpty').onclick = async () => {
  showEmpty = !showEmpty;
  $('bEmpty').classList.toggle('on', showEmpty);
  $('bEmpty').textContent = showEmpty ? 'Empty' : 'As scanned';
  await refreshImages();
};
if (!house.panos.some((p) => p.imgEmpty)) { showEmpty = false; $('bEmpty').textContent = 'As scanned'; $('bEmpty').classList.remove('on'); }

// ------------------------------------------------------------------ main loop
const _dir = new THREE.Vector3(), _fwd = new THREE.Vector3();
// walkin.beforeRender: add (dt) => {} to run every frame after all input (mouse, hands) and right before the draw,
// e.g. physics.js constraining pieces. A callback that throws is dropped so it can't stop the render loop.
const beforeRender = new Set();
let lastFrameT = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now(), dt = Math.min(0.05, (now - lastFrameT) / 1000);
  lastFrameT = now;
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
  dimmer.position.copy(camPos);
  camera.updateMatrixWorld();
  drawHands();
  radial.layout(); // A5: keep an open menu where you pinched while the head turns
  for (const fn of beforeRender) {
    try { fn(dt); } catch (e) { console.warn('beforeRender callback dropped:', e); beforeRender.delete(fn); }
  }
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
  renderer, // for env maps / tone mapping (#29); don't resize it or change its pixel ratio, app.js owns that
  beforeRender, // Set of (dt) => {} run every frame after input, before the draw (physics.js, #44)
  get current() { return current; }, get selected() { return selected; },
  get handRay() { return handRay; },
  get occluderMesh() { return meshOccluder; }, // the empty-house OBJ in model space, or null (walls.js #61); read-only
  get hands() { return handsList; }, // latest tracked hands: {side, pts[21] in 0..1 screen units, x, y, pinch}
  get handStyle() { return handStyle; },
  set handStyle(s) { setHandStyle(s); },
  get radial() { return radial.state; }, // A5: {side, hot, label} while the pinch-hold menu is open, else null
  // A2 test hook: run made-up hands ({side, x, y, pinch}, x/y in 0..1 of the screen) through the real gesture code,
  // so grab / carry / twist / pinch-teleport can be checked without a webcam. simHands([]) = hands gone (no fling).
  // Add depth (metres from the camera) to try push / pull: with the front camera a smaller depth pushes the piece away.
  simHands(list = []) {
    onHands(list.map((h) => ({ side: 'Right', pinch: false, size: 0.2, ...h,
      pts: h.pts || Array.from({ length: 21 }, () => ({ x: h.x, y: h.y, z: 0 })) })), null);
    return handsList.map((h) => ({ side: h.side, floor: h.floor ? [h.floor.x, h.floor.y] : null,
      holding: grabs[h.side]?.item?.userData.kind ?? null }));
  },
}; // hooks for agent.js and other modules
dispatchEvent(new Event('walkin:ready')); // modules can wait for this instead of polling for window.walkin

// #108: the home's own furniture as 3D pieces, cut from the MatterPak by tools/meshdiff.py (data/<model>/furniture.bin).
// realfurniture.js builds them; this is the way in without a console, which a phone doesn't have.
// More → 🛋 Own furniture toggles them; ?mesh=1 puts them in on load (add &a1=1 to get the headset fps with them on).
// Pieces photogrammetry got wrong (melted plants, shredded chairs) are left out: the quarter of this
// house with the worst fold (foldRank from tools/meshdiff.py, #117). A fixed fold cut doesn't travel
// between houses (it took 34% of one and 59% of another). ?mesh=all loads every piece, for debugging.
const meshBtn = $('bMesh');
const meshOpts = params.get('mesh') === 'all' ? {} : { worst: 0.25 };
const meshPieces = () => furniture.children.filter((o) => o.userData.meshPiece);
let meshBusy = false;
async function toggleMeshFurniture() {
  const w = window.walkin;
  if (meshBusy) return; // a second tap while furniture.bin loads would put every piece in twice
  if (!w.meshFurniture) { warn('Own furniture: realfurniture.js did not load'); return; }
  meshBusy = true;
  try {
    if (meshPieces().length) {
      if (selected?.userData.meshPiece) select(null);
      w.clearMeshFurniture();
    } else {
      const r = await w.meshFurniture(meshOpts);
      console.log(`[mesh] ${r.say}`, r);
      if (!r.ok || !r.placed) warn(`Own furniture: ${r.say}`);
    }
  } finally { meshBusy = false; }
  const n = meshPieces().length;
  if (meshBtn) { meshBtn.classList.toggle('on', n > 0); meshBtn.textContent = n ? `🛋 Own furniture (${n})` : '🛋 Own furniture'; }
}
if (meshBtn) meshBtn.onclick = toggleMeshFurniture;
if (['1', 'all'].includes(params.get('mesh'))) (function wait(tries = 0) { // realfurniture.js attaches its hooks a moment after this
  if (window.walkin.meshFurniture) toggleMeshFurniture();
  else if (tries < 100) setTimeout(() => wait(tries + 1), 50);
})();
