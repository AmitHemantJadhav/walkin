// A4 — walkin.setWallMaterial(wall, textureUrl, tileMetres): put a material on one real wall.
// The quad sits 1 cm in front of the wall face on the viewer's side, runs the full room height, is split
// around doorways and windows (the API's `openings`), and repeats the texture at real-world scale.
// It lives in model space, so it is the same wall from every scan point - which is the point: CoStar's
// open problem #6 is that image-only edits don't survive a change of view, and this one does.
// Shading comes from the photo itself (see shade.js), so a wall in shadow stays in shadow.
import * as THREE from 'three';
import { panoLuminance } from './shade.js';

const WALL_H = 2.7;             // fallback when the API gives a room no height
const TOP_GAP = 0.04;           // stop just below the ceiling, so the offset below can't ride over the cornice
// How far in front of the wall face the quad sits. The wall graph is idealised and the empty-house mesh
// (the occluder) is a few centimetres into the room from it, so 1 cm leaves the paper buried: measured on
// La Mirada, anything under ~4 cm is almost entirely hidden, and polygon offset isn't enough on its own.
const OFFSET = 0.08;
const LIGHT_U = 24, LIGHT_V = 16; // resolution of the luminance map sampled off the pano

const group = new THREE.Group();
group.name = 'wall-materials';
const applied = new Map();      // key -> { mesh, wall, url, tile }
const texLoader = new THREE.TextureLoader();
const texCache = new Map();

const keyOf = (wall) => `${wall.floor || '-'}|${wall.index != null ? wall.index
  : `${wall.a}|${wall.b}`}`;

function loadTexture(url) {
  if (!texCache.has(url)) {
    texCache.set(url, new Promise((res, rej) => texLoader.load(url, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      res(t);
    }, undefined, rej)));
  }
  return texCache.get(url);
}

/** The wall record from house.json that a `{floor, index}` or `{a, b}` refers to. */
function findWall(wall) {
  const w = window.walkin;
  const floors = w.house.floors || [];
  const f = floors.find((x) => x.id === wall.floor) || floors[0];
  if (!f) return null;
  if (wall.index != null && f.walls[wall.index]) return { wall: f.walls[wall.index], floor: f };
  if (wall.a && wall.b) {                                  // match by endpoints, either way round
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.02;
    const hit = f.walls.find((x) => (near(x.a, wall.a) && near(x.b, wall.b))
      || (near(x.a, wall.b) && near(x.b, wall.a)));
    if (hit) return { wall: hit, floor: f };
  }
  return null;
}

/**
 * The wall split into the rectangles that are actually wall: full-height pieces between the openings,
 * plus the strips above and below each one. Coordinates are (u along the wall, v up from the floor).
 */
export function wallPanels(wall, height = WALL_H) {
  const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
  const holes = (wall.openings || [])
    .filter((o) => o && o.at != null)
    .map((o) => {
      const half = (o.width || 0.9) / 2;
      const c = o.at * len;
      const bottom = Math.max(0, o.bottom || 0);
      return { u0: Math.max(0, c - half), u1: Math.min(len, c + half),
        v0: bottom, v1: Math.min(height, bottom + (o.height || 2.05)) };
    })
    .filter((h) => h.u1 - h.u0 > 0.02)
    .sort((a, b) => a.u0 - b.u0);

  const panels = [];
  let cursor = 0;
  for (const h of holes) {
    if (h.u0 > cursor + 0.02) panels.push({ u0: cursor, u1: h.u0, v0: 0, v1: height });
    if (h.v0 > 0.02) panels.push({ u0: h.u0, u1: h.u1, v0: 0, v1: h.v0 });        // under a window
    if (h.v1 < height - 0.02) panels.push({ u0: h.u0, u1: h.u1, v0: h.v1, v1: height }); // over a door
    cursor = Math.max(cursor, h.u1);
  }
  if (cursor < len - 0.02) panels.push({ u0: cursor, u1: len, v0: 0, v1: height });
  return { panels, len };
}

