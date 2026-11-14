// #57, no browser needed:  node tools/push-test.mjs [model] [wall#] [query]
// Loads the real physics.js against a house's real walls and checks the sofa can shove a coffee table:
//  1. beat 5: the sofa, end-on to the front door, is carried at it with the coffee table in its path
//     (where staging puts it). Without #57 it stops dead at the table.
//  2. Shaurya's invariant check: drag the sofa in two full circles round the room for 10 s with the table,
//     an armchair and a plant about. No two pieces may ever overlap, nothing may leave the room.
//  3. a light piece (a chair) carried into the sofa must not move it.
// Each runs with ?pushaside=off and on. Exit code 1 if anything overlaps or the push doesn't help.
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

const root = new URL('..', import.meta.url);
const vendor = new URL('vendor/three/', root).href;
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'three') return next('${vendor}build/three.module.js', ctx);
  if (spec.startsWith('three/addons/')) return next('${vendor}examples/jsm/' + spec.slice(13), ctx);
  return next(spec, ctx);
}`));

const model = process.argv[2] || 'zvKHR9DHNjJ';
const wallNo = +(process.argv[3] || 13);
const house = JSON.parse(readFileSync(new URL(`data/${model}/house.json`, root), 'utf8'));
const floor = house.floors[0];
const wall = floor.walls[wallNo];
const o = wall.openings.find((q) => q.type !== 'window');
const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
const ux = (wall.b[0] - wall.a[0]) / len, uy = (wall.b[1] - wall.a[1]) / len;
const door = { x: wall.a[0] + ux * o.at * len, y: wall.a[1] + uy * o.at * len, width: o.width };

let T = 0, raf = null, n = 0;
globalThis.window = { walkin: { house, furniture: { children: [] }, current: { floor: floor.id, floorZ: 0 } },
  dispatchEvent: () => {}, addEventListener: () => {} };
globalThis.CustomEvent = class { constructor(type, o2) { this.type = type; this.detail = o2 && o2.detail; } };
globalThis.location = { search: process.argv[4] || '' };
globalThis.requestAnimationFrame = (cb) => { raf = cb; };
globalThis.setInterval = () => 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => T }, configurable: true, writable: true });
const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }),
  getElementById: () => null };
globalThis.fetch = () => new Promise(() => {});

const { physics } = await import(new URL('physics.js', root).href);
const { FURNITURE } = await import(new URL('furniture.js', root).href);
const { footprint, overlaps, pointInPoly } = await import(new URL('fit.js', root).href);
const w = window.walkin;
const tick = () => { T += 1000 / 60; raf(); };

// the room the door opens from: the side whose point 1.5 m back is inside a room with an outline
const roomAt = (x, y) => house.rooms.find((r) => r.floor === floor.id && r.poly && pointInPoly(x, y, r.poly));
let NX = -uy, NY = ux;
if (!roomAt(door.x - NX * 1.5, door.y - NY * 1.5)) { NX = -NX; NY = -NY; }
const room = roomAt(door.x - NX * 1.5, door.y - NY * 1.5);
const SKIN = 0.012;
const solid = () => w.furniture.children.filter((q) => !(FURNITURE[q.userData.kind] || {}).flat && !q.userData.on);
const fpOf = (q) => footprint(q.userData.kind, q.position.x, q.position.y, q.rotation.z, -SKIN);
function overlapping() {
  const s = solid();
  let k = 0;
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) if (overlaps(fpOf(s[i]), fpOf(s[j]))) k++;
  return k;
}
function piece(kind, x, y, rot) {
  const q = { uuid: `${kind}${++n}`, userData: { kind, floor: floor.id }, rotation: { z: rot },
    position: { x, y, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; } } };
  w.furniture.children.push(q);
  return q;
}
function fresh() { w.furniture.children.length = 0; tick(); }
const at = (back, side = 0) => [door.x - NX * back + ux * side, door.y - NY * back + uy * side];
const toDoor = Math.atan2(NY, NX);

/** Hand on a piece, walk the hand along `path(s)` (s in 0..1) for `secs`, counting overlaps every frame. */
function carry(item, path, secs) {
  physics.grab(item, 'h', [item.position.x, item.position.y]);
  let worst = 0, frames = 0;
  for (let f = 0; f < secs * 60; f++) {
    physics.moveTarget('h', path(Math.min(1, f / (secs * 60 - 30))), item.rotation.z);
    tick();
    const k = overlapping();
    if (k) frames++;
    worst = Math.max(worst, k);
  }
  physics.release('h');
  for (let f = 0; f < 60; f++) tick();
  return { worst, frames };
}

let fails = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
console.log(`${model}: ${room.label}, ${door.width.toFixed(2)} m door on wall ${wallNo}${location.search ? ' ' + location.search : ''}`);

const result = {};
for (const on of [false, true]) {
  physics.pushAside = on;
  console.log(`pushAside ${on ? 'on' : 'off'}`);

  // 1. beat 5: sofa end-on 3.4 m back, coffee table between it and the door
  fresh();
  const [sx, sy] = at(3.4), [tx, ty] = at(1.6);
  const sofa = piece('sofa', sx, sy, toDoor), table = piece('coffeetable', tx, ty, toDoor + Math.PI / 2);
  for (let f = 0; f < 40; f++) tick();
  physics.stats.pushed = 0;
  const [ex, ey] = at(-2);
  const r1 = carry(sofa, (s) => [sx + (ex - sx) * s, sy + (ey - sy) * s], 5.4 / 0.6 + 2);
  const travel = Math.hypot(sofa.position.x - sx, sofa.position.y - sy);
  const shoved = Math.hypot(table.position.x - tx, table.position.y - ty);
  const tableIn = roomAt(table.position.x, table.position.y);
  console.log(`  beat 5: sofa travelled ${travel.toFixed(2)} m, table shoved ${shoved.toFixed(2)} m`
    + ` (now in ${tableIn ? tableIn.label : 'no room'}), ${physics.stats.pushed} push frames, lastHit ${physics.stats.lastHit}`);
  check(r1.worst === 0, `beat 5: no overlap on any frame (worst ${r1.worst}, ${r1.frames} frames)`);
  result[on] = travel;

  // 2. two circles round the room with the sofa, among a coffee table, an armchair and a plant
  fresh();
  const xs = room.poly.map((p) => p[0]), ys = room.poly.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const rad = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.3;
  const sofa2 = piece('sofa', cx + rad, cy, Math.PI / 2);
  piece('coffeetable', cx, cy, 0);
  piece('armchair', cx - rad, cy, 0);
  piece('plant', cx, cy + rad * 0.9, 0);
  for (let f = 0; f < 40; f++) tick();
  const start = overlapping();
  physics.stats.pushed = 0;
  const r2 = carry(sofa2, (s) => [cx + rad * Math.cos(s * 4 * Math.PI), cy + rad * Math.sin(s * 4 * Math.PI)], 10);
  const outside = solid().filter((q) => !pointInPoly(q.position.x, q.position.y, room.poly)).map((q) => q.uuid);
  console.log(`  circles: ${physics.stats.pushed} push frames, overlapping at start ${start}`);
  check(r2.worst === 0, `circles: no overlap on any frame (worst ${r2.worst}, ${r2.frames} frames)`);
  check(!outside.length, `circles: nothing left the room${outside.length ? ' (' + outside.join(', ') + ')' : ''}`);

  // 3. a chair carried into the sofa: the sofa stays put
  fresh();
  const sofa3 = piece('sofa', cx, cy, 0);
  const chair = piece('chair', cx, cy - 1.4, 0);
  for (let f = 0; f < 40; f++) tick();
  const before = [sofa3.position.x, sofa3.position.y];
  const r3 = carry(chair, (s) => [cx, cy - 1.4 + 2.0 * s], 4);
  const moved = Math.hypot(sofa3.position.x - before[0], sofa3.position.y - before[1]);
  check(moved < 1e-6 && r3.worst === 0, `chair into sofa: sofa moved ${moved.toFixed(3)} m, worst overlap ${r3.worst}`);
}
check(result.true > result.false + 0.5, `beat 5: the push lets the sofa further (${result.false.toFixed(2)} → ${result.true.toFixed(2)} m)`);
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
