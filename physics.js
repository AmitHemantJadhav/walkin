// S8 — furniture that has weight and can't walk through walls.
//
// Not a physics engine: a constraint layer. Whatever moves a piece - the mouse drag in app.js, a hand
// in hands.js, stageRoom, the agent - sets its position as usual, and every frame this module takes that
// as a *target* and moves the piece there under collision. So a sofa pushed at a wall stops at the wall,
// a sofa carried at a doorway narrower than it won't go through until you turn it, and letting go while
// moving lets it slide and settle on friction.
//
// Why not Rapier, which the issue asked for: everything our furniture does happens in plan. Pieces stay
// upright, never stack and never topple, so the whole problem is an oriented rectangle sliding among wall
// segments - about 200 lines against geometry fit.js already has, instead of a 2 MB wasm download that we
// would also have to vendor (#40) and that can jitter a staged room. The API below is exactly the one the
// issue specified, so if we do want a real solver later it swaps underneath without touching the callers.
//
// Units: metres, Z up. walkin.physics.enabled = false, or ?physics=off, turns it all off.
import { FURNITURE } from './furniture.js';
import { footprint, overlaps } from './fit.js';

// kg. Only the ratios matter: they set how much a piece lags behind your hand and how far it slides.
const MASS = {
  sofa: 60, armchair: 28, queen: 55, king: 65, table: 25, desk: 22, chair: 7, nightstand: 12,
  sidetable: 9, coffeetable: 16, tvstand: 20, tv: 12, bookcase: 35, floorlamp: 6,
  rug: 4, ruground: 4, plant: 8, plantsmall: 1.5, plantfern: 1.5, plantsucculent: 1.5,
  cactus: 3, cactustall: 5,
};
const DEFAULT_MASS = 15;
// Telling a placement from a push. Distance alone isn't enough: hold a sofa against a wall and the hand
// keeps going, so the gap grows past any threshold and the piece would teleport through the wall. A
// placement is a jump that happens when nothing was pushing the piece a moment ago.
const TELEPORT = 0.5;          // metres
const SETTLED = 300;           // ms since the last push before a jump counts as a placement
const HOLD_BLOCK = 2000;       // ...and a piece that is stuck is never a placement, however long you pause:
                               // hold a sofa at a door it won't fit through, think for a second, nudge it, and
                               // the cursor is now a metre past the wall. That must not read as "put it there".
const MAX_LAG = 0.3;           // how far a piece may fall behind the hand while it is moving freely
const SKIN = 0.012;            // shrink the footprint slightly so a piece doesn't stick to a wall it touches
const FRICTION = 0.6;          // floor friction, as a deceleration of mu * g
const G = 9.81;
const STOP = 0.06;             // below this speed a sliding piece is parked
const MAX_V = 6;               // m/s, so a wild hand can't fling a sofa across the house
const MAX_STEP = 0.6;          // metres a piece may travel in one frame, however far the hand has run off
const ESCAPE = 0.08;           // how fast a piece that starts overlapped may crawl out of trouble
const ASSIST = 0.35;           // m/s a piece that would fit is slid towards a doorway's centre line...
const ASSIST_MIN = 0.03;       // ...but at least this much per frame it is actually blocked, because it only
                               // gets a handful of those: it alternates between nudging sideways and moving
                               // forward again, and 0.35 m/s of a 16 ms frame is 6 mm
const ASSIST_RANGE = 1.2;      // how close to the doorway the assist starts

const mass = (kind) => MASS[kind] || DEFAULT_MASS;
// how long a piece takes to catch up with your hand: a plant is immediate, a sofa drags
const lagOf = (kind) => 0.02 + mass(kind) / 420;

const state = new Map();       // item -> { x, y, rot, vx, vy, still, sliding }
let segCache = null;           // { floor, segs: [{poly, a, b}], doors: [{x, y, width, a, b}] }

const stats = { frames: 0, moved: 0, blocked: 0, teleports: 0, assisted: 0, lastHit: null };