/** One rectangle of wall as geometry: uv repeats at real scale, uv1 spans the whole wall for the shading. */
function panelGeometry(p, len, height, tile) {
  const g = new THREE.BufferGeometry();
  const pos = [], uv = [], uv1 = [];
  for (const [u, v] of [[p.u0, p.v0], [p.u1, p.v0], [p.u1, p.v1], [p.u0, p.v1]]) {
    pos.push(u, v, 0);
    uv.push(u / tile, v / tile);
    uv1.push(u / len, v / height);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/** Which way the wall faces the person looking at it. */
function facingNormal(wall, from) {
  const dx = wall.b[0] - wall.a[0], dy = wall.b[1] - wall.a[1];
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;
  const mx = (wall.a[0] + wall.b[0]) / 2, my = (wall.a[1] + wall.b[1]) / 2;
  if ((from[0] - mx) * nx + (from[1] - my) * ny < 0) { nx = -nx; ny = -ny; }
  return [nx, ny];
}

/**
 * Put `textureUrl` on `wall`, repeating every `tileMetres`.
 * `wall` is `walkin.pointer.wall` — `{floor, index, a, b, normal?}` — or anything with `a` and `b`.
 * Returns { ok, wall, tileMetres, panels, area, why }.
 */
export async function setWallMaterial(wall, textureUrl, tileMetres = 1) {
  const w = window.walkin;
  if (!w || !wall) return { ok: false, why: 'no wall given' };
  const found = findWall(wall);
  if (!found) return { ok: false, why: "that wall isn't in the house data" };
  if (!textureUrl) return { ok: false, why: 'no texture given' };
  const tile = Math.max(0.05, Math.min(8, Number(tileMetres) || 1));

  let tex;
  try { tex = await loadTexture(textureUrl); } catch (e) { return { ok: false, why: "the texture didn't load" }; }

  const rec = found.wall;
  const floorZ = (w.current && w.current.floorZ) || 0;
  const from0 = (w.current && w.current.pos) || [0, 0];
  const [pnx, pny] = facingNormal(rec, from0);
  // a wall midpoint sits exactly on the room boundary, so look the room up a step inside it
  const room = w.roomAt((rec.a[0] + rec.b[0]) / 2 + pnx * 0.3, (rec.a[1] + rec.b[1]) / 2 + pny * 0.3,
    w.current && w.current.floor);
  const ceiling = (room && room.dims && room.dims.height > 1.8 && room.dims.height) || WALL_H;
  const height = Math.min(3.2, Math.max(2.2, ceiling)) - TOP_GAP;
  const { panels, len } = wallPanels(rec, height);
  if (!panels.length) return { ok: false, why: 'that wall is all doorway' };

  const from = (wall.normal && [(rec.a[0] + rec.b[0]) / 2 + wall.normal[0], (rec.a[1] + rec.b[1]) / 2 + wall.normal[1]])
    || from0;
  const [nx, ny] = facingNormal(rec, from);

  clearWallMaterial(wall);

  // the cached texture is used as-is: the repeat is baked into uv, so no per-wall clone (and nothing to leak)
  const material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide });
  // the photo's own light and shade on this wall, as a light map over uv1
  const shade = await panoLuminance(rec, height, LIGHT_U, LIGHT_V, [nx, ny]);
  if (shade) {
    material.lightMap = shade;
    material.lightMapIntensity = shade.userData.scale || 1;   // the map is stored scaled to fit a byte
  }

  const mesh = new THREE.Group();
  const dirx = (rec.b[0] - rec.a[0]) / (len || 1), diry = (rec.b[1] - rec.a[1]) / (len || 1);
  for (const p of panels) {
    const m = new THREE.Mesh(panelGeometry(p, len, height, tile), material);
    m.renderOrder = 2;                       // after the depth-only occluders, like furniture
    mesh.add(m);
  }
  // local (u, v, 0) -> world: u along the wall, v up, pushed out along the normal
  mesh.matrixAutoUpdate = false;
  mesh.matrix.set(
    dirx, 0, nx, rec.a[0] + nx * OFFSET,
    diry, 0, ny, rec.a[1] + ny * OFFSET,
    0, 1, 0, floorZ,
    0, 0, 0, 1,
  );
  group.add(mesh);
  if (!group.parent) w.scene.add(group);

  const area = panels.reduce((a, p) => a + (p.u1 - p.u0) * (p.v1 - p.v0), 0);
  applied.set(keyOf({ floor: found.floor.id, index: wall.index, a: rec.a, b: rec.b }),
    { mesh, wall: { floor: found.floor.id, index: wall.index, a: rec.a, b: rec.b }, url: textureUrl, tile });
  return { ok: true, wall: { floor: found.floor.id, index: wall.index, a: rec.a, b: rec.b },
    tileMetres: tile, panels: panels.length, length: +len.toFixed(2), height: +height.toFixed(2),
    area: +area.toFixed(1), room: room ? room.label : null,
    say: `${(area).toFixed(1)} m2 of wall${room ? ` in the ${room.label.toLowerCase()}` : ''}, repeating every ${tile} m` };
}

