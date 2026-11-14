// John's furniture hands: list, move, turn, remove and recolour pieces that are already in the house.
// Registered through the agent tool registry (agent.js), so agent.js and live.js pick these up unchanged:
//   list_furniture, move_furniture, rotate_furniture, remove_furniture, set_furniture_color
// and a superset of add_furniture (same as before, plus optional room / against / color, so "add a queen bed in the
// bedroom and make it red" is one call instead of three rounds).
//
// Every placement is tested before it is written: the footprint has to be inside the room, clear of the wall bands
// and of other pieces (and of walkin.physics' own probe when it is loaded), and the fit check (fit.js) is reported the
// same way add_furniture reports it. Talks to the viewer only through window.walkin. Units: metres, Z up.
//   walkin.furnitureTools.resolve('the sofa')  -> [item]     (for tests / the console)
import * as THREE from 'three';
import { FURNITURE, PLANTS } from './furniture.js';
import { fitReport, fitLine, footprint, overlaps, pointInPoly, openings } from './fit.js';

const W = () => window.walkin;
const r2 = (v) => Math.round(v * 100) / 100;
const lower = (s) => String(s || '').toLowerCase();
const WALL_GAP = 0.04;           // a piece pushed against a wall stands this far off its face
const DEFAULT_TH = 0.12;         // wall thickness when the graph doesn't say

// ------------------------------------------------------------------ the pieces, with short ids
const pieces = () => {
  const w = W();
  return (w && w.furniture ? w.furniture.children : []).filter((o) => o.userData && o.userData.kind && !o.userData.meshPiece);
};

/** sofa1, queen1, chair2… stable for the life of the piece. */
function idOf(item) {
  if (item.userData.fid) return item.userData.fid;
  const kind = item.userData.kind;
  const used = new Set(pieces().map((o) => o.userData.fid).filter(Boolean));
  let n = 1;
  while (used.has(`${kind}${n}`)) n++;
  item.userData.fid = `${kind}${n}`;
  return item.userData.fid;
}

let last = null;                 // the piece John or the user touched last
function touch(item) {
  last = item;
  const w = W();
  if (w.select && w.furniture.children.includes(item)) w.select(item);
}
// the user grabbing or clicking a piece makes it "it" as well
setInterval(() => {
  const s = W() && W().selected;
  if (s && s.userData && s.userData.kind && !s.userData.meshPiece) last = s;
}, 250);

const alive = (o) => !!(o && W().furniture.children.includes(o));

// ------------------------------------------------------------------ words -> kinds, rooms
const SYN = [
  ['king size bed', ['king']], ['king bed', ['king']], ['king', ['king']],
  ['queen size bed', ['queen']], ['queen bed', ['queen']], ['double bed', ['queen']], ['queen', ['queen']],
  ['bed', ['queen', 'king']],
  ['coffee table', ['coffeetable']], ['side table', ['sidetable']], ['end table', ['sidetable']],
  ['bedside table', ['nightstand']], ['night stand', ['nightstand']], ['nightstand', ['nightstand']],
  ['dining table', ['table']], ['kitchen table', ['table']],
  ['tv stand', ['tvstand']], ['media console', ['tvstand']], ['tv unit', ['tvstand']], ['tv cabinet', ['tvstand']],
  ['television', ['tv']], ['tv', ['tv']],
  ['armchair', ['armchair']], ['arm chair', ['armchair']], ['recliner', ['armchair']], ['lounge chair', ['armchair']],
  ['couch', ['sofa']], ['settee', ['sofa']], ['loveseat', ['sofa']], ['sofa', ['sofa']],
  ['dining chair', ['chair']], ['chair', ['chair', 'armchair']],
  ['desk', ['desk']], ['table', ['table', 'coffeetable', 'sidetable', 'desk']],
  ['bookcase', ['bookcase']], ['bookshelf', ['bookcase']], ['shelves', ['bookcase']], ['shelf', ['bookcase']],
  ['floor lamp', ['floorlamp']], ['lamp', ['floorlamp']],
  ['round rug', ['ruground']], ['rug', ['rug', 'ruground']], ['carpet', ['rug', 'ruground']],
  ['tall cactus', ['cactustall']], ['cactus', ['cactus', 'cactustall']], ['fern', ['plantfern']],
  ['succulent', ['plantsucculent']], ['small plant', ['plantsmall', 'plantfern', 'plantsucculent']],
  ['plant', PLANTS],
];

/** Kinds named in a phrase (most specific phrase wins), or null if none. */
function kindsIn(text) {
  const t = ` ${lower(text).replace(/[^a-z0-9 ]+/g, ' ')} `;
  for (const k of Object.keys(FURNITURE)) if (t.includes(` ${k} `) || t.includes(` ${k}s `)) return [k];
  for (const [word, kinds] of SYN) {
    if (t.includes(` ${word} `) || t.includes(` ${word}s `) || t.includes(` ${word}es `)) return kinds;
  }
  for (const [k, f] of Object.entries(FURNITURE)) if (t.includes(` ${lower(f.name)} `)) return [k];
  return null;
}

const usableRooms = () => W().house.rooms.filter((r) => r.poly && r.poly.length > 2);
const area = (r) => (r.dims && r.dims.areaFloor) || polyArea(r.poly);
function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

function userPos() {
  const c = W().current;
  return c ? { x: c.pos[0], y: c.pos[1], floor: c.floor } : null;
}
const userRoom = () => { const u = userPos(); return u ? W().roomAt(u.x, u.y, u.floor) : null; };
const roomOf = (item) => W().roomAt(item.position.x, item.position.y, item.userData.floor);

const ROOM_SYN = [['lounge', 'living room'], ['family room', 'living room'], ['sitting room', 'living room'],
  ['master', 'bedroom'], ['bed room', 'bedroom'], ['dining', 'dining room'], ['study', 'office'], ['hall', 'hallway'],
  ['bath', 'bathroom']];

