// S3 — walkin.stageRoom(room, style): furnish a whole room in one go.
// Puts the big piece against the best wall, arranges the rest around it, and checks every placement
// with fit.js, so what comes back is a set that actually fits with the doors still usable.
import { FURNITURE, PLANTS, applyStyle, setStyle, STYLES, getStyle } from './furniture.js';
import { fitReport, fitLine, openings, overlaps, pointInPoly, footprint } from './fit.js';

const WALL_GAP = 0.06;          // a piece stands this far off the wall
const lower = (s) => (s || 'room').toLowerCase();

// ------------------------------------------------------------------ the room's walls
/** One entry per polygon edge: midpoint, length, direction, inward normal, and whether a door opens onto it. */
function edgesOf(room, house) {
  const holes = openings(room, house);
  const walls = (house.floors || []).flatMap((f) => f.walls || []);

  /** How thick the wall on this edge is: a room polygon follows wall centre lines, not their faces. */
  const thicknessAt = (mx, my, dx, dy) => {
    let best = 0.12;
    let bestD = 0.25;
    for (const w of walls) {
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      if (len < 0.1) continue;
      const ux = (w.b[0] - w.a[0]) / len, uy = (w.b[1] - w.a[1]) / len;
      if (Math.abs(ux * dx + uy * dy) < 0.95) continue;        // not parallel to this edge
      const t = Math.max(0, Math.min(len, (mx - w.a[0]) * ux + (my - w.a[1]) * uy));
      const d = Math.hypot(w.a[0] + ux * t - mx, w.a[1] + uy * t - my);
      if (d < bestD) { bestD = d; best = w.thickness || 0.12; }
    }
    return best;
  };
  const n = room.poly.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = room.poly[i], [bx, by] = room.poly[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.4) continue;
    const dx = (bx - ax) / len, dy = (by - ay) / len;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    let nx = -dy, ny = dx;                                   // pick the normal that points into the room
    if (!pointInPoly(mx + nx * 0.25, my + ny * 0.25, room.poly)) { nx = -nx; ny = -ny; }
    // which openings sit on this wall: a bed wants a wall with neither a door nor a window
    const band = [
      [ax - nx * 0.05, ay - ny * 0.05], [bx - nx * 0.05, by - ny * 0.05],
      [bx + nx * 0.3, by + ny * 0.3], [ax + nx * 0.3, ay + ny * 0.3],
    ];
    const on = holes.filter((h) => overlaps(h.zone, band));
    out.push({ ax, ay, bx, by, mx, my, dx, dy, nx, ny, len,
      th: thicknessAt(mx, my, dx, dy),
      doors: on.filter((h) => h.kind === 'door').length,
      windows: on.filter((h) => h.kind === 'window').length,
      facing: Math.atan2(ny, nx) + Math.PI / 2 });
  }
  return out;
}

/** Walls long enough for the piece: no doorway first, then no window, then the longest. */
function wallsFor(edges, width, { avoidWindows = false } = {}) {
  return edges.filter((e) => e.len >= width + 0.2)
    .sort((a, b) => (a.doors - b.doors)
      || (avoidWindows ? a.windows - b.windows : 0)
      || (b.len - a.len));
}

/**
 * Is a piece clear of the walls themselves? A room polygon follows wall centre lines, so the fit check
 * can call a spot "inside the room" while half the piece is buried in a 16 cm wall. Staging should never
 * do that: it is also what left a staged sofa wedged in a wall once physics.js started holding it there.
 */
function clearOfWalls(house, floorId, kind, x, y, rot) {
  const poly = footprint(kind, x, y, rot, -0.01);
  const f = (house.floors || []).find((q) => q.id === floorId) || (house.floors || [])[0];
  for (const w of (f && f.walls) || []) {
    if (w.type !== 'wall') continue;
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (len < 0.1) continue;
    const ux = (w.b[0] - w.a[0]) / len, uy = (w.b[1] - w.a[1]) / len;
    const th = Math.max(0.06, w.thickness || 0.12) / 2;
    const nx = -uy * th, ny = ux * th;
    const band = [[w.a[0] + nx, w.a[1] + ny], [w.b[0] + nx, w.b[1] + ny],
      [w.b[0] - nx, w.b[1] - ny], [w.a[0] - nx, w.a[1] - ny]];
    if (overlaps(poly, band)) return false;
  }
  return true;
}

