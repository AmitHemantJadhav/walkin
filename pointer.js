// A3 — walkin.pointer: what the user points at, every frame.
//   walkin.pointer = { type: 'wall'|'floor'|'furniture'|null, wall: {floor, index, a, b, normal} | null,
//                      point: [x, y, z] | null, room: <house room> | null, item: <furniture group> | null, source }
// The ray comes from, in order: walkin.handRay ({origin:[x,y,z], dir:[x,y,z]}, if the hands code publishes one),
// the mouse while it hovers the canvas (laptop, not in headset mode), or the centre of the view (gaze).
// Walls are the same quads app.js uses as occluders: 2.7 m high, type "wall" only, doorways cut out.
// The pointed wall gets a faint highlight; walkin.pointerHighlight = false turns it off.
// walkin.updatePointer() recomputes it right away (it is otherwise refreshed once per frame).
// Talks to the viewer only through window.walkin. Units: metres, Z up.
import * as THREE from 'three';

const WALL_H = 2.7;               // same as app.js buildWallOccluders
const MOUSE_IDLE_MS = 2500;       // after this long without mouse movement, fall back to the view centre

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let mouse = null;                 // {x, y, t} in client pixels
let highlight = null;

addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' && e.target && e.target.tagName === 'CANVAS' && !e.buttons) mouse = { x: e.clientX, y: e.clientY, t: performance.now() };
}, { passive: true });
addEventListener('pointerleave', () => { mouse = null; });

const inHeadset = () => document.body.classList.contains('vr');

function setRay(w) {
  const hr = w.handRay;
  if (hr && hr.origin && hr.dir) {
    ray.ray.origin.set(...hr.origin);
    ray.ray.direction.set(...hr.dir).normalize();
    return 'hand';
  }
  w.camera.updateMatrixWorld();
  if (mouse && !inHeadset() && performance.now() - mouse.t < MOUSE_IDLE_MS) {
    ndc.set((mouse.x / innerWidth) * 2 - 1, -(mouse.y / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, w.camera);
    return 'mouse';
  }
  ndc.set(0, 0);
  ray.setFromCamera(ndc, w.camera);
  return 'gaze';
}

/** Nearest wall quad along the ray, skipping doorway openings. */
function hitWall(w, floorId, floorZ, o, d) {
  const f = w.house.floors.find((x) => x.id === floorId) || w.house.floors[0];
  let best = null;
  (f ? f.walls : []).forEach((wall, index) => {
    if (wall.type !== 'wall') return;
    const [ax, ay] = wall.a, [bx, by] = wall.b;
    const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey);
    if (len < 0.05) return;
    const den = d.x * ey - d.y * ex;              // 2D ray vs segment
    if (Math.abs(den) < 1e-9) return;
    const t = ((ax - o.x) * ey - (ay - o.y) * ex) / den;
    const s = ((ax - o.x) * d.y - (ay - o.y) * d.x) / den;
    if (t <= 0.05 || s < 0 || s > 1) return;
    const z = o.z + t * d.z - floorZ;             // height above this floor
    if (z < 0 || z > WALL_H) return;
    const along = s * len;
    for (const op of wall.openings || []) {        // the ray goes through doorways (windows count as wall)
      if (op.type !== 'doorway') continue;
      const c = (op.at == null ? 0.5 : op.at) * len, half = (op.width || 0.9) / 2;
      const bottom = op.bottom || 0, top = bottom + (op.height || 2.05);
      if (along > c - half && along < c + half && z >= bottom && z <= top) return;
    }
    if (!best || t < best.t) {
      let nx = -ey / len, ny = ex / len;           // normal facing the viewer
      if (nx * d.x + ny * d.y > 0) { nx = -nx; ny = -ny; }
      best = { t, index, a: wall.a, b: wall.b, normal: [nx, ny, 0], point: [o.x + t * d.x, o.y + t * d.y, o.z + t * d.z] };
    }
  });
  return best;
}