/** A room named in a phrase: by id, by label (longest first). The user's room wins a tie, then the biggest. */
function roomIn(text, { prefer } = {}) {
  if (!text) return null;
  let t = lower(text);
  const rooms = usableRooms();
  const byId = rooms.find((r) => t.includes(lower(r.id)));
  if (byId) return byId;
  if (/\b(this|current|same) room\b|\broom i'?m in\b|\bhere\b/.test(t) && !/\b(living|dining|bed|bath)\s?room\b/.test(t)) return userRoom();
  for (const [a, b] of ROOM_SYN) if (t.includes(a) && !t.includes(b)) t += ` ${b}`;
  const labels = [...new Set(rooms.map((r) => lower(r.label)).filter((l) => l && l !== 'room'))].sort((a, b) => b.length - a.length);
  const label = labels.find((l) => t.includes(l) || t.includes(l.replace(' ', '')));
  if (!label) return null;
  const cands = rooms.filter((r) => lower(r.label) === label);
  const other = /\b(other|second|another|smaller)\b/.test(t);
  const ur = userRoom();
  if (!other && ur && cands.includes(ur)) return ur;
  if (!other && prefer && cands.includes(prefer)) return prefer;
  const sorted = cands.sort((a, b) => area(b) - area(a));
  if (/\bsmall(er|est)?\b/.test(t)) return sorted[sorted.length - 1];
  if (other) return sorted.find((r) => r !== ur && r !== prefer) || sorted[0];
  return sorted[0];
}

// ------------------------------------------------------------------ "the sofa", "it", "the bed in the bedroom"
const IT = /^\s*(it|that|this|this one|that one|the one|the piece|selected|the selected (one|piece)|last|the last one|him|her|them)?\s*$/i;
const ALL = /\b(all|everything|every piece|every thing|all furniture|all the furniture|whole house|everything placed)\b/i;

/**
 * The pieces a phrase means. `many` lets plurals and "all" return several; otherwise one piece, chosen as:
 * the one you touched last, the one you point at, the nearest to you.
 */
function resolve(target, { many = false } = {}) {
  const w = W(), all = pieces();
  if (!all.length) return { items: [], why: 'Nothing is placed yet.' };
  const t = lower(target).trim();
  const lastOk = alive(last) && !last.userData.meshPiece ? last : null;
  const sel = w.selected && alive(w.selected) && !w.selected.userData.meshPiece ? w.selected : null;
  const pointed = w.pointer && w.pointer.item && alive(w.pointer.item) && !w.pointer.item.userData.meshPiece ? w.pointer.item : null;

  if (IT.test(t)) {
    const it = sel || lastOk || pointed || (all.length === 1 ? all[0] : null);
    return it ? { items: [it] } : { items: [], why: 'Which piece? Nothing is selected; name it (e.g. "the sofa").' };
  }
  const byId = all.find((o) => t.replace(/[\s#]+/g, '') === idOf(o) || new RegExp(`\\b${idOf(o)}\\b`).test(t.replace(/\s+#?(\d)/, '$1')));
  if (byId) return { items: [byId] };

  const kinds = kindsIn(t);
  const room = /\b(in|from|of)\b/.test(t) || !kinds ? roomIn(t) : null;
  if (ALL.test(t) && !kinds && !room) return { items: all };
  let items = all;
  if (kinds) {
    const exact = items.filter((o) => kinds.includes(o.userData.kind));
    // "the chair" when only an armchair is placed: fall back to the looser word list
    const loose = SYN.find(([wd]) => new RegExp(`\\b${wd}(e?s)?\\b`).test(t));
    items = exact.length || !loose ? exact : items.filter((o) => loose[1].includes(o.userData.kind));
  }
  if (room) items = items.filter((o) => roomOf(o) === room);
  // "the blue sofa"
  const tinted = items.filter((o) => o.userData.tint && o.userData.tint.words.some((wd) => t.includes(wd)));
  if (tinted.length) items = tinted;
  if (!kinds && !room) {
    if (/\b(here|there|pointing|point at|looking at)\b/.test(t) && pointed) return { items: [pointed] };
    return { items: [], why: `I don't know which piece "${target}" is. Placed: ${all.map(idOf).join(', ')}.` };
  }
  if (!items.length) {
    return { items: [], why: `There is no ${kinds ? FURNITURE[kinds[0]].name.toLowerCase() : 'piece'}${room ? ` in the ${lower(room.label)}` : ''}. Placed: ${all.map(idOf).join(', ')}.` };
  }
  const plural = ALL.test(t) || /\b(both|every|each)\b/.test(t) || (kinds && /s\b/.test(t.split(/\s+/).pop()) && !kinds.some((k) => t.endsWith(k)))
    || (!kinds && room);
  if (many && plural) return { items };
  if (items.length === 1) return { items };
  const pick = [sel, lastOk, pointed].find((o) => o && items.includes(o));
  if (pick) return { items: [pick] };
  const u = userPos();
  items.sort((a, b) => (u ? Math.hypot(a.position.x - u.x, a.position.y - u.y) - Math.hypot(b.position.x - u.x, b.position.y - u.y) : 0));
  return { items: [items[0]] };
}

// ------------------------------------------------------------------ geometry
function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length], f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) return poly.reduce((s, p) => [s[0] + p[0] / poly.length, s[1] + p[1] / poly.length], [0, 0]);
  return [cx / (3 * a), cy / (3 * a)];
}

function floorWalls(floorId) {
  const h = W().house, f = (h.floors || []).find((q) => q.id === floorId) || (h.floors || [])[0];
  return ((f && f.walls) || []).filter((x) => x.type === 'wall');
}

/** Thickness of the wall that runs along a room edge (room polygons follow wall centre lines). */
function thicknessAt(floorId, mx, my, dx, dy) {
  let best = DEFAULT_TH, bestD = 0.25;
  for (const w of floorWalls(floorId)) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (len < 0.1) continue;
    const ux = (w.b[0] - w.a[0]) / len, uy = (w.b[1] - w.a[1]) / len;
    if (Math.abs(ux * dx + uy * dy) < 0.95) continue;
    const t = Math.max(0, Math.min(len, (mx - w.a[0]) * ux + (my - w.a[1]) * uy));
    const d = Math.hypot(w.a[0] + ux * t - mx, w.a[1] + uy * t - my);
    if (d < bestD) { bestD = d; best = w.thickness || DEFAULT_TH; }
  }
  return best;
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The room's walls: one entry per polygon edge, with inward normal, thickness and the windows/doors on it. */
function edgesOf(room) {
  const holes = openings(room, W().house);
  const n = room.poly.length, out = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = room.poly[i], [bx, by] = room.poly[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.4) continue;
    const dx = (bx - ax) / len, dy = (by - ay) / len, mx = (ax + bx) / 2, my = (ay + by) / 2;
    let nx = -dy, ny = dx;
    if (!pointInPoly(mx + nx * 0.25, my + ny * 0.25, room.poly)) { nx = -nx; ny = -ny; }
    const windows = [], doors = [];
    for (const h of holes) {
      const cx = h.x - h.inward[0] * 0.4, cy = h.y - h.inward[1] * 0.4;      // the opening's centre, on the wall
      if (distToSeg(cx, cy, ax, ay, bx, by) > 0.3) continue;
      const s = (cx - ax) * dx + (cy - ay) * dy;
      (h.kind === 'window' ? windows : doors).push({ x: cx, y: cy, s, width: h.width });
    }
    out.push({ ax, ay, bx, by, mx, my, dx, dy, nx, ny, len, windows, doors,
      th: thicknessAt(room.floor, mx, my, dx, dy), facing: Math.atan2(ny, nx) + Math.PI / 2 });
  }
  return out;
}

/** A piece's front is its local -y: at rotation r it points along (sin r, -cos r). */
const facingTo = (ux, uy) => Math.atan2(uy, ux) + Math.PI / 2;
const frontOf = (rot) => [Math.sin(rot), -Math.cos(rot)];
const normAng = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Spots along a wall edge with the piece's back to it, starting at `s0` metres along it and stepping out. */
function alongEdge(e, kind, s0 = e.len / 2) {
  const spec = FURNITURE[kind];
  const back = spec.d / 2 + e.th / 2 + WALL_GAP, half = spec.w / 2 + 0.05;
  const lo = half, hi = e.len - half;
  const out = [];
  if (hi < lo) return [{ x: e.mx + e.nx * back, y: e.my + e.ny * back, rot: e.facing }];
  const start = Math.max(lo, Math.min(hi, s0));
  for (let k = 0; k <= 30; k++) {
    for (const sg of k ? [1, -1] : [1]) {
      const s = start + sg * k * 0.15;
      if (s < lo - 1e-6 || s > hi + 1e-6) continue;
      out.push({ x: e.ax + e.dx * s + e.nx * back, y: e.ay + e.dy * s + e.ny * back, rot: e.facing });
    }
  }
  return out;
}

// ------------------------------------------------------------------ is a spot free?
/** Footprint inside the room, clear of every wall band and every other standing piece. */
function spotClear(item, x, y, rot, room) {
  const w = W(), kind = item.userData.kind, spec = FURNITURE[kind], floor = item.userData.floor;
  const r = w.roomAt(x, y, floor);
  if (room && r !== room) return false;
  if (!r) return false;
  const poly = footprint(kind, x, y, rot, -0.01);
  if (!poly.every(([px, py]) => pointInPoly(px, py, r.poly))) return false;
  if (spec.flat) return true;                                   // a rug lies under things
  for (const wl of floorWalls(floor)) {
    const len = Math.hypot(wl.b[0] - wl.a[0], wl.b[1] - wl.a[1]);
    if (len < 0.1) continue;
    const ux = (wl.b[0] - wl.a[0]) / len, uy = (wl.b[1] - wl.a[1]) / len, th = Math.max(0.06, wl.thickness || DEFAULT_TH) / 2;
    const nx = -uy * th, ny = ux * th;
    if (overlaps(poly, [[wl.a[0] + nx, wl.a[1] + ny], [wl.b[0] + nx, wl.b[1] + ny], [wl.b[0] - nx, wl.b[1] - ny], [wl.a[0] - nx, wl.a[1] - ny]])) return false;
  }
  for (const o of pieces()) {
    if (o === item || o.userData.on === item.uuid || item.userData.on === o.uuid) continue;
    if ((FURNITURE[o.userData.kind] || {}).flat || o.userData.on || o.userData.floor !== floor) continue;
    if (overlaps(poly, footprint(o.userData.kind, o.position.x, o.position.y, o.rotation.z, -0.01))) return false;
  }
  if (w.physics && w.physics.enabled && w.physics.probe) {      // physics' own idea of walls (doorways open)
    const p = w.physics.probe(item, x, y, rot);
    if (p && p.hit) return false;
  }
  return true;
}

