// #63, no browser needed:  node tools/overlap-test.mjs [model] [seconds] [debug]
// ("debug" prints the first new overlap of each run: which two pieces, and how each moved that frame.)
// Loads the real physics.js against a house's real walls, furnishes the living room with 12 pieces, then
// fiddles the way the soak in #63 did: grab a random piece, drag it somewhere random, let go (sometimes
// with a fling), and often press ⟳ on it ~220 ms later, the way app.js's rotateSelected() does it
// (item.rotation.z += 45°, written straight onto the item before physics has looked at it).
// After every frame it lists the pairs of pieces that overlap. Two pieces should never be in the same place.
// Runs each seed twice: physics.neighbourState off (pieces are tested against item.position) and on.
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
const seconds = +(process.argv[3] || 60);
const DEBUG = process.argv[4] === 'debug';
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
const { FURNITURE } = await import(new URL('furniture.js', root).href);
const { footprint, overlaps, pointInPoly } = await import(new URL('fit.js', root).href);
const w = window.walkin;
const tick = () => { T += 1000 / 60; raf(); };

const room = ['Living Room', 'Family Room', 'Dining Room', 'Bedroom', 'Kitchen'].map((l) => house.rooms.find((r) => r.label === l
  && r.floor === floor.id && r.poly)).find(Boolean);
const xs = room.poly.map((p) => p[0]), ys = room.poly.map((p) => p[1]);
const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
const SKIN = 0.012;
const solid = () => w.furniture.children.filter((o) => !(FURNITURE[o.userData.kind] || {}).flat && !o.userData.on);
const fpOf = (o) => footprint(o.userData.kind, o.position.x, o.position.y, o.rotation.z, -SKIN);
const inRoom = (kind, x, y, rot) => footprint(kind, x, y, rot).every(([px, py]) => pointInPoly(px, py, room.poly));

function rng(seed) {                                       // mulberry32
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pairs() {
  const s = solid(), out = new Set();
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
    if (overlaps(fpOf(s[i]), fpOf(s[j]))) out.add(`${s[i].uuid}+${s[j].uuid}`);
  }
  return out;
}
function furnish(rand) {
  w.furniture.children.length = 0;
  tick();                                                  // let physics forget the last run's pieces
  const kinds = ['sofa', 'coffeetable', 'armchair', 'armchair', 'sidetable', 'plant', 'floorlamp', 'tvstand',
    'bookcase', 'chair', 'chair', 'plantsmall'];
  for (const kind of kinds) {
    for (let tries = 0; tries < 400; tries++) {
      const x = box[0] + rand() * (box[2] - box[0]), y = box[1] + rand() * (box[3] - box[1]);
      const rot = Math.floor(rand() * 4) * Math.PI / 2;
      if (!inRoom(kind, x, y, rot)) continue;
      const f = footprint(kind, x, y, rot, 0.02);
      if (solid().some((o) => overlaps(f, footprint(o.userData.kind, o.position.x, o.position.y, o.rotation.z)))) continue;
      w.furniture.children.push({ uuid: `${kind}${++n}`, userData: { kind, floor: floor.id }, rotation: { z: rot },
        position: { x, y, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; } } });
      break;
    }
  }
  for (let i = 0; i < 30; i++) tick();
}

/** One soak. Returns how many times a new overlapping pair appeared, and on what kind of frame. */
function soak(seed, fixOn) {
  physics.neighbourState = fixOn;
  const rand = rng(seed);
  furnish(rand);
  const pieces = solid();
  let drag = null, rotateAt = -1, selected = null;
  let seen = pairs();
  const start = seen.size;
  const ev = { rotateFrame: 0, other: 0, frames: seconds * 60, start };
  for (let f = 0; f < seconds * 60; f++) {
    let rotated = false;
    if (!drag && rand() < 0.08) {                          // grab something
      const item = pieces[Math.floor(rand() * pieces.length)];
      physics.grab(item, 'h');
      const tx = box[0] + rand() * (box[2] - box[0]), ty = box[1] + rand() * (box[3] - box[1]);
      drag = { item, x0: item.position.x, y0: item.position.y, tx, ty, len: 10 + Math.floor(rand() * 30), f: 0 };
      selected = item;
    }
    if (drag) {
      drag.f++;
      const s = Math.min(1, drag.f / drag.len);
      physics.moveTarget('h', [drag.x0 + (drag.tx - drag.x0) * s, drag.y0 + (drag.ty - drag.y0) * s]);
      if (drag.f >= drag.len) {
        const fling = rand() < 0.5;
        physics.release('h', fling ? [(drag.tx - drag.x0) / (drag.len / 60), (drag.ty - drag.y0) / (drag.len / 60)] : null);
        drag = null;
        if (rand() < 0.6) rotateAt = f + 13;               // ⟳ about 220 ms after letting go
      }
    }
    if (f === rotateAt && selected) {                      // what rotateSelected() does
      selected.rotation.z += Math.PI / 4;
      rotated = true;
    }
    const before = new Map(pieces.map((o) => [o, [o.position.x, o.position.y, o.rotation.z]]));
    tick();
    const now = pairs();
    for (const p of now) if (!seen.has(p)) {
      if (rotated) ev.rotateFrame++; else ev.other++;
      if (DEBUG && !ev.shown) {
        ev.shown = true;
        console.log(`    first new overlap at frame ${f}: ${p}${rotated ? ` (⟳ pressed on ${selected.uuid})` : ''}`);
        for (const o of pieces) {
          const [x0, y0, r0] = before.get(o);
          if (!p.split('+').includes(o.uuid)) continue;
          console.log(`      ${o.uuid}: (${x0.toFixed(3)}, ${y0.toFixed(3)}, ${(r0 * 180 / Math.PI).toFixed(0)}°) -> `
            + `(${o.position.x.toFixed(3)}, ${o.position.y.toFixed(3)}, ${(o.rotation.z * 180 / Math.PI).toFixed(0)}°)`
            + `${drag && drag.item === o ? ' held' : ''} lastHit ${physics.stats.lastHit}`);
        }
      }
    }
    seen = now;
  }
  ev.end = seen.size;
  if (drag) physics.release('h');
  return ev;
}

const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
console.log(`${model} ${room.label}: 12 pieces, ${seconds} s of drag + fling + ⟳ per seed, ${seeds.length} seeds`);
let total = { false: 0, true: 0 };
for (const fixOn of [false, true]) {
  for (const seed of seeds) {
    const e = soak(seed, fixOn);
    total[fixOn] += e.rotateFrame + e.other;
    console.log(`  neighbourState ${fixOn ? 'on ' : 'off'} seed ${seed}: new overlaps ${e.rotateFrame + e.other}`
      + ` (${e.rotateFrame} on a ⟳ frame, ${e.other} otherwise), overlapping at the end ${e.end}`);
  }
}
console.log(`total new overlaps: off ${total.false}, on ${total.true}`);
process.exit(total.true ? 1 : 0);
