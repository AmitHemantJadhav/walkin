// #55 beat 5, no browser needed:  node tools/door-test.mjs [model] [wall#]
// Loads the real physics.js + fit.js + furniture.js against a house's real walls, grabs a sofa turned end-on,
// and carries it with a steady "hand" through a doorway, held 0..50 cm off the doorway's centre line.
// Prints where the sofa ends up: sideU < 0 means it went through (Shaurya's table on #55).
// Default: La Mirada's 1.15 m front door (wall 13). A 4th argument is the page's query string, for flags.
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
const ux = (wall.b[0] - wall.a[0]) / len, uy = (wall.b[1] - wall.a[1]) / len;   // along the wall
const door = { x: wall.a[0] + ux * o.at * len, y: wall.a[1] + uy * o.at * len, width: o.width };

// --- a fake browser: one sofa, a clock we drive, and a frame loop we step by hand
let T = 0, raf = null, runs = 0, sofa = null;
globalThis.window = { walkin: { house, furniture: { children: [] }, current: { floor: floor.id } },
  dispatchEvent: () => {}, addEventListener: () => {} };
globalThis.CustomEvent = class { constructor(type, o2) { this.type = type; this.detail = o2 && o2.detail; } };
const qs = process.argv[4] || '';                      // e.g. '?doorrail=off' to compare against a flag
globalThis.location = { search: qs };
globalThis.requestAnimationFrame = (cb) => { raf = cb; };
globalThis.setInterval = () => 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => T }, configurable: true, writable: true });
const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }),
  getElementById: () => null };
globalThis.fetch = () => new Promise(() => {});        // furniture.js preloads GLBs; geometry here is the catalog's

const { physics } = await import(new URL('physics.js', root).href);
const tick = () => { T += 1000 / 60; raf(); };

// Which side of the wall is the room? The side with the sofa's start in it: try both, pick the one
// physics doesn't call blocked. nx, ny points from the room through the door.
const NX = -uy, NY = ux;
// yawErr (radians) holds the sofa that far off square for the whole carry. The piece is *created* turned,
// so nothing gets turned in place near the door (that shove is what spoiled the first try on #84).
function run(offset, side, broadside = false, speed = 0.6, yawErr = 0) {
  const nx = NX * side, ny = NY * side;
  const start = 2.2, end = 2.0;                         // centre 2.2 m before the door plane, hand runs 2 m past
  // A fresh piece each run: physics keeps state per item, and moving the old one back to the start is
  // a *push* if it was pushed in the last 2 s, so it got dragged back from wherever the last run ended.
  sofa = { uuid: `sofa${++runs}`, userData: { kind: 'sofa', floor: floor.id }, position: { x: 0, y: 0, z: 0 }, rotation: { z: 0 } };
  window.walkin.furniture.children = [sofa];
  sofa.position.x = door.x - nx * start + ux * offset;
  sofa.position.y = door.y - ny * start + uy * offset;
  // end-on: the 0.95 m side is across the door; broadside: the 2.10 m side is, and it must not go through
  sofa.rotation.z = Math.atan2(ny, nx) + (broadside ? Math.PI / 2 : 0) + yawErr;
  const held = sofa.rotation.z;
  physics.stats.assisted = 0;
  for (let i = 0; i < 40; i++) tick();                  // settle the new placement
  // Where the carry really starts. #84: a run that the settle already shoved through the door looks like a
  // short, failed carry, so every run reports this and the yaw sweep refuses to count a bad start.
  const startU = +(-((sofa.position.x - door.x) * nx + (sofa.position.y - door.y) * ny)).toFixed(2);
  physics.grab(sofa, 'h', [sofa.position.x, sofa.position.y]);
  const total = start + end, secs = total / speed + 4;
  let maxTurn = 0;
  for (let f = 0; f < secs * 60; f++) {
    const s = Math.min(total, (f / 60) * speed);
    physics.moveTarget('h', [door.x - nx * (start - s) + ux * offset, door.y - ny * (start - s) + uy * offset], held);
    tick();
    maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(Math.sin(sofa.rotation.z - held), Math.cos(sofa.rotation.z - held))));
  }
  physics.release('h');
  const rx = sofa.position.x - door.x, ry = sofa.position.y - door.y;
  return { sideU: +(-(rx * nx + ry * ny)).toFixed(2), off: +(rx * ux + ry * uy).toFixed(3), assisted: physics.stats.assisted,
    startU, turned: +(maxTurn * 180 / Math.PI).toFixed(1) };
}

// the room side: carrying with no offset must get somewhere from one side or the other
const a = run(0, 1), b = run(0, -1);
const side = a.sideU <= b.sideU ? 1 : -1;
console.log(`${model} wall ${wallNo}: ${door.width.toFixed(2)} m doorway at (${door.x.toFixed(2)}, ${door.y.toFixed(2)})`
  + `${qs ? ' ' + qs : ''}`);
console.log('hand offset | sideU (m, <0 = through) | ends off-centre (m) | assist fired');
let through = 0;
const offs = [0, 0.08, 0.16, 0.25, 0.35, 0.5];
for (const off of offs) {
  const r = run(off, side);
  if (r.sideU < -1) through++;
  console.log(`${String(Math.round(off * 100)).padStart(6)} cm | ${String(r.sideU).padStart(6)} | ${String(r.off).padStart(7)} | ${r.assisted}`);
}
console.log(`${through}/${offs.length} through`);
let leaked = 0;
for (const off of door.width - 0.02 < 2.10 ? [0, 0.25] : []) {   // a 2.5 m opening takes a sofa broadside
  const r = run(off, side, true);
  if (r.sideU < 0.3) leaked++;
  console.log(`broadside ${Math.round(off * 100)} cm: sideU ${r.sideU} ${r.sideU < 0.3 ? 'FAIL (a misfit got in)' : 'ok, stopped'}`);
}
// #84: how far off square can you carry it through, on the centre line? Same hand, same speed, the yaw held
// the whole way. A run only counts if it started on the room side (startU near 2.2 m), never already through.
console.log('off square | start (m) | sideU (m, <0 = through) | assist turned it (deg) | assist fired');
let lastThrough = null, badStart = 0;
for (const deg of [0, 2, 4, 6, 8, 10, 12, 15, 20]) {
  const worst = [];
  for (const sgn of deg ? [1, -1] : [1]) {
    const r = run(0, side, false, 0.6, sgn * deg * Math.PI / 180);
    const ok = r.startU > 1.5;
    if (!ok) badStart++;
    worst.push(r);
    console.log(`${String(sgn * deg).padStart(7)} deg | ${String(r.startU).padStart(5)}${ok ? '' : ' BAD START'} | `
      + `${String(r.sideU).padStart(6)} | ${String(r.turned).padStart(5)} | ${r.assisted}`);
  }
  if (worst.every((r) => r.startU > 1.5 && r.sideU < -1)) lastThrough = deg;
}
console.log(lastThrough === null ? 'off square: not even square goes through'
  : `off square: goes through both ways up to ${lastThrough} deg${badStart ? ` (${badStart} runs had a bad start, not counted)` : ''}`);
process.exitCode = leaked ? 1 : 0;