const riders = (item) => pieces().filter((o) => o.userData.on === item.uuid);
function fitsAt(item, x, y, rot) {
  const r = fitReport({ kind: item.userData.kind, x, y, rot, floor: item.userData.floor, ignore: [item, ...riders(item)], quick: true });
  return r.ok;
}

/**
 * The first good spot: the candidates in order, then rings around the first few. A spot that fits (no door
 * blocked, nothing overlapped) beats one that is merely free. `exact` takes the first candidate if it is free,
 * even if it blocks a door: the user asked for that spot.
 */
function findSpot(item, cands, room, { exact = false, keepRot = true } = {}) {
  if (!cands.length) return null;
  if (exact && spotClear(item, cands[0].x, cands[0].y, cands[0].rot, room)) return cands[0];
  const rings = [];
  for (const c of cands.slice(0, 3)) {
    for (let rr = 0.1; rr <= 2.01; rr += 0.1) {
      const nA = Math.max(8, Math.round(rr * 20));
      for (let i = 0; i < nA; i++) {
        const a = (i / nA) * Math.PI * 2;
        rings.push({ x: c.x + Math.cos(a) * rr, y: c.y + Math.sin(a) * rr, rot: c.rot });
      }
    }
  }
  const all = [...cands, ...rings];
  for (const c of all) if (spotClear(item, c.x, c.y, c.rot, room) && fitsAt(item, c.x, c.y, c.rot)) return c;
  for (const c of all) if (spotClear(item, c.x, c.y, c.rot, room)) return c;
  if (!keepRot) return null;
  // last resort: the same spots turned a quarter
  const turned = all.slice(0, 400).map((c) => ({ ...c, rot: c.rot + Math.PI / 2 }));
  for (const c of turned) if (spotClear(item, c.x, c.y, c.rot, room)) return c;
  return null;
}

// ------------------------------------------------------------------ putting it there
const nextFrame = () => new Promise((res) => {
  let done = false;
  const fin = () => { if (!done) { done = true; res(); } };
  requestAnimationFrame(() => requestAnimationFrame(fin));
  setTimeout(fin, 120);                                         // a hidden tab gets no frames
});

async function put(item, x, y, rot) {
  const w = W();
  if (item.userData.on) {                                       // a plant lifted off a table goes to the floor
    item.userData.on = null;
    item.position.z = ((w.current && w.current.floorZ) || 0) + 0.004;
  }
  item.position.x = x; item.position.y = y; item.rotation.z = normAng(rot);
  touch(item);
  await nextFrame();
  await new Promise((res) => setTimeout(res, 120));
  if (w.checkFit) w.checkFit();
}

function report(item, extra = {}) {
  const w = W();
  const on = item.userData.on && pieces().find((s) => s.uuid === item.userData.on);
  const r = fitReport({ item, ignore: on ? [on] : [] });
  const room = r.room || roomOf(item);
  return { ok: true, id: idOf(item), kind: item.userData.kind, room: room ? room.label : null, fits: !!r.ok,
    fit: fitLine(r), ...extra, position: [r2(item.position.x), r2(item.position.y)],
    facing_deg: Math.round(((item.rotation.z * 180 / Math.PI) % 360 + 360) % 360) };
}

// ------------------------------------------------------------------ where "to" is
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, half: 0.5, 'half a': 0.5, couple: 2, 'a couple of': 2, few: 0.3, bit: 0.3, little: 0.3 };
/** "a metre", "1.5 m", "50 cm", "two feet", "a bit" -> metres, or null. */
function distanceIn(text) {
  const t = lower(text);
  let m = t.match(/(\d+(?:\.\d+)?)\s*(cm|centimet(?:er|re)s?|mm|m\b|met(?:er|re)s?|ft|feet|foot|in\b|inch(?:es)?)?/);
  if (m) {
    const v = parseFloat(m[1]), u = m[2] || 'm';
    if (/^cm|^centi/.test(u)) return v / 100;
    if (/^mm/.test(u)) return v / 1000;
    if (/^f/.test(u)) return v * 0.3048;
    if (/^in/.test(u)) return v * 0.0254;
    return v;
  }
  m = t.match(/\b(half a|a couple of|a|an|one|two|three|four|five|half)\s+(met(?:er|re)s?|m|feet|foot|ft|step|steps)\b/);
  if (m) {
    const v = NUM_WORDS[m[1]] || 1;
    return /^f/.test(m[2]) ? v * 0.3048 : /^step/.test(m[2]) ? v * 0.6 : v;
  }
  if (/\b(a (little )?bit|slightly|a little|a touch|nudge)\b/.test(t)) return 0.3;
  return null;
}

function camVectors() {
  const cam = W().camera;
  cam.updateMatrixWorld();
  const e = cam.matrixWorld.elements;
  let rx = e[0], ry = e[1];                                     // camera +x (screen right) in the model frame
  const rl = Math.hypot(rx, ry) || 1;
  rx /= rl; ry /= rl;
  const d = cam.getWorldDirection(new THREE.Vector3());
  let fx = d.x, fy = d.y;
  const fl = Math.hypot(fx, fy) || 1;
  fx /= fl; fy /= fl;
  return { right: [rx, ry], fwd: [fx, fy] };
}

function nearestEdge(edges, x, y, minLen = 0) {
  const ok = edges.filter((e) => e.len >= minLen);
  return (ok.length ? ok : edges).slice().sort((a, b) => distToSeg(x, y, a.ax, a.ay, a.bx, a.by) - distToSeg(x, y, b.ax, b.ay, b.bx, b.by))[0];
}

/** An edge of `room` that matches a wall from the graph / pointer ({a, b}), or null. */
function edgeForWall(edges, wall) {
  if (!wall) return null;
  const mx = (wall.a[0] + wall.b[0]) / 2, my = (wall.a[1] + wall.b[1]) / 2;
  const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]) || 1;
  const ux = (wall.b[0] - wall.a[0]) / len, uy = (wall.b[1] - wall.a[1]) / len;
  const par = edges.filter((e) => Math.abs(e.dx * ux + e.dy * uy) > 0.9);
  par.sort((a, b) => distToSeg(mx, my, a.ax, a.ay, a.bx, a.by) - distToSeg(mx, my, b.ax, b.ay, b.bx, b.by));
  return par[0] && distToSeg(mx, my, par[0].ax, par[0].ay, par[0].bx, par[0].by) < 0.4 ? par[0] : null;
}

function windowEdge(room, near, item) {
  const edges = edgesOf(room).filter((e) => e.windows.length);
  if (!edges.length) return null;
  const w = W();
  const pw = w.pointer && w.pointer.wall && edgeForWall(edges, w.pointer.wall);
  if (pw) return pw;
  const spec = FURNITURE[item.userData.kind];
  const roomy = edges.filter((e) => e.len >= spec.w + 0.1);
  const list = roomy.length ? roomy : edges;
  return list.sort((a, b) => distToSeg(near[0], near[1], a.ax, a.ay, a.bx, a.by) - distToSeg(near[0], near[1], b.ax, b.ay, b.bx, b.by))[0];
}

