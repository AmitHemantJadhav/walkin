// Where a piece of furniture may go: the rules staging (staging.js) and single adds (furniture-tools.js) share,
// so a staged room and "add a sofa" make the same decisions.
//
//   - no piece within SPOT_CLEAR of a scan point: after a teleport there you would be standing in it
//   - no piece in a doorway's clear zone: the opening's width x DOOR_DEPTH, on BOTH sides of the wall
//   - FRONT_CLEAR of open floor in front of a sofa, an armchair, a bed (its foot) and a desk, where nothing
//     but the piece that belongs there (a coffee table, a desk chair) may stand
//   - clear of the wall bands (room polygons follow wall centre lines) and of every other piece
//   - and fit.js's own check: inside the room, the doors still reachable, a walkway left
// Rugs are walked on and are exempt from the first three. Units: metres, Z up. Model frame.
//
//   check(kind, x, y, rot, { floor, room, ignore })  -> { ok, reasons }
//   search(kind, room, { floor, near, rot, wall, ignore, accept })  -> { x, y, rot } or null
import { FURNITURE } from './furniture.js';
import { fitReport, footprint, overlaps, pointInPoly } from './fit.js';

export const SPOT_CLEAR = 0.45;
// A scan-dense small room (five scan points in La Mirada's 11 m2 dining room, seven in a 13 m2 bedroom on
// Dunvegan Way) has no spot where a table or a bed keeps 45 cm off all of them. Rather than leave the room
// without it, the ONE piece a room is staged around (bed, dining table, sofa, desk) may come closer, in these
// steps - you look down at its edge, you never stand in it. Everything else keeps the full SPOT_CLEAR.
export const SPOT_RELAXED = [0.25, 0.1];
export const DOOR_DEPTH = 0.9;
export const FRONT_CLEAR = 0.6;
const WALL_GAP = 0.06;

/** Pieces that need open floor in front of them, and what is allowed to stand in it. */
export const FRONT = {
  sofa: ['coffeetable', 'sidetable'],
  armchair: ['coffeetable', 'sidetable'],
  queen: [],
  king: [],
  desk: ['chair'],
};

const W = () => window.walkin;
const flat = (kind) => !!(FURNITURE[kind] || {}).flat;
const floorOf = (house, id) => (house.floors || []).find((f) => f.id === id) || (house.floors || [])[0];

