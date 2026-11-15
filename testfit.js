// Test fit: how many people does this space seat, and what does that look like from inside?
//
// A broker's test fit is an architect's drawing of desks on a floor plan, and it takes days. Here you
// stand in the real empty floor, ask for 150 seats with 1.2 m aisles, and real-size desks flow into
// the room with every door kept clear - then you walk it. Zones by voice ("four 8-person meeting
// rooms on the back wall, a kitchen by the entrance") reserve their floor first and the desks fill
// the rest. The numbers a planner is paid to produce come with it: seats, the benching maximum, code
// occupancy, seats within 7.5 m of a window, and the longest walk to an exit.
//
// The usable floor comes from the defurnished MESH, not the room polygon. Suite 300's 1,461 m2 room
// arrives with a 22-vertex polygon that encloses 20 m2, while its wall graph and floor mesh both span
// 62 x 31 m. Rasterising the mesh - floor where a near-horizontal face sits at floor height, blocked
// where anything crosses 0.3-2.0 m above it - gives the right answer there and also catches columns,
// partitions and fixtures in every house, which polygons never did.
//
// Exposed as walkin.testFit / walkin.testFitZones / walkin.clearTestFit, and registered as voice tools
// on walkin.agent at load. Talks to the viewer only through window.walkin.
import * as THREE from 'three';
import { FURNITURE, buildFurniture, fitToSpec, load, shadowTexture } from './furniture.js';
import { footprint, DOOR_CLEAR } from './fit.js';

const CELL = 0.15;                 // raster cell, metres: a chair leg is bigger than this
const FLOOR_BAND = 0.12;           // a face this close to floorZ is floor
const BLOCK_LO = 0.30, BLOCK_HI = 2.0;   // anything crossing this band stands in the way of a desk
const DESK = FURNITURE.desk;       // 1.4 x 0.7 x 0.74
const CHAIR = FURNITURE.chair;     // 0.45 x 0.5 x 0.9
const CHAIR_ZONE = 0.6;            // floor behind a desk for the chair
const PULL_OUT = 0.3;              // and for pushing it back
const PITCH = DESK.w;              // desks along a row, touching
const CROSS_EVERY = 6;             // a cross aisle after this many desks
const CROSS_AISLE = 1.2;
const MIN_EXIT_W = 0.7;            // narrower than this is a duct or a cupboard, not a way out
const MIN_ASIDE = 1.0;             // free floor a bench block needs beside it, so corridors stay empty
const DRAW_CAP = 160;              // desks drawn when no headcount is asked for; the count is still the full one
const DAYLIGHT_M = 7.5;            // "near a window" for the daylight count (WELL / LEED use 7.5 m)
const EGRESS_SPRINKLERED = 91;     // IBC business occupancy: 300 ft travel distance with sprinklers (200 ft without)
const SQFT = 0.09290304;
const CODE_PER_PERSON = 150 * SQFT;    // IBC business occupancy, gross
const TYPICAL_PER_PERSON = 100 * SQFT; // what brokers quote

let group = null;                  // everything we drew
let lastFit = null;                // the last layout, for zones to rebuild on top of
let zones = [];                    // reserved rectangles in the row frame
let lastPeople = null;             // the headcount last asked for, so 'add meeting rooms' keeps it

const W = () => window.walkin;

// ------------------------------------------------------------------ the floor, from the mesh
/**
 * A grid over the whole floor of the mesh: 1 where a desk can stand (floor underneath, nothing in the way
 * up to head height), 0 elsewhere. Door-clear zones are cut out too, the same 0.8 m the sofa physics keeps.
 */