/** Fallback when the ray at eye height leaves through a doorway: the user's room edge straight ahead. */
function roomWallAhead() {
  const u = userPos(), r = userRoom();
  if (!u || !r) return null;
  const { fwd } = camVectors();
  let best = null;
  for (const e of edgesOf(r)) {
    const den = fwd[0] * e.dy - fwd[1] * e.dx;
    if (Math.abs(den) < 1e-6) continue;
    const t = ((e.ax - u.x) * e.dy - (e.ay - u.y) * e.dx) / den;
    const s = ((e.ax - u.x) * fwd[1] - (e.ay - u.y) * fwd[0]) / den;
    if (t > 0.1 && s >= 0 && s <= e.len && (!best || t < best.t)) best = { t, e };
  }
  if (!best) return null;
  const e = best.e;
  return { a: [e.ax, e.ay], b: [e.bx, e.by], normal: [e.nx, e.ny, 0], index: -1 };
}

/** {cands, room, desc, exact} for a "to" phrase, or {error}. */
function plan(item, args) {
  const w = W(), kind = item.userData.kind, spec = FURNITURE[kind];
  const to = lower([args.to, args.direction].filter(Boolean).join(' '));
  const x0 = item.position.x, y0 = item.position.y, rot0 = item.rotation.z;
  const here = roomOf(item) || userRoom();
  const named = roomIn(args.room || to, { prefer: here });
  const room = named || here;
  const u = userPos();

  // next to / beside / in front of another piece
  const refText = args.next_to || (to.match(/\b(?:next to|beside|by|near|alongside|in front of|opposite|across from|facing)\s+(?:the\s+)?(.+)$/) || [])[1];
  if (refText && kindsIn(refText)) {
    const ref = resolve(refText).items.find((o) => o !== item);
    if (ref) {
      const rs = FURNITURE[ref.userData.kind], rr = ref.rotation.z;
      const sx = Math.cos(rr), sy = Math.sin(rr), [fx, fy] = frontOf(rr);
      const rref = roomOf(ref);
      if (/\b(in front of|opposite|across from|facing)\b/.test(to) && !args.next_to) {
        const gap = /opposite|across|facing/.test(to) ? 1.4 : 0.35;
        const dist = rs.d / 2 + spec.d / 2 + gap;
        return { room: rref, desc: `in front of the ${lower(rs.name)}`,
          cands: [{ x: ref.position.x + fx * dist, y: ref.position.y + fy * dist, rot: rr + Math.PI }] };
      }
      const off = rs.w / 2 + spec.w / 2 + 0.1, back = (rs.d - spec.d) / 2;  // flush with its back
      const side = (sg) => ({ x: ref.position.x + sx * off * sg - fx * back, y: ref.position.y + sy * off * sg - fy * back, rot: rr });
      const closer = Math.hypot(side(1).x - x0, side(1).y - y0) <= Math.hypot(side(-1).x - x0, side(-1).y - y0);
      const sides = /\bleft\b/.test(to) ? [side(-1), side(1)] : /\bright\b/.test(to) ? [side(1), side(-1)] : closer ? [side(1), side(-1)] : [side(-1), side(1)];
      return { room: rref, desc: `next to the ${lower(rs.name)}`, cands: sides };
    }
  }

  // relative: left / right / closer / further, by a distance
  const dist = typeof args.distance_m === 'number' && args.distance_m > 0 ? args.distance_m : distanceIn(to);
  const dirm = to.match(/\b(left|right|closer|nearer|toward(?:s)? me|further|farther|away(?: from me)?|forward|backward|back)\b/);
  if (dirm && !/\b(against|wall|window|room|middle|centre|center|corner)\b/.test(to.replace(dirm[0], ''))) {
    const { right } = camVectors();
    const d = dist || 0.5;
    let vx = 0, vy = 0;
    const word = dirm[1];
    if (word === 'left') [vx, vy] = [-right[0], -right[1]];
    else if (word === 'right') [vx, vy] = right;
    else if (u) {
      const dx = u.x - x0, dy = u.y - y0, L = Math.hypot(dx, dy) || 1;
      const toward = /closer|nearer|toward|forward/.test(word);
      [vx, vy] = toward ? [dx / L, dy / L] : [-dx / L, -dy / L];
    }
    const stop = /closer|nearer|toward|forward/.test(word) && u ? Math.max(0, Math.hypot(u.x - x0, u.y - y0) - 0.9) : Infinity;
    const step = Math.min(d, stop);
    const cands = [];
    for (let f = 1; f >= 0.2; f -= 0.1) cands.push({ x: x0 + vx * step * f, y: y0 + vy * step * f, rot: rot0 });
    return { room: null, exact: true, desc: `${r2(step)} m ${word}`, cands, linear: true };
  }

  // against the window (wall)
  if (/\bwindows?\b/.test(to)) {
    if (!room) return { error: 'It is not inside a room.' };
    const e = windowEdge(room, [x0, y0], item);
    if (!e) return { error: `The ${lower(room && room.label)} has no window in the scan.` };
    const win = e.windows.slice().sort((a, b) => b.width - a.width)[0];
    return { room, desc: `against the window wall of the ${lower(room.label)}`, cands: alongEdge(e, kind, win.s) };
  }

  // against the wall I'm looking at / pointing at
  if (/\bwall\b/.test(to) && /\b(look|looking|facing|face|front of me|ahead|this|that|point|pointing|there)\b/.test(to)) {
    const p = w.pointer;
    const wall = (p && p.type === 'wall' && p.wall) || (w.wallAhead && w.wallAhead()) || roomWallAhead();
    if (!wall) return { error: 'There is no wall straight ahead. Ask the user to face the wall they mean.' };
    const nrm = wall.normal, ax = wall.a[0], ay = wall.a[1], bx = wall.b[0], by = wall.b[1];
    const len = Math.hypot(bx - ax, by - ay) || 1, dx = (bx - ax) / len, dy = (by - ay) / len;
    let px, py;
    if (p && p.type === 'wall' && p.point) [px, py] = p.point;
    else if (u) { const s = (u.x - ax) * dx + (u.y - ay) * dy; px = ax + dx * s; py = ay + dy * s; }
    const r = w.roomAt(px + nrm[0] * 0.4, py + nrm[1] * 0.4, item.userData.floor) || room;
    const fl = (w.house.floors || []).find((q) => q.id === item.userData.floor) || (w.house.floors || [])[0];
    const g = wall.index >= 0 && fl && fl.walls ? fl.walls[wall.index] : null;
    const th = (g && g.thickness) || thicknessAt(item.userData.floor, (ax + bx) / 2, (ay + by) / 2, dx, dy);
    const e = { ax, ay, bx, by, dx, dy, nx: nrm[0], ny: nrm[1], len, th, mx: (ax + bx) / 2, my: (ay + by) / 2, facing: facingTo(nrm[0], nrm[1]) };
    const s0 = (px - ax) * dx + (py - ay) * dy;
    return { room: r, desc: 'against the wall the user faces', cands: alongEdge(e, kind, s0) };
  }

  // a corner
  if (/\bcorner\b/.test(to) && room) {
    const edges = edgesOf(room);
    const ref = named ? centroid(room.poly) : [x0, y0];
    const corners = [];
    for (const e of edges) {
      for (const end of [0, 1]) {
        const s = end ? e.len - spec.w / 2 - 0.08 : spec.w / 2 + 0.08;
        for (const c of alongEdge(e, kind, s).slice(0, 1)) corners.push(c);
      }
    }
    corners.sort((a, b) => Math.hypot(a.x - ref[0], a.y - ref[1]) - Math.hypot(b.x - ref[0], b.y - ref[1]));
    return { room, desc: `in a corner of the ${lower(room.label)}`, cands: corners };
  }

  // against a / the wall (nearest one, or the best one in a named room)
  if (/\b(against|wall|flush)\b/.test(to) && room) {
    const edges = edgesOf(room);
    const opposite = /\b(opposite|other|far)\b/.test(to);
    let e;
    if (named && named !== roomOf(item)) e = edges.filter((q) => q.len >= spec.w + 0.2).sort((a, b) => a.doors.length - b.doors.length || b.len - a.len)[0];
    else if (opposite) e = edges.slice().sort((a, b) => distToSeg(x0, y0, b.ax, b.ay, b.bx, b.by) - distToSeg(x0, y0, a.ax, a.ay, a.bx, a.by))[0];
    else e = nearestEdge(edges, x0, y0, spec.w + 0.1);
    if (!e) return { error: 'No wall long enough for it.' };
    const s0 = (x0 - e.ax) * e.dx + (y0 - e.ay) * e.dy;
    return { room, desc: `against the ${opposite ? 'opposite ' : ''}wall of the ${lower(room.label)}`, cands: alongEdge(e, kind, named && named !== roomOf(item) ? e.len / 2 : s0) };
  }

  // middle of the room
  if (/\b(middle|centre|center)\b/.test(to) && room) {
    const [cx, cy] = centroid(room.poly);
    return { room, desc: `in the middle of the ${lower(room.label)}`, cands: [{ x: cx, y: cy, rot: rot0 }] };
  }

  // where I'm pointing / here / in front of me
  if (/\b(point|pointing|there|this spot|that spot|where i'?m looking|looking at|here|in front of me|to me|over here)\b/.test(to)) {
    const p = w.pointer;
    const front = /\b(here|in front of me|to me|over here)\b/.test(to) && !/point|there|looking/.test(to);
    if (!front && p && p.point && p.type === 'floor') {
      return { room: null, exact: true, desc: 'where the user points', cands: [{ x: p.point[0], y: p.point[1], rot: rot0 }] };
    }
    if (!front && p && p.type === 'wall' && p.wall) {
      return plan(item, { to: 'against the wall i am pointing at' });
    }
    if (!front && p && p.type === 'furniture' && p.item && p.item !== item) {
      return plan(item, { to: `next to ${idOf(p.item)}`, next_to: idOf(p.item) });
    }
    if (u) {
      const { fwd } = camVectors();
      const d = 1.2 + spec.d / 2;
      return { room: null, desc: 'in front of the user', cands: [{ x: u.x + fwd[0] * d, y: u.y + fwd[1] * d, rot: facingTo(-fwd[0], -fwd[1]) }] };
    }
  }

  // just a room: against its best wall if the piece goes against a wall, else the middle
  if (named) {
    const [cx, cy] = centroid(named.poly);
    if (spec.against === 'wall') {
      const edges = edgesOf(named).filter((q) => q.len >= spec.w + 0.2)
        .sort((a, b) => a.doors.length - b.doors.length || (kind === 'queen' || kind === 'king' ? a.windows.length - b.windows.length : 0) || b.len - a.len);
      const cands = edges.slice(0, 3).flatMap((e) => alongEdge(e, kind).slice(0, 8));
      cands.push({ x: cx, y: cy, rot: rot0 });
      return { room: named, desc: `in the ${lower(named.label)}`, cands };
    }
    return { room: named, desc: `in the ${lower(named.label)}`, cands: [{ x: cx, y: cy, rot: rot0 }] };
  }
  return { error: 'Where to? Say e.g. "against the window wall", "into the bedroom", "1 m to the left", "next to the bed", "the middle of the room" or "where I point".' };
}

// ------------------------------------------------------------------ facing
function faceAngle(item, what) {
  const w = W(), t = lower(what), x = item.position.x, y = item.position.y;
  const room = roomOf(item) || userRoom();
  const toward = (tx, ty) => facingTo(tx - x, ty - y);
  const u = userPos();
  if (/\b(me|user|camera|viewer|us|my way)\b/.test(t) && u) return { rot: toward(u.x, u.y), desc: 'towards the user' };
  if (/\bwindows?\b/.test(t) && room) {
    const wins = edgesOf(room).flatMap((e) => e.windows);
    if (wins.length) { wins.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)); return { rot: toward(wins[0].x, wins[0].y), desc: 'towards the window' }; }
    return { error: `There is no window in the ${lower(room.label)}.` };
  }
  if (/\b(door|doorway|entrance)\b/.test(t) && room) {
    const ds = edgesOf(room).flatMap((e) => e.doors);
    if (ds.length) { ds.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)); return { rot: toward(ds[0].x, ds[0].y), desc: 'towards the door' }; }
  }
  const k = kindsIn(t);
  if (k) {
    const ref = resolve(t).items.find((o) => o !== item);
    if (ref) return { rot: toward(ref.position.x, ref.position.y), desc: `towards the ${lower(FURNITURE[ref.userData.kind].name)}` };
    return { error: `There is no ${lower(FURNITURE[k[0]].name)} placed to face.` };
  }
  if (/\bwall\b/.test(t) && room) {
    const e = nearestEdge(edgesOf(room), x, y);
    return { rot: facingTo(-e.nx, -e.ny), desc: 'towards the wall' };
  }
  if (/\b(room|middle|centre|center|inward|inwards|out|away from the wall)\b/.test(t) && room) {
    const spec = FURNITURE[item.userData.kind];
    const e = nearestEdge(edgesOf(room), x, y);
    if (e && distToSeg(x, y, e.ax, e.ay, e.bx, e.by) < spec.d / 2 + e.th / 2 + 0.35) return { rot: e.facing, desc: 'into the room, back to the wall' };
    const [cx, cy] = centroid(room.poly);
    return { rot: toward(cx, cy), desc: 'towards the middle of the room' };
  }
  return null;
}

