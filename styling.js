// Finishing touches for a furnished room: the layer that makes it look lived in rather than staged.
//
//   walkin.styling.styleRoom({ room, accent, add })  -> { ok, added, say }
//     add: any of 'pillows', 'throw', 'coffee_table', 'pouf', 'console', 'curtains', 'gallery', 'mirror'
//     (empty = pillows, throw, coffee_table, pouf, console)
//
//  - pillows and a knitted throw on the sofa, in an accent colour. The seat and back are found by probing the
//    sofa's own model, so they sit on whichever sofa model it is instead of floating at a guessed height
//  - the coffee table styled: a tray, a short stack of books, a ceramic vase of greenery, on its real top
//  - a pouf by the coffee table and a console table with a lamp behind the sofa (catalog pieces: they move, fit
//    check, delete and have a price like anything else)
//  - curtains: pleated panels and a rod at the room's real windows, from the scan's wall openings
//  - a gallery wall (three framed pieces, decor.js) and a round mirror (decor.js), only when asked
//
// Pillows, throw and table styling are children of the piece they sit on: they move with it, go with a delete,
// and never take part in fit checks or physics. One John tool, style_room. Units: metres, Z up.
import * as THREE from 'three';
import { knit } from './furniture.js';

const W = () => window.walkin;
const lower = (s) => String(s || '').toLowerCase();
const DEFAULT_ADD = ['pillows', 'throw', 'coffee_table', 'pouf', 'console'];   // curtains, gallery, mirror only when asked
const ACCENT = { cozy: '#b5643c', modern: '#d2a54a', scandi: '#8fa58a' };     // rust, mustard, sage