// ------------------------------------------------------------------ putting pieces down
function makePlacer(room, floorZ, floor, style) {
  const w = window.walkin;
  const placed = [];
  const skipped = [];

  /** Try each candidate {x, y, rot} in turn; keep the first that passes the fit check. */
  function tryPlace(kind, candidates, { optional = false } = {}) {
    let why = 'no room for it';
    for (const c of candidates) {
      const r = fitReport({ kind, x: c.x, y: c.y, rot: c.rot, floor });
      if (r.room !== room) { why = `would land in the ${lower(r.room ? r.room.label : 'hallway')}`; continue; }
      if (!r.ok) { why = r.reasons[0]; continue; }
      if (!clearOfWalls(w.house, floor, kind, c.x, c.y, c.rot)) { why = 'half of it would be in the wall'; continue; }
      const item = w.addFurniture(kind);
      const it = item || w.furniture.children[w.furniture.children.length - 1];
      it.position.set(c.x, c.y, floorZ + (FURNITURE[kind].flat ? 0.002 : 0.004));
      it.rotation.z = c.rot;
      it.userData.floor = floor;
      if (style) applyStyle(it, style);
      placed.push({ kind, name: FURNITURE[kind].name, x: +c.x.toFixed(2), y: +c.y.toFixed(2), item });
      return it;
    }
    if (!optional) skipped.push({ kind, name: FURNITURE[kind].name, why });
    return null;
  }

  /** Would this piece be fine here, without actually putting it there? */
  function probe(kind, c) {
    const r = fitReport({ kind, x: c.x, y: c.y, rot: c.rot, floor });
    return r.room === room && r.ok && clearOfWalls(w.house, floor, kind, c.x, c.y, c.rot);
  }

  return { placed, skipped, tryPlace, probe, floor };
}

/** Points along a wall, centre first, then stepping out to both sides. */
function alongWall(edge, kind, offsets = [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2]) {
  const spec = FURNITURE[kind];
  // the polygon edge is the wall's centre line, so clear half its thickness as well as the gap
  const back = spec.d / 2 + (edge.th || 0.12) / 2 + WALL_GAP;
  const half = Math.max(0, edge.len / 2 - spec.w / 2 - 0.1);
  return offsets.filter((o) => Math.abs(o) <= half + 1e-6).map((o) => ({
    x: edge.mx + edge.dx * o + edge.nx * back,
    y: edge.my + edge.dy * o + edge.ny * back,
    rot: edge.facing,
  }));
}

/** A spot `dist` in front of an already placed piece (along the direction it faces). */
function inFrontOf(item, dist, side = 0) {
  const rot = item.rotation.z;
  const fx = Math.sin(rot), fy = -Math.cos(rot);            // the piece's own -y, in world
  const sx = Math.cos(rot), sy = Math.sin(rot);             // its +x
  return { x: item.position.x + fx * dist + sx * side, y: item.position.y + fy * dist + sy * side, rot: rot + Math.PI };
}

/** Beside a spot {x, y, rot}, along its own x axis. */
function beside(c, side) {
  return { x: c.x + Math.cos(c.rot) * side, y: c.y + Math.sin(c.rot) * side, rot: c.rot };
}

/** Beside a piece, on its own x axis. */
function besideOf(item, side) {
  const rot = item.rotation.z;
  return { x: item.position.x + Math.cos(rot) * side, y: item.position.y + Math.sin(rot) * side, rot };
}

