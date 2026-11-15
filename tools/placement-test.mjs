// Furniture placement, no browser needed:  node tools/placement-test.mjs [model] [--strict]
// Loads the real staging.js + furniture-tools.js + fit.js against a house's real rooms, walls and scan points,
// then counts what a person would see as a mistake:
//   doors    pieces standing in a doorway's clear zone (the opening's width x 0.9 m, both sides)
//   scan     pieces within 0.45 m of a scan point (after a teleport there you would be standing in them);
//            "under" is the subset with the scan point inside the footprint - standing IN the piece
//   overlap  pairs of pieces that share floor
// for (1) stage_house, and (2) five separate add_furniture calls (sofa, queen, desk, sofa, queen) made from
// the scan points of each living room, dining room and bedroom, the way a user asks John for them.
// The counts here are measured by this file's own geometry, not by placement.js, so the rules are not
// marking their own homework. --strict exits 1 if any count is non-zero.
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

const model = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'zvKHR9DHNjJ';
const STRICT = process.argv.includes('--strict');
const house = JSON.parse(readFileSync(new URL(`data/${model}/house.json`, root), 'utf8'));

// --- a fake browser: just enough of window.walkin for staging and the furniture tools
globalThis.location = { search: '' };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.setInterval = () => 0;
const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }),
  getElementById: () => null };
globalThis.fetch = () => new Promise(() => {});
globalThis.addEventListener = () => {};
globalThis.window = globalThis;

const THREE = await import('three');
const { FURNITURE } = await import(new URL('furniture.js', root).href);
const { footprint, overlaps, pointInPoly } = await import(new URL('fit.js', root).href);

function roomAt(x, y, floorId) {
  return house.rooms.find((r) => r.poly && r.poly.length > 2 && (!floorId || !r.floor || r.floor === floorId)
    && pointInPoly(x, y, r.poly));
}
const furniture = new THREE.Group();
const w = {
  house, furniture, FURNITURE, roomAt, view: { yaw: 0, pitch: 0 }, selected: null,
  current: null,
  camera: new THREE.PerspectiveCamera(),
  select(it) { w.selected = it; },
  checkFit() {},
  addFurniture(kind) {
    const it = new THREE.Group();
    it.userData.kind = kind;
    const yaw = w.view.yaw;
    it.position.set(w.current.pos[0] + Math.cos(yaw) * 2, w.current.pos[1] + Math.sin(yaw) * 2, 0.004);
    it.rotation.z = yaw - Math.PI / 2;
    it.userData.floor = w.current.floor;
    furniture.add(it);
    w.select(it);
    return it;
  },
};
window.walkin = w;
const standAt = (p, yaw = 0) => { w.current = { ...p, floorZ: p.floorZ || 0 }; w.view.yaw = yaw; };
standAt(house.panos.find((p) => roomAt(p.pos[0], p.pos[1], p.floor)) || house.panos[0]);

const { stageHouse, stageRoom } = await import(new URL('staging.js', root).href);
await import(new URL('furniture-tools.js', root).href);
const tools = w.furnitureTools.run;

// --- what counts as a mistake (independent of placement.js)
const DOOR_DEPTH = 0.9, SPOT = 0.45;
const doorZones = [];
for (const f of house.floors || []) {
  for (const wl of f.walls || []) {
    const [ax, ay] = wl.a, [bx, by] = wl.b, len = Math.hypot(bx - ax, by - ay);
    if (len < 0.05) continue;
    const dx = (bx - ax) / len, dy = (by - ay) / len, nx = -dy, ny = dx;
    for (const o of wl.openings || []) {
      if (o.at == null || /window/i.test(o.type || '') || (o.bottom || 0) >= 0.3) continue;
      const cx = ax + dx * o.at * len, cy = ay + dy * o.at * len, hw = (o.width || 0.9) / 2;
      doorZones.push({ floor: f.id, poly: [
        [cx - dx * hw - nx * DOOR_DEPTH, cy - dy * hw - ny * DOOR_DEPTH], [cx + dx * hw - nx * DOOR_DEPTH, cy + dy * hw - ny * DOOR_DEPTH],
        [cx + dx * hw + nx * DOOR_DEPTH, cy + dy * hw + ny * DOOR_DEPTH], [cx - dx * hw + nx * DOOR_DEPTH, cy - dy * hw + ny * DOOR_DEPTH]] });
    }
  }
}
const solid = () => furniture.children.filter((o) => o.userData.kind && !(FURNITURE[o.userData.kind] || {}).flat && !o.userData.on);
const fp = (o, pad = -0.01) => footprint(o.userData.kind, o.position.x, o.position.y, o.rotation.z, pad);
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
function count(filter = () => true) {
  const items = solid().filter(filter);
  const doors = items.filter((o) => doorZones.some((z) => (!z.floor || z.floor === o.userData.floor) && overlaps(fp(o), z.poly)));
  const scan = items.filter((o) => house.panos.some((p) => (!p.floor || p.floor === o.userData.floor)
    && distToPoly(p.pos[0], p.pos[1], fp(o, 0)) < SPOT - 0.005));
  const under = items.filter((o) => house.panos.some((p) => (!p.floor || p.floor === o.userData.floor)
    && distToPoly(p.pos[0], p.pos[1], fp(o, 0)) === 0));
  const near = scan.map((o) => Math.min(...house.panos.filter((p) => !p.floor || p.floor === o.userData.floor)
    .map((p) => distToPoly(p.pos[0], p.pos[1], fp(o, 0)))));
  let pairs = 0;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (overlaps(fp(items[i]), fp(items[j]))) pairs++;
  return { pieces: furniture.children.filter((o) => o.userData.kind && filter(o)).length, doors: doors.length,
    scan: scan.length, under: under.length, overlap: pairs,
    detail: [...doors.map((o) => `door:${o.userData.kind}`), ...scan.map((o, i) => `scan:${o.userData.kind}@${near[i].toFixed(2)}m`)] };
}
const clear = () => { for (const o of [...furniture.children]) furniture.remove(o); };
const KINDS = [['living', /living|family/i], ['dining', /dining/i], ['bedroom', /bed/i]];
const inKind = (re) => (o) => { const r = roomAt(o.position.x, o.position.y, o.userData.floor); return !!r && re.test(r.label); };