export const physics = {
  enabled: true,
  MASS,
  stats,
  grab, moveTarget, release, shove,
  segments: () => (segCache ? segCache.segs.length : 0),
  /** What would be in the way if this piece stood at (x, y, rot)? For debugging and for the Debug overlay. */
  probe(item, x, y, rot) {
    // the frame loop ignores rugs and anything standing on something else, so the probe must too,
    // or a television on a stand against a wall reads as stuck in it
    const spec = FURNITURE[item.userData.kind] || {};
    if (spec.flat || (item.userData || {}).on) return { hit: null, skipped: true };
    const walls = wallsOf(item.userData.floor);
    const hit = blockedBy(fp(item, x, y, rot === undefined ? item.rotation.z : rot), item, walls);
    return { hit: hit ? hit.kind : null, segs: walls.segs.length,
      dir: hit && hit.dir ? hit.dir.map((v) => +v.toFixed(3)) : null,
      seg: hit && hit.seg ? hit.seg.poly.map((q) => q.map((v) => +v.toFixed(2))) : null };
  },
  get bodies() { return state.size; },
};

// ------------------------------------------------------------------ the walls, as things to bump into
/** Wall segments for a floor with the doorways left open, plus the doorways themselves. */
function wallsOf(floorId) {
  if (segCache && segCache.floor === floorId) return segCache;
  const w = window.walkin;
  const f = (w.house.floors || []).find((x) => x.id === floorId) || (w.house.floors || [])[0];
  const segs = [], doors = [];
  for (const wall of (f && f.walls) || []) {
    if (wall.type !== 'wall') continue;
    const ax = wall.a[0], ay = wall.a[1];
    const len = Math.hypot(wall.b[0] - ax, wall.b[1] - ay);
    if (len < 0.1) continue;
    const dx = (wall.b[0] - ax) / len, dy = (wall.b[1] - ay) / len;
    const th = Math.max(0.06, wall.thickness || 0.12);
    // everything we own is shorter than a door head, so a doorway is simply a gap
    const gaps = (wall.openings || [])
      .filter((o) => o && o.at != null && (o.bottom || 0) < 0.3 && (o.type !== 'window'))
      .map((o) => {
        const half = (o.width || 0.9) / 2, c = o.at * len;
        doors.push({ x: ax + dx * c, y: ay + dy * c, width: o.width || 0.9, dx, dy });
        return [Math.max(0, c - half), Math.min(len, c + half)];
      })
      .sort((p, q) => p[0] - q[0]);
    let cursor = 0;
    const pieces = [];
    for (const [g0, g1] of gaps) {
      if (g0 > cursor + 0.02) pieces.push([cursor, g0]);
      cursor = Math.max(cursor, g1);
    }
    if (cursor < len - 0.02) pieces.push([cursor, len]);
    for (const [s0, s1] of pieces) {
      const nx = -dy * (th / 2), ny = dx * (th / 2);
      segs.push({
        poly: [[ax + dx * s0 + nx, ay + dy * s0 + ny], [ax + dx * s1 + nx, ay + dy * s1 + ny],
          [ax + dx * s1 - nx, ay + dy * s1 - ny], [ax + dx * s0 - nx, ay + dy * s0 - ny]],
        dir: [dx, dy],
      });
    }
  }
  segCache = { floor: floorId, segs, doors };
  return segCache;
}

/** The pieces a given item can bump into (not itself, not rugs, not things standing on something). */
function neighbours(item) {
  const w = window.walkin;
  return w.furniture.children.filter((o) => o !== item && o.userData.kind
    && !(FURNITURE[o.userData.kind] || {}).flat && !(o.userData || {}).on
    && o.userData.floor === item.userData.floor);
}

/** Just the walls: being stuck in another piece is recoverable, being pushed into a wall never is. */
function hitsWall(poly, walls) {
  for (const s of walls.segs) if (overlaps(poly, s.poly)) return true;
  return false;
}

/** Is this footprint clear of walls and of other pieces? Returns null, or what it hit. */
function blockedBy(poly, item, walls) {
  for (const s of walls.segs) if (overlaps(poly, s.poly)) return { kind: 'wall', dir: s.dir, seg: s };
  for (const o of neighbours(item)) {
    const p = footprint(o.userData.kind, o.position.x, o.position.y, o.rotation.z, -SKIN);
    if (overlaps(poly, p)) return { kind: 'piece', item: o };
  }
  return null;
}

const fp = (item, x, y, rot) => footprint(item.userData.kind, x, y, rot, -SKIN);

/**
 * Move a piece from where it is towards (tx, ty, trot), stopping at whatever is in the way and sliding
 * along it. The move is swept in sub-steps: testing only the destination lets a fast piece tunnel clean
 * through a wall, which is exactly what happened the first time - a sofa held against a wall while the
 * hand kept going built up a 2.3 m step and reappeared in the next room.
 * Returns what it hit, or null.
 */