// ------------------------------------------------------------------ what goes in which room
const PLANS = {
  bedroom(room, edges, P) {
    const area = (room.dims || {}).areaFloor || 12;
    const bed = area > 15 ? 'king' : 'queen';
    const spec = FURNITURE[bed];
    const reach = spec.w / 2 + FURNITURE.nightstand.w / 2 + 0.1;

    // a bed wants a nightstand on each side, so score every spot on every usable wall by how many fit
    let best = null;
    for (const e of wallsFor(edges, spec.w, { avoidWindows: true })) {
      for (const c of alongWall(e, bed)) {
        if (!P.probe(bed, c)) continue;
        const sides = [1, -1].filter((s) => P.probe('nightstand', beside(c, reach * s)));
        const score = sides.length * 10 - (e.windows ? 2 : 0);
        if (!best || score > best.score) best = { c, sides, score };
        if (score >= 20) break;
      }
      if (best && best.score >= 20) break;
    }
    if (!best) { P.skipped.push({ kind: bed, name: spec.name, why: 'no wall long enough without a door' }); return; }

    const placedBed = P.tryPlace(bed, [best.c], { optional: true });
    for (const s of best.sides) P.tryPlace('nightstand', [beside(best.c, reach * s)], { optional: true });
    void placedBed;
    P.tryPlace('floorlamp', spotsFor(room, edges, 'floorlamp'), { optional: true });
    P.tryPlace('plant', spotsFor(room, edges, 'plant').reverse(), { optional: true });
  },

  living(room, edges, P) {
    const sofa = FURNITURE.sofa;
    let placedSofa = null;
    for (const e of wallsFor(edges, sofa.w)) {
      placedSofa = P.tryPlace('sofa', alongWall(e, 'sofa'), { optional: true });
      if (placedSofa) break;
    }
    if (!placedSofa) { P.skipped.push({ kind: 'sofa', name: sofa.name, why: 'no wall long enough without a door' }); return; }
    P.tryPlace('rug', [inFrontOf(placedSofa, 1.25)], { optional: true });
    P.tryPlace('coffeetable', [inFrontOf(placedSofa, 1.0), inFrontOf(placedSofa, 0.85)], { optional: true });
    const side = FURNITURE.sofa.w / 2 + FURNITURE.armchair.w / 2 + 0.35;
    P.tryPlace('armchair', [
      { ...inFrontOf(placedSofa, 0.9, side), rot: placedSofa.rotation.z - Math.PI / 2 },
      { ...inFrontOf(placedSofa, 0.9, -side), rot: placedSofa.rotation.z + Math.PI / 2 },
      { ...inFrontOf(placedSofa, 1.4, side * 0.8), rot: placedSofa.rotation.z - Math.PI / 2 },
      { ...inFrontOf(placedSofa, 1.4, -side * 0.8), rot: placedSofa.rotation.z + Math.PI / 2 },
    ], { optional: true });
    // the television goes on the wall the sofa looks at
    const opposite = edges.filter((e) => Math.cos(e.facing - placedSofa.rotation.z) < -0.5)
      .sort((a, b) => b.len - a.len);
    for (const e of opposite) {
      const stand = P.tryPlace('tvstand', alongWall(e, 'tvstand', [0]), { optional: true });
      if (stand) {
        const on = besideOf(stand, 0);
        P.tryPlace('tv', [{ x: on.x, y: on.y, rot: stand.rotation.z }], { optional: true });
        break;
      }
    }
    P.tryPlace('plant', spotsFor(room, edges, 'plant'), { optional: true });
  },

  dining(room, edges, P) {
    const c = centroid(room.poly);
    const table = P.tryPlace('table', [
      { x: c.x, y: c.y, rot: 0 }, { x: c.x, y: c.y, rot: Math.PI / 2 },
    ], { optional: true });
    if (!table) { P.skipped.push({ kind: 'table', name: FURNITURE.table.name, why: 'no clear middle to the room' }); return; }
    const t = FURNITURE.table;
    const rot = table.rotation.z;
    const fx = Math.sin(rot), fy = -Math.cos(rot), sx = Math.cos(rot), sy = Math.sin(rot);
    const gap = t.d / 2 + FURNITURE.chair.d / 2 + 0.06;
    const spread = t.w / 4;
    for (const [side, along, turn] of [[1, -spread, Math.PI], [1, spread, Math.PI], [-1, -spread, 0], [-1, spread, 0]]) {
      P.tryPlace('chair', [{
        x: table.position.x + fx * gap * side + sx * along,
        y: table.position.y + fy * gap * side + sy * along,
        rot: rot + turn,
      }], { optional: true });
    }
    P.tryPlace('plant', spotsFor(room, edges, 'plant'), { optional: true });
  },

  office(room, edges, P) {
    let desk = null;
    for (const e of wallsFor(edges, FURNITURE.desk.w)) {
      desk = P.tryPlace('desk', alongWall(e, 'desk'), { optional: true });
      if (desk) break;
    }
    if (!desk) { P.skipped.push({ kind: 'desk', name: FURNITURE.desk.name, why: 'no wall long enough without a door' }); return; }
    P.tryPlace('chair', [{ ...inFrontOf(desk, 0.65), rot: desk.rotation.z + Math.PI }], { optional: true });
    for (const e of wallsFor(edges, FURNITURE.bookcase.w)) {
      if (P.tryPlace('bookcase', alongWall(e, 'bookcase', [0, 1.0, -1.0]), { optional: true })) break;
    }
    P.tryPlace('plant', spotsFor(room, edges, 'plant'), { optional: true });
  },
};

