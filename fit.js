// S4 — does a piece actually work where it is?
// Three questions the room-outline check in app.js can't answer: does it stick out of the room, does it
// overlap something else, and can you still walk round it and through the doors.
// Pure geometry on top of window.walkin (house, rooms, walls with `openings`). Units: metres.
import { FURNITURE } from './furniture.js';

export const WALK = 0.6;        // a walkway has to be this wide
const CELL = 0.08;              // grid used for the walkway test
const DOOR_STEP = 0.4;          // how far into the room the "standing in the doorway" point is
export const DOOR_CLEAR = 0.8;  // depth of floor that has to stay clear in front of a doorway
const MAX_CELLS = 40000;        // a 30 m2 room is ~4700 cells; this is just a guard

// ------------------------------------------------------------------ small geometry helpers
export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The four corners of a piece's footprint, optionally grown by `pad` on every side. */
export function footprint(kind, x, y, rot, pad = 0) {
  const spec = FURNITURE[kind] || { w: 0.5, d: 0.5 };
  const w = spec.w / 2 + pad, d = spec.d / 2 + pad;
  const c = Math.cos(rot), s = Math.sin(rot);
  return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([px, py]) => [x + px * c - py * s, y + px * s + py * c]);
}

/** Separating-axis test for two convex polygons (our footprints are rectangles). */
export function overlaps(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const nx = -(y2 - y1), ny = x2 - x1;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [px, py] of a) { const p = px * nx + py * ny; a0 = Math.min(a0, p); a1 = Math.max(a1, p); }
      for (const [px, py] of b) { const p = px * nx + py * ny; b0 = Math.min(b0, p); b1 = Math.max(b1, p); }
      if (a1 <= b0 + 1e-9 || b1 <= a0 + 1e-9) return false;
    }
  }
  return true;
}

const itemPoly = (it, pad = 0) => footprint(it.userData.kind, it.position.x, it.position.y, it.rotation.z, pad);
const isFlat = (kind) => !!(FURNITURE[kind] || {}).flat;     // a rug is walked on, not round
// placeObject records what a small object was stood on; neither of the pair should fault the other
const standsOn = (a, b) => !!(a && b && ((a.userData || {}).on === b.uuid || (b.userData || {}).on === a.uuid));
const isOnSomething = (o) => !!(o.userData || {}).on;

/** The z span a piece occupies, from its own origin (its footprint sits on whatever holds it up). */
function zSpan(o) {
  const h = (FURNITURE[o.userData.kind] || {}).h || 0;
  return [o.position.z, o.position.z + h];
}

/** Two pieces at different heights - a lamp on a table and a chair under it - can share a footprint. */
function sameHeight(a, b, floorZ) {
  const [a0, a1] = a.isObject3D ? zSpan(a) : [floorZ, floorZ + ((FURNITURE[a.kind] || {}).h || 0)];
  const [b0, b1] = zSpan(b);
  return a1 > b0 + 0.02 && b1 > a0 + 0.02;
}

// ------------------------------------------------------------------ doors
/**
 * Where the doorways of a room are: for every opening on a wall that borders the room, a point one step
 * inside the room, plus the opening's width.
 */
export function doorways(room, house) {
  return openings(room, house).filter((o) => o.kind === 'door');
}