function floorGrid(w, floorZ) {
  const occ = w.occluderMesh;
  if (!occ) return null;
  const tris = [];
  occ.updateMatrixWorld(true);
  occ.traverse((m) => {
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.getIndex();
    const n = idx ? idx.count : pos.count;
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let i = 0; i < n; i += 3) {
      for (let k = 0; k < 3; k++) {
        const j = idx ? idx.getX(i + k) : i + k;
        v[k].fromBufferAttribute(pos, j).applyMatrix4(m.matrixWorld);
      }
      tris.push([v[0].x, v[0].y, v[0].z, v[1].x, v[1].y, v[1].z, v[2].x, v[2].y, v[2].z]);
    }
  });
  if (!tris.length) return null;

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of tris) {
    for (let k = 0; k < 9; k += 3) {
      if (Math.abs(t[k + 2] - floorZ) < 3.5) {                       // this storey only
        x0 = Math.min(x0, t[k]); x1 = Math.max(x1, t[k]); y0 = Math.min(y0, t[k + 1]); y1 = Math.max(y1, t[k + 1]);
      }
    }
  }
  const nx = Math.ceil((x1 - x0) / CELL) + 2, ny = Math.ceil((y1 - y0) / CELL) + 2;
  const floor = new Uint8Array(nx * ny), block = new Uint8Array(nx * ny);
  const at = (ix, iy) => iy * nx + ix;

  // paint each triangle's footprint into whichever layer its height says
  for (const t of tris) {
    const zs = [t[2], t[5], t[8]];
    const zmin = Math.min(...zs) - floorZ, zmax = Math.max(...zs) - floorZ;
    let layer = null;
    if (zmax < FLOOR_BAND && zmin > -FLOOR_BAND) layer = floor;
    else if (zmax > BLOCK_LO && zmin < BLOCK_HI) layer = block;
    if (!layer) continue;
    const ax = t[0], ay = t[1], bx = t[3], by = t[4], cx = t[6], cy = t[7];
    const minx = Math.floor((Math.min(ax, bx, cx) - x0) / CELL), maxx = Math.ceil((Math.max(ax, bx, cx) - x0) / CELL);
    const miny = Math.floor((Math.min(ay, by, cy) - y0) / CELL), maxy = Math.ceil((Math.max(ay, by, cy) - y0) / CELL);
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (layer === block) {
      // A wall face is near-vertical, so in plan it is a sliver a few millimetres wide that no cell
      // centre ever lands in: the barycentric test below never marks it, the wall never reaches
      // `block`, and the floor on both sides joins up - desks standing across walls (Amit, #133,
      // measured: 234 of 692 wall samples on La Mirada sat on "free" floor). Stamp the cells under
      // each edge instead; that is what a wall is in plan.
      for (const [px, py, qx, qy] of [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]) {
        const steps = Math.max(1, Math.ceil(Math.hypot(qx - px, qy - py) / (CELL / 2)));
        for (let k = 0; k <= steps; k++) {
          const ix = Math.floor((px + (qx - px) * k / steps - x0) / CELL), iy = Math.floor((py + (qy - py) * k / steps - y0) / CELL);
          if (ix >= 0 && iy >= 0 && ix < nx && iy < ny) block[at(ix, iy)] = 1;
        }
      }
      if (Math.abs(det) < 1e-9) continue;
    } else if (Math.abs(det) < 1e-9) {
      continue;                                                      // a degenerate floor face holds no floor
    }
    for (let ix = Math.max(0, minx); ix <= Math.min(nx - 1, maxx); ix++) {
      for (let iy = Math.max(0, miny); iy <= Math.min(ny - 1, maxy); iy++) {
        const px = x0 + (ix + 0.5) * CELL, py = y0 + (iy + 0.5) * CELL;
        const l1 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / det;
        const l2 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / det;
        const l3 = 1 - l1 - l2;
        const e = -0.08;                                             // a little slack so edges count
        if (l1 >= e && l2 >= e && l3 >= e) layer[at(ix, iy)] = 1;
      }
    }
  }
  // grow the blockers by one cell: a wall's projection is a line, and a desk should not kiss it
  const grown = new Uint8Array(block);
  for (let iy = 1; iy < ny - 1; iy++) for (let ix = 1; ix < nx - 1; ix++) {
    if (!block[at(ix, iy)]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) grown[at(ix + dx, iy + dy)] = 1;
  }
  // The API's wall graph is stamped in as well. The defurnished mesh loses some partitions along with
  // the furniture - on Suite 300, 91 of 2,655 wall samples still sat on free floor with the mesh alone -
  // and the graph knows where every wall is. Doorway spans are left open so the egress walk can use them.
  for (const f of w.house.floors || []) {
    if (currentFloor(w) && f.id && f.id !== currentFloor(w)) continue;
    for (const wall of f.walls || []) {
      const [ax, ay] = wall.a, [bx, by] = wall.b;
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 0.05) continue;
      const doors = (wall.openings || []).filter((o) => !/window/i.test(o.type || '')).map((o) => {
        const t = o.at == null ? 0.5 : o.at, hw = ((o.width || 0.9) / 2 + 0.05) / L;
        return [t - hw, t + hw];
      });
      const half = Math.max(CELL, (wall.thickness || 0.1) / 2 + CELL / 2);
      const nxw = -(by - ay) / L, nyw = (bx - ax) / L;
      for (let d = 0; d <= L; d += CELL / 2) {
        const t = d / L;
        if (doors.some(([t0, t1]) => t >= t0 && t <= t1)) continue;
        for (let o = -half; o <= half; o += CELL / 2) {
          const ix = Math.floor((ax + (bx - ax) * t + nxw * o - x0) / CELL), iy = Math.floor((ay + (by - ay) * t + nyw * o - y0) / CELL);
          if (ix >= 0 && iy >= 0 && ix < nx && iy < ny) grown[at(ix, iy)] = 1;
        }
      }
    }
  }

  const free = new Uint8Array(nx * ny);
  let freeCount = 0;
  for (let i = 0; i < free.length; i++) if (floor[i] && !grown[i]) { free[i] = 1; freeCount++; }

  const g = { x0, y0, nx, ny, at, free, floor, block: grown, freeCount,
    cell: (x, y) => [Math.floor((x - x0) / CELL), Math.floor((y - y0) / CELL)],
    isFree(x, y) { const [ix, iy] = this.cell(x, y); return ix >= 0 && iy >= 0 && ix < nx && iy < ny && !!free[at(ix, iy)]; } };

  // doors: keep the floor in front of every doorway clear on both sides
  for (const d of doorways(w)) {
    for (const s of [1, -1]) {
      const hw = d.width / 2 + 0.05;
      const poly = [
        [d.cx - d.ux * hw, d.cy - d.uy * hw], [d.cx + d.ux * hw, d.cy + d.uy * hw],
        [d.cx + d.ux * hw + d.nx * s * DOOR_CLEAR, d.cy + d.uy * hw + d.ny * s * DOOR_CLEAR],
        [d.cx - d.ux * hw + d.nx * s * DOOR_CLEAR, d.cy - d.uy * hw + d.ny * s * DOOR_CLEAR]];
      fillPoly(g, poly, (i) => { if (free[i]) { free[i] = 0; g.freeCount--; } });
    }
  }
  return g;
}

function fillPoly(g, poly, fn) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const [ix0, iy0] = g.cell(Math.min(...xs), Math.min(...ys)), [ix1, iy1] = g.cell(Math.max(...xs), Math.max(...ys));
  for (let iy = Math.max(0, iy0); iy <= Math.min(g.ny - 1, iy1); iy++) {
    for (let ix = Math.max(0, ix0); ix <= Math.min(g.nx - 1, ix1); ix++) {
      if (pointIn(g.x0 + (ix + 0.5) * CELL, g.y0 + (iy + 0.5) * CELL, poly)) fn(g.at(ix, iy));
    }
  }
}

function pointIn(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Every opening on this floor, straight from the walls: no room polygon needed. */
function wallOpenings(w, floorId) {
  const out = [];
  for (const f of w.house.floors || []) {
    if (floorId && f.id && f.id !== floorId) continue;
    for (const wall of f.walls || []) {
      const [ax, ay] = wall.a, [bx, by] = wall.b;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      for (const o of wall.openings || []) {
        const t = o.at == null ? 0.5 : o.at;
        out.push({ type: /window/i.test(o.type || '') ? 'window' : 'door', cx: ax + ux * t * len, cy: ay + uy * t * len,
          ux, uy, nx: -uy, ny: ux, width: o.width || 0.9, height: o.height || 2, bottom: o.bottom || 0, wall, len });
      }
    }
  }
  return out;
}
const doorways = (w) => wallOpenings(w, currentFloor(w)).filter((o) => o.type === 'door');
const windows = (w) => wallOpenings(w, currentFloor(w)).filter((o) => o.type === 'window');
const currentFloor = (w) => (w.current && w.current.floor) || null;

// ------------------------------------------------------------------ the row frame
/** Rows run along the longest wall that has windows on it; failing that, the longest wall. */
function rowDirection(w) {
  let best = null;
  for (const f of w.house.floors || []) {
    if (currentFloor(w) && f.id && f.id !== currentFloor(w)) continue;
    for (const wall of f.walls || []) {
      const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
      const wins = (wall.openings || []).filter((o) => /window/i.test(o.type || '')).length;
      const score = len * (wins ? 3 : 1);
      if (!best || score > best.score) best = { score, ang: Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]) };
    }
  }
  return best ? best.ang : 0;
}

/** A workstation is a desk plus the floor its chair needs; its rectangle in the row frame. */
function stationRect(u, v, facing) {
  // facing +1: the desk's front (where the chair sits) points to +v
  const deskNear = v - DESK.d / 2 * facing, deskFar = v + DESK.d / 2 * facing;
  const chairFar = deskFar + (CHAIR_ZONE + PULL_OUT) * facing;
  return { u0: u - DESK.w / 2, u1: u + DESK.w / 2, v0: Math.min(deskNear, chairFar), v1: Math.max(deskNear, chairFar) };
}