function step(item, st, tx, ty, trot, walls) {
  let hit = null;

  let dx = tx - st.x, dy = ty - st.y;

  if (trot !== st.rot) {
    if (!blockedBy(fp(item, st.x, st.y, trot), item, walls)) st.rot = trot;
    else {
      // Turning a piece that is pressed against a jamb has nowhere to go, which is exactly the moment
      // someone turns a sofa at a door. Give it room: back off a little the way it came and turn there.
      const len = Math.hypot(dx, dy) || 1;
      const bx = -dx / len, by = -dy / len;
      let turned = false;
      for (const back of [0.08, 0.16, 0.26]) {
        const nx2 = st.x + bx * back, ny2 = st.y + by * back;
        if (blockedBy(fp(item, nx2, ny2, trot), item, walls)) continue;
        st.x = nx2; st.y = ny2; st.rot = trot; turned = true;
        break;
      }
      if (!turned) hit = { kind: 'rotate' };
    }
  }
  let dist = Math.hypot(dx, dy);
  if (dist < 1e-5) return hit;
  if (dist > MAX_STEP) { dx *= MAX_STEP / dist; dy *= MAX_STEP / dist; dist = MAX_STEP; }

  const spec = FURNITURE[item.userData.kind];
  const sub = Math.max(0.03, Math.min(spec.w, spec.d) * 0.3);   // never step more than a third of the piece
  const n = Math.max(1, Math.ceil(dist / sub));

  // A piece that is already overlapping something - a layout saved before any of this existed, or a
  // placement a centimetre inside a wall - must not be frozen there. Let it move, preferring any step
  // that gets it out.
  if (blockedBy(fp(item, st.x, st.y, st.rot), item, walls)) {
    for (const f of [1, 0.5, 0.25]) {
      if (!blockedBy(fp(item, st.x + dx * f, st.y + dy * f, st.rot), item, walls)) {
        st.x += dx * f; st.y += dy * f;
        return hit;
      }
    }
    // Still stuck: creep, don't jump, and never into a wall. Crawling freely was how a sofa that
    // started overlapping another piece walked 4.8 m through the living room wall in a demo rehearsal.
    const crawl = Math.min(1, ESCAPE / (dist || 1));
    const cx = st.x + dx * crawl, cy = st.y + dy * crawl;
    if (hitsWall(fp(item, cx, cy, st.rot), walls)) return { kind: 'wall', dir: [0, 0] };  // say why, as usual
    st.x = cx;
    st.y = cy;
    return { kind: 'overlapping' };
  }

  /**
   * Walk along (ax, ay) in `steps` sub-steps, stopping before the first blocked one, then halving the
   * remaining sub-step a few times so a piece can come to rest touching a wall rather than a sub-step
   * short of it.
   */
  function sweep(ax, ay, steps) {
    const sx = ax / steps, sy = ay / steps;
    let moved = 0, blocked = null;
    for (let i = 0; i < steps; i++) {
      const b = blockedBy(fp(item, st.x + sx, st.y + sy, st.rot), item, walls);
      if (b) { blocked = b; break; }
      st.x += sx;
      st.y += sy;
      moved++;
    }
    if (blocked) {                                        // close the last gap
      let hx = sx / 2, hy = sy / 2;
      for (let i = 0; i < 3; i++) {
        if (!blockedBy(fp(item, st.x + hx, st.y + hy, st.rot), item, walls)) { st.x += hx; st.y += hy; }
        hx /= 2; hy /= 2;
      }
    }
    return { moved, blocked };
  }

  const first = sweep(dx, dy, n);
  if (!first.blocked) return hit;
  hit = first.blocked;

  // slide what is left of the move along whatever stopped it: a wall has a direction of its own, and for
  // another piece the tangent at the contact is the nearest thing to one
  const left = Math.max(0.15, 1 - first.moved / n);
  let ux = 0, uy = 0;
  if (first.blocked.kind === 'wall') {
    [ux, uy] = first.blocked.dir;
  } else if (first.blocked.item) {
    const nx2 = st.x - first.blocked.item.position.x, ny2 = st.y - first.blocked.item.position.y;
    const len2 = Math.hypot(nx2, ny2) || 1;
    ux = -ny2 / len2; uy = nx2 / len2;                    // perpendicular to the line between centres
  }
  const along = (dx * ux + dy * uy) * left;
  if (Math.abs(along) > 1e-4) {
    sweep(ux * along, uy * along, Math.max(1, Math.ceil(Math.abs(along) / sub)));
  }
  return hit;
}