/** Free one wall's geometry, its material and the light map made for it (the texture itself is cached). */
function dispose(mesh) {
  const seen = new Set();
  mesh.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    if (seen.has(o.material)) return;            // one material is shared by all the panels of a wall
    seen.add(o.material);
    if (o.material.lightMap) o.material.lightMap.dispose();
    o.material.dispose();
  });
}

/** Take the material off one wall. */
export function clearWallMaterial(wall) {
  if (!wall) return 0;
  const found = findWall(wall);
  if (!found) return 0;
  const k = keyOf({ floor: found.floor.id, index: wall.index, a: found.wall.a, b: found.wall.b });
  const rec = applied.get(k);
  if (!rec) return 0;
  group.remove(rec.mesh);
  dispose(rec.mesh);
  applied.delete(k);
  return 1;
}

/** Take every wall material off. */
export function clearAllWallMaterials() {
  const n = applied.size;
  for (const rec of applied.values()) {
    group.remove(rec.mesh);
    dispose(rec.mesh);
  }
  applied.clear();
  return n;
}

/** What is on the walls now (layout.js and the agent can read this). */
export function wallMaterials() {
  return [...applied.values()].map(({ wall, url, tile }) => ({ wall, url, tileMetres: tile }));
}

// ------------------------------------------------------------------ keep the shading in step
let lastPano = null;
async function refreshShading() {
  for (const rec of applied.values()) {
    const found = findWall(rec.wall);
    if (!found) continue;
    const mats = [];
    rec.mesh.traverse((o) => { if (o.isMesh && !mats.includes(o.material)) mats.push(o.material); });
    const from = window.walkin.current.pos;
    const [rnx, rny] = facingNormal(found.wall, from);
    const room = window.walkin.roomAt((found.wall.a[0] + found.wall.b[0]) / 2 + rnx * 0.3,
      (found.wall.a[1] + found.wall.b[1]) / 2 + rny * 0.3, window.walkin.current.floor);
    const ceiling = (room && room.dims && room.dims.height > 1.8 && room.dims.height) || WALL_H;
    const height = Math.min(3.2, Math.max(2.2, ceiling)) - TOP_GAP;
    const shade = await panoLuminance(found.wall, height, LIGHT_U, LIGHT_V, facingNormal(found.wall, from));
    for (const m of mats) {
      if (m.lightMap) m.lightMap.dispose();      // the old map is replaced, not kept
      m.lightMap = shade || null;
      m.lightMapIntensity = shade ? (shade.userData.scale || 1) : 1;
      m.needsUpdate = true;
    }
  }
}

(function start(tries = 0) {
  if (!window.walkin) {
    if (tries < 600) return setTimeout(() => start(tries + 1), 50);
    return;
  }
  const w = window.walkin;
  w.setWallMaterial = setWallMaterial;
  w.clearWallMaterial = clearWallMaterial;
  w.clearAllWallMaterials = clearAllWallMaterials;
  w.wallMaterials = wallMaterials;
  w.scene.add(group);

  (function tick() {
    requestAnimationFrame(tick);
    if (!w.current || w.current.id === lastPano || !applied.size) { lastPano = w.current && w.current.id; return; }
    lastPano = w.current.id;
    refreshShading().catch((e) => console.warn('walls: shading failed', e));
  })();
})();