function hitFurniture(w) {
  if (!w.furniture || !w.furniture.children.length) return null;
  const h = ray.intersectObjects(w.furniture.children, true).find((x) => x.object.visible !== false);
  if (!h) return null;
  let item = h.object;
  while (item.parent && item.parent !== w.furniture) item = item.parent;
  return { t: h.distance, item, point: [h.point.x, h.point.y, h.point.z] };
}

function hitFloor(floorZ, o, d) {
  if (d.z >= -1e-6) return null;
  const t = (floorZ - o.z) / d.z;
  return t > 0 ? { t, point: [o.x + t * d.x, o.y + t * d.y, floorZ] } : null;
}

// ------------------------------------------------------------------ wall highlight
function showHighlight(w, wall, floorZ) {
  const on = w.pointerHighlight !== false && wall;
  if (!on) { if (highlight) highlight.visible = false; return; }
  if (!highlight) {
    highlight = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.12, depthTest: false, depthWrite: false,
        side: THREE.DoubleSide }));
    highlight.renderOrder = 40;
    highlight.name = 'pointer-highlight';
    w.scene.add(highlight);
  }
  const [ax, ay] = wall.a, [bx, by] = wall.b, len = Math.hypot(bx - ax, by - ay);
  highlight.scale.set(len, WALL_H, 1);
  highlight.position.set((ax + bx) / 2 + wall.normal[0] * 0.02, (ay + by) / 2 + wall.normal[1] * 0.02, floorZ + WALL_H / 2);
  highlight.rotation.set(Math.PI / 2, 0, Math.atan2(by - ay, bx - ax), 'ZYX'); // stand the plane up, then turn it along the wall
  highlight.visible = true;
}

// ------------------------------------------------------------------ every frame
const EMPTY = Object.freeze({ type: null, wall: null, point: null, room: null, item: null, source: null });

function update() {
  const w = window.walkin, cur = w && w.current;
  if (!cur || !w.camera) return;
  const source = setRay(w);
  const o = ray.ray.origin, d = ray.ray.direction, floorZ = cur.floorZ || 0;
  const hits = [];
  const fu = hitFurniture(w);
  if (fu) hits.push({ type: 'furniture', ...fu });
  const wa = hitWall(w, cur.floor, floorZ, o, d);
  if (wa) hits.push({ type: 'wall', ...wa });
  const fl = hitFloor(floorZ, o, d);
  // only floor inside the house: through a doorway or window the plane would otherwise reach the garden
  if (fl && w.roomAt(fl.point[0], fl.point[1], cur.floor)) hits.push({ type: 'floor', ...fl });
  hits.sort((x, y) => x.t - y.t);
  const h = hits[0];
  if (!h) { w.pointer = { ...EMPTY, source }; showHighlight(w, null); return; }
  const wall = h.type === 'wall' ? { floor: cur.floor, index: h.index, a: h.a, b: h.b, normal: h.normal } : null;
  // the room on the near side of a wall, so "this wall" belongs to the room the user is in
  const px = wall ? h.point[0] + wall.normal[0] * 0.1 : h.point[0], py = wall ? h.point[1] + wall.normal[1] * 0.1 : h.point[1];
  w.pointer = {
    type: h.type, wall, point: h.point.map((v) => Math.round(v * 1000) / 1000),
    room: w.roomAt(px, py, cur.floor) || null, item: h.item || null, source,
  };
  showHighlight(w, wall, floorZ);
}

(function start(tries = 0) {
  if (!window.walkin) {
    if (tries < 600) setTimeout(() => start(tries + 1), 200);
    return;
  }
  window.walkin.pointer = { ...EMPTY };
  window.walkin.updatePointer = () => { update(); return window.walkin.pointer; }; // fresh result now, not next frame
  const loop = () => {
    try { update(); } catch (e) { console.warn('[pointer]', e); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();