// ------------------------------------------------------------------ materials
const fabricCache = new Map();
function linen(color) {
  const key = new THREE.Color(color).getHexString();
  if (fabricCache.has(key)) return fabricCache.get(key);
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = `#${key}`; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 128; i += 2) {                   // a fine weave: light and dark threads both ways
    g.fillStyle = `rgba(255,255,255,${0.035 + Math.random() * 0.04})`; g.fillRect(0, i, 128, 1);
    g.fillStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.04})`; g.fillRect(i, 0, 1, 128);
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.95, metalness: 0 });
  fabricCache.set(key, m);
  return m;
}
const M = {
  tray: new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 0.45 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.35, metalness: 0.8 }),
  ceramic: new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.35 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x5f7a4f, roughness: 0.7, side: THREE.DoubleSide }),
  stem: new THREE.MeshStandardMaterial({ color: 0x4d5f3c, roughness: 0.8 }),
  pages: new THREE.MeshStandardMaterial({ color: 0xf1ece0, roughness: 0.9 }),
  rod: new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.4, metalness: 0.6 }),
};
const BOOK = [0x2f4858, 0xb5643c, 0xd9cbb0, 0x6b705c, 0x3b3b3b];
function prop(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.renderOrder = 2;
  m.userData.prop = true; m.userData.styling = true;
  return m;
}

// ------------------------------------------------------------------ probing a model for its real surfaces
const ray = new THREE.Raycaster();
function body(item) {
  const out = [];
  item.traverse((n) => { if (n.isMesh && n.visible && !n.userData.shadow && !n.userData.styling && !n.userData.priceTag) out.push(n); });
  return out;
}
/** Height (item-local) of the first surface straight down at local (lx, ly), or null. */
function topAt(item, lx, ly) {
  item.updateMatrixWorld(true);
  const o = new THREE.Vector3(lx, ly, 3).applyMatrix4(item.matrixWorld);
  ray.set(o, new THREE.Vector3(0, 0, -1));
  const h = ray.intersectObjects(body(item), false)[0];
  return h ? item.worldToLocal(h.point.clone()).z : null;
}
/** Local y of the first surface met going from the front (-y) towards the back at height z, or null. */
function backAt(item, lx, z, d) {
  item.updateMatrixWorld(true);
  const o = new THREE.Vector3(lx, -d, z).applyMatrix4(item.matrixWorld);
  const dir = new THREE.Vector3(0, 1, 0).transformDirection(item.matrixWorld);
  ray.set(o, dir);
  const h = ray.intersectObjects(body(item), false)[0];
  return h ? item.worldToLocal(h.point.clone()).y : null;
}
/** Wait (briefly) for a piece's photoreal model to replace the instant stand-in, so we probe the real surfaces. */
async function settled(item) {
  const spec = W().FURNITURE[item.userData.kind] || {};
  const hero = (spec.heroBy && spec.heroBy[item.userData.style]) || spec.hero;
  for (let i = 0; i < 30 && hero && item.userData.model !== hero; i++) await new Promise((r) => setTimeout(r, 100));
}
function clearStyling(item, what) {
  for (const c of [...item.children]) if (c.userData.styling === what) item.remove(c);
}

// ------------------------------------------------------------------ the pieces
function pillowGeo(w, h, t) {
  const g = new THREE.BoxGeometry(w, t, h, 10, 2, 10);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {                  // puff: thick in the middle, pinched at the corners
    v.fromBufferAttribute(p, i);
    const ex = 1 - Math.pow(Math.abs(v.x) / (w / 2), 2), ez = 1 - Math.pow(Math.abs(v.z) / (h / 2), 2);
    v.y *= 0.35 + 0.65 * Math.max(0, ex * ez);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function addPillows(sofa, accent) {
  const spec = W().FURNITURE[sofa.userData.kind];
  clearStyling(sofa, 'pillows');
  const seat = topAt(sofa, 0, -spec.d * 0.1) ?? 0.45;
  const back = backAt(sofa, 0, seat + 0.25, spec.d) ?? spec.d / 2 - 0.22;
  const g = new THREE.Group(); g.userData.styling = 'pillows';
  const main = linen(accent), soft = linen(new THREE.Color(accent).lerp(new THREE.Color(0xf2ece0), 0.65));
  const put = (x, size, mat, tilt, yaw) => {
    const m = prop(pillowGeo(size, size, 0.15), mat);
    m.position.set(x, back - 0.09, seat + size / 2 - 0.02);
    m.rotation.set(-0.28 - tilt, 0, yaw);
    g.add(m);
  };
  const edge = spec.w / 2 - 0.36;
  put(-edge, 0.45, main, 0.02, 0.06); put(edge, 0.45, main, 0.0, -0.06);           // a pair at the arms
  if (spec.w > 1.6) { put(-edge + 0.36, 0.38, soft, 0.05, 0.1); put(edge - 0.36, 0.38, soft, 0.04, -0.1); }
  sofa.add(g);
  return true;
}

function addThrow(sofa, accent) {
  const spec = W().FURNITURE[sofa.userData.kind];
  clearStyling(sofa, 'throw');
  const x = spec.w / 2 - 0.42;
  const seat = topAt(sofa, x, -spec.d * 0.15) ?? 0.45;
  const g = new THREE.Group(); g.userData.styling = 'throw';
  const mat = knit(new THREE.Color(accent).lerp(new THREE.Color(0xf5efe4), 0.55).getHex());
  const folded = prop(new THREE.BoxGeometry(0.5, 0.42, 0.035), mat);                 // folded on the seat
  folded.position.set(x, -spec.d * 0.12, seat + 0.02); folded.rotation.z = -0.12;
  const hang = prop(new THREE.BoxGeometry(0.46, 0.025, Math.max(0.15, seat - 0.12)), mat);   // and over the front edge
  hang.position.set(x + 0.02, -spec.d / 2 + 0.02, seat / 2 + 0.07); hang.rotation.z = -0.12;
  g.add(folded, hang);
  sofa.add(g);
  return true;
}

function vaseWithGreenery() {
  const g = new THREE.Group();
  const pts = [[0.001, 0], [0.05, 0.005], [0.065, 0.06], [0.06, 0.13], [0.035, 0.19], [0.028, 0.22], [0.033, 0.235]]
    .map(([r, z]) => new THREE.Vector2(r, z));
  const vase = prop(new THREE.LatheGeometry(pts, 28).rotateX(Math.PI / 2), M.ceramic);
  g.add(vase);
  for (let i = 0; i < 7; i++) {                       // eucalyptus-like stems leaning out of the neck
    const a = (i / 7) * Math.PI * 2 + 0.3, lean = 0.22 + (i % 3) * 0.08, len = 0.3 + (i % 2) * 0.1;
    const stem = new THREE.Group();
    const s = prop(new THREE.CylinderGeometry(0.0025, 0.003, len, 5).rotateX(Math.PI / 2).translate(0, 0, len / 2), M.stem);
    stem.add(s);
    for (let k = 1; k <= 5; k++) {
      const leaf = prop(new THREE.CircleGeometry(0.022 - k * 0.002, 8), M.leaf);
      leaf.position.set((k % 2 ? 1 : -1) * 0.012, 0, (k / 6) * len);
      leaf.rotation.set(Math.PI / 2, (k % 2 ? 1 : -1) * 0.6, 0);
      stem.add(leaf);
    }
    stem.position.z = 0.21;
    stem.rotation.set(Math.sin(a) * lean, Math.cos(a) * lean, a);
    g.add(stem);
  }
  return g;
}

function styleCoffeeTable(table) {
  const top = topAt(table, 0, 0);
  if (top == null || top < 0.2) return false;
  clearStyling(table, 'coffee_table');
  const spec = W().FURNITURE[table.userData.kind];
  const span = Math.min(spec.w, spec.d);
  const g = new THREE.Group(); g.userData.styling = 'coffee_table';
  const tray = prop(new THREE.BoxGeometry(Math.min(0.42, span * 0.7), Math.min(0.28, span * 0.45), 0.018), M.tray);
  tray.position.set(span * 0.08, 0, top + 0.009);
  g.add(tray);
  const vase = vaseWithGreenery(); vase.position.set(span * 0.12, 0.01, top + 0.018); g.add(vase);
  let z = top;
  BOOK.slice(0, 3).forEach((col, i) => {               // a stack of three, each a little turned
    const bw = 0.24 - i * 0.02, bd = 0.17 - i * 0.012, bh = 0.028 + (i % 2) * 0.008;
    const book = new THREE.Group();
    const cover = prop(new THREE.BoxGeometry(bw, bd, bh), new THREE.MeshStandardMaterial({ color: col, roughness: 0.7 }));
    const pages = prop(new THREE.BoxGeometry(bw - 0.012, bd - 0.008, bh - 0.006), M.pages);
    pages.position.x = 0.004; book.add(cover, pages);
    book.position.set(-span * 0.2, 0, z + bh / 2); book.rotation.z = 0.12 - i * 0.14;
    z += bh; g.add(book);
  });
  table.add(g);
  return true;
}

// ------------------------------------------------------------------ curtains at the real windows
const curtainGroups = [];
function windowsOf(room, floorId) {
  const w = W(), f = w.house.floors.find((x) => x.id === floorId) || w.house.floors[0];
  const out = [];
  for (const wall of f.walls) {
    for (const op of wall.openings || []) {
      if (op.type !== 'window') continue;
      const [ax, ay] = wall.a, [bx, by] = wall.b, len = Math.hypot(bx - ax, by - ay);
      if (len < 0.1) continue;
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      const c = (op.at == null ? 0.5 : op.at) * len;
      const cx = ax + ux * c, cy = ay + uy * c;
      let nx = -uy, ny = ux;                             // the normal into this room
      if (w.roomAt(cx + nx * 0.3, cy + ny * 0.3, floorId) !== room) { nx = -nx; ny = -ny; }
      if (w.roomAt(cx + nx * 0.3, cy + ny * 0.3, floorId) !== room) continue;
      out.push({ cx, cy, ux, uy, nx, ny, width: op.width || 1, top: (op.bottom || 0.8) + (op.height || 1.3) });
    }
  }
  return out;
}
function pleated(width, height) {
  // Deep, even folds (about one every 9 cm), shaded in their hollows so they read as fabric and not as a board:
  // the vertex colour darkens towards the back of each fold, the way a real drape catches less light there.
  const folds = Math.max(4, Math.round(width / 0.09));
  const g = new THREE.PlaneGeometry(width, height, folds * 8, 4);
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    const ph = (x / width + 0.5) * folds * Math.PI * 2;
    const hem = 0.85 + 0.3 * (0.5 - y / height);          // folds open up a little towards the hem
    p.setZ(i, Math.sin(ph) * 0.045 * hem);
    const shade = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(ph));
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = shade;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
function addCurtains(room, floorId, floorZ, color) {
  removeCurtains(room);
  const wins = windowsOf(room, floorId);
  const mat = linen(color).clone(); mat.side = THREE.DoubleSide; mat.vertexColors = true;
  for (const win of wins) {
    const g = new THREE.Group(); g.userData.room = room.id; g.name = 'styling-curtains';
    const rodZ = Math.min(2.45, win.top + 0.18), drop = rodZ - 0.02, panel = Math.max(0.35, win.width * 0.32);
    const rodLen = win.width + 0.5;
    const rod = prop(new THREE.CylinderGeometry(0.012, 0.012, rodLen, 10), M.rod);
    rod.rotation.z = Math.PI / 2; rod.position.set(0, 0, rodZ); g.add(rod);
    for (const s of [-1, 1]) {                           // drawn open, one panel each side of the glass
      const m = prop(pleated(panel, drop), mat);
      m.rotation.x = Math.PI / 2;                        // stand the plane up (its y becomes our z)
      m.position.set(s * (win.width / 2 + panel / 2 - 0.1), -0.0, drop / 2 + 0.02);
      g.add(m);
    }
    g.position.set(win.cx + win.nx * 0.13, win.cy + win.ny * 0.13, floorZ);
    g.rotation.z = Math.atan2(win.uy, win.ux);
    W().scene.add(g);
    curtainGroups.push(g);
  }
  return wins.length;
}
function removeCurtains(room) {
  for (let i = curtainGroups.length - 1; i >= 0; i--) {
    const g = curtainGroups[i];
    if (room && g.userData.room !== room.id) continue;
    g.parent && g.parent.remove(g);
    curtainGroups.splice(i, 1);
  }
}

// ------------------------------------------------------------------ pouf and console, as catalog pieces
function placeNear(kind, x, y, rot) {
  const w = W();
  if (typeof w.placeObject === 'function') {
    const r = w.placeObject(kind, x, y, { rot });
    return r && r.fits ? r.item || true : null;
  }
  return null;
}
function addPouf(room, sofa, table) {
  const w = W(), anchor = table || sofa;
  if (!anchor) return false;
  if (w.furniture.children.some((o) => o.userData.kind === 'pouf' && w.roomAt(o.position.x, o.position.y, o.userData.floor) === room)) return false;
  const r = (sofa || anchor).rotation.z, c = Math.cos(r), s = Math.sin(r);
  for (const side of [1, -1]) {                         // beside the coffee table, a little towards the room
    const x = anchor.position.x + c * side * 0.85 - s * -0.25, y = anchor.position.y + s * side * 0.85 + c * -0.25;
    if (placeNear('pouf', x, y, r)) return true;
  }
  return false;
}
function addConsole(room, sofa) {
  const w = W();
  if (!sofa) return false;
  if (w.furniture.children.some((o) => o.userData.kind === 'console' && w.roomAt(o.position.x, o.position.y, o.userData.floor) === room)) return false;
  const spec = w.FURNITURE.sofa, cs = w.FURNITURE.console;
  const r = sofa.rotation.z, c = Math.cos(r), s = Math.sin(r);
  const back = spec.d / 2 + 0.08 + cs.d / 2;            // local +y is the sofa's back
  const x = sofa.position.x - s * back, y = sofa.position.y + c * back;
  const placed = placeNear('console', x, y, r);
  if (!placed) return false;                             // the sofa is against a wall: no room behind it
  if (placed !== true && Math.hypot(placed.position.x - x, placed.position.y - y) > 0.3) {   // put somewhere else: not wanted
    placed.parent && placed.parent.remove(placed);
    return false;
  }
  if (typeof w.placeObject === 'function') w.placeObject('tablelamp', x + c * 0.4, y + s * 0.4, { rot: r });
  return true;
}

// ------------------------------------------------------------------ the tool
function pieceIn(room, kind) {
  const w = W();
  return w.furniture.children.find((o) => o.userData.kind === kind && !o.userData.meshPiece
    && w.roomAt(o.position.x, o.position.y, o.userData.floor) === room) || null;
}
function colourOf(accent, palette) {
  if (accent) { try { return '#' + new THREE.Color(lower(accent).replace(/\s+/g, '')).getHexString(); } catch (e) { /* not a CSS name */ } }
  return ACCENT[palette] || ACCENT.modern;
}

export async function styleRoom({ room, accent, add } = {}) {
  const w = W();
  if (!w || !w.current) return { ok: false, reason: 'the viewer is not ready' };
  const r = room ? (w.house.rooms.find((x) => x.id === room) || w.house.rooms.find((x) => lower(x.label).includes(lower(room))))
    : w.roomAt(w.current.pos[0], w.current.pos[1], w.current.floor);
  if (!r) return { ok: false, reason: 'Stand in a room (or name one) and ask again.' };
  const want = (Array.isArray(add) && add.length ? add : DEFAULT_ADD).map(lower);
  const sofa = pieceIn(r, 'sofa'), table = pieceIn(r, 'coffeetable');
  const palette = (sofa && sofa.userData.style) || 'modern';
  const col = colourOf(accent, palette);
  for (const it of [sofa, table]) if (it) await settled(it);
  const added = [], skipped = [];
  const did = (name, ok, why) => (ok ? added : skipped).push(ok ? name : `${name} (${why})`);
  if (want.includes('pillows')) did('put cushions on the sofa', !!sofa && addPillows(sofa, col), 'no sofa here');
  if (want.includes('throw')) did('laid a knitted throw over it', !!sofa && addThrow(sofa, col), 'no sofa here');
  if (want.includes('coffee_table')) did('styled the coffee table with books and greenery', !!table && styleCoffeeTable(table), 'no coffee table');
  if (want.includes('pouf')) did('added a pouf', addPouf(r, sofa, table), 'no room for one');
  if (want.includes('console')) did('put a console table with a lamp behind the sofa', addConsole(r, sofa), 'the sofa is against the wall');
  if (want.includes('curtains')) {
    const n = addCurtains(r, w.current.floor, w.current.floorZ || 0, new THREE.Color(col).lerp(new THREE.Color(0xf3eee6), 0.35).getHex());
    did(`hung curtains at ${n === 1 ? 'the window' : `the ${n} windows`}`, n > 0, 'no windows in this room');
  }
  if (want.includes('gallery')) {
    const g = w.decor && w.decor.hangGallery ? w.decor.hangGallery({ theme: accent ? `${accent} toned` : 'warm neutral' }) : null;
    did('hung a gallery wall', !!(g && g.ok), 'no free wall');
  }
  if (want.includes('mirror')) {
    const m = w.decor && w.decor.hangPicture ? w.decor.hangPicture({ description: 'a round mirror with a thin brass frame, reflecting the room', wall: 'above the sofa', width_m: 0.8, height_m: 0.8, frame: 'oak' }) : null;
    did('hung a round mirror', !!(m && m.ok), 'no free wall');
  }
  const list = added.length > 1 ? `${added.slice(0, -1).join(', ')} and ${added[added.length - 1]}` : added[0];
  const say = added.length ? `I ${list}.` : `Nothing to style yet in the ${lower(r.label)}${skipped.length ? `: ${skipped.join('; ')}` : ''}.`;
  return { ok: added.length > 0, room: r.label, accent: col, added, skipped, say };
}

export function clearStyle(roomName) {
  const w = W();
  const r = roomName ? w.house.rooms.find((x) => lower(x.label).includes(lower(roomName))) : w.roomAt(w.current.pos[0], w.current.pos[1], w.current.floor);
  removeCurtains(r);
  for (const o of w.furniture.children) for (const c of [...o.children]) if (c.userData.styling) o.remove(c);
  return { ok: true };
}

// ------------------------------------------------------------------ John: one tool, a narrow job
const declarations = [{
  name: 'style_room',
  description: 'Finishing touches on a room that already has furniture: throw pillows and a knitted throw on the sofa, the coffee table styled (tray, books, vase of greenery), a pouf, a console table with a lamp behind the sofa, curtains at the real windows, a gallery wall of three framed pieces, or a round mirror. Use for "make it prettier / cosier / more lived-in", "add cushions", "style the coffee table", "add curtains", "a gallery wall". Not for furnishing an empty room (suggest_room) or a themed makeover (decorate_room).',
  parameters: { type: 'object', properties: {
    room: { type: 'string', description: 'Room name; leave empty for the room the user is in.' },
    accent: { type: 'string', description: 'Accent colour in the user\'s words, e.g. "rust", "sage green", "navy". Leave empty to suit the room.' },
    add: { type: 'array', items: { type: 'string', enum: ['pillows', 'throw', 'coffee_table', 'pouf', 'console', 'curtains', 'gallery', 'mirror'] },
      description: 'What to add. Leave empty for pillows, throw, coffee_table, pouf and console. Only include curtains, gallery or mirror when asked.' },
  } },
}];
const rules = `- Finishing touches on a furnished room ("make it prettier", "cosier", "add cushions", "style the coffee table", "add curtains", "gallery wall") -> style_room. An empty room gets suggest_room first. A theme ("as if I'm a Ronaldo fan", "make it Moroccan") stays decorate_room.`;

(function attach(tries = 0) {
  const w = W();
  if (!w || !w.furniture || !w.house) { if (tries < 600) setTimeout(() => attach(tries + 1), 50); return; }
  w.styling = { styleRoom, clearStyle };
  (window.walkinTools = window.walkinTools || []).push({ declarations, run: { style_room: (a) => styleRoom(a || {}) }, rules });
})();