function centroid(poly) {
  const x = poly.reduce((a, p) => a + p[0], 0) / poly.length;
  const y = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  return { x, y };
}

/**
 * Candidate spots tucked into each corner. The polygon corner is where two wall centre lines meet, so a
 * piece has to come in far enough along the diagonal to clear half a wall on both sides as well as its
 * own half-width - moving L along the diagonal only clears L/sqrt(2) on each axis.
 */
function cornersOf(room, kind) {
  const spec = FURNITURE[kind] || { w: 0.5, d: 0.5 };
  const clear = (Math.max(spec.w, spec.d) / 2 + 0.08 + 0.06) * Math.SQRT2;
  const c = centroid(room.poly);
  return room.poly.map(([x, y]) => {
    const dx = c.x - x, dy = c.y - y, len = Math.hypot(dx, dy) || 1;
    return { x: x + (dx / len) * clear, y: y + (dy / len) * clear, rot: Math.atan2(dy, dx) + Math.PI / 2 };
  });
}

/**
 * Where a small piece could go: corners first, then tucked against each wall, then a coarse sweep of the
 * floor. The placer takes the first one that passes, so a lamp still lands somewhere sensible in a room
 * whose corners are all taken or too tight.
 */
function spotsFor(room, edges, kind) {
  const spec = FURNITURE[kind] || { w: 0.5, d: 0.5 };
  const out = cornersOf(room, kind);
  for (const e of edges) {
    const back = spec.d / 2 + (e.th || 0.12) / 2 + WALL_GAP;
    for (const o of [0, 0.6, -0.6, 1.2, -1.2]) {
      const half = Math.max(0, e.len / 2 - spec.w / 2 - 0.15);
      if (Math.abs(o) > half) continue;
      out.push({ x: e.mx + e.dx * o + e.nx * back, y: e.my + e.dy * o + e.ny * back, rot: e.facing });
    }
  }
  const xs = room.poly.map((p) => p[0]), ys = room.poly.map((p) => p[1]);
  for (let gx = Math.min(...xs) + 0.5; gx < Math.max(...xs); gx += 0.7) {
    for (let gy = Math.min(...ys) + 0.5; gy < Math.max(...ys); gy += 0.7) {
      out.push({ x: gx, y: gy, rot: 0 });
    }
  }
  return out;
}

const PLAN_FOR = (label) => {
  const l = lower(label);
  if (l.includes('bed')) return PLANS.bedroom;
  if (l.includes('living') || l.includes('family')) return PLANS.living;
  if (l.includes('dining')) return PLANS.dining;
  if (l.includes('office') || l === 'room' || l.includes('den') || l.includes('study')) return PLANS.office;
  return null;
};

// ------------------------------------------------------------------ the hook
/**
 * Furnish a room. `room` can be a room object, a room id, a label ("the bedroom"), or left out for
 * the room you are standing in. Anything already in that room is cleared first.
 * Returns { room, placed: [...], skipped: [{name, why}], fits, say } — `say` is a sentence for the agent.
 */