/** Is this rectangle in the row frame entirely on free floor? Sampled every half cell. */
function rectFree(g, frame, r) {
  const step = CELL / 2;
  for (let u = r.u0; u <= r.u1 + 1e-6; u += step) {
    for (let v = r.v0; v <= r.v1 + 1e-6; v += step) {
      const [x, y] = frame.toWorld(u, v);
      if (!g.isFree(x, y)) return false;
    }
  }
  return true;
}

function makeFrame(ang, ox, oy) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { ang, c, s, ox, oy,
    toWorld: (u, v) => [ox + u * c - v * s, oy + u * s + v * c],
    toLocal: (x, y) => [(x - ox) * c + (y - oy) * s, -(x - ox) * s + (y - oy) * c] };
}

// ------------------------------------------------------------------ the layout
/**
 * Benching: pairs of desks back to back, chairs outward, an aisle between every pair of rows, a cross aisle
 * every few desks. Greedy, cell by cell, so a column or a reserved zone just leaves a gap.
 */
function layoutDesks(g, frame, aisle, extraBlocked) {
  // extent of the free floor in the row frame
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let iy = 0; iy < g.ny; iy++) for (let ix = 0; ix < g.nx; ix++) {
    if (!g.free[g.at(ix, iy)]) continue;
    const [u, v] = frame.toLocal(g.x0 + (ix + 0.5) * CELL, g.y0 + (iy + 0.5) * CELL);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  if (!isFinite(u0)) return [];
  const isFree = (r) => rectFree(g, frame, r) && !extraBlocked.some((z) => !(r.u1 <= z.u0 || z.u1 <= r.u0 || r.v1 <= z.v0 || z.v1 <= r.v0));

  const half = DESK.d + CHAIR_ZONE + PULL_OUT;        // one side of a back-to-back pair, from the shared back line
  const stations = [];
  let v = v0 + half + 0.1;
  while (v + half <= v1 + 1e-6) {
    let placedInBlock = 0;
    let u = u0 + DESK.w / 2 + 0.1, n = 0;
    while (u + DESK.w / 2 <= u1 + 1e-6) {
      // an aisle's width of free floor on at least one side of the block, or this is a corridor and a
      // desk does not belong in it however well the rectangle fits
      const beside = isFree({ u0: u - DESK.w / 2, u1: u + DESK.w / 2, v0: v + half, v1: v + half + MIN_ASIDE })
                  || isFree({ u0: u - DESK.w / 2, u1: u + DESK.w / 2, v0: v - half - MIN_ASIDE, v1: v - half });
      for (const facing of beside ? [-1, 1] : []) {    // the pair: one desk faces -v, the other +v
        const centre = v + (DESK.d / 2) * facing;
        const r = stationRect(u, centre, facing);
        if (isFree(r)) { stations.push({ u, v: centre, facing, rect: r }); placedInBlock++; }
      }
      n++;
      u += PITCH + (n % CROSS_EVERY === 0 ? CROSS_AISLE : 0);
    }
    v += 2 * half + aisle;
    if (!placedInBlock) v -= (2 * half + aisle) - CELL * 2;  // nothing fit on this line: creep forward instead
  }
  return stations;
}

// ------------------------------------------------------------------ daylight and egress
function nearestWindow(wins, x, y) {
  let best = Infinity;
  for (const o of wins) best = Math.min(best, Math.hypot(o.cx - x, o.cy - y));
  return best;
}

/** Distance over the free floor from each cell to the nearest exit door: a BFS from every exit at once. */
function egressField(g, exits, blockedRects, frame) {
  const dist = new Float32Array(g.nx * g.ny).fill(Infinity);
  const walk = new Uint8Array(g.free);
  for (const r of blockedRects) {                     // desks are in the way of a walk
    for (let u = r.u0; u <= r.u1; u += CELL / 2) for (let v = r.v0; v <= r.v1; v += CELL / 2) {
      const [x, y] = frame.toWorld(u, v); const [ix, iy] = g.cell(x, y);
      if (ix >= 0 && iy >= 0 && ix < g.nx && iy < g.ny) walk[g.at(ix, iy)] = 0;
    }
  }
  const q = [];
  for (const e of exits) {
    const [ix, iy] = g.cell(e.x, e.y);
    // seed the nearest free cell within half a metre, so a sill does not lose the exit
    let seeded = false;
    for (let r = 0; r <= 4 && !seeded; r++) for (let dy = -r; dy <= r && !seeded; dy++) for (let dx = -r; dx <= r && !seeded; dx++) {
      const jx = ix + dx, jy = iy + dy;
      if (jx < 0 || jy < 0 || jx >= g.nx || jy >= g.ny || !g.free[g.at(jx, jy)]) continue;
      dist[g.at(jx, jy)] = 0; q.push([jx, jy]); seeded = true;
    }
  }
  let head = 0;
  while (head < q.length) {
    const [ix, iy] = q[head++]; const d = dist[g.at(ix, iy)];
    for (const [dx, dy, c] of [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, -1, Math.SQRT2]]) {
      const jx = ix + dx, jy = iy + dy;
      if (jx < 0 || jy < 0 || jx >= g.nx || jy >= g.ny) continue;
      const j = g.at(jx, jy);
      if (!walk[j] && !g.free[j]) continue;             // may cross a desk cell? no: desks block
      if (!walk[j]) continue;
      if (dist[j] <= d + c * CELL) continue;
      dist[j] = d + c * CELL; q.push([jx, jy]);
    }
  }
  return dist;
}

/**
 * Which doors are exits. A door with no floor beyond it leads out of what was scanned. In a suite the
 * scan usually runs on into the building's corridor, so the better tell is that the far side is a
 * corridor: free floor only a couple of metres wide, where the near side is a room. Failing both,
 * the two widest doors - entrances are cut wider than the doors between offices.
 */