/** Every opening (doors and windows) on a wall bordering the room, with the floor it opens onto. */
export function openings(room, house) {
  const out = [];
  for (const f of house.floors || []) {
    if (room.floor && f.id && f.id !== room.floor) continue;
    for (const w of f.walls || []) {
      const [ax, ay] = w.a, [bx, by] = w.b;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const dx = (bx - ax) / len, dy = (by - ay) / len;
      const nx = -dy, ny = dx;
      for (const o of w.openings || []) {
        if (o.at == null) continue;
        const kind = o.type && /window/i.test(o.type) ? 'window' : 'door';
        const cx = ax + dx * o.at * len, cy = ay + dy * o.at * len;
        const width = o.width || 0.9;
        for (const s of [1, -1]) {                               // the side that is inside this room
          const px = cx + nx * s * DOOR_STEP, py = cy + ny * s * DOOR_STEP;
          if (!pointInPoly(px, py, room.poly)) continue;
          // the floor you walk on coming through: as wide as the opening, DOOR_CLEAR deep
          const hw = width / 2 + 0.05, ix = nx * s, iy = ny * s;
          const zone = [
            [cx - dx * hw, cy - dy * hw],
            [cx + dx * hw, cy + dy * hw],
            [cx + dx * hw + ix * DOOR_CLEAR, cy + dy * hw + iy * DOOR_CLEAR],
            [cx - dx * hw + ix * DOOR_CLEAR, cy - dy * hw + iy * DOOR_CLEAR],
          ];
          out.push({ kind, x: px, y: py, width, wall: w, zone, inward: [ix, iy] });
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ walkways
/**
 * Mark the room's floor as free / blocked / walkable (a WALK-wide circle fits), then flood fill from the
 * doors. Returns the grid plus how much of the free floor you can actually reach.
 */
function walkGrid(room, blockers) {
  const xs = room.poly.map((p) => p[0]), ys = room.poly.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const nx = Math.ceil((x1 - x0) / CELL) + 1, ny = Math.ceil((y1 - y0) / CELL) + 1;
  if (nx * ny > MAX_CELLS) return null;                           // huge room: skip rather than stall
  const at = (ix, iy) => iy * nx + ix;
  const free = new Uint8Array(nx * ny);
  let freeCount = 0;

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = x0 + ix * CELL, y = y0 + iy * CELL;
      if (!pointInPoly(x, y, room.poly)) continue;
      if (blockers.some((p) => pointInPoly(x, y, p))) continue;
      free[at(ix, iy)] = 1;
      freeCount++;
    }
  }

  // walkable = a circle of radius WALK/2 centred here is entirely free
  const r = Math.max(1, Math.round((WALK / 2) / CELL));
  const disc = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) disc.push([dx, dy]);
  const walk = new Uint8Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (!free[at(ix, iy)]) continue;
      let ok = true;
      for (const [dx, dy] of disc) {
        const jx = ix + dx, jy = iy + dy;
        if (jx < 0 || jy < 0 || jx >= nx || jy >= ny || !free[at(jx, jy)]) { ok = false; break; }
      }
      if (ok) walk[at(ix, iy)] = 1;
    }
  }
  return { x0, y0, nx, ny, at, free, walk, freeCount,
    cellOf: (x, y) => [Math.round((x - x0) / CELL), Math.round((y - y0) / CELL)] };
}

/** Flood fill the walkable cells from one cell; returns the set of reached cells. */
function reach(g, start) {
  const seen = new Uint8Array(g.nx * g.ny);
  const [sx, sy] = start;
  // start from the nearest walkable cell within 0.5 m, so a door sill doesn't fail the fill
  let seed = null;
  const span = Math.round(0.5 / CELL);
  for (let rr = 0; rr <= span && !seed; rr++) {
    for (let dy = -rr; dy <= rr && !seed; dy++) {
      for (let dx = -rr; dx <= rr && !seed; dx++) {
        const ix = sx + dx, iy = sy + dy;
        if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) continue;
        if (g.walk[g.at(ix, iy)]) seed = [ix, iy];
      }
    }
  }
  if (!seed) return { seen, count: 0, ok: false };
  const stack = [seed];
  seen[g.at(seed[0], seed[1])] = 1;
  let count = 1;
  while (stack.length) {
    const [ix, iy] = stack.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const jx = ix + dx, jy = iy + dy;
      if (jx < 0 || jy < 0 || jx >= g.nx || jy >= g.ny) continue;
      const k = g.at(jx, jy);
      if (seen[k] || !g.walk[k]) continue;
      seen[k] = 1;
      count++;
      stack.push([jx, jy]);
    }
  }
  return { seen, count, ok: true };
}

// ------------------------------------------------------------------ the report
const lower = (s) => (s || 'room').toLowerCase();

/**
 * Everything wrong with where one piece is. `ok` is false only for things that are actually wrong;
 * `warnings` are things worth saying but not worth refusing.
 *   { ok, room, reasons: ['blocks the bedroom door'], warnings: [...] }
 * Pass `{ item }` for a piece already in the scene, or `{ kind, x, y, rot, floor }` for a trial position.
 * `{ on: <the piece it stands on> }` and `{ ignore: [...] }` both drop pieces from the overlap test.
 * `{ quick: true }` skips the walkway raster, which is ~1.8 ms in a 29 m2 room on a laptop and several
 * times that on a phone. Everything else - the room, overlaps, the doorway zones - is microseconds, so
 * the viewer runs quick checks while you drag and the full one once you stop.
 */
