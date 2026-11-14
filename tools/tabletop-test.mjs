// #58, no browser needed:  node tools/tabletop-test.mjs [model]
// Loads the real physics.js + tabletop.js against a house's real walls and does what app.js does for a hand:
// liftOff on grab, physics.grab / moveTarget every frame, physics.release + setDown on let-go.
// A plant carried at a coffee table should end up ON it (z = table top, linked), ride along when the table
// moves, come off when grabbed again, and land on the floor when let go away from the table.
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
const house = JSON.parse(readFileSync(new URL(`data/${model}/house.json`, root), 'utf8'));
const floor = house.floors[0];

let T = 0, raf = null, n = 0;
globalThis.window = { walkin: { house, furniture: { children: [] }, current: { floor: floor.id, floorZ: 0 } },
  dispatchEvent: () => {}, addEventListener: () => {} };
globalThis.CustomEvent = class { constructor(type, o2) { this.type = type; this.detail = o2 && o2.detail; } };
globalThis.location = { search: '' };
globalThis.requestAnimationFrame = (cb) => { raf = cb; };
globalThis.setInterval = () => 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => T }, configurable: true, writable: true });
const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }),
  getElementById: () => null };
globalThis.fetch = () => new Promise(() => {});

const { physics } = await import(new URL('physics.js', root).href);
const { liftOff, setDown, supportFor } = await import(new URL('tabletop.js', root).href);
const { pointInPoly } = await import(new URL('fit.js', root).href);
const w = window.walkin;
w.roomAt = (x, y, f) => house.rooms.find((r) => r.floor === f && r.poly && pointInPoly(x, y, r.poly)) || null;
const tick = (k = 1) => { for (let i = 0; i < k; i++) { T += 1000 / 60; raf(); } };

function piece(kind, x, y, rot = 0) {
  const o = { uuid: `${kind}${++n}`, userData: { kind, floor: floor.id }, rotation: { z: rot },
    position: { x, y, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; } } };
  w.furniture.children.push(o);
  return o;
}
/** app.js's hand: pinch on the piece, walk the hand to (x, y) at 0.6 m/s, open the hand. */
function carry(item, x, y, opts = {}) {
  liftOff(item);
  physics.grab(item, 'h');
  const x0 = item.position.x, y0 = item.position.y, d = Math.hypot(x - x0, y - y0), frames = Math.ceil((d / 0.6) * 60) + 60;
  for (let f = 1; f <= frames; f++) {
    const s = Math.min(1, f / (frames - 60));
    physics.moveTarget('h', [x0 + (x - x0) * s, y0 + (y - y0) * s]);
    tick();
  }
  const short = Math.hypot(item.position.x - x, item.position.y - y);
  physics.release('h');
  const on = setDown(item, opts.thrown ? null : x, y);
  tick(60);
  return { short: +short.toFixed(2), on: on ? on.userData.kind : null };
}

// a dining room, living room or kitchen on the ground floor (some rooms have no outline in the scan)
const room = ['Dining Room', 'Living Room', 'Kitchen'].map((l) => house.rooms.find((r) => r.label === l
  && r.floor === floor.id && r.poly)).find(Boolean);
const xs = room.poly.map((p) => p[0]), ys = room.poly.map((p) => p[1]);
const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
const table = piece('coffeetable', cx, cy);
const plant = piece('plantsmall', cx - 1.5, cy);
tick(30);

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
console.log(`${model} ${room.label}: coffee table at (${cx.toFixed(2)}, ${cy.toFixed(2)}), small plant 1.5 m to its left`);

// 1. carried at the table's centre: without #58 it stops beside it on the floor
let r = carry(plant, cx, cy);
check(r.short > 0.3, `the table stops the carried plant ${r.short} m short of the hand (the #58 bug's cause)`);
check(r.on === 'coffeetable' && plant.userData.on === table.uuid, `let go over the table: it is on the ${r.on}`);
check(Math.abs(plant.position.z - 0.45) < 1e-6, `stands at the table top, z = ${plant.position.z.toFixed(3)}`);
check(pointInPoly(plant.position.x, plant.position.y, [[cx - 0.6, cy - 0.35], [cx + 0.6, cy - 0.35], [cx + 0.6, cy + 0.35], [cx - 0.6, cy + 0.35]]),
  'and is inside the table top');

// 2. it rides with the table
const before = [plant.position.x - table.position.x, plant.position.y - table.position.y];
carry(table, cx + 0.5, cy);
const after = [plant.position.x - table.position.x, plant.position.y - table.position.y];
check(Math.hypot(after[0] - before[0], after[1] - before[1]) < 0.01 && plant.userData.on === table.uuid,
  `moving the table 0.5 m carries the plant with it (offset kept to ${Math.hypot(after[0] - before[0], after[1] - before[1]).toFixed(3)} m)`);

// 3. grab it again and put it on the floor 1.5 m away
r = carry(plant, table.position.x, cy + 1.5);
check(!plant.userData.on && plant.position.z === 0, `picked up again and let go on the floor: on = ${plant.userData.on}, z = ${plant.position.z}`);
check(r.short < 0.05, `it followed the hand off the table (${r.short} m short)`);
check(!physics.probe(plant, plant.position.x, plant.position.y).hit, 'and is not stuck in anything');

// 4. a chair let go at the table stays on the floor
const chair = piece('chair', cx - 1.2, cy - 1.2);
tick(30);
r = carry(chair, table.position.x, table.position.y);
check(r.on === null && !chair.userData.on && chair.position.z === 0, 'a chair let go over the table stays on the floor');

// 5. thrown, or too far away: floor
r = carry(plant, table.position.x, table.position.y, { thrown: true });
check(r.on === null && !plant.userData.on && plant.position.z === 0, 'a plant thrown at the table stays on the floor');
const far = piece('plantfern', table.position.x - 2.6, table.position.y);
check(supportFor(far, table.position.x, table.position.y) === null, 'a hand over a table 2.6 m from the plant does not teleport it there');

// 6. lifted from the table and put straight back (a click with no drag)
carry(plant, table.position.x, table.position.y);
const z1 = plant.position.z;
liftOff(plant); physics.grab(plant, 'h'); tick(5); physics.release('h');
setDown(plant, plant.position.x, plant.position.y); tick(10);
check(plant.userData.on === table.uuid && plant.position.z === z1, `clicked without moving: still on the table (z ${plant.position.z.toFixed(3)})`);

console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