/**
 * Why a doorway is refusing a piece. The number that matters is how wide the piece is *as you are holding
 * it* - its footprint measured across the doorway - not its narrowest side, which is what it would be if
 * you turned it. That difference is the whole beat: "turn it and it goes through".
 */
function doorReason(item, st, walls) {
  const spec = FURNITURE[item.userData.kind];
  let best = null;
  for (const d of walls.doors) {
    const dist = Math.hypot(d.x - st.x, d.y - st.y);
    if (dist < 1.4 && (!best || dist < best.dist)) best = { d, dist };
  }
  if (!best) return null;
  const { d } = best;
  // the footprint's extent along the wall the door is in
  const width = widthAcross(item, st.rot, d);
  if (width <= d.width - 0.02) return null;                 // it isn't the door's fault
  const narrow = Math.min(spec.w, spec.d);
  const name = spec.name.toLowerCase();
  return {
    door: +d.width.toFixed(2), across: +width.toFixed(2),
    turnable: narrow <= d.width - 0.02,
    text: `the ${name} is ${width.toFixed(2)} m across the way you're holding it and that door is `
      + `${d.width.toFixed(2)} m`
      + (narrow <= d.width - 0.02 ? ` — turn it and it goes through` : ` — it won't fit through at all`),
  };
}

/**
 * The doorway a piece is being pushed at, if it is close enough to one and actually heading through it.
 * Returns the doorway plus how far off its centre line the piece is, measured along the wall.
 */
function doorAhead(item, st, walls, dx, dy) {
  let best = null;
  for (const d of walls.doors) {
    const vx = d.x - st.x, vy = d.y - st.y;
    const dist = Math.hypot(vx, vy);
    if (dist > ASSIST_RANGE) continue;
    if (dx * vx + dy * vy <= 0) continue;                 // not moving towards it
    if (!best || dist < best.dist) best = { d, dist, off: vx * d.dx + vy * d.dy };
  }
  return best;
}

/** How wide the piece is measured across a doorway, at a given rotation. */
function widthAcross(item, rot, d) {
  const spec = FURNITURE[item.userData.kind];
  const c = Math.cos(rot), sn = Math.sin(rot);
  return 2 * (Math.abs((spec.w / 2) * (d.dx * c + d.dy * sn))
    + Math.abs((spec.d / 2) * (-d.dx * sn + d.dy * c)));
}

/**
 * S9: a piece that would fit through a doorway only goes through within about 10 cm of its centre line,
 * which is finer than tracked hands can hold. When one is blocked at a jamb and it *would* fit the way it
 * is turned, slide it sideways towards the centre line instead of stopping. A piece that genuinely does
 * not fit is left alone, so it still stops and still says "turn it".
 */
function assistThroughDoor(item, st, walls, dt, dx, dy, wantRot) {
  const near = doorAhead(item, st, walls, dx, dy);
  if (!near) return false;
  // Judge the fit by the way it is turned OR the way the user is turning it: pressed against a jamb a
  // piece can't turn at all, so waiting for the turn to happen first would deadlock the two.
  const fits = Math.min(widthAcross(item, st.rot, near.d),
    typeof wantRot === 'number' ? widthAcross(item, wantRot, near.d) : Infinity);
  if (fits > near.d.width - 0.02) return false;                            // a real misfit: say so instead
  if (Math.abs(near.off) < 0.015) return false;                            // already lined up
  const d = near.d;

  // The user is turning it and it would fit turned, but it is jammed against the jamb so it can't turn
  // and can't slide. Do what a person does: back it off the doorway, line it up, and turn it, in one move.
  if (typeof wantRot === 'number' && wantRot !== st.rot
      && widthAcross(item, wantRot, d) <= d.width - 0.02) {
    const len = Math.hypot(dx, dy) || 1;
    const bx = -dx / len, by = -dy / len;
    for (const back of [0.15, 0.3, 0.5, 0.75]) {
      for (const frac of [1, 0.6, 0.3, 0]) {
        const lat = near.off * frac;
        const nx2 = st.x + bx * back + d.dx * lat, ny2 = st.y + by * back + d.dy * lat;
        if (blockedBy(fp(item, nx2, ny2, wantRot), item, walls)) continue;
        st.x = nx2; st.y = ny2; st.rot = wantRot;
        return true;
      }
    }
  }

  const move = Math.sign(near.off) * Math.min(Math.abs(near.off), Math.max(ASSIST * dt, ASSIST_MIN));
  const before = st.x;
  const beforeY = st.y;
  step(item, st, st.x + d.dx * move, st.y + d.dy * move, st.rot, walls);
  return st.x !== before || st.y !== beforeY;
}