export function fitReport(opts = {}) {
  const w = window.walkin;
  const item = opts.item || null;
  const kind = opts.kind || (item && item.userData.kind);
  if (!w || !kind) return { ok: false, reasons: ['nothing selected'], warnings: [], room: null };

  if (!item && (opts.x == null || opts.y == null)) {
    return { ok: false, room: null, reasons: ['no position given'], warnings: [] };
  }
  const x = opts.x != null ? opts.x : item.position.x;
  const y = opts.y != null ? opts.y : item.position.y;
  const rot = opts.rot != null ? opts.rot : (item ? item.rotation.z : 0);   // a trial position may omit it
  const floor = opts.floor !== undefined ? opts.floor : (item && item.userData.floor);
  const spec = FURNITURE[kind];
  const reasons = [], warnings = [];

  const room = w.roomAt(x, y, floor);
  const zFloor = item ? item.position.z : ((w.current && w.current.floorZ) || 0);
  const poly = footprint(kind, x, y, rot);
  if (!room) {
    return { ok: false, room: null, reasons: ['not inside a room'], warnings: [] };
  }
  if (!poly.every(([px, py]) => pointInPoly(px, py, room.poly))) {
    reasons.push(`sticks out of the ${lower(room.label)}`);
  }

  // other pieces on the same floor, in the same room
  // `ignore` is for a piece this one is standing on: a lamp on a table doesn't overlap the table
  const ignore = opts.ignore || [];
  const others = (w.furniture ? w.furniture.children : []).filter((o) =>
    o !== item && !ignore.includes(o) && o.userData.kind && (floor === undefined || o.userData.floor === floor));
  for (const o of others) {
    const ok = o.userData.kind;
    if (isFlat(kind) || isFlat(ok)) continue;                     // you can stand furniture on a rug
    if (standsOn(item, o) || (opts.on && opts.on === o)) continue; // a lamp on a table isn't in the table's way
    if (!sameHeight(item || { kind }, o, zFloor)) continue;        // nor is anything else at a different height
    if (overlaps(poly, itemPoly(o))) reasons.push(`overlaps the ${lower(FURNITURE[ok].name)}`);
  }

  // standing in a doorway is cheap to test and always worth saying, so it runs even in a quick check
  if (!isFlat(kind) && opts.quick) {
    const doors = doorways(room, w.house);
    if (doors.some((d) => overlaps(poly, d.zone))) reasons.push(`blocks the ${lower(room.label)} door`);
  }

  if (!isFlat(kind) && !opts.quick) {
    const blockers = others.filter((o) => !isFlat(o.userData.kind) && !isOnSomething(o)
      && w.roomAt(o.position.x, o.position.y, floor) === room)
      .map((o) => itemPoly(o));
    blockers.push(poly);
    const g = walkGrid(room, blockers);
    const doors = doorways(room, w.house);
    // standing in a doorway: the piece itself overlaps the floor you come in on
    if (doors.some((d) => overlaps(poly, d.zone))) reasons.push(`blocks the ${lower(room.label)} door`);
    if (g && doors.length) {
      const fills = doors.map((d) => reach(g, g.cellOf(d.x, d.y)));
      if (fills.some((f) => !f.ok)) reasons.push(`blocks the ${lower(room.label)} door`);
      const open = fills.filter((f) => f.ok);
      for (let i = 1; i < open.length; i++) {
        const a = open[0], b = open[i];
        let shared = false;
        for (let k = 0; k < a.seen.length && !shared; k++) if (a.seen[k] && b.seen[k]) shared = true;
        if (!shared) { reasons.push(`leaves no ${WALK} m way between the doors`); break; }
      }
      const reached = open.length ? Math.max(...open.map((f) => f.count)) : 0;
      const walkable = g.walk.reduce((a, b) => a + b, 0);
      if (walkable && reached / walkable < 0.6) warnings.push('cuts the room in two');
    } else if (g && !doors.length) {
      const walkable = g.walk.reduce((a, b) => a + b, 0);
      if (!walkable) warnings.push(`no ${WALK} m of clear floor left`);
    }
  }

  const uniq = [...new Set(reasons)];
  return { ok: uniq.length === 0, room, reasons: uniq, warnings: [...new Set(warnings)], spec };
}

/** One line a person (or the agent) can read. */
export function fitLine(report) {
  const all = [...(report.reasons || []), ...(report.warnings || [])];
  if (all.length) return all.join(', ');
  if (!report.room) return "it isn't in a room";
  return `fits in the ${lower(report.room.label)}`;
}

/** Every piece in a room, checked. Used by staging.js and by the agent. */
export function checkRoom(room) {
  const w = window.walkin;
  const items = (w.furniture ? w.furniture.children : [])
    .filter((o) => o.userData.kind && w.roomAt(o.position.x, o.position.y, o.userData.floor) === room);
  const reports = items.map((item) => ({ item, kind: item.userData.kind, ...fitReport({ item }) }));
  return { ok: reports.every((r) => r.ok), reports,
    reasons: [...new Set(reports.flatMap((r) => r.reasons))] };
}

/**
 * Every doorway in the house, and whether a given piece gets through it: `'as held'` if it fits at
 * any angle, `'turned'` if only the narrow way round, `'never'` if it doesn't fit at all.
 *
 * Which is the question beat 5 of the demo asks, and the answer is not obvious: of La Mirada's
 * twenty-two doorways exactly one is in the interesting middle for a sofa. Point this at a new house
 * before rehearsing on it.
 *
 *   walkin.doorsFor('sofa').filter(d => d.fits === 'turned')
 */