function exitDoors(g, w) {
  const out = [];
  const floorAt = (x, y) => { const [ix, iy] = g.cell(x, y); return ix >= 0 && iy >= 0 && ix < g.nx && iy < g.ny && !!g.floor[g.at(ix, iy)]; };
  // free span along the wall direction, measured `k` metres past the door on side `s`
  const spanAt = (d, s, k) => {
    const px = d.cx + d.nx * s * k, py = d.cy + d.ny * s * k;
    let a = 0, b = 0;
    for (let t = 0; t < 6; t += CELL) { if (!g.isFree(px + d.ux * t, py + d.uy * t)) break; a = t; }
    for (let t = 0; t < 6; t += CELL) { if (!g.isFree(px - d.ux * t, py - d.uy * t)) break; b = t; }
    return a + b;
  };
  // free run straight out from the door on side `s`
  const runAt = (d, s) => { let r = 0; for (let t = 0.3; t < 8; t += CELL) { if (!g.isFree(d.cx + d.nx * s * t, d.cy + d.ny * s * t)) break; r = t; } return r; };
  // A corridor is narrow one way and long the other: it either runs along the wall (wide span, short
  // run) or away from the door (narrow span, long run). A 2.5 x 4 m private office or a WC fails both,
  // which matters: with span alone their doors counted as exits and shortened the longest walk (Amit).
  const isCorridor = (d, s) => {
    const span = Math.min(spanAt(d, s, 1.5), spanAt(d, s, 2.5)), run = runAt(d, s);
    return (spanAt(d, s, 1.5) >= 5 && run < 3) || (span < 3 && run >= 5);
  };
  const all = doorways(w).filter((d) => d.width >= MIN_EXIT_W).map((d) => {
    const floor = [1, -1].map((s) => [0.4, 0.7, 1.0].filter((k) => floorAt(d.cx + d.nx * s * k, d.cy + d.ny * s * k)).length);
    const span = [1, -1].map((s) => Math.min(spanAt(d, s, 1.5), spanAt(d, s, 2.5)));
    const corridor = [1, -1].map((s) => isCorridor(d, s));
    return { d, floor, span, corridor };
  });
  for (const { d, floor, span, corridor } of all) {
    let inside = null;
    if ((floor[0] === 0) !== (floor[1] === 0)) inside = floor[0] ? 1 : -1;               // nothing beyond
    else if (corridor[0] && !corridor[1]) inside = -1;                                      // corridor on side +1
    else if (corridor[1] && !corridor[0]) inside = 1;
    if (inside) out.push({ x: d.cx + d.nx * inside * 0.4, y: d.cy + d.ny * inside * 0.4, width: d.width, door: d, why: floor[0] === 0 || floor[1] === 0 ? 'edge of scan' : 'corridor' });
  }
  if (!out.length) {
    for (const { d, span } of all.slice().sort((a, b) => b.d.width - a.d.width).slice(0, 2)) {
      const inside = span[0] >= span[1] ? 1 : -1;
      out.push({ x: d.cx + d.nx * inside * 0.4, y: d.cy + d.ny * inside * 0.4, width: d.width, door: d, why: 'widest door' });
    }
  }
  return out;
}

// ------------------------------------------------------------------ drawing
//
// The kit's desk and chair are low-poly with one flat colour each, and 150 of them read as Lego.
// What makes a desk read as a desk from across a floor is not polygons: it is wood grain that
// catches the environment light, a monitor and keyboard on top, a soft shadow underneath, and
// chairs that are not all parked at exactly the same angle. All of that is done here with
// procedural textures and instanced boxes - no new assets, nothing to download at the venue.

let woodTex = null, screenTex = null;
function wood() {
  if (woodTex) return woodTex;
  const c = document.createElement('canvas'); c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#b8905f'; g.fillRect(0, 0, 512, 512);
  // grain: long wobbling streaks in three browns, denser towards one edge like a sawn board
  for (let i = 0; i < 260; i++) {
    const y = (i / 260) * 512 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * 6;
    const tone = ['#a97d4f', '#c29b6c', '#9c7047', '#b5895a'][i % 4];
    g.strokeStyle = tone; g.globalAlpha = 0.22 + 0.25 * Math.abs(Math.sin(i * 0.7));
    g.lineWidth = 0.6 + 2.2 * Math.abs(Math.sin(i * 1.3));
    g.beginPath();
    for (let x = 0; x <= 512; x += 16) g.lineTo(x, y + Math.sin(x / 61 + i) * 2.4 + Math.sin(x / 17 + i * 3) * 0.7);
    g.stroke();
  }
  g.globalAlpha = 1;
  woodTex = new THREE.CanvasTexture(c);
  woodTex.colorSpace = THREE.SRGBColorSpace;
  woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
  woodTex.anisotropy = 8;
  return woodTex;
}
function screen() {
  if (screenTex) return screenTex;
  const c = document.createElement('canvas'); c.width = 256; c.height = 160;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 160);
  grad.addColorStop(0, '#2a3340'); grad.addColorStop(1, '#141a22');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 160);
  g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(18, 20, 150, 110);   // a window, dimly
  g.fillStyle = 'rgba(255,255,255,0.16)'; g.fillRect(18, 20, 150, 12);
  g.fillStyle = 'rgba(120,170,255,0.25)'; g.fillRect(180, 20, 58, 110);
  screenTex = new THREE.CanvasTexture(c);
  screenTex.colorSpace = THREE.SRGBColorSpace;
  return screenTex;
}

/** Box-project UVs in metres onto a geometry, so a wood texture lands as grain and not as one swatch. */
function boxUV(geometry, metresPerRepeat = 0.7, scale = new THREE.Vector3(1, 1, 1)) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i).multiply(scale); b.fromBufferAttribute(pos, i + 1).multiply(scale); c.fromBufferAttribute(pos, i + 2).multiply(scale);
    n.subVectors(b, a).cross(c.clone().sub(a));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const v = [a, b, c][k];
      let u, w;
      if (ay >= ax && ay >= az) { u = v.x; w = v.z; }          // the top: grain runs along the desk
      else if (ax >= az) { u = v.z; w = v.y; } else { u = v.x; w = v.y; }
      uv[(i + k) * 2] = u / metresPerRepeat; uv[(i + k) * 2 + 1] = w / metresPerRepeat;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Nicer materials for the kit's office pieces: real-looking wood, dark metal, matte fabric, all env-lit. */
function dressed(mesh, kind) {
  const name = (mesh.material.name || '');
  const shared = (m) => { m.userData.sharedMap = true; return m; };
  if (kind === 'desk') {
    if (/metal/.test(name)) return { geometry: mesh.geometry, material: new THREE.MeshStandardMaterial({ color: 0x3a3a3f, metalness: 0.85, roughness: 0.35 }) };
    // UVs in world metres: fitToSpec has already scaled this clone (desk.glb is 0.73 wide -> 1.4 m), so
    // the projection has to use the world scale or one wood repeat comes out ~1.3 m instead of 0.7 (Amit)
    return { geometry: boxUV(mesh.geometry, 0.7, mesh.getWorldScale(new THREE.Vector3())),
             material: shared(new THREE.MeshStandardMaterial({ map: wood(), color: 0xffffff, roughness: 0.55, metalness: 0, envMapIntensity: 0.9 })) };
  }
  if (/fabric/.test(name)) return { geometry: mesh.geometry, material: new THREE.MeshStandardMaterial({ color: 0x33343a, roughness: 0.95, metalness: 0 }) };
  return { geometry: mesh.geometry, material: new THREE.MeshStandardMaterial({ color: 0x1e1f23, metalness: 0.75, roughness: 0.4 }) };
}