const rows = [];
if (process.env.DEBUG === 'why') {
  const P = await import(new URL('placement.js', root).href);
  const { fitReport } = await import(new URL('fit.js', root).href);
  for (const r of house.rooms.filter((q) => new RegExp(process.env.ROOMS || 'bed|dining', 'i').test(q.label) && q.poly)) {
    clear();
    const kind = /bed/i.test(r.label) ? 'queen' : 'table';
    const cands = kind === 'queen' ? P.wallSpots(kind, r, { floor: r.floor }) : P.gridSpots(r);
    const tally = {};
    for (const c of cands) {
      const why = P.rules(kind, c.x, c.y, c.rot, { floor: r.floor, spot: +(process.env.SPOT || 0.45) });
      const f = fitReport({ kind, x: c.x, y: c.y, rot: c.rot, floor: r.floor });
      const k = [...why, ...(f.room === r ? f.reasons : ['other room'])].join(' + ') || 'OK';
      tally[k] = (tally[k] || 0) + 1;
    }
    console.log(r.label, (r.dims || {}).areaFloor, house.panos.filter((p) => roomAt(p.pos[0], p.pos[1], p.floor) === r).length, 'scan pts', tally);
  }
  process.exit(0);
}
if (process.env.DEBUG) {
  for (const r of house.rooms) {
    if (!r.poly || r.poly.length < 3) continue;
    clear();
    const res = stageRoom(r, 'cozy');
    console.log('   ', r.label, ((r.dims || {}).areaFloor || 0).toFixed(1), '|', res.say);
  }
}
// (1) stage the whole house
clear();
const staged = stageHouse('cozy');
if (process.env.DEBUG) for (const r of staged.rooms) console.log('   ', r.room, r.area, r.placed.join(','));
for (const [name, re] of KINDS) rows.push({ case: `stage_house ${name}`, ...count(inKind(re)) });
rows.push({ case: 'stage_house all', ...count() });
void staged;

// (2) five separate adds from the scan points of each room kind
const ADDS = ['sofa', 'queen', 'desk', 'sofa', 'queen'];
for (const [name, re] of KINDS) {
  clear();
  const spots = house.panos.filter((p) => { const r = roomAt(p.pos[0], p.pos[1], p.floor); return r && re.test(r.label); });
  if (!spots.length) { rows.push({ case: `5 adds ${name}`, pieces: 0, doors: 0, scan: 0, under: 0, overlap: 0, detail: ['no scan point'] }); continue; }
  for (let i = 0; i < ADDS.length; i++) {
    standAt(spots[i % spots.length], (i * 77 * Math.PI) / 180);
    if (process.env.DEBUG === 'add') {
      const P = await import(new URL('placement.js', root).href);
      const { fitReport } = await import(new URL('fit.js', root).href);
      const r = roomAt(w.current.pos[0], w.current.pos[1], w.current.floor);
      const tally = {};
      for (const c of P.wallSpots(ADDS[i], r, { floor: r.floor })) {
        const why = P.rules(ADDS[i], c.x, c.y, c.rot, { floor: r.floor });
        const f = fitReport({ kind: ADDS[i], x: c.x, y: c.y, rot: c.rot, floor: r.floor });
        const k = [...why, ...(f.room === r ? f.reasons : ['other room'])].join(' + ') || 'OK';
        tally[k] = (tally[k] || 0) + 1;
      }
      console.log(ADDS[i], 'in', r.label, tally);
    }
    const res = await tools.add_furniture({ kind: ADDS[i] });
    if (process.env.DEBUG) console.log('   ', name, ADDS[i], '->', res.ok === false ? res.reason : `${res.room} ${res.fits ? 'fits' : res.fit} ${res.note || ''}`);
  }
  rows.push({ case: `5 adds ${name}`, ...count() });
}

console.log(`${house.name || model}`);
for (const r of rows) {
  console.log(`  ${r.case.padEnd(22)} pieces ${String(r.pieces).padStart(3)}  doors ${r.doors}  scan ${r.scan} (under ${r.under})  overlap ${r.overlap}`
    + (r.detail.length ? `   ${r.detail.join(' ')}` : ''));
}
const bad = rows.reduce((a, r) => a + r.doors + r.scan + r.overlap, 0);
console.log(bad ? `  ${bad} problems` : '  clean');
process.exit(STRICT && bad ? 1 : 0);
