// node tools/walls-test.mjs [model]   (#61 step 2, no browser needed)
// Runs the real walls.js setWallMaterial() against the vendored three.js and the real OBJLoader, with the
// empty-house mesh placed the way app.js placeMesh() does, and checks that every papered wall face:
//  - sits where wallfit.js says (same offset as tools/wallfit-test.mjs's own triangle path, to 1 mm),
//  - is never nearer the centre line than the old fixed 8 cm, never further than the 25 cm cap,
//  - goes back to exactly 8 cm with ?wallfit=off, and to half the wall thickness + 1.5 cm with no mesh.
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { wallOffset } from '../wallfit.js';

const root = new URL('..', import.meta.url);
const threeUrl = new URL('vendor/three/build/three.module.js', root).href;
const model = process.argv[2] || 'zvKHR9DHNjJ';
if (!existsSync(`data/${model}/house.json`)) { console.log(`no data/${model} (python prep_house.py ${model}), skipped`); process.exit(0); }
const house = JSON.parse(readFileSync(`data/${model}/house.json`, 'utf8'));
const meshInfo = (house.meshes || []).find((x) => /defurnished/i.test(x.file));
if (!meshInfo || !existsSync(`data/${model}/${meshInfo.file}`)) { console.log(`${model}: no defurnished mesh, skipped`); process.exit(0); }

// browser bits walls.js touches at load time
globalThis.window = globalThis;
globalThis.requestAnimationFrame = () => 0;
const THREE = await import(threeUrl);
THREE.TextureLoader.prototype.load = function (url, onLoad) { const t = new THREE.Texture(); setTimeout(() => onLoad(t)); return t; };

// load a module with its bare/relative imports pointed at real files (or a stub for the pano shading)
const tmps = [];
async function load(file, search = '') {
  let src = readFileSync(new URL(file, root), 'utf8').replaceAll("from 'three'", `from '${threeUrl}'`);
  src = src.replace("from './shade.js'", `from 'data:text/javascript,export async function panoLuminance() { return null; }'`)
    .replace("from './wallfit.js'", `from '${new URL('wallfit.js', root).href}'`);
  const tmp = new URL(`tools/.under-test-${tmps.length}.mjs`, root);
  writeFileSync(tmp, src); tmps.push(tmp);
  globalThis.location = { search };
  try { return await import(tmp.href); } finally { rmSync(tmp); }
}
const { OBJLoader } = await load('vendor/three/examples/jsm/loaders/OBJLoader.js');

// app.js loadOccluderMesh() + placeMesh()
const obj = new OBJLoader().parse(readFileSync(`data/${model}/${meshInfo.file}`, 'utf8'));
const pts = house.panos.map((p) => new THREE.Vector3(...p.pos));
let best = null;
for (const R of [new THREE.Matrix4(), new THREE.Matrix4().makeRotationX(Math.PI / 2), new THREE.Matrix4().makeRotationX(-Math.PI / 2)]) {
  obj.matrix.copy(R); obj.matrixAutoUpdate = false; obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj).expandByScalar(0.3);
  const score = pts.filter((v) => box.containsPoint(v)).length;
  if (!best || score > best.score) best = { R, score };
}
obj.matrix.copy(best.R); obj.updateMatrixWorld(true);

// the same triangles the way tools/wallfit-test.mjs reads them, as the reference
const ref = [];
obj.traverse((o) => {
  if (!o.isMesh) return;
  const p = o.geometry.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); ref.push(v.x, v.y, v.z); }
});

const f = house.floors[0];
const zs = house.panos.filter((p) => p.floor === f.id && p.floorZ != null).map((p) => p.floorZ).sort((a, b) => a - b);
const floorZ = zs[zs.length >> 1];
const scene = new THREE.Scene();
window.walkin = { house, scene, roomAt: () => null, occluderMesh: obj,
  current: { id: 'x', floor: f.id, floorZ, pos: [0, 0, floorZ + 1.5] } };