async function instanced(kind, poses, floorZ) {
  const spec = FURNITURE[kind];
  const src = await load(spec.model);
  const proto = src ? fitToSpec(src.clone(true), spec, false, undefined, false)
                    : new THREE.Mesh(new THREE.BoxGeometry(spec.w, spec.d, spec.h).translate(0, 0, spec.h / 2), new THREE.MeshStandardMaterial({ color: 0x9a8f80 }));
  proto.updateMatrixWorld(true);
  const parts = [];
  proto.traverse((m) => { if (m.isMesh) parts.push(m); });
  const out = new THREE.Group();
  const M = new THREE.Matrix4(), P = new THREE.Matrix4();
  for (const m of parts) {
    const d = dressed(m, kind);
    const im = new THREE.InstancedMesh(d.geometry, d.material, poses.length);
    im.renderOrder = 2;
    im.frustumCulled = false;
    im.userData.ownGeo = d.geometry !== m.geometry;      // box-projected copies are ours to dispose; shared ones are not
    im.userData.ownMat = true;                            // every dressed material is ours, whatever geometry it sits on
    for (let i = 0; i < poses.length; i++) {
      const p = poses[i];
      P.makeRotationZ(p.rot).setPosition(p.x, p.y, floorZ);
      M.multiplyMatrices(P, m.matrixWorld);
      im.setMatrixAt(i, M);
    }
    im.instanceMatrix.needsUpdate = true;
    out.add(im);
  }
  return out;
}

/** What sits on a desk: a monitor on a stand, a keyboard, a mouse. Boxes, instanced per desk. */
function deskTop(poses, floorZ) {
  const H = DESK.h;
  const parts = [
    { geo: new THREE.BoxGeometry(0.22, 0.17, 0.012).translate(0, 0.14, H + 0.006), mat: new THREE.MeshStandardMaterial({ color: 0x202226, metalness: 0.6, roughness: 0.4 }) },   // stand base
    { geo: new THREE.BoxGeometry(0.035, 0.035, 0.26).translate(0, 0.19, H + 0.13), mat: new THREE.MeshStandardMaterial({ color: 0x202226, metalness: 0.6, roughness: 0.4 }) },    // neck
    { geo: new THREE.BoxGeometry(0.56, 0.028, 0.33).translate(0, 0.19, H + 0.31).applyMatrix4(new THREE.Matrix4().makeRotationX(-0.09)), mat: new THREE.MeshStandardMaterial({ color: 0x0f1013, roughness: 0.5 }) }, // bezel
    { geo: new THREE.PlaneGeometry(0.52, 0.29).applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2 - 0.09)).translate(0, 0.174, H + 0.31), mat: Object.assign(new THREE.MeshStandardMaterial({ map: screen(), emissive: 0x9fb4d0, emissiveMap: screen(), emissiveIntensity: 0.55, roughness: 0.25 }), { userData: { sharedMap: true } }) }, // screen
    { geo: new THREE.BoxGeometry(0.42, 0.14, 0.018).translate(0, -0.1, H + 0.009), mat: new THREE.MeshStandardMaterial({ color: 0x2b2d33, roughness: 0.8 }) },   // keyboard
    { geo: new THREE.BoxGeometry(0.06, 0.1, 0.03).translate(0.3, -0.1, H + 0.015), mat: new THREE.MeshStandardMaterial({ color: 0x2b2d33, roughness: 0.6 }) },    // mouse
  ];
  const out = new THREE.Group();
  const M = new THREE.Matrix4();
  for (const p of parts) {
    const im = new THREE.InstancedMesh(p.geo, p.mat, poses.length);
    im.renderOrder = 2; im.frustumCulled = false; im.userData.ours = true;
    for (let i = 0; i < poses.length; i++) { M.makeRotationZ(poses[i].rot).setPosition(poses[i].x, poses[i].y, floorZ); im.setMatrixAt(i, M); }
    im.instanceMatrix.needsUpdate = true;
    out.add(im);
  }
  return out;
}

/** A soft contact shadow under each station, the same blob the catalog furniture uses. */
function shadows(poses, floorZ) {
  const geo = new THREE.PlaneGeometry(DESK.w + 0.5, DESK.d + CHAIR_ZONE + 0.5).translate(0, -0.3, 0);
  const mat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, opacity: 0.42, depthWrite: false });
  mat.userData.sharedMap = true;                                  // furniture.js owns that texture
  const im = new THREE.InstancedMesh(geo, mat, poses.length);
  im.renderOrder = 1; im.frustumCulled = false; im.userData.ours = true;
  const M = new THREE.Matrix4();
  for (let i = 0; i < poses.length; i++) { M.makeRotationZ(poses[i].rot).setPosition(poses[i].x, poses[i].y, floorZ + 0.012); im.setMatrixAt(i, M); }
  im.instanceMatrix.needsUpdate = true;
  return im;
}

function ribbon(points, floorZ, color, width = 0.25) {
  const shape = [];
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    const [nx, ny] = (() => {
      const [px, py] = points[Math.max(0, i - 1)], [qx, qy] = points[Math.min(points.length - 1, i + 1)];
      const dx = qx - px, dy = qy - py, l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l];
    })();
    shape.push(x + nx * width / 2, y + ny * width / 2, floorZ + 0.03, x - nx * width / 2, y - ny * width / 2, floorZ + 0.03);
  }
  const idx = [];
  for (let i = 0; i < points.length - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(shape, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
  mesh.renderOrder = 1; mesh.userData.ours = true;
  return mesh;
}

function label(text, x, y, z, scale = 1.2) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(20,20,24,0.78)'; ctx.fillRect(0, 0, 1024, 256);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // shrink to fit: "8-seat meeting room 2" is longer than the canvas at the size that reads from afar
  let px = 108;
  do { ctx.font = `bold ${px}px -apple-system, Helvetica, Arial`; px -= 6; } while (ctx.measureText(text).width > 980 && px > 40);
  ctx.fillText(text, 512, 128);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(scale, scale / 4, 1); sp.position.set(x, y, z); sp.renderOrder = 20; sp.userData.ours = true;
  return sp;
}

function ensureGroup(w) {
  if (!group) { group = new THREE.Group(); group.name = 'testfit'; w.scene.add(group); }
  return group;
}

export function clearTestFit() {
  if (group) {
    // Only what we made ourselves is disposed. The instanced desks and chairs share their geometry and
    // materials with the GLB cached by furniture.js's load(); disposing those would make the next real
    // desk re-upload them (Amit, #133).
    disposeOurs(group);
    if (group.parent) group.parent.remove(group);
    group = null;
  }
  lastFit = null; zones = []; lastPeople = null;
  hud(null);
  return { ok: true, say: 'Cleared the test fit.' };
}

function hud(text) {
  let el = document.getElementById('testfitHud');
  if (!text) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div'); el.id = 'testfitHud';
    Object.assign(el.style, { position: 'fixed', left: '16px', bottom: '72px', maxWidth: '46vw', padding: '10px 14px', borderRadius: '12px',
      background: 'rgba(20,20,24,0.72)', color: '#fff', font: '14px/1.4 -apple-system, Helvetica, Arial', backdropFilter: 'blur(8px)', zIndex: 30, whiteSpace: 'pre-line' });
    document.body.appendChild(el);
    // the headset has no room for a card: John's voice is the HUD there
    if (!document.getElementById('testfitHudStyle')) {
      const st = document.createElement('style'); st.id = 'testfitHudStyle';
      st.textContent = 'body.vr #testfitHud { display: none; }';
      document.head.appendChild(st);
    }
  }
  el.textContent = text;
}