// ------------------------------------------------------------------ colours and materials
const COLOURS = {
  navy: '#1f2a4a', 'navy blue': '#1f2a4a', 'midnight blue': '#191970', 'royal blue': '#2c4fb8', 'sky blue': '#87b8de',
  'baby blue': '#a9cbe8', 'powder blue': '#b0d0e6', 'cobalt': '#1f4fa8', 'denim': '#3b5b85', 'teal': '#1f6f6f',
  'duck egg': '#a8c8c0', 'sage': '#9caf88', 'sage green': '#9caf88', 'olive': '#6b6b3a', 'forest green': '#2e4a33',
  'emerald': '#1f7a4d', 'emerald green': '#1f7a4d', 'bottle green': '#1e4630', 'mint': '#b5e0c5', 'mustard': '#d4a52a',
  'mustard yellow': '#d4a52a', 'ochre': '#c48a2c', 'terracotta': '#c0603d', 'rust': '#a4482a', 'burnt orange': '#c35b1f',
  'burgundy': '#6d1f2c', 'wine': '#6b2135', 'maroon': '#6e1e24', 'oxblood': '#5a1a1a', 'blush': '#e8b4b0',
  'blush pink': '#e8b4b0', 'dusty pink': '#d4a5a5', 'dusty rose': '#c9898b', 'charcoal': '#3a3b3e', 'charcoal grey': '#3a3b3e',
  'slate': '#5b6670', 'dove grey': '#b9b6b0', 'light grey': '#c8c8c8', 'dark grey': '#4a4a4a', 'cream': '#efe6d2',
  'ivory': '#f2ecdc', 'off white': '#eeeae0', 'beige': '#d8c7a6', 'oatmeal': '#d9ccb4', 'taupe': '#8b7d6b', 'sand': '#d6c29a',
  'camel': '#b78a57', 'tan': '#b48a5a', 'cognac': '#9a4f22', 'caramel': '#a8692c', 'chocolate': '#4e2f1f', 'espresso': '#3b2a20',
  'portugal red': '#da291c', 'ferrari red': '#d40000', 'fire engine red': '#ce2029', 'cherry red': '#a6192e',
  red: '#b8262b', blue: '#2f5c9e', green: '#3f7a4c', yellow: '#e0b83a', orange: '#d9772b', purple: '#5f467f',
  pink: '#e3a0b4', brown: '#6b4a32', black: '#1e1e20', white: '#f1efea', grey: '#8f8f8f', gray: '#8f8f8f',
  'tiffany blue': '#81d8d0', 'klein blue': '#002fa7', 'pantone blue': '#0f4c81',
};
const MATERIALS = {
  leather: { rough: 0.45, def: '#6b4226' }, 'leather brown': { rough: 0.45, def: '#6b4226', both: true }, suede: { rough: 0.98, def: '#9c7a54' },
  velvet: { rough: 1.0, def: '#3b2f5a' }, linen: { rough: 0.96, def: '#d9cfbd' }, boucle: { rough: 1.0, def: '#ece6da' },
  wool: { rough: 0.98, def: '#bdb5a6' }, cotton: { rough: 0.95 }, fabric: { rough: 0.94 },
  oak: { rough: 0.55, def: '#b08a5e', wood: true }, walnut: { rough: 0.5, def: '#5c3b25', wood: true },
  cherry: { rough: 0.5, def: '#7b3f2a', wood: true }, pine: { rough: 0.6, def: '#d2b07a', wood: true },
  mahogany: { rough: 0.5, def: '#4f1f14', wood: true }, teak: { rough: 0.55, def: '#9a6a3b', wood: true },
  wood: { rough: 0.55, def: '#8a6440', wood: true }, wooden: { rough: 0.55, def: '#8a6440', wood: true },
  brass: { rough: 0.3, metal: 0.9, def: '#b5954a' }, gold: { rough: 0.3, metal: 0.9, def: '#c9a54b' },
  chrome: { rough: 0.15, metal: 1, def: '#d8d8d8' }, steel: { rough: 0.3, metal: 0.9, def: '#9a9da1' },
  silver: { rough: 0.25, metal: 0.9, def: '#c0c0c0' }, copper: { rough: 0.3, metal: 0.9, def: '#b06a3e' },
  marble: { rough: 0.25, def: '#e8e6e1' }, glossy: { rough: 0.2 }, gloss: { rough: 0.2 }, matte: { rough: 0.95 }, matt: { rough: 0.95 },
};