function distToPoly(x, y, poly) {
  if (pointInPoly(x, y, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

// ------------------------------------------------------------------ the house, cached per house object
let cache = null;
function geometry() {
  const house = W().house;
  if (cache && cache.house === house) return cache;
  const doors = [], walls = [];
  for (const f of house.floors || []) {
    for (const wl of f.walls || []) {
      const [ax, ay] = wl.a, [bx, by] = wl.b, len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const dx = (bx - ax) / len, dy = (by - ay) / len, nx = -dy, ny = dx;
      if (wl.type === 'wall' && len >= 0.1) {
        const th = Math.max(0.06, wl.thickness || 0.12) / 2;
        walls.push({ floor: f.id, poly: [[ax + nx * th, ay + ny * th], [bx + nx * th, by + ny * th],
          [bx - nx * th, by - ny * th], [ax - nx * th, ay - ny * th]] });
      }
      for (const o of wl.openings || []) {
        if (o.at == null || /window/i.test(o.type || '') || (o.bottom || 0) >= 0.3) continue;
        const cx = ax + dx * o.at * len, cy = ay + dy * o.at * len, hw = (o.width || 0.9) / 2 + 0.05;
        const D = DOOR_DEPTH;
        doors.push({ floor: f.id, x: cx, y: cy, width: o.width || 0.9, poly: [
          [cx - dx * hw - nx * D, cy - dy * hw - ny * D], [cx + dx * hw - nx * D, cy + dy * hw - ny * D],
          [cx + dx * hw + nx * D, cy + dy * hw + ny * D], [cx - dx * hw + nx * D, cy - dy * hw + ny * D]] });
      }
    }
  }
  cache = { house, doors, walls };
  return cache;
}
const onFloor = (floor) => (q) => !floor || !q.floor || q.floor === floor;

/** The scan points (pano positions) on a floor. */
export function scanPoints(floor) {
  return (W().house.panos || []).filter(onFloor(floor)).map((p) => p.pos);
}

/** The strip of floor in front of a piece that has to stay open, or null if it needs none. */
export function frontZone(kind, x, y, rot, depth = FRONT_CLEAR) {
  if (!FRONT[kind]) return null;
  const spec = FURNITURE[kind];
  const c = Math.cos(rot), s = Math.sin(rot);
  const hw = spec.w / 2, y0 = -spec.d / 2, y1 = y0 - depth;        // a piece's front is its local -y
  return [[-hw, y0], [hw, y0], [hw, y1], [-hw, y1]].map(([px, py]) => [x + px * c - py * s, y + px * s + py * c]);
}

const others = (floor, ignore) => (W().furniture ? W().furniture.children : []).filter((o) => o.userData && o.userData.kind
  && !o.userData.meshPiece && !ignore.includes(o) && (floor == null || o.userData.floor == null || o.userData.floor === floor));

/**
 * The shared rules, without fit.js (cheap: microseconds). Returns the reasons a spot is wrong; [] means fine.
 */
export function rules(kind, x, y, rot, { floor, ignore = [], on = null, spot = SPOT_CLEAR } = {}) {
  const spec = FURNITURE[kind];
  if (!spec) return ['unknown piece'];
  if (flat(kind) || on) return [];                     // a rug lies under things; a lamp on a table is on the table
  const g = geometry();
  const out = [];
  const poly = footprint(kind, x, y, rot, -0.01);
  const full = footprint(kind, x, y, rot);

  if (scanPoints(floor).some(([px, py]) => distToPoly(px, py, full) < spot)) out.push('it would stand where you stand');
  if (g.doors.some((d) => onFloor(floor)(d) && overlaps(poly, d.poly))) out.push('it would block a doorway');
  if (g.walls.some((wl) => onFloor(floor)(wl) && overlaps(poly, wl.poly))) out.push('half of it would be in the wall');

  const rest = others(floor, ignore).filter((o) => !flat(o.userData.kind) && !o.userData.on);
  for (const o of rest) {
    if (overlaps(poly, footprint(o.userData.kind, o.position.x, o.position.y, o.rotation.z, -0.01))) {
      out.push(`it would overlap the ${FURNITURE[o.userData.kind].name.toLowerCase()}`);
      break;
    }
  }
  // its own front: open floor, inside the house, nothing in it but what belongs there
  const zone = frontZone(kind, x, y, rot);
  if (zone) {
    const fz = frontZone(kind, x, y, rot, FRONT_CLEAR - 0.02);
    if (!fz.every(([px, py]) => W().roomAt(px, py, floor))) out.push('no room to get to it');
    else if (g.walls.some((wl) => onFloor(floor)(wl) && overlaps(fz, wl.poly))) out.push('no room to get to it');
    else if (rest.some((o) => !FRONT[kind].includes(o.userData.kind)
      && overlaps(zone, footprint(o.userData.kind, o.position.x, o.position.y, o.rotation.z, -0.01)))) {
      out.push('something would stand right in front of it');
    }
  }
  // nor in front of anything already there
  for (const o of rest) {
    const z = frontZone(o.userData.kind, o.position.x, o.position.y, o.rotation.z);
    if (z && !FRONT[o.userData.kind].includes(kind) && overlaps(poly, z)) {
      out.push(`it would be in the way of the ${FURNITURE[o.userData.kind].name.toLowerCase()}`);
      break;
    }
  }
  return out;
}

/**
 * Everything: the shared rules plus fit.js (the room, overlaps, doors reachable, a walkway). `room` pins the
 * room the piece has to land in. `quick` skips fit.js's walkway raster.
 */
export function check(kind, x, y, rot, { floor, room = null, ignore = [], on = null, quick = false, spot } = {}) {
  const reasons = rules(kind, x, y, rot, { floor, ignore, on, spot });
  if (reasons.length) return { ok: false, reasons };
  const r = fitReport({ kind, x, y, rot, floor, ignore, on, quick });
  if (!r.room) return { ok: false, reasons: ['that spot is not in a room'] };
  if (room && r.room !== room) return { ok: false, reasons: [`it would land in the ${(r.room.label || 'hallway').toLowerCase()}`] };
  return { ok: r.ok, reasons: r.reasons, room: r.room };
}

// ------------------------------------------------------------------ finding a spot
function wallThickness(house, floor, mx, my, dx, dy) {
  let best = 0.12, bestD = 0.25;
  for (const w of (floorOf(house, floor) || {}).walls || []) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (len < 0.1) continue;
    const ux = (w.b[0] - w.a[0]) / len, uy = (w.b[1] - w.a[1]) / len;
    if (Math.abs(ux * dx + uy * dy) < 0.95) continue;
    const t = Math.max(0, Math.min(len, (mx - w.a[0]) * ux + (my - w.a[1]) * uy));
    const d = Math.hypot(w.a[0] + ux * t - mx, w.a[1] + uy * t - my);
    if (d < bestD) { bestD = d; best = w.thickness || 0.12; }
  }
  return best;
}

/** Spots with the piece's back to one of the room's walls, every `step` metres along each wall. */
export function wallSpots(kind, room, { floor, step = 0.15 } = {}) {
  const spec = FURNITURE[kind], house = W().house, out = [];
  const n = room.poly.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = room.poly[i], [bx, by] = room.poly[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < spec.w + 0.1) continue;
    const dx = (bx - ax) / len, dy = (by - ay) / len, mx = (ax + bx) / 2, my = (ay + by) / 2;
    let nx = -dy, ny = dx;
    if (!pointInPoly(mx + nx * 0.25, my + ny * 0.25, room.poly)) { nx = -nx; ny = -ny; }
    const back = spec.d / 2 + wallThickness(house, floor, mx, my, dx, dy) / 2 + WALL_GAP;
    const rot = Math.atan2(ny, nx) + Math.PI / 2;
    for (let s = spec.w / 2 + 0.05; s <= len - spec.w / 2 - 0.05 + 1e-6; s += step) {
      out.push({ x: ax + dx * s + nx * back, y: ay + dy * s + ny * back, rot, edge: i });
    }
  }
  return out;
}

/** A grid over the room's floor at a few rotations. */
export function gridSpots(room, { step = 0.2, rots = [0, Math.PI / 2] } = {}) {
  const xs = room.poly.map((p) => p[0]), ys = room.poly.map((p) => p[1]);
  const out = [];
  for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) {
    for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) {
      if (!pointInPoly(x, y, room.poly)) continue;
      for (const rot of rots) out.push({ x, y, rot });
    }
  }
  return out;
}