// ------------------------------------------------------------------ the public API
/**
 * Lay the floor out with desks. `people` caps the seats (the ones nearest a window are kept); `aisle` is the
 * clear width between rows. Zones asked for earlier are kept out of the way.
 */
export async function testFit({ people = null, aisle = 1.2 } = {}) {
  const w = W();
  if (people) lastPeople = people;
  if (!w || !w.house || !w.current) return { ok: false, say: 'the viewer is not ready' };
  // The 50k-face mesh arrives a few seconds after the panos; a question asked before that should
  // wait for it, not fail.
  for (let i = 0; i < 60 && !w.occluderMesh; i++) await new Promise((r) => setTimeout(r, 250));
  if (!w.occluderMesh) return { ok: false, say: 'this space has no mesh yet, so I cannot see its floor' };
  const t0 = performance.now();
  const floorZ = w.current.floorZ ?? 0;
  const g = floorGrid(w, floorZ);
  if (!g || !g.freeCount) return { ok: false, say: 'I could not find any usable floor in the mesh' };

  const ang = rowDirection(w);
  const frame = makeFrame(ang, 0, 0);
  const wins = windows(w);
  let stations = layoutDesks(g, frame, aisle, zones);
  const benching = stations.length;
  for (const s of stations) { const [x, y] = frame.toWorld(s.u, s.v); s.x = x; s.y = y; s.rot = ang + (s.facing > 0 ? Math.PI : 0); s.window = nearestWindow(wins, x, y); }
  stations.sort((a, b) => a.window - b.window);        // daylight first: the seats nearest a window come first
  if (people && people < stations.length) stations = stations.slice(0, people);
  // Nobody asked for a number: say how many fit, but draw only the window-side DRAW_CAP. All 331 cost
  // 6.4 ms of GPU fill on the laptop against 3.7 for 150, and a phone in stereo cannot carry that.
  const drawn = people ? stations : stations.slice(0, DRAW_CAP);

  const exits = exitDoors(g, w);
  const field = egressField(g, exits, stations.map((s) => s.rect), frame);
  let worst = null;
  for (const s of stations) {
    const [cx, cy] = frame.toWorld(s.u, s.v + (CHAIR_ZONE + DESK.d / 2 + 0.1) * s.facing);
    let d = Infinity;                                   // read the field at the chair, nearest reachable cell
    const [ix, iy] = g.cell(cx, cy);
    for (let r = 0; r <= 3 && !isFinite(d); r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const jx = ix + dx, jy = iy + dy; if (jx < 0 || jy < 0 || jx >= g.nx || jy >= g.ny) continue;
      d = Math.min(d, field[g.at(jx, jy)]);
    }
    s.toExit = d; s.chair = [cx, cy];
    if (isFinite(d) && (!worst || d > worst.toExit)) worst = s;
  }

  // draw
  clearGroup();
  const grp = ensureGroup(w);
  const deskPoses = drawn.map((s) => ({ x: s.x, y: s.y, rot: s.rot }));
  const chairPoses = drawn.map((s, i) => {
    // nobody parks a chair square: a few degrees and a few centimetres, fixed per seat so it does not jitter between runs
    const j1 = Math.sin(i * 12.9898) * 43758.5453, j2 = Math.sin(i * 78.233) * 43758.5453;
    const dj = (j1 - Math.floor(j1)) - 0.5, du = (j2 - Math.floor(j2)) - 0.5;
    const [cx, cy] = frame.toWorld(s.u + du * 0.08, s.v + (DESK.d / 2 + CHAIR.d / 2 + 0.05 + Math.abs(dj) * 0.12) * s.facing);
    return { x: cx, y: cy, rot: s.rot + Math.PI + dj * 0.35 };
  });
  grp.add(shadows(deskPoses, floorZ));
  grp.add(await instanced('desk', deskPoses, floorZ));
  grp.add(deskTop(deskPoses, floorZ));
  grp.add(await instanced('chair', chairPoses, floorZ));
  for (const z of zones) grp.add(z.draw(frame, floorZ));
  if (worst) grp.add(ribbon(tracePath(g, field, worst.chair), floorZ, 0x3cb371));

  const area = g.freeCount * CELL * CELL;
  const near = stations.filter((s) => s.window <= DAYLIGHT_M).length;
  const lit = isFinite(worst?.toExit) ? worst.toExit : null;
  lastFit = { stations, g, frame, exits, floorZ, aisle, worst };
  w.testFitLast = lastFit;                               // read-only: where the desks and exits are
  const say = `${stations.length} seats${people && benching > people ? ` (room for ${benching} at benching density)` : ''}, ` +
    `${near} of them within ${DAYLIGHT_M} m of a window. ${Math.round(area)} m² of usable floor: ` +
    `${Math.floor(area / CODE_PER_PERSON)} people by code at 150 square feet each, ${Math.floor(area / TYPICAL_PER_PERSON)} at 100. ` +
    (lit != null ? `Longest walk to an exit ${lit.toFixed(0)} m through ${exits.length} exit${exits.length === 1 ? '' : 's'} - ` +
      (lit <= EGRESS_SPRINKLERED ? `inside the ${EGRESS_SPRINKLERED} m limit for a sprinklered office.` : `over the ${EGRESS_SPRINKLERED} m limit for a sprinklered office, so that corner needs a second exit.`) : '');
  const exitWhy = exits.map((e) => `${e.width.toFixed(2)} m (${e.why})`).join(', ');
  hud(`Test fit · ${stations.length} seats${drawn.length < stations.length ? ` (showing ${drawn.length})` : ''} · aisles ${aisle} m\n${near} within ${DAYLIGHT_M} m of a window · ${wins.length} windows\n${Math.round(area)} m² usable · code ${Math.floor(area / CODE_PER_PERSON)} · typical ${Math.floor(area / TYPICAL_PER_PERSON)}` +
    (lit != null ? `\nlongest walk to exit ${lit.toFixed(0)} m` : '') + (zones.length ? `\n${zones.length} zone${zones.length === 1 ? '' : 's'}: ${zones.map((z) => z.name).join(', ')}` : ''));
  return { ok: true, ms: Math.round(performance.now() - t0), seats: stations.length, drawn: drawn.length, benching_max: benching, near_window: near,
    usable_m2: Math.round(area), code_occupancy: Math.floor(area / CODE_PER_PERSON), typical_occupancy: Math.floor(area / TYPICAL_PER_PERSON),
    windows: wins.length, exits: exits.length, exit_doors: exitWhy, longest_walk_to_exit_m: lit == null ? null : Math.round(lit), aisle_m: aisle, say };
}