const walls = await load('walls.js');
const off = await load('walls.js', '?wallfit=off');
const H = 2.7 - 0.04;   // walls.js height with roomAt() unknown

let fails = 0, faces = 0, moved = 0, maxDiff = 0, returns = 0;
const bad = (what) => { fails++; if (fails <= 8) console.log('FAIL', what); };
const t0 = Date.now();
for (const [index, w] of f.walls.entries()) {
  if (w.type && w.type !== 'wall') continue;
  const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  if (len < 0.4) continue;
  const n = [-(w.b[1] - w.a[1]) / len, (w.b[0] - w.a[0]) / len];
  for (const s of [1, -1]) {
    const normal = [n[0] * s, n[1] * s];
    const r = await walls.setWallMaterial({ floor: f.id, index, normal }, 'tile.png', 1);
    if (!r.ok) { if (r.why !== 'that wall is all doorway') bad(`#${index}: ${r.why}`); continue; }
    faces++;
    const want = wallOffset(ref, w, normal, floorZ, H).offset;
    maxDiff = Math.max(maxDiff, Math.abs(r.fit.offset - want));
    if (Math.abs(r.fit.offset - want) > 0.001) bad(`#${index} side ${s}: offset ${r.fit.offset}, wallfit.js says ${want}`);
    if (r.fit.offset < 0.08 - 1e-9 || r.fit.offset > 0.25 + 1e-9) bad(`#${index}: offset ${r.fit.offset} outside 8-25 cm`);
    if (r.fit.offset > 0.081) moved++;
    // the quad really is there: its origin is a + normal * offset
    const m = scene.getObjectByName('wall-materials').children.at(-1).matrix.elements;
    if (Math.hypot(m[12] - (w.a[0] + normal[0] * r.fit.offset), m[13] - (w.a[1] + normal[1] * r.fit.offset)) > 1e-4) bad(`#${index}: quad not at the offset`);
    // #91: every return strip faces into an opening (a step along its normal lands in a hole) and stays
    // between the paper and the centre line
    const { holes } = walls.wallPanels(w, r.height);
    const rets = scene.getObjectByName('wall-materials').children.at(-1).children.filter((c) => c.name === 'return');
    if (rets.length !== r.returns) bad(`#${index}: ${rets.length} return meshes, result says ${r.returns}`);
    returns += rets.length;
    for (const c of rets) {
      const p = c.geometry.attributes.position, nn = c.geometry.attributes.normal;
      let cu = 0, cv = 0, zmin = 0;
      for (let i = 0; i < 4; i++) { cu += p.getX(i) / 4; cv += p.getY(i) / 4; zmin = Math.min(zmin, p.getZ(i)); }
      const su = cu + nn.getX(0) * 0.03, sv = cv + nn.getY(0) * 0.03;
      if (!holes.some((h) => su > h.u0 && su < h.u1 && sv > h.v0 && sv < h.v1)) bad(`#${index}: a return faces away from its opening`);
      if (Math.abs(nn.getZ(0)) > 1e-6 || zmin < -Math.min(0.045, r.fit.offset) - 1e-6) bad(`#${index}: return off the paper edge (z ${zmin})`);
    }
    const o = await off.setWallMaterial({ floor: f.id, index, normal }, 'tile.png', 1);
    if (o.fit.offset !== 0.08 || o.fit.how !== 'fixed') bad(`#${index}: ?wallfit=off gave ${JSON.stringify(o.fit)}`);
    if (o.returns !== 0) bad(`#${index}: ?wallfit=off still folds the paper back (${o.returns})`);
  }
}
// the thickest wall, with the mesh and then without it (the wall-box occluders: stand just in front of the box face)
const thick = f.walls.findIndex((w) => (w.thickness || 0) > 0.2 && (!w.type || w.type === 'wall'));
if (thick >= 0) {
  for (const s of [1, -1]) {
    const w = f.walls[thick], len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const r = await walls.setWallMaterial({ floor: f.id, index: thick, normal: [-(w.b[1] - w.a[1]) / len * s, (w.b[0] - w.a[0]) / len * s] }, 'tile.png', 1);
    if (r.ok) console.log(`     wall #${thick} side ${s > 0 ? '+' : '-'} with the mesh: ${JSON.stringify(r.fit)}, ${r.returns} returns`);
  }
}
// #61 step 3: walkin.wallFit() from every scan point, with app.js's roomAt (point in room polygon)
const inPoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
window.walkin.roomAt = (x, y, fl) => house.rooms.find((r) => r.poly && r.poly.length > 2
  && (!fl || !r.floor || r.floor === fl) && inPoly(x, y, r.poly));
