// A5 radial menu, no browser needed:  node tools/radial-test.mjs
// Loads radial.js against the vendored three.js with a stub canvas and checks open / pick / cancel / screen edges.
// The gesture side (pinch-hold in app.js) is checked in a browser by tools/radial-check.html.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
const root = new URL('..', import.meta.url);
const threeUrl = new URL('vendor/three/build/three.module.js', root).href;
const src = readFileSync(new URL('radial.js', root), 'utf8').replace("from 'three'", `from '${threeUrl}'`);
const tmp = new URL('tools/.radial-under-test.mjs', root);
writeFileSync(tmp, src);
// measureText is the one canvas call radial.js reads a value from (it shrinks a label until it fits): answer
// like a canvas would, about 0.55 em per character, so the shrink loop ends
const ctx = new Proxy({ measureText: (s) => ({ width: String(s).length * 0.55 * (parseInt(String(ctx.font || '').match(/(\d+)px/)?.[1], 10) || 16) }) },
  { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
const THREE = await import(threeUrl);
const { createRadial } = await import(tmp.href);
rmSync(tmp);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 500);
camera.up.set(0, 0, 1); camera.position.set(1, 2, 1.5); camera.lookAt(3, 2, 1.5); camera.updateMatrixWorld();
const toWorld = (sx, sy, d, out) => out.set(sx * 2 - 1, -(sy * 2 - 1), 0.5).unproject(camera).sub(camera.position)
  .normalize().multiplyScalar(d).add(camera.position);
const ran = [];
let empty = true;
const names = ['Sofa', 'Bed', 'Table', 'Plant', 'Empty', 'Talk'];
const items = names.map((n) => ({ icon: '*', label: n === 'Empty' ? () => (empty ? 'Scanned' : 'Empty') : n, run: (f) => ran.push([n, f]) }));
const r = createRadial({ scene, camera, toWorld, aspect: () => 16 / 9, items });
let fails = 0;
const eq = (a, b, what) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fails++; console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };

eq(r.side, null, 'closed at start');
const floor = { x: 3, y: 2, z: 0 };
r.open('Right', 0.5, 0.5, floor);
eq(r.state, { side: 'Right', hot: null, label: null }, 'open, nothing hot');
const g = scene.children[0];
eq(g.visible, true, 'menu visible');
// every option sits 0.55 m from the camera, and the top one is above the centre (z up)
const d = g.children.map((s) => +s.position.distanceTo(camera.position).toFixed(3));
eq(d.every((v) => v === 0.55), true, 'all at 0.55 m');
eq(g.children[0].position.z > g.children[6].position.z, true, 'Sofa above the centre');
r.point(0.5, 0.49); eq(r.state.hot, null, 'tiny move = dead zone');
r.point(0.5, 0.40); eq(r.state.label, 'Sofa', 'up = Sofa');
r.point(0.56, 0.44); eq(r.state.label, 'Bed', 'up-right = Bed');
r.point(0.56, 0.56); eq(r.state.label, 'Table', 'down-right = Table');
r.point(0.5, 0.62); eq(r.state.label, 'Plant', 'down = Plant');
r.point(0.44, 0.56); eq(r.state.label, 'Scanned', 'down-left = Empty/Scanned toggle (label follows state)');
r.point(0.44, 0.44); eq(r.state.label, 'Talk', 'up-left = Talk');
r.layout();
eq(+(g.children[5].scale.x / g.children[0].scale.x).toFixed(2), 1.3, 'hot option grows');
eq(r.release(), 'Talk', 'release picks Talk');
eq(ran.map((x) => x[0]), ['Talk'], 'Talk ran');
eq(r.side, null, 'closed after release'); eq(g.visible, false, 'hidden after release');

r.open('Left', 0.97, 0.03, floor); // pinched in a corner: ring is clamped on screen, picking is by direction
r.point(0.97, 0.12); eq(r.state.label, 'Plant', 'corner: down still = Plant');
r.layout();
const ndc = g.children.map((s) => s.position.clone().project(camera));
eq(ndc.every((p) => Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1), true, 'corner: whole ring on screen');
eq(r.release(), 'Plant', 'release picks Plant'); eq(ran.at(-1), ['Plant', floor], 'Plant got the pinch floor point');

r.open('Right', 0.5, 0.5, null); r.point(0.5, 0.40); r.point(0.5, 0.5);
eq(r.release(), null, 'back to centre and let go = cancel'); eq(ran.length, 2, 'nothing ran');
empty = false; r.open('Right', 0.5, 0.5, null); r.point(0.44, 0.56); eq(r.state.label, 'Empty', 'label redrawn on reopen');
r.cancel(); eq(r.side, null, 'cancel closes');
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exitCode = fails ? 1 : 0;