/** Let go of everything this file made, and nothing it borrowed from the GLB cache. */
function disposeOurs(root) {
  root.traverse((o) => {
    if (o.isInstancedMesh) o.dispose();                           // the instance buffers, not the shared geometry
    const own = o.userData;
    if (own.ours || own.ownGeo) o.geometry && o.geometry.dispose();
    if (own.ours || own.ownMat) {
      for (const m of [].concat(o.material || [])) {
        // wood(), screen() and the catalog's shadow blob are shared textures: freeing them here only
        // makes three re-upload them next frame (Amit). A label's own canvas is ours to free.
        if (m.map && !m.userData.sharedMap) m.map.dispose();
        if (m.emissiveMap && !m.userData.sharedMap) m.emissiveMap.dispose();
        m.dispose && m.dispose();
      }
    }
  });
}

function clearGroup() {
  if (!group) return;
  disposeOurs(group);                                               // "seat 150" then "seat 100" must not pile up ribbons and labels (Amit)
  for (const o of [...group.children]) group.remove(o);
}

/** Walk the egress field downhill from a cell to an exit; the path we draw. */
function tracePath(g, field, from) {
  const pts = [];
  let [ix, iy] = g.cell(from[0], from[1]);
  // start from the nearest finite cell
  let best = null;
  for (let r = 0; r <= 3 && !best; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const jx = ix + dx, jy = iy + dy; if (jx < 0 || jy < 0 || jx >= g.nx || jy >= g.ny) continue;
    if (isFinite(field[g.at(jx, jy)]) && (!best || field[g.at(jx, jy)] < field[g.at(best[0], best[1])])) best = [jx, jy];
  }
  if (!best) return pts;
  [ix, iy] = best;
  for (let n = 0; n < 5000; n++) {
    pts.push([g.x0 + (ix + 0.5) * CELL, g.y0 + (iy + 0.5) * CELL]);
    const d = field[g.at(ix, iy)];
    if (d <= 0) break;
    let nx = ix, ny = iy, nd = d;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const jx = ix + dx, jy = iy + dy; if (jx < 0 || jy < 0 || jx >= g.nx || jy >= g.ny) continue;
      if (field[g.at(jx, jy)] < nd) { nd = field[g.at(jx, jy)]; nx = jx; ny = jy; }
    }
    if (nx === ix && ny === iy) break;
    ix = nx; iy = ny;
  }
  return pts.filter((_, i) => i % 3 === 0 || i === pts.length - 1);
}

// ------------------------------------------------------------------ zones by voice
const ZONE_SIZE = {
  meeting: (seats) => (seats <= 4 ? [3.2, 2.8] : seats <= 6 ? [3.8, 3.0] : seats <= 8 ? [4.4, 3.2] : seats <= 12 ? [5.4, 3.6] : [6.4, 4.0]),
  kitchen: () => [4.2, 3.2],
  lounge: () => [4.2, 4.0],
  phone: () => [1.6, 1.6],
  reception: () => [4.0, 3.0],
};

/**
 * Reserve floor for meeting rooms, a kitchen, a lounge, then lay the desks out around them.
 * `where`: "back" (farthest from the exits), "window", "entrance", or nothing (farthest from the windows).
 */
export async function testFitZones({ zones: asked = [], people = null, aisle = 1.2 } = {}) {
  const w = W();
  if (!w || !w.house || !w.current) return { ok: false, say: 'the viewer is not ready for a test fit' };
  for (let i = 0; i < 60 && !w.occluderMesh; i++) await new Promise((r) => setTimeout(r, 250));
  if (!w.occluderMesh) return { ok: false, say: 'this space has no mesh yet, so I cannot see its floor' };
  const floorZ = w.current.floorZ ?? 0;
  const g = floorGrid(w, floorZ);
  if (!g) return { ok: false, say: 'no floor' };
  const frame = makeFrame(rowDirection(w), 0, 0);
  const wins = windows(w), exits = exitDoors(g, w);
  const cen = (pts) => pts.length ? pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]) : null;
  const winC = cen(wins.map((o) => [o.cx, o.cy])), exitC = cen(exits.map((e) => [e.x, e.y]));

  // candidate anchor cells for a zone, scored by the asked-for side
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let iy = 0; iy < g.ny; iy++) for (let ix = 0; ix < g.nx; ix++) {
    if (!g.free[g.at(ix, iy)]) continue;
    const [u, v] = frame.toLocal(g.x0 + (ix + 0.5) * CELL, g.y0 + (iy + 0.5) * CELL);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  zones = [];
  const placed = [];
  for (const z of asked) {
    const type = (z.type || 'meeting').toLowerCase().replace(/\s.*$/, '');
    const size = (ZONE_SIZE[type] || ZONE_SIZE.meeting)(z.seats || 8);
    const count = Math.max(1, Math.min(12, z.count || 1));
    const where = (z.where || '').toLowerCase();
    for (let k = 0; k < count; k++) {
      let best = null;
      for (let v = v0 + size[1] / 2 + 0.3; v <= v1 - size[1] / 2; v += 0.5) {
        for (let u = u0 + size[0] / 2 + 0.3; u <= u1 - size[0] / 2; u += 0.5) {
          const r = { u0: u - size[0] / 2 - 0.45, u1: u + size[0] / 2 + 0.45, v0: v - size[1] / 2 - 0.45, v1: v + size[1] / 2 + 0.45 }; // with a corridor round it
          if (!rectFree(g, frame, r)) continue;
          if (placed.some((p) => !(r.u1 <= p.u0 || p.u1 <= r.u0 || r.v1 <= p.v0 || p.v1 <= r.v0))) continue;
          const [x, y] = frame.toWorld(u, v);
          let score;
          if (/back|far|rear/.test(where) && exitC) score = Math.hypot(x - exitC[0], y - exitC[1]);
          else if (/entr|front|door|lobby/.test(where) && exitC) score = -Math.hypot(x - exitC[0], y - exitC[1]);
          else if (/window|light|view/.test(where) && winC) score = -nearestWindow(wins, x, y);
          else score = winC ? nearestWindow(wins, x, y) : -v;          // default: leave the window line for desks
          // prefer standing against something: more blocked neighbours around the rectangle
          if (!best || score > best.score) best = { score, u, v, r };
        }
      }
      if (!best) break;
      const name = `${type === 'meeting' ? `${z.seats || 8}-seat meeting room` : type}${count > 1 ? ` ${k + 1}` : ''}`;
      const rect = { u0: best.u - size[0] / 2, u1: best.u + size[0] / 2, v0: best.v - size[1] / 2, v1: best.v + size[1] / 2 };
      placed.push(best.r);
      zones.push({ ...best.r, name, type, size, u: best.u, v: best.v, seats: z.seats || 8,
        draw: (fr, fz) => drawZone({ type, size, u: best.u, v: best.v, seats: z.seats || 8, name }, fr, fz) });
    }
  }
  // "add four meeting rooms" after "seat 150" keeps the 150: the follow-up rarely repeats the number
  const res = await testFit({ people: people || lastPeople, aisle });
  if (!res.ok) return res;
  const names = zones.map((z) => z.name);
  res.zones = names;
  res.say = `${names.length ? `Put in ${summarise(names)}. ` : ''}${res.say}`;
  return res;
}