let lastBlocked = 0;
function sayBlocked(item, info) {
  const now = performance.now();
  if (now - lastBlocked < 1200) return;                   // one message per beat, not per frame
  lastBlocked = now;
  const detail = { item, kind: item.userData.kind, ...info };
  window.dispatchEvent(new CustomEvent('walkin:blocked', { detail }));
  if (window.walkin) window.walkin.lastBlocked = detail;
}

// ------------------------------------------------------------------ the API the hands use (A2)
const hands = new Map();        // handId -> { item, target, yaw }

/** Attach a piece to a hand. The piece follows with the lag its mass gives it. */
export function grab(item, handId = 'hand', worldPoint = null) {
  if (!item || !item.userData.kind) return false;
  hands.set(handId, { item, target: worldPoint ? [worldPoint[0], worldPoint[1]] : [item.position.x, item.position.y],
    yaw: item.rotation.z });
  const st = ensure(item);
  st.sliding = false;
  st.pushT = performance.now();   // held means carried: never treat the hand running ahead as a placement
  return true;
}

/** Where the hand is now. */
export function moveTarget(handId, point, yaw) {
  const h = hands.get(handId);
  if (!h || !point) return false;
  h.target = [point[0], point[1]];
  if (typeof yaw === 'number') h.yaw = yaw;
  const st = state.get(h.item);
  if (st) st.pushT = performance.now();
  return true;
}

/** Let go, with the hand's velocity: the piece slides and stops on friction. */
export function release(handId, velocity) {
  const h = hands.get(handId);
  if (!h) return false;
  const st = ensure(h.item);
  if (velocity) {
    const v = Math.min(MAX_V, Math.hypot(velocity[0], velocity[1]));
    const n = Math.hypot(velocity[0], velocity[1]) || 1;
    st.vx = (velocity[0] / n) * v;
    st.vy = (velocity[1] / n) * v;
    st.sliding = v > STOP;
  }
  hands.delete(handId);
  return true;
}

/** An open palm pushes whatever it touches. */
export function shove(point, velocity, radius = 0.35) {
  const w = window.walkin;
  if (!w || !physics.enabled) return 0;
  let n = 0;
  const speed = Math.min(MAX_V, Math.hypot(velocity[0], velocity[1]));
  for (const o of w.furniture.children) {
    if (!o.userData.kind || (FURNITURE[o.userData.kind] || {}).flat) continue;
    const d = Math.hypot(o.position.x - point[0], o.position.y - point[1]);
    if (d > radius + Math.max(FURNITURE[o.userData.kind].w, FURNITURE[o.userData.kind].d) / 2) continue;
    const st = ensure(o);
    const push = (speed * 12) / mass(o.userData.kind);    // a light chair skates, a sofa barely shifts
    const len = Math.hypot(velocity[0], velocity[1]) || 1;
    st.vx += (velocity[0] / len) * push;
    st.vy += (velocity[1] / len) * push;
    st.sliding = Math.hypot(st.vx, st.vy) > STOP;
    n++;
  }
  return n;
}

function ensure(item) {
  let st = state.get(item);
  if (!st) {
    st = { x: item.position.x, y: item.position.y, rot: item.rotation.z, vx: 0, vy: 0, still: 0, sliding: false };
    state.set(item, st);
  }
  return st;
}