/** CSS colour names and rgb()/hex through the browser's own parser. */
function cssColour(s) {
  const ctx = cssColour.ctx || (cssColour.ctx = document.createElement('canvas').getContext('2d'));
  ctx.fillStyle = '#010203';
  ctx.fillStyle = s;
  const v = ctx.fillStyle;
  return v === '#010203' ? null : v;
}

function oneColour(phrase) {
  let p = lower(phrase).replace(/\b(colou?r(ed)?|shade|tone|ish|the|a|an|in|make|it|paint(ed)?)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!p) return null;
  let mat = null;
  for (const k of Object.keys(MATERIALS).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${k}\\b`).test(p)) { mat = { name: k, ...MATERIALS[k] }; if (!MATERIALS[k].both) p = p.replace(new RegExp(`\\b${k}\\b`), ' ').trim(); else p = ''; break; }
  }
  let hex = null, name = p;
  if (p) {
    if (COLOURS[p]) hex = COLOURS[p];
    else {
      hex = cssColour(p.replace(/\s+/g, '')) || cssColour(p);
      const key = !hex && Object.keys(COLOURS).sort((a, b) => b.length - a.length).find((k) => p.startsWith(k + ' ') || p.endsWith(' ' + k) && k.includes(' '));
      if (key) { hex = COLOURS[key]; name = key; }
      if (!hex) {                                                  // "dark green", "light pink", "pale blue"
        const m = p.match(/\b(dark|deep|light|pale|bright|soft|muted)\s+(\w+)/);
        const base = m && (COLOURS[m[2]] || cssColour(m[2]));
        if (base) {
          const c = new THREE.Color(base), hsl = {};
          c.getHSL(hsl);
          if (/dark|deep/.test(m[1])) hsl.l *= 0.6; else if (/light|pale|soft/.test(m[1])) hsl.l = hsl.l + (1 - hsl.l) * 0.45;
          if (/muted|soft/.test(m[1])) hsl.s *= 0.6; if (/bright/.test(m[1])) hsl.s = Math.min(1, hsl.s * 1.3);
          c.setHSL(hsl.h, hsl.s, hsl.l);
          hex = '#' + c.getHexString();
        } else {
          // last word alone ("portuguese racing red" -> red)
          const lastWord = p.split(' ').reverse().find((wd) => COLOURS[wd] || cssColour(wd));
          if (lastWord) hex = COLOURS[lastWord] || cssColour(lastWord);
        }
      }
    }
  }
  if (!hex && mat && mat.def) { hex = mat.def; name = mat.name; }
  if (!hex && !mat) return null;
  return { hex, name: [name, mat && !mat.both && name !== mat.name ? mat.name : null].filter(Boolean).join(' ') || (mat && mat.name), rough: mat && mat.rough, metal: mat && mat.metal, wood: !!(mat && mat.wood) };
}

/** "red and white", "navy with oak legs" -> [{hex, name, rough, metal, wood}…], primary first. */
function parseColours(text, hex) {
  const parts = lower(text).split(/\s*(?:\band\b|&|\bwith\b|\bplus\b|,|\/)\s*/).filter(Boolean);
  const out = parts.map(oneColour).filter(Boolean);
  if (!out.length && hex && /^#?[0-9a-f]{6}$/i.test(hex)) out.push({ hex: hex.startsWith('#') ? hex : `#${hex}`, name: text || hex });
  if (out.length === 1 && hex && /^#?[0-9a-f]{6}$/i.test(hex) && !COLOURS[lower(text)] && !cssColour(lower(text).replace(/\s+/g, ''))) {
    out[0].hex = hex.startsWith('#') ? hex : `#${hex}`;           // the model's hex for a name we only half knew
  }
  return out;
}

/** Which part of a piece a mesh is: fabric (main), light (cushions, bedding), wood, metal, leaf, shade, hero. */
function partOfMesh(o) {
  const m = o.userData.tintOrig || o.material;
  if (!m || m.isMeshBasicMaterial) return null;                 // the contact shadow
  if (o.userData.hero) return 'hero';
  const n = lower(m.name).split(':')[0];
  if (/^fabriclt/.test(n)) return 'light';
  if (/^fabric/.test(n)) return 'fabric';
  if (/^wood/.test(n)) return 'wood';
  if (/^metal/.test(n)) return 'metal';
  if (/^leaf/.test(n)) return 'leaf';
  if (/^shade/.test(n)) return 'shade';
  const hsl = { h: 0, s: 0, l: 0.5 };
  if (m.color) m.color.getHSL(hsl);
  return hsl.l > 0.72 ? 'light' : hsl.l < 0.22 ? 'metal' : 'fabric';
}

function meshesOf(item) {
  const out = [];
  item.traverse((o) => { if (o.isMesh && o.material && !Array.isArray(o.material) && partOfMesh(o)) out.push(o); });
  return out;
}

/** Which parts get which colour. */
function assign(item, colours) {
  const ms = meshesOf(item);
  const has = (p) => ms.some((o) => partOfMesh(o) === p);
  const soft = ['fabric', 'light', 'hero'].filter(has);
  const map = {};
  const [c1, c2] = colours;
  if (c1.metal) { (has('metal') ? ['metal'] : soft.length ? soft : ['wood']).forEach((p) => { map[p] = c1; }); }
  else if (c1.wood) { (has('wood') ? ['wood'] : soft).forEach((p) => { map[p] = c1; }); }
  else if (soft.length) soft.forEach((p) => { map[p] = c1; });
  else ['wood', 'metal', 'shade'].filter(has).forEach((p) => { map[p] = c1; });
  if (c2) {
    if (c2.wood || c2.metal) (has('wood') ? ['wood'] : has('metal') ? ['metal'] : []).forEach((p) => { map[p] = c2; });
    else if (has('light') && has('fabric')) map.light = c2;
    else if (has('wood')) map.wood = c2;
    else if (soft.length > 1) map[soft[1]] = c2;
  }
  return map;
}

function tintMesh(o, c, key) {
  if (o.material.userData && o.material.userData.walkinTint === key) return;
  if (!o.userData.tintOrig || o.material.userData.walkinTint === undefined) o.userData.tintOrig = o.material;
  const src = o.userData.tintOrig, m = src.clone();
  const col = new THREE.Color(c.hex);
  if (src.map) col.multiplyScalar(1.35);                        // a photo texture is darkened by the tint: lift it
  else {                                                        // keep a little of the light/dark variation
    const hsl = { h: 0, s: 0, l: 0.5 };
    if (src.color) src.color.getHSL(hsl);
    col.multiplyScalar(THREE.MathUtils.clamp(0.9 + 0.2 * hsl.l, 0.85, 1.1));
  }
  m.color = col;
  if (c.rough !== undefined) m.roughness = c.rough;
  if (c.metal !== undefined) m.metalness = c.metal; else if (!src.map && m.metalness > 0.3 && !c.wood) m.metalness = 0.1;
  m.userData = { ...(src.userData || {}), walkinTint: key };
  o.material = m;
}

/** (Re)apply a piece's tint: the real model swaps in after the boxes, and a restyle replaces materials. */
function applyTint(item) {
  const t = item.userData.tint;
  if (!t) return;
  const map = assign(item, t.colours);
  for (const o of meshesOf(item)) {
    const c = map[partOfMesh(o)];
    if (c) tintMesh(o, c, `${t.key}|${partOfMesh(o)}`);
    else if (o.userData.tintOrig && o.material.userData.walkinTint) { o.material = o.userData.tintOrig; }
  }
}

function clearTint(item) {
  delete item.userData.tint;
  item.traverse((o) => {
    if (o.isMesh && o.userData.tintOrig) { o.material = o.userData.tintOrig; delete o.userData.tintOrig; }
  });
}

setInterval(() => { if (W() && W().furniture) for (const o of pieces()) if (o.userData.tint) applyTint(o); }, 300);

// ------------------------------------------------------------------ the tools
async function moveFurniture(args) {
  const { items, why } = resolve(args.target || 'it');
  if (!items.length) return { ok: false, reason: why };
  const item = items[0];
  const p = plan(item, args);
  if (p.error) return { ok: false, id: idOf(item), reason: p.error };
  const spot = findSpot(item, p.cands, p.room, { exact: !!p.exact });
  if (!spot) return { ok: false, id: idOf(item), reason: `There is no free spot ${p.desc} for the ${lower(FURNITURE[item.userData.kind].name)}; it stays where it is.` };
  const from = [item.position.x, item.position.y];
  await put(item, spot.x, spot.y, spot.rot);
  const moved = Math.hypot(item.position.x - from[0], item.position.y - from[1]);
  const res = report(item, { moved: p.desc, moved_m: r2(moved) });
  if (p.linear && p.cands[0] && Math.hypot(spot.x - p.cands[0].x, spot.y - p.cands[0].y) > 0.05) res.note = `only ${r2(moved)} m: something is in the way`;
  return res;
}

async function rotateFurniture(args) {
  const { items, why } = resolve(args.target || 'it');
  if (!items.length) return { ok: false, reason: why };
  const item = items[0];
  let rot, desc;
  const faceText = args.face || (args.how && /\bface|facing|towards?|to the\b/.test(lower(args.how)) ? args.how : null);
  if (faceText) {
    const f = faceAngle(item, faceText);
    if (!f) return { ok: false, id: idOf(item), reason: `Face what? Try "the room", "the window", "the TV", "the wall", "me".` };
    if (f.error) return { ok: false, id: idOf(item), reason: f.error };
    rot = f.rot; desc = f.desc;
  } else {
    let deg = typeof args.degrees === 'number' ? args.degrees : null;
    const h = lower(args.how || '');
    if (deg === null) {
      const m = h.match(/-?\d+(\.\d+)?/);
      deg = m ? parseFloat(m[0]) : /around|round|180|flip|other way|backwards/.test(h) ? 180 : /quarter|90/.test(h) ? 90 : /bit|little|slightly/.test(h) ? 15 : 90;
      if (/\b(left|anti|counter)/.test(h)) deg = -Math.abs(deg);
    }
    rot = item.rotation.z - deg * Math.PI / 180;                 // positive = clockwise seen from above
    desc = `turned ${Math.abs(Math.round(deg))} degrees ${deg >= 0 ? 'clockwise' : 'anticlockwise'}`;
  }
  const room = roomOf(item);
  const spot = findSpot(item, [{ x: item.position.x, y: item.position.y, rot }], room, { exact: true, keepRot: false })
    || findSpot(item, [{ x: item.position.x, y: item.position.y, rot }], null, { keepRot: false });
  if (!spot) return { ok: false, id: idOf(item), reason: 'There is no room to turn it here; move it out from the wall first.' };
  const before = item.rotation.z;
  const shifted = Math.hypot(spot.x - item.position.x, spot.y - item.position.y);
  await put(item, spot.x, spot.y, spot.rot);
  const turned = Math.abs(normAng(item.rotation.z - before)) * 180 / Math.PI;
  return report(item, { turned: desc, turned_deg: Math.round(turned), ...(turned < 1 ? { note: 'it already faced that way' } : {}),
    ...(shifted > 0.05 ? { note: 'shifted a little to make room for the turn' } : {}) });
}

function removeFurniture(args) {
  const w = W();
  const t = lower(args.target || 'it');
  const { items, why } = resolve(t, { many: true });
  if (!items.length) return { ok: false, reason: why };
  const ids = items.map(idOf);
  for (const o of items) {
    if (w.selected === o) w.select(null);
    if (last === o) last = null;
    w.furniture.remove(o);
  }
  if (w.checkFit) w.checkFit();
  return { ok: true, removed: ids, count: ids.length, left: pieces().length };
}

function setFurnitureColor(args) {
  const { items, why } = resolve(args.target || 'it', { many: true });
  if (!items.length) return { ok: false, reason: why };
  const text = String(args.color || args.colour || '').trim();
  if (/^(reset|original|default|normal|back|undo|as it was|original colou?r)/i.test(text)) {
    items.forEach(clearTint);
    items.forEach(touch);
    return { ok: true, ids: items.map(idOf), color: 'original' };
  }
  const colours = parseColours(text, args.hex);
  if (!colours.length) return { ok: false, reason: `I don't know the colour "${text}". Pass hex as well (e.g. #1f2a4a).` };
  const key = colours.map((c) => `${c.hex}/${c.rough ?? ''}/${c.metal ?? ''}`).join('+');
  const words = [...new Set(colours.flatMap((c) => lower(c.name).split(' ')).concat(lower(text).split(/\W+/)).filter((x) => x.length > 2))];
  for (const item of items) {
    item.userData.tint = { key, colours, name: text, words };
    applyTint(item);
  }
  touch(items[items.length - 1]);
  return { ok: true, ids: items.map(idOf), color: text, applied: colours.map((c) => `${c.name} ${c.hex}`),
    parts: Object.keys(assign(items[0], colours)) };
}

function listFurniture() {
  const w = W();
  const all = pieces().map((o) => {
    const on = o.userData.on && pieces().find((s) => s.uuid === o.userData.on);
    const r = fitReport({ item: o, ignore: on ? [on] : [], quick: true });
    const room = roomOf(o);
    return { id: idOf(o), name: FURNITURE[o.userData.kind].name, room: room ? room.label : null,
      position: [r2(o.position.x), r2(o.position.y)], facing_deg: Math.round(((o.rotation.z * 180 / Math.PI) % 360 + 360) % 360),
      ...(o.userData.tint ? { color: o.userData.tint.name } : {}), ...(on ? { on: idOf(on) } : {}),
      fits: r.ok, ...(r.ok ? {} : { problems: r.reasons }) };
  });
  const sel = w.selected && alive(w.selected) && w.selected.userData.kind ? idOf(w.selected) : null;
  return { count: all.length, pieces: all, selected: sel, last_touched: alive(last) ? idOf(last) : null,
    it_means: sel || (alive(last) ? idOf(last) : null) };
}

/** add_furniture as before (2 m in front of the user), plus room / against / color, and never inside a wall. */
async function addFurniture(args) {
  const w = W(), kind = lower(args.kind).replace(/\s+/g, '');
  const k = FURNITURE[kind] ? kind : (kindsIn(args.kind || '') || [])[0];
  if (!k) return { ok: false, reason: `Unknown kind. Use one of: ${Object.keys(w.FURNITURE).join(', ')}.` };
  w.addFurniture(k);
  const item = w.selected || w.furniture.children[w.furniture.children.length - 1];
  idOf(item);
  touch(item);
  const extra = {};
  if (args.room || args.against) {
    const to = [args.against ? `against the ${args.against}` : '', args.room ? `in the ${args.room}` : ''].join(' ');
    const p = plan(item, { to, room: args.room });
    const spot = !p.error && findSpot(item, p.cands, p.room);
    if (spot) { await put(item, spot.x, spot.y, spot.rot); extra.where = p.desc; }
    else extra.where_problem = p.error || `no free spot ${p.desc}`;
  } else if (!spotClear(item, item.position.x, item.position.y, item.rotation.z, null)) {
    // 2 m ahead was inside a wall or another piece: the nearest free spot, in the room the user looks into first
    // (2 m ahead can also be past a window, outside the house: then walk the line back towards the user)
    const r = w.roomAt(item.position.x, item.position.y, item.userData.floor) || userRoom();
    const u = userPos(), x1 = item.position.x, y1 = item.position.y, rot = item.rotation.z;
    const line = u ? [1, 0.85, 0.7, 0.55, 0.4].map((f) => ({ x: u.x + (x1 - u.x) * f, y: u.y + (y1 - u.y) * f, rot })) : [];
    const ur = userRoom(), mid = ur && centroid(ur.poly);
    const spot = findSpot(item, [{ x: x1, y: y1, rot }, ...line], r)
      || (ur && findSpot(item, [...line, { x: mid[0], y: mid[1], rot }], ur));
    if (spot) { await put(item, spot.x, spot.y, spot.rot); extra.note = 'moved off the wall to the nearest free spot'; }
  }
  if (args.color) {
    const c = setFurnitureColor({ target: idOf(item), color: args.color, hex: args.hex });
    extra.color = c.ok ? args.color : c.reason;
  }
  const res = report(item, extra);
  return { ...res, placed: k };
}

// ------------------------------------------------------------------ registration
const TARGET = { type: 'string', description: 'Which piece: "it" (the piece the user touched or you changed last), "the sofa", "sofa1" (id from list_furniture), "the bed in the bedroom".' };
const declarations = [
  { name: 'list_furniture',
    description: 'The furniture placed so far: an id for each piece (sofa1, queen1…), its room, position, facing, colour and whether it fits, plus which piece "it" means right now.',
    parameters: { type: 'object', properties: {} } },
  { name: 'add_furniture',
    description: 'Place one NEW real-size furniture item. By default 2 m in front of the user; with room it goes into that room (against its best wall if it is a wall piece), with against it goes against "window" or "wall", with color it is coloured at once. Returns whether it fits.',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', description: 'Catalog key from describe_house, e.g. sofa, armchair, queen, king, table, desk.' },
      room: { type: 'string', description: 'Optional room label, e.g. bedroom, living room.' },
      against: { type: 'string', description: 'Optional: "window" (the window wall) or "wall".' },
      color: { type: 'string', description: 'Optional colour or material, e.g. red, navy, leather brown.' },
      hex: { type: 'string', description: 'Optional hex for the colour, e.g. #1f2a4a.' } },
      required: ['kind'] } },
  { name: 'move_furniture',
    description: 'Move a piece that is already placed. Use it for any "move / put / push / slide / shift / bring the X …" about an existing piece. It never puts a piece in a wall and reports whether it fits.',
    parameters: { type: 'object', properties: {
      target: TARGET,
      to: { type: 'string', description: 'Where, in the user\'s words: "against the window wall", "against the wall I\'m looking at", "against the wall", "left 1 m", "closer", "further away", "into the bedroom", "the middle of the room", "a corner", "where I\'m pointing", "here", "next to the bed", "in front of the sofa".' },
      room: { type: 'string', description: 'Optional room label if the user named one.' },
      distance_m: { type: 'number', description: 'Optional distance for left/right/closer/further, in metres (a foot is 0.3).' },
      next_to: { type: 'string', description: 'Optional other piece to put it beside.' } },
      required: ['to'] } },
  { name: 'rotate_furniture',
    description: 'Turn a placed piece: by degrees, or to face something ("the room", "the window", "the TV", "the wall", "the door", "me").',
    parameters: { type: 'object', properties: {
      target: TARGET,
      degrees: { type: 'number', description: 'Turn by this many degrees; positive = clockwise seen from above (to the right), negative = anticlockwise. "turn it around" = 180.' },
      face: { type: 'string', description: 'What its front should face instead of degrees: the room, the window, the tv, the sofa, the wall, the door, me.' } } } },
  { name: 'remove_furniture',
    description: 'Remove placed pieces: one ("the sofa", "it"), all of a kind ("all the chairs"), everything in a room ("everything in the bedroom") or "all".',
    parameters: { type: 'object', properties: {
      target: { type: 'string', description: '"it", "the sofa", "sofa1", "all the chairs", "everything in the bedroom", or "all".' } },
      required: ['target'] } },
  { name: 'set_furniture_color',
    description: 'Change the colour or material of a placed piece (its fabric, or its wood for tables and shelves). Accepts names like navy, sage green, red and white (two colours), leather brown, walnut, brass, Portugal red. "original" resets it.',
    parameters: { type: 'object', properties: {
      target: TARGET,
      color: { type: 'string', description: 'Colour and/or material in the user\'s words, e.g. "navy blue", "red and white", "leather brown", "oak", "original".' },
      hex: { type: 'string', description: 'Your best hex for the main colour, e.g. #1f2a4a for navy. Always give it for a named colour.' } },
      required: ['color'] } },
];

