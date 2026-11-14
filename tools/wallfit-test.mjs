// node tools/wallfit-test.mjs [model ...]
// #61: how often the scan mesh sits further into the room than walls.js's OFFSET (8 cm from the centre
// line), i.e. how much wallpaper the occluder cuts off, per house. Reads data/<model>/house.json and the
// defurnished OBJ, rotates the mesh the way app.js placeMesh() does, then casts rays at every wall face.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { wallDepths, wallOffset } from '../wallfit.js';

const OFFSET = 0.08;      // walls.js
const OBJECT = 0.25;      // deeper than this is a thing (fireplace, cabinet), not the wall: the occluder should win
const FIT_OPTS = process.env.FIT_PCT ? { pct: +process.env.FIT_PCT } : {};   // FIT_PCT=0.75 to try another percentile

function loadObj(path) {
  const v = [], tris = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith('v ')) { const [, x, y, z] = line.trim().split(/\s+/); v.push([+x, +y, +z]); }
    else if (line.startsWith('f ')) {
      const idx = line.trim().split(/\s+/).slice(1).map((s) => { const i = parseInt(s, 10); return i < 0 ? v.length + i : i - 1; });
      for (let k = 1; k + 1 < idx.length; k++) for (const j of [idx[0], idx[k], idx[k + 1]]) tris.push(...v[j]);
    }
  }
  return tris;
}

// app.js placeMesh(): identity, rotX(+90), rotX(-90); keep the one whose box (+0.3 m) holds most scan points
function placeMesh(tris, panos) {
  const rots = [(x, y, z) => [x, y, z], (x, y, z) => [x, -z, y], (x, y, z) => [x, z, -y]];
  let best = null;
  for (const R of rots) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < tris.length; i += 3) {
      const p = R(tris[i], tris[i + 1], tris[i + 2]);
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    }
    const score = panos.filter((q) => q.pos.every((c, k) => c >= lo[k] - 0.3 && c <= hi[k] + 0.3)).length;
    if (!best || score > best.score) best = { R, score };
  }
  const out = new Float64Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) out.set(best.R(tris[i], tris[i + 1], tris[i + 2]), i);
  return { tris: out, fit: best.score / panos.length };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

const models = process.argv.slice(2).length ? process.argv.slice(2)
  : (existsSync('data') ? readdirSync('data').filter((m) => existsSync(`data/${m}/house.json`)) : []);
if (!models.length) { console.log('no houses in data/ (python prep_house.py <model>)'); process.exit(0); }

let failed = 0;
for (const m of models) {
  const house = JSON.parse(readFileSync(`data/${m}/house.json`, 'utf8'));
  const mesh = (house.meshes || []).find((x) => /defurnished/i.test(x.file));
  if (!mesh || !existsSync(`data/${m}/${mesh.file}`)) { console.log(`${m}: no defurnished mesh, skipped`); continue; }
  const t0 = Date.now();
  const { tris, fit } = placeMesh(loadObj(`data/${m}/${mesh.file}`), house.panos);
  let samples = 0, buried = 0, objects = 0, fitted = 0;
  const offsets = [];
  const bad = [];
  for (const f of house.floors || []) {
    const zs = house.panos.filter((p) => p.floor === f.id && p.floorZ != null).map((p) => p.floorZ);
    if (!zs.length) continue;
    const floorZ = median(zs);
    f.walls.forEach((w, index) => {
      if (w.type && w.type !== 'wall') return;
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      if (len < 0.4) return;
      const n = [-(w.b[1] - w.a[1]) / len, (w.b[0] - w.a[0]) / len];
      for (const s of [1, -1]) {
        // only faces the scanner saw: the surface is on this side of the centre line
        const d = wallDepths(tris, w, [n[0] * s, n[1] * s], floorZ, 2.6).filter((x) => x.depth != null && x.depth > -0.02);
        if (d.length < 4) continue;
        const wallOnly = d.filter((x) => x.depth <= OBJECT);
        const under = wallOnly.filter((x) => x.depth > OFFSET + 0.01);   // clearly in front of the paper, not a tie
        samples += d.length; objects += d.length - wallOnly.length; buried += under.length;
        // step 2: the per-wall offset walls.js now uses, and what it still leaves cut
        const fit = wallOffset(tris, w, [n[0] * s, n[1] * s], floorZ, 2.6, FIT_OPTS);
        fitted += wallOnly.filter((x) => x.depth > fit.offset + 0.01).length;
        offsets.push(fit.offset);
        if (under.length / d.length > 0.1) {
          bad.push({ floor: f.id, index, side: s, len: +len.toFixed(2), share: Math.round(100 * under.length / d.length),
            worst: +Math.max(...under.map((x) => x.depth)).toFixed(3), med: +median(wallOnly.map((x) => x.depth)).toFixed(3),
            half: (w.thickness || 0.12) / 2, lowRows: under.filter((x) => x.v < 0.6).length });
        }
      }
    });
  }
  const share = samples ? (100 * buried / samples) : 0;
  console.log(`${m} ${house.name}: mesh fit ${(fit * 100).toFixed(0)}%, ${samples} samples on scanned wall faces, `
    + `${share.toFixed(1)}% where the scan is > ${OFFSET * 100 + 1} cm out (paper cut off), ${objects} on objects > ${OBJECT * 100} cm, ${Date.now() - t0} ms`);
  const after = samples ? (100 * fitted / samples) : 0;
  const os = [...offsets].sort((x, y) => x - y);
  console.log(`   per-wall offset (#61 step 2): ${after.toFixed(1)}% still cut; offsets over ${os.length} faces: `
    + `median ${(100 * median(os)).toFixed(1)} cm, 90th ${(100 * os[Math.floor(0.9 * (os.length - 1))]).toFixed(1)} cm, `
    + `max ${(100 * os[os.length - 1]).toFixed(1)} cm, ${os.filter((x) => x > OFFSET + 0.001).length} faces moved out`);
  if (samples && after >= share) { console.log('   FAIL: the per-wall offset cuts no less than the fixed one'); failed++; }
  for (const b of bad.sort((x, y) => y.share - x.share).slice(0, 6)) {
    console.log(`   wall ${b.floor}#${b.index} side ${b.side > 0 ? '+' : '-'} (${b.len} m, half-thickness ${b.half}): `
      + `${b.share}% cut, scan face median ${b.med} m / worst ${b.worst} m from centre, ${b.lowRows} cut samples below 0.6 m`);
  }
  if (!samples) { console.log('   FAIL: no wall face found in the mesh'); failed++; }
}
process.exit(failed ? 1 : 0);