export function doorsFor(kind = 'sofa') {
  const w = window.walkin;
  const spec = FURNITURE[kind];
  if (!w || !spec) return [];
  const narrow = Math.min(spec.w, spec.d), wide = Math.max(spec.w, spec.d);
  const out = [];
  for (const f of w.house.floors || []) {
    for (const wl of f.walls || []) {
      const [ax, ay] = wl.a, [bx, by] = wl.b;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const dx = (bx - ax) / len, dy = (by - ay) / len, nx = -dy, ny = dx;
      for (const o of wl.openings || []) {
        if (o.at == null || (o.type && /window/i.test(o.type)) || (o.bottom || 0) >= 0.3) continue;
        const width = o.width || 0.9;
        const x = ax + dx * o.at * len, y = ay + dy * o.at * len;
        const side = (s) => (w.roomAt(x + nx * s * 0.6, y + ny * s * 0.6, f.id) || {}).label || null;
        const near = (w.house.panos || [])
          .map((p) => ({ label: p.label, d: Math.hypot(p.pos[0] - x, p.pos[1] - y) }))
          .sort((a, b) => a.d - b.d)[0];
        out.push({
          width: +width.toFixed(2),
          fits: wide <= width - 0.02 ? 'as held' : narrow <= width - 0.02 ? 'turned' : 'never',
          x: +x.toFixed(2), y: +y.toFixed(2),
          between: [side(1), side(-1)],
          scanPoint: near ? near.label : null,
          metresAway: near ? +near.d.toFixed(2) : null,
        });
      }
    }
  }
  return out.sort((a, b) => b.width - a.width);
}

// ------------------------------------------------------------------ show it in the viewer
// app.js writes the room-outline result into #fit; this adds the rest on the line below it.
(function start(tries = 0) {
  if (!window.walkin) {
    if (tries < 600) return setTimeout(() => start(tries + 1), 50);
    return;
  }
  window.walkin.fitReport = fitReport;
  window.walkin.checkRoom = checkRoom;
  window.walkin.fitLine = fitLine;
  window.walkin.doorsFor = doorsFor;

  const host = document.getElementById('fit');
  if (!host) return;
  const extra = document.createElement('div');
  extra.id = 'fitmore';
  extra.style.cssText = 'margin-top:2px;font-size:12px;color:#ffb199';
  host.after(extra);

  // Put the doorway answer on the screen. physics.js works out "the sofa is 2.10 m across the way
  // you're holding it and that door is 1.15 m - turn it and it goes through" and fires it as
  // walkin:blocked; John says it out loud once #54 is merged, and until then nothing in the repo
  // listens at all, so the beat the runbook says to land hardest happens in silence. This is the
  // written half, which costs nothing and doesn't depend on a key, a voice or a merge. The headset
  // hides this panel, so there is no double when John has it too.
  //
  // It holds the line for four seconds against the fit checks that run while you drag, and after that
  // the next thing that actually changes replaces it - so a piece sitting still at a door keeps its
  // answer on screen to be read rather than blinking out on a timer.
  let blockedUntil = 0;
  addEventListener('walkin:blocked', (e) => {
    const reason = e.detail && e.detail.reason;
    if (!reason) return;
    extra.textContent = reason;
    blockedUntil = performance.now() + 4000;
  });

  // While a piece is moving, run the cheap checks (room, overlaps, doorways) at ~7 Hz; the walkway
  // raster only runs once it has been still for a moment, so dragging on a phone stays smooth.
  const show = (r) => {
    if (performance.now() < blockedUntil) return;   // don't write over the doorway answer
    const say = [...r.reasons, ...r.warnings].filter((t) => t !== 'not inside a room');
    extra.textContent = say.join(' · ');   // app.js already says "outside a room" on the line above
  };
  let lastKey = '', lastRun = 0, settleTimer = null;
  (function tick() {
    requestAnimationFrame(tick);
    const sel = window.walkin.selected;
    if (!sel) {
      if (lastKey && performance.now() >= blockedUntil) { extra.textContent = ''; lastKey = ''; clearTimeout(settleTimer); }
      return;
    }
    const key = `${sel.id}|${sel.position.x.toFixed(2)}|${sel.position.y.toFixed(2)}|${sel.rotation.z.toFixed(2)}`
      + `|${window.walkin.furniture.children.length}`;
    const now = performance.now();
    if (key === lastKey || now - lastRun < 140) return;
    lastKey = key;
    lastRun = now;
    show(fitReport({ item: sel, quick: true }));
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (window.walkin.selected === sel) show(fitReport({ item: sel }));
    }, 300);
  })();
})();