const rules = `- Placed furniture can be changed: list_furniture shows each piece with an id (sofa1). For a piece that already exists use move_furniture, rotate_furniture, remove_furniture or set_furniture_color, never add_furniture: "put the sofa against the window" when a sofa is placed means move_furniture. Never say you can't move, turn, remove or recolour furniture.
- "it", "that", "this one" mean the piece the user touched or you changed last: pass target "it". If the user names a kind, pass that ("the sofa").
- "Add a queen bed in the bedroom and make it red" is ONE add_furniture call with kind, room and color. Add + move or add + colour in one sentence: use add_furniture's room, against and color.
- "turn it", "face the room/window/TV": rotate_furniture. "remove / delete / get rid of / take away the X": call remove_furniture at once, no confirmation ("delete everything", "clear it all": target "all").
- After moving, say where it went and whether it fits, from the tool result, in one short sentence.`;

const run = {
  list_furniture: () => listFurniture(),
  add_furniture: (a) => addFurniture(a),
  move_furniture: (a) => moveFurniture(a),
  rotate_furniture: (a) => rotateFurniture(a),
  remove_furniture: (a) => removeFurniture(a),
  set_furniture_color: (a) => setFurnitureColor(a),
};

(window.walkinTools = window.walkinTools || []).push({ declarations, run, rules });

(function expose(tries = 0) {
  if (!window.walkin) { if (tries < 600) setTimeout(() => expose(tries + 1), 200); return; }
  window.walkin.furnitureTools = { resolve: (t, o) => resolve(t, o).items, list: listFurniture, plan, parseColours, edges: edgesOf, run };
})();