export function stageRoom(room, style = 'modern') {
  const w = window.walkin;
  if (!w) return { placed: [], skipped: [], fits: false, say: 'the viewer is not ready' };

  let r = room;
  if (!r) r = w.roomAt(w.current.pos[0], w.current.pos[1], w.current.floor);
  else if (typeof r === 'string') {
    r = w.house.rooms.find((q) => q.id === room)
      || w.house.rooms.filter((q) => lower(q.label).includes(lower(room).replace(/^the /, '')))
        .sort((a, b) => ((b.dims || {}).areaFloor || 0) - ((a.dims || {}).areaFloor || 0))[0];
  }
  if (!r || !r.poly || r.poly.length < 3) return { placed: [], skipped: [], fits: false, say: "I can't find that room" };

  const plan = PLAN_FOR(r.label);
  if (!plan) {
    return { room: r, placed: [], skipped: [], fits: true,
      say: `I don't have a set for a ${lower(r.label)} yet` };
  }

  // start from an empty room
  const cleared = [];
  for (const it of [...w.furniture.children]) {
    if (it.userData.kind && w.roomAt(it.position.x, it.position.y, it.userData.floor) === r) {
      w.furniture.remove(it);
      cleared.push(it.userData.kind);
    }
  }

  const floor = r.floor || (w.current && w.current.floor);
  const floorZ = (w.current && w.current.floorZ) || 0;
  const edges = edgesOf(r, w.house);
  const styleName = STYLES[style] ? style : getStyle();
  const P = makePlacer(r, floorZ, floor, styleName);
  plan(r, edges, P, floorZ, style);

  if (w.select) w.select(null);
  const names = P.placed.map((p) => lower(p.name));
  const fits = P.placed.length > 0 && P.skipped.length === 0;
  const say = P.placed.length
    ? `I put ${list(names)} in the ${lower(r.label)}`
      + (P.skipped.length ? `. No room for the ${list(P.skipped.map((s) => lower(s.name)))} — ${P.skipped[0].why}.` : '. Everything fits, doors clear.')
    : `I couldn't fit a ${lower(r.label)} set in there: ${(P.skipped[0] || {}).why || 'the room is too small'}`;

  return { room: r, style: styleName, cleared, placed: P.placed.map(({ item, ...rest }) => rest), skipped: P.skipped, fits, say };
}

/** "a sofa, a rug and 4 chairs" — duplicates are counted wherever they appear, not only side by side. */
function list(items) {
  const counted = [];
  for (const it of items) {
    const seen = counted.find((c) => c.name === it);
    if (seen) seen.n++;
    else counted.push({ name: it, n: 1 });
  }
  const words = counted.map(({ name, n }) => (n > 1 ? `${n} ${name.replace(/y$/, 'ie')}s` : name));
  if (words.length <= 1) return words[0] || 'nothing';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * Furnish every room in the house that has a set. Returns a per-room summary and one sentence.
 * "Furnish the whole house" is a fair thing for someone to ask, and doing it room by room from the
 * agent costs a round trip each; this is one call and about two seconds.
 */
export function stageHouse(style) {
  const w = window.walkin;
  if (!w) return { rooms: [], placed: 0, say: 'the viewer is not ready' };
  const rooms = [];
  let placed = 0;
  for (const room of w.house.rooms) {
    if (!room.poly || room.poly.length < 3) continue;
    if (!PLAN_FOR(room.label) && ((room.dims || {}).areaFloor || 0) < 20) continue;   // kitchens, bathrooms, halls
    const res = stageRoom(room, style);
    if (!res.placed.length) continue;
    placed += res.placed.length;
    rooms.push({ room: room.label, area: +((room.dims || {}).areaFloor || 0).toFixed(1),
      placed: res.placed.map((p) => p.kind), fits: res.fits });
  }
  if (w.select) w.select(null);
  const say = rooms.length
    ? `I furnished ${rooms.length} room${rooms.length === 1 ? '' : 's'} with ${placed} pieces`
      + ` — ${list(rooms.map((r) => lower(r.room)))}`
    : 'there is nothing here I have a set for';
  return { rooms, placed, style: rooms.length ? undefined : style, say };
}

/** Check a staged room after the fact (handy from the console and for the agent). */
export function describeRoom(room) {
  const w = window.walkin;
  const r = room || w.roomAt(w.current.pos[0], w.current.pos[1], w.current.floor);
  if (!r) return 'not in a room';
  const items = w.furniture.children.filter((o) => o.userData.kind
    && w.roomAt(o.position.x, o.position.y, o.userData.floor) === r);
  if (!items.length) return `the ${lower(r.label)} is empty`;
  const bad = items.map((it) => ({ it, r: fitReport({ item: it }) })).filter((x) => !x.r.ok);
  return `${lower(r.label)}: ${list(items.map((i) => lower(FURNITURE[i.userData.kind].name)))}`
    + (bad.length ? ` — ${bad.map((b) => fitLine(b.r)).join('; ')}` : ' — all of it fits');
}


// ------------------------------------------------------------------ S5: one small object at a point
// Things you can stand something on. A lamp or a plant put on one of these goes on top of it.
const SUPPORTS = ['table', 'desk', 'coffeetable', 'sidetable', 'nightstand', 'tvstand', 'bookcase'];

/** The piece whose top (x, y) lands on, if any. */
function supportAt(x, y, floor) {
  const w = window.walkin;
  return (w.furniture ? w.furniture.children : []).find((o) => o.userData.kind
    && SUPPORTS.includes(o.userData.kind)
    && (floor === undefined || o.userData.floor === floor)
    && pointInPoly(x, y, footprintOf(o)));
}

function footprintOf(o) {
  const spec = FURNITURE[o.userData.kind];
  const c = Math.cos(o.rotation.z), sn = Math.sin(o.rotation.z);
  const hw = spec.w / 2, hd = spec.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]
    .map(([px, py]) => [o.position.x + px * c - py * sn, o.position.y + px * sn + py * c]);
}