// ------------------------------------------------------------------ the frame
let lastT = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const w = window.walkin;
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (!w || !w.furniture || !physics.enabled) return;
  stats.frames++;

  const live = new Set();
  for (const item of w.furniture.children) {
    if (!item.userData.kind) continue;
    live.add(item);
    const spec = FURNITURE[item.userData.kind];
    const st = ensure(item);
    if (spec.flat || item.userData.on) {                  // rugs and things on tables don't collide
      st.x = st.tx = item.position.x; st.y = st.ty = item.position.y; st.rot = st.trot = item.rotation.z;
      st.wroteX = st.x; st.wroteY = st.y; st.wroteRot = st.rot;
      continue;
    }
    const walls = wallsOf(item.userData.floor);

    // Whatever moved the piece this frame - mouse, hand, agent - is the target. It has to be remembered
    // rather than re-read, because this loop writes the constrained position back to the item: re-reading
    // it would make the target equal the current position the moment the user stops moving, and a piece
    // lagging behind by its mass would simply stay there. A mouse drag left a sofa 30 cm short of the drop.
    const held = [...hands.values()].find((h) => h.item === item);
    const movedOutside = st.wroteX === undefined
      || Math.abs(item.position.x - st.wroteX) > 1e-6 || Math.abs(item.position.y - st.wroteY) > 1e-6;
    if (held) {
      st.tx = held.target[0];
      st.ty = held.target[1];
      if (typeof held.yaw === 'number') st.trot = held.yaw;
    } else if (movedOutside) {
      st.tx = item.position.x;
      st.ty = item.position.y;
    }
    if (!held && Math.abs(item.rotation.z - (st.wroteRot === undefined ? item.rotation.z : st.wroteRot)) > 1e-6) {
      st.trot = item.rotation.z;
    }
    if (st.tx === undefined) { st.tx = item.position.x; st.ty = item.position.y; }
    if (st.trot === undefined) st.trot = item.rotation.z;
    const tx = st.tx, ty = st.ty, trot = st.trot;

    const jump = Math.hypot(tx - st.x, ty - st.y);
    const pushing = !!held || now - (st.pushT || 0) < SETTLED || now - (st.blockT || 0) < HOLD_BLOCK;
    if (jump > TELEPORT && !pushing) {                    // a placement, not a push: take it as given
      stats.teleports++;
      st.x = tx; st.y = ty; st.rot = trot; st.vx = st.vy = 0; st.sliding = false;
      item.position.x = st.x; item.position.y = st.y; item.rotation.z = st.rot;
      st.wroteX = st.x; st.wroteY = st.y; st.wroteRot = st.rot;
      continue;
    }

    if (jump > 1e-4 || trot !== st.rot) {
      st.pushT = now;
      // heavier pieces lag further behind the hand, but never by more than MAX_LAG
      let k = 1 - Math.exp(-dt / lagOf(item.userData.kind));
      if (jump * (1 - k) > MAX_LAG) k = 1 - MAX_LAG / jump;
      const nx = st.x + (tx - st.x) * k, ny = st.y + (ty - st.y) * k;
      const before = [st.x, st.y];
      const hit = step(item, st, nx, ny, trot, walls);
      stats.moved++;
      if (hit) { stats.blocked++; stats.lastHit = hit.kind; st.blockT = now; }
      st.vx = (st.x - before[0]) / dt;
      st.vy = (st.y - before[1]) / dt;
      st.sliding = false;
      if (hit && (hit.kind === 'wall' || hit.kind === 'overlapping' || hit.kind === 'rotate')) {
        // Help before complaining. A piece that would fit the way it is turned - or the way the user is
        // turning it - gets slid onto the doorway's centre line; only a real misfit gets the sentence.
        if (assistThroughDoor(item, st, walls, dt, tx - st.x, ty - st.y, trot)) stats.assisted++;
        else {
          const door = doorReason(item, st, walls);
          if (door) sayBlocked(item, { reason: door.text, door: door.door, across: door.across, turnable: door.turnable });
        }
      }
    } else if (st.sliding) {
      const v = Math.hypot(st.vx, st.vy);
      if (v < STOP) { st.sliding = false; st.vx = st.vy = 0; } else {
        const drop = Math.min(v, FRICTION * G * dt);      // friction takes the speed off
        const s = (v - drop) / v;
        st.vx *= s; st.vy *= s;
        const hit = step(item, st, st.x + st.vx * dt, st.y + st.vy * dt, st.rot, walls);
        if (hit) { st.vx *= 0.3; st.vy *= 0.3; }          // bumping something kills most of the speed
      }
    }
    item.position.x = st.x;
    item.position.y = st.y;
    item.rotation.z = st.rot;
    st.wroteX = st.x; st.wroteY = st.y; st.wroteRot = st.rot;
  }
  for (const item of state.keys()) if (!live.has(item)) state.delete(item);
}

(function start(tries = 0) {
  if (!window.walkin) {
    if (tries < 600) return setTimeout(() => start(tries + 1), 50);
    return;
  }
  if (new URLSearchParams(location.search).get('physics') === 'off') physics.enabled = false;
  window.walkin.physics = physics;
  // the wall list is per floor and cheap, but drop it when the house or floor changes
  let lastFloor = null;
  setInterval(() => {
    const f = window.walkin.current && window.walkin.current.floor;
    if (f !== lastFloor) { lastFloor = f; segCache = null; }
  }, 1000);
  frame();
})();