/**
 * The best valid spot for a piece in a room: against a wall if it belongs against one, else anywhere; nearest
 * to `near` ([x, y]) first. Every candidate passes the cheap rules before fit.js's full check runs on it, and
 * `accept(c)` can add a test of its own (staging uses it to ask "and do the nightstands fit too?").
 */
export function search(kind, room, { floor, near = null, rot = 0, wall, ignore = [], accept = null, extra = [], maxFull = 40,
  spot } = {}) {
  if (!room || !room.poly || room.poly.length < 3 || !FURNITURE[kind]) return null;
  const spec = FURNITURE[kind];
  const againstWall = wall != null ? wall : spec.against === 'wall';
  let cands = againstWall ? wallSpots(kind, room, { floor })
    : gridSpots(room, { step: spec.w > 1 ? 0.2 : 0.15, rots: [rot, rot + Math.PI / 2, rot + Math.PI, rot - Math.PI / 2] });
  if (near) {
    const d2 = (c) => (c.x - near[0]) ** 2 + (c.y - near[1]) ** 2;
    cands.sort((a, b) => d2(a) - d2(b));
  }
  cands = [...extra, ...cands];
  let full = 0;
  for (const c of cands) {
    if (rules(kind, c.x, c.y, c.rot, { floor, ignore, spot }).length) continue;
    const q = fitReport({ kind, x: c.x, y: c.y, rot: c.rot, floor, ignore, quick: true });
    if (!q.ok || q.room !== room) continue;
    if (accept && !accept(c)) continue;
    if (full++ >= maxFull) break;
    if (fitReport({ kind, x: c.x, y: c.y, rot: c.rot, floor, ignore }).ok) return { x: c.x, y: c.y, rot: c.rot };
  }
  return null;
}

/** For tests and the console: what is wrong with every piece in the house right now. */
export function audit() {
  const w = W();
  return (w.furniture ? w.furniture.children : []).filter((o) => o.userData && o.userData.kind && !o.userData.meshPiece)
    .map((o) => ({ kind: o.userData.kind, x: +o.position.x.toFixed(2), y: +o.position.y.toFixed(2),
      problems: rules(o.userData.kind, o.position.x, o.position.y, o.rotation.z,
        { floor: o.userData.floor, ignore: [o], on: o.userData.on }) }))
    .filter((r) => r.problems.length);
}