/** Pull (x, y) far enough inside a support's top that the object doesn't hang over the edge. */
function clampOnto(support, x, y, spec) {
  const rot = support.rotation.z, c = Math.cos(rot), sn = Math.sin(rot);
  const s = FURNITURE[support.userData.kind];
  const dx = x - support.position.x, dy = y - support.position.y;
  let lx = dx * c + dy * sn, ly = -dx * sn + dy * c;         // into the support's own frame
  lx = Math.max(-1, Math.min(1, lx / Math.max(1e-6, s.w / 2 - spec.w / 2))) * Math.max(0, s.w / 2 - spec.w / 2);
  ly = Math.max(-1, Math.min(1, ly / Math.max(1e-6, s.d / 2 - spec.d / 2))) * Math.max(0, s.d / 2 - spec.d / 2);
  return { x: support.position.x + lx * c - ly * sn, y: support.position.y + lx * sn + ly * c };
}

/**
 * Put one small object down: a plant, a lamp, a rug, anything in the catalog.
 *   walkin.placeObject('plant')                 where you are pointing, or 2 m ahead
 *   walkin.placeObject('plantsmall', x, y)      at a spot in model coordinates
 * If the spot is on a table, desk, nightstand or shelf, the object goes on top of it.
 * Returns { kind, name, x, y, z, on, fits, why, say }.
 */
export function placeObject(kind, x, y, opts = {}) {
  const w = window.walkin;
  if (!w) return { fits: false, say: 'the viewer is not ready' };
  if (!FURNITURE[kind]) return { fits: false, say: `I don't have a ${kind}` };
  const spec = FURNITURE[kind];
  const floor = opts.floor !== undefined ? opts.floor : (w.current && w.current.floor);
  const floorZ = (w.current && w.current.floorZ) || 0;

  if (x == null || y == null) {                              // where is the user looking?
    const p = w.pointer && w.pointer.point;
    if (p && w.pointer.room) { x = p[0]; y = p[1]; }
    else {
      const yaw = (w.view && w.view.yaw) || 0;
      x = w.current.pos[0] + Math.cos(yaw) * 2;
      y = w.current.pos[1] + Math.sin(yaw) * 2;
    }
  }

  const support = opts.onFloor ? null : supportAt(x, y, floor);
  const rot = opts.rot != null ? opts.rot
    : (support ? support.rotation.z : ((w.view && w.view.yaw) || 0) - Math.PI / 2);

  let spot = { x, y }, z = floorZ + (spec.flat ? 0.002 : 0.004), on = 'the floor', fits = true, why = '';
  if (support) {
    spot = clampOnto(support, x, y, spec);
    z = support.position.z + FURNITURE[support.userData.kind].h;
    on = `the ${lower(FURNITURE[support.userData.kind].name)}`;
  } else {
    // on the floor: take the first spot that passes the fit check, searching outwards from the ask
    const ring = [[0, 0]];
    for (let r = 0.3; r <= 1.2; r += 0.3) {
      for (let a = 0; a < 8; a++) ring.push([Math.cos((a * Math.PI) / 4) * r, Math.sin((a * Math.PI) / 4) * r]);
    }
    let found = null;
    for (const [ox, oy] of ring) {
      const r = fitReport({ kind, x: x + ox, y: y + oy, rot, floor });
      if (r.ok) { found = { x: x + ox, y: y + oy }; break; }
      if (!why) why = r.room ? r.reasons[0] : 'that spot is not in a room';
    }
    if (found) { spot = found; why = ''; } else { fits = false; }
  }

  if (!fits) {
    return { kind, name: spec.name, fits: false, why, say: `I can't put a ${lower(spec.name)} there - ${why}` };
  }

  w.addFurniture(kind);
  const it = w.furniture.children[w.furniture.children.length - 1];
  it.position.set(spot.x, spot.y, z);
  it.rotation.z = rot;
  it.userData.floor = floor;
  it.userData.on = support ? support.uuid : null;
  if (w.select) w.select(it);

  const room = w.roomAt(spot.x, spot.y, floor);
  return { kind, name: spec.name, x: +spot.x.toFixed(2), y: +spot.y.toFixed(2), z: +z.toFixed(3),
    on, room: room ? room.label : null, fits: true, item: it,
    say: `${spec.name} on ${on}${room ? ` in the ${lower(room.label)}` : ''}` };
}