function summarise(names) {
  const counts = {};
  for (const n of names) { const k = n.replace(/ \d+$/, ''); counts[k] = (counts[k] || 0) + 1; }
  return Object.entries(counts).map(([k, c]) => (c > 1 ? `${c} ${k}s` : `a ${k}`)).join(', ');
}

/** A zone, drawn: a glass box with the right furniture inside it, and a label. */
function drawZone(z, frame, floorZ) {
  const g = new THREE.Group();
  const [cx, cy] = frame.toWorld(z.u, z.v);
  const H = 2.4;
  const box = new THREE.Mesh(new THREE.BoxGeometry(z.size[0], z.size[1], H),
    new THREE.MeshBasicMaterial({ color: z.type === 'meeting' ? 0x8fd3ff : z.type === 'kitchen' ? 0xffd27f : 0xc8f08f, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
  box.position.set(cx, cy, floorZ + H / 2); box.rotation.z = frame.ang; box.renderOrder = 3; box.userData.ours = true;
  g.add(box);
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(z.size[0], z.size[1]),
    new THREE.MeshBasicMaterial({ color: box.material.color, transparent: true, opacity: 0.28, depthWrite: false }));
  plate.position.set(cx, cy, floorZ + 0.015); plate.rotation.z = frame.ang; plate.renderOrder = 1; plate.userData.ours = true;
  g.add(plate);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
  edges.position.copy(box.position); edges.rotation.copy(box.rotation); edges.renderOrder = 3; edges.userData.ours = true;
  g.add(edges);
  const put = (kind, du, dv, rot = 0) => {
    const item = buildFurniture(kind);
    const [x, y] = frame.toWorld(z.u + du, z.v + dv);
    item.position.set(x, y, floorZ); item.rotation.z = frame.ang + rot;
    g.add(item);
  };
  if (z.type === 'meeting') {
    put('table', 0, 0);
    const along = Math.ceil(z.seats / 2);
    for (let i = 0; i < along; i++) {
      const du = -0.9 + 0.4 + i * (1.6 / Math.max(1, along - 1)) * (along > 1 ? 1 : 0) - (along === 1 ? -0.5 : 0);
      put('chair', along > 1 ? (-0.75 + i * (1.5 / (along - 1))) : 0, 0.75, Math.PI);
      put('chair', along > 1 ? (-0.75 + i * (1.5 / (along - 1))) : 0, -0.75, 0);
    }
  } else if (z.type === 'kitchen') {
    put('table', 0, -0.4); put('chair', -0.5, 0.35, Math.PI); put('chair', 0.5, 0.35, Math.PI);
    put('bookcase', -z.size[0] / 2 + 0.3, z.size[1] / 2 - 0.3, Math.PI / 2); put('plant', z.size[0] / 2 - 0.4, z.size[1] / 2 - 0.4);
  } else if (z.type === 'lounge') {
    put('sofa', 0, 1.0, Math.PI); put('sofa', 0, -1.0, 0); put('coffeetable', 0, 0); put('plant', z.size[0] / 2 - 0.4, z.size[1] / 2 - 0.4);
  } else if (z.type === 'reception') {
    put('desk', 0, 0.4); put('chair', 0, -0.2, Math.PI); put('plant', -z.size[0] / 2 + 0.4, 0);
  } else {
    put('chair', 0, 0);
  }
  g.add(label(z.name, cx, cy, floorZ + H + 0.35, Math.max(3.2, z.size[0] * 0.9)));
  return g;
}

// ------------------------------------------------------------------ wiring
function register() {
  const w = W();
  if (!w) return;
  w.testFit = testFit;
  w.testFitZones = testFitZones;
  w.clearTestFit = clearTestFit;
  // voice: the agent keeps its tool table and declarations as live objects on walkin.agent
  const a = w.agent;
  if (!a || !a.tools || !a.declarations || a.tools.test_fit) return;
  a.tools.test_fit = (args) => testFit({ people: args.people || null, aisle: args.aisle_m || 1.2 });
  a.tools.test_fit_zones = (args) => testFitZones({ zones: args.zones || [], people: args.people || null, aisle: args.aisle_m || 1.2 });
  a.tools.clear_test_fit = () => clearTestFit();
  a.declarations.push(
    { name: 'test_fit',
      description: 'Office test fit: lay real-size desks out across this whole floor in benching rows with aisles, keeping every door clear. Use for "how many people can I seat here", "fit 150 people", "test fit", "lay out desks". Returns seats, the benching maximum, seats within 7.5 m of a window, code occupancy and the longest walk to an exit.',
      parameters: { type: 'object', properties: {
        people: { type: 'number', description: 'How many seats to place. Leave empty for as many as fit.' },
        aisle_m: { type: 'number', description: 'Clear aisle width between rows in metres, default 1.2.' } } } },
    { name: 'test_fit_zones',
      description: 'Office test fit with zones: reserve meeting rooms, a kitchen, a lounge, phone booths or a reception where the user asks, then lay desks out around them. Use for "add four 8-person meeting rooms on the back wall", "kitchen by the entrance", "a lounge in the corner".',
      parameters: { type: 'object', properties: {
        zones: { type: 'array', description: 'What to reserve.', items: { type: 'object', properties: {
          type: { type: 'string', description: 'meeting, kitchen, lounge, phone, or reception.' },
          seats: { type: 'number', description: 'Seats in a meeting room, e.g. 8.' },
          count: { type: 'number', description: 'How many of this zone, default 1.' },
          where: { type: 'string', description: 'back, window, or entrance. Leave empty to keep the window line for desks.' } } } },
        people: { type: 'number', description: 'How many desks to place around the zones. Leave empty for as many as fit.' },
        aisle_m: { type: 'number', description: 'Aisle width in metres, default 1.2.' } },
        required: ['zones'] } },
    { name: 'clear_test_fit', description: 'Take the test-fit desks and zones away again.', parameters: { type: 'object', properties: {} } },
  );
}
if (window.walkin) register(); else addEventListener('walkin:ready', register, { once: true });
// agent.js attaches walkin.agent some time after the viewer is ready - later still on a phone over a
// tunnel - so keep trying until the tools are on it, for up to a minute.
{
  let tries = 0;
  const again = setInterval(() => {
    register();
    const a = window.walkin && window.walkin.agent;
    if ((a && a.tools && a.tools.test_fit) || ++tries > 120) clearInterval(again);
  }, 500);
}