let fitN = 0, fitCut = 0, fitFixed = 0, fitPts = 0, worstFit = null;
const tf = Date.now();
for (const p of house.panos) {
  if (p.floorZ == null) continue;
  window.walkin.current = { id: p.id, floor: p.floor, floorZ: p.floorZ, pos: p.pos };
  const r = walls.wallFit(), o = off.wallFit();
  if (!r.ok) { bad(`wallFit at ${p.id}: ${r.why}`); continue; }
  if (r.how !== 'scan' || o.how !== 'fixed') bad(`wallFit how: ${r.how} / ${o.how}`);
  if (r.faces !== o.faces || r.fixedCut !== o.cut) bad(`wallFit at ${p.id}: off ${JSON.stringify(o)} vs on ${JSON.stringify(r)}`);
  if (!r.measured) continue;
  if (r.cut > r.fixedCut + 1e-9) bad(`wallFit at ${p.id}: worse than the fixed offset (${r.cut} > ${r.fixedCut})`);
  fitPts++; fitN += r.measured; fitCut += r.cut; fitFixed += r.fixedCut;
  if (!worstFit || r.cut > worstFit.cut) worstFit = r;
}
console.log(`${fitPts ? 'ok  ' : 'FAIL'} wallFit() at ${fitPts} scan points (${(fitN / Math.max(1, fitPts)).toFixed(1)} walls each, `
  + `${Date.now() - tf} ms): scan covers ${(100 * fitCut / Math.max(1, fitPts)).toFixed(1)}% of the paper on average, `
  + `${(100 * fitFixed / Math.max(1, fitPts)).toFixed(1)}% at a fixed 8 cm`);
if (!fitPts) fails++;
if (worstFit) console.log(`     worst room: ${worstFit.say}`);
window.walkin.roomAt = () => null;
window.walkin.occluderMesh = null;
{
  const r = walls.wallFit();
  if (!r.ok || r.cut !== null || r.how !== 'thickness') bad(`wallFit with no mesh: ${JSON.stringify(r)}`);
}
if (thick >= 0) {
  const r = await walls.setWallMaterial({ floor: f.id, index: thick }, 'tile.png', 1);
  const want = +Math.max(0.08, f.walls[thick].thickness / 2 + 0.015).toFixed(3);
  if (r.fit.how !== 'thickness' || r.fit.offset !== want) bad(`no mesh, wall #${thick}: ${JSON.stringify(r.fit)}, want ${want}`);
  else console.log(`ok   no mesh: wall #${thick} (${f.walls[thick].thickness} m thick) papered at ${r.fit.offset} m`);
}
walls.clearAllWallMaterials(); off.clearAllWallMaterials();
console.log(`${fails ? 'FAIL' : 'ok  '} ${house.name}: ${faces} faces papered through walls.js, ${moved} moved out past 8 cm, `
  + `${returns} returns at opening edges, `
  + `max difference from wallfit.js ${(maxDiff * 1000).toFixed(2)} mm, ${Date.now() - t0} ms`);
process.exit(fails ? 1 : 0);