/** The plants in the catalog, for the agent to choose from. */
export const plants = () => PLANTS.map((k) => ({ kind: k, name: FURNITURE[k].name, h: FURNITURE[k].h }));

(function start(tries = 0) {
  if (!window.walkin) {
    if (tries < 600) return setTimeout(() => start(tries + 1), 50);
    return;
  }
  window.walkin.stageRoom = stageRoom;
  window.walkin.stageHouse = stageHouse;
  window.walkin.setStyle = (style) => setStyle(style, window.walkin.furniture);
  window.walkin.styles = () => Object.keys(STYLES);

  // Buttons in the More popover, so a human can stage a room without the agent - the fallback if the
  // voice path is having a bad day in front of the judges. Each press cycles to the next style.
  const styles = Object.keys(STYLES);
  let next = 0;
  const stageBtn = document.getElementById('bStage');
  if (stageBtn) {
    stageBtn.addEventListener('click', () => {
      const w = window.walkin;
      const room = w.roomAt(w.current.pos[0], w.current.pos[1], w.current.floor);
      if (!room) { stageBtn.textContent = '⌂ not in a room'; setTimeout(() => { stageBtn.textContent = '⌂ Stage room'; }, 1800); return; }
      const style = styles[next++ % styles.length];
      const res = stageRoom(room, style);
      stageBtn.textContent = res.placed.length ? `⌂ ${style}` : '⌂ no room for a set';
      setTimeout(() => { stageBtn.textContent = '⌂ Stage room'; }, 2200);
      console.log(`stage: ${res.say}`);
    });
  }
  // Removing a piece deliberately disposes nothing. A model's geometry and materials are shared: a piece
  // is THREE.Object3D.clone(true) of one cached glTF, which shares geometry and material references, the
  // style materials are cached per (style, source material) in furniture.js, and every contact shadow uses
  // one CanvasTexture. Disposing any of them from here would blank the next piece of the same kind. What a
  // removed piece owns on its own is a few box geometries and one quad, which GC handles.
  const clearBtn = document.getElementById('bClearRoom');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const w = window.walkin;
      const room = w.roomAt(w.current.pos[0], w.current.pos[1], w.current.floor);
      if (!room) return;
      let n = 0;
      for (const it of [...w.furniture.children]) {
        if (it.userData.kind && w.roomAt(it.position.x, it.position.y, it.userData.floor) === room) {
          w.furniture.remove(it);   // see the note below on why nothing is disposed here
          n++;
        }
      }
      if (w.select) w.select(null);
      clearBtn.textContent = `⌁ took out ${n}`;
      setTimeout(() => { clearBtn.textContent = '⌁ Clear room'; }, 1800);
    });
  }
  window.walkin.describeRoom = describeRoom;
  window.walkin.placeObject = placeObject;
  window.walkin.plants = plants;
})();
