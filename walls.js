// A4 — walkin.setWallMaterial(wall, textureUrl, tileMetres): put a material on one real wall.
// The quad sits 1 cm in front of the wall face on the viewer's side, runs the full room height, is split
// around doorways and windows (the API's `openings`), and repeats the texture at real-world scale.
// It lives in model space, so it is the same wall from every scan point - which is the point: CoStar's
// open problem #6 is that image-only edits don't survive a change of view, and this one does.
// Shading comes from the photo itself (see shade.js), so a wall in shadow stays in shadow.
import * as THREE from 'three';
import { panoLuminance } from './shade.js';
import { wallOffset, ceilingHeight, seenFrom, FIT } from './wallfit.js';

const WALL_H = 2.7;             // fallback when the API gives a room no height
const TOP_GAP = 0.04;           // stop just below the ceiling, so the offset below can't ride over the cornice
const TOP_GAP_SCAN = 0.008;     // the same with the ceiling measured off the scan (paint gaps): right up to it
// How far in front of the wall's centre line the quad sits. The wall graph is idealised and the empty-house
// mesh (the occluder) is a few centimetres into the room from it, so 1 cm leaves the paper buried: measured on
// La Mirada, anything under ~4 cm is almost entirely hidden, and polygon offset isn't enough on its own.
// #61: one fixed 8 cm ignores wall thickness, so the scan cut off 11-19% of the paper. Each wall is now
// measured against the mesh when it is papered (wallfit.js); OFFSET is the floor, and `?wallfit=off` puts
// every wall back on it.
const OFFSET = FIT.floor;
const WALLFIT = new URLSearchParams(location.search).get('wallfit') !== 'off';
// #91: the paper stands a few cm proud of the scanned face, so at a doorway or window edge you can see past
// its free edge to the trim behind it (La Mirada wall #1's 2.5 m doorway: paper at 25 cm, face at 21-24 cm).
// Fold the paper back at every opening edge by this much, like paper wrapped round a jamb. Wall ends meet
// the next wall at an inside corner, where the neighbour's face already hides the end, so they get none.
// `?wallreturn=off` (or `?wallfit=off`) leaves the edges open, as before.
const RETURN = 0.045;
const RETURNS = WALLFIT && new URLSearchParams(location.search).get('wallreturn') !== 'off';
// Paint gaps: the scan of the wall is lumpy (sills, skirting, trim, cornice, a few cm of mesh noise), and
// wherever a lump stands in front of the paper the depth-only occluder hid the paper and the photo's old wall
// showed through: tan slivers round windows, under the ceiling and in corners. So the paper's depth test is
// done as if it stood PULL metres further into the room (along the wall's normal, in the vertex shader):
// anything of the scan within PULL of the wall no longer covers it, anything further out (another room's wall,
// a kitchen run) still does. The paper stops writing depth, so furniture in front of it isn't hidden either,
// and it draws before the furniture (renderOrder 0.5). From where a wall is behind another wall, only
// FAR_PULL is used, so it can't show through near a corner. `?paintpull=off` = the old behaviour.
const PULL = 0.3;
const FAR_PULL = 0.02;
const NEAR_GAP = 0.4;           // the pull stops this far short of the camera
const PULLS = new URLSearchParams(location.search).get('paintpull') !== 'off';
const LIGHT_U = 24, LIGHT_V = 16; // resolution of the luminance map sampled off the pano

const group = new THREE.Group();
group.name = 'wall-materials';
const applied = new Map();      // key -> { mesh, wall, url, tile }
const texLoader = new THREE.TextureLoader();
const texCache = new Map();

const keyOf = (wall) => `${wall.floor || '-'}|${wall.index != null ? wall.index
  : `${wall.a}|${wall.b}`}`;

function loadTexture(url) {
  if (!texCache.has(url)) {
    texCache.set(url, new Promise((res, rej) => texLoader.load(url, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      res(t);
    }, undefined, rej)));
  }
  return texCache.get(url);
}

/** The wall record from house.json that a `{floor, index}` or `{a, b}` refers to. */
function findWall(wall) {
  const w = window.walkin;
  const floors = w.house.floors || [];
  const f = floors.find((x) => x.id === wall.floor) || floors[0];
  if (!f) return null;
  if (wall.index != null && f.walls[wall.index]) return { wall: f.walls[wall.index], floor: f };
  if (wall.a && wall.b) {                                  // match by endpoints, either way round
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.02;
    const hit = f.walls.find((x) => (near(x.a, wall.a) && near(x.b, wall.b))
      || (near(x.a, wall.b) && near(x.b, wall.a)));
    if (hit) return { wall: hit, floor: f };
  }
  return null;
}

/**
 * The wall split into the rectangles that are actually wall: full-height pieces between the openings,
 * plus the strips above and below each one. Coordinates are (u along the wall, v up from the floor).
 */
export function wallPanels(wall, height = WALL_H, ends = [0, 0]) {
  const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
  const holes = (wall.openings || [])
    .filter((o) => o && o.at != null)
    .map((o) => {
      const half = (o.width || 0.9) / 2;
      const c = o.at * len;
      const bottom = Math.max(0, o.bottom || 0);
      return { u0: Math.max(0, c - half), u1: Math.min(len, c + half),
        v0: bottom, v1: Math.min(height, bottom + (o.height || 2.05)) };
    })
    .filter((h) => h.u1 - h.u0 > 0.02)
    .sort((a, b) => a.u0 - b.u0);

  // paint gaps: `ends` = how far the paper runs past each end of the centre line (negative: stops short), to
  // meet the next wall's paper at a corner; not where an opening runs to the end of the wall
  const e0 = holes.length && holes[0].u0 <= 0.02 ? Math.min(0, ends[0]) : ends[0];
  const e1 = holes.some((h) => h.u1 >= len - 0.02) ? Math.min(0, ends[1]) : ends[1];
  const start = -e0, end = len + e1;
  const panels = [];
  let cursor = start;
  for (const h of holes) {
    if (h.u0 > cursor + 0.02) panels.push({ u0: cursor, u1: h.u0, v0: 0, v1: height });
    if (h.v0 > 0.02) panels.push({ u0: h.u0, u1: h.u1, v0: 0, v1: h.v0 });        // under a window
    if (h.v1 < height - 0.02) panels.push({ u0: h.u0, u1: h.u1, v0: h.v1, v1: height }); // over a door
    cursor = Math.max(cursor, h.u1);
  }
  if (cursor < end - 0.02) panels.push({ u0: cursor, u1: end, v0: 0, v1: height });
  return { panels: panels.filter((p) => p.u1 - p.u0 > 0.005), len, holes };
}

/**
 * #91: the strips that fold the paper back into each opening, `depth` deep, as [{ pos, uv, uv1 }] quads in
 * the wall's local frame (u along, v up, z out of the paper; z < 0 is toward the wall). Each one faces
 * into its opening and carries on the paper's texture round the edge. An edge gets one only where there is
 * paper on its far side: not at a wall end, the floor or the top, and not where two openings run together.
 */
export function openingReturns(holes, len, height, depth) {
  const inHole = (u, self) => holes.some((h) => h !== self && u > h.u0 && u < h.u1);
  const out = [];
  for (const h of holes) {
    const { u0, u1, v0, v1 } = h, d = depth;
    if (u0 > 0.02 && !inHole(u0 - 0.02, h)) {          // left jamb, paper at u < u0, faces +u
      out.push({ pos: [[u0, v0, 0], [u0, v0, -d], [u0, v1, -d], [u0, v1, 0]], uv: [[u0, v0], [u0 + d, v0], [u0 + d, v1], [u0, v1]] });
    }
    if (u1 < len - 0.02 && !inHole(u1 + 0.02, h)) {    // right jamb, paper at u > u1, faces -u
      out.push({ pos: [[u1, v0, -d], [u1, v0, 0], [u1, v1, 0], [u1, v1, -d]], uv: [[u1 - d, v0], [u1, v0], [u1, v1], [u1 - d, v1]] });
    }
    if (v1 < height - 0.02) {                          // head of a door or window, paper above, faces down
      out.push({ pos: [[u0, v1, 0], [u0, v1, -d], [u1, v1, -d], [u1, v1, 0]], uv: [[u0, v1], [u0, v1 - d], [u1, v1 - d], [u1, v1]] });
    }
    if (v0 > 0.02) {                                   // window sill, paper below, faces up
      out.push({ pos: [[u0, v0, -d], [u0, v0, 0], [u1, v0, 0], [u1, v0, -d]], uv: [[u0, v0 + d], [u0, v0], [u1, v0], [u1, v0 + d]] });
    }
  }
  for (const q of out) q.uv1 = q.pos.map(([u, v]) => [u / len, v / height]);
  return out;
}

/** One #91 return strip as geometry, the texture at real scale like the panels. */
function returnGeometry(q, tile) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(q.pos.flat(), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(q.uv.flat().map((x) => x / tile), 2));
  g.setAttribute('uv1', new THREE.Float32BufferAttribute(q.uv1.flat(), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/** One rectangle of wall as geometry: uv repeats at real scale, uv1 spans the whole wall for the shading. */
function panelGeometry(p, len, height, tile) {
  const g = new THREE.BufferGeometry();
  const pos = [], uv = [], uv1 = [];
  // paint gaps: neighbouring panels overlap by a few mm, or the seam between them shows as a hairline of photo
  const e = PULLS ? 0.003 : 0;
  for (const [u, v] of [[p.u0 - e, p.v0 - e], [p.u1 + e, p.v0 - e], [p.u1 + e, p.v1 + e], [p.u0 - e, p.v1 + e]]) {
    pos.push(u, v, 0);
    uv.push(u / tile, v / tile);
    uv1.push(u / len, v / height);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

// The occluder mesh as one flat model-space triangle list, made once per house (~50k triangles, ~2 MB).
let trisOf = { mesh: null, tris: null };
function occluderTris() {
  const mesh = window.walkin.occluderMesh;
  if (!mesh) return null;
  if (trisOf.mesh === mesh) return trisOf.tris;
  const out = [];
  const v = new THREE.Vector3();
  mesh.updateMatrixWorld(true);
  mesh.traverse((o) => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  });
  trisOf = { mesh, tris: Float32Array.from(out) };
  return trisOf.tris;
}

/**
 * How far from the centre line to put the paper on this face of `rec` (#61). Measured against the scan
 * mesh when there is one; with the wall-box occluders (no mesh) the box face is at half the thickness,
 * so stand just in front of that. `?wallfit=off` = the old fixed OFFSET everywhere.
 */
function paperOffset(rec, normal, floorZ, height) {
  if (!WALLFIT) return { offset: OFFSET, how: 'fixed' };
  const tris = occluderTris();
  if (tris) {
    const fit = wallOffset(tris, rec, normal, floorZ, height);
    return { ...fit, how: fit.cut == null ? 'unscanned' : 'scan' };
  }
  const half = (rec.thickness || 0.12) / 2;
  return { offset: +Math.min(FIT.cap, Math.max(OFFSET, half + FIT.margin)).toFixed(3), how: 'thickness' };
}

/**
 * How tall to paper a wall of `room`, less the gap under the cornice. Paint gaps: with the scan mesh, the
 * ceiling over this face of the wall (wallfit.js ceilingHeight), which the API's room height undershoots
 * by a few cm and some rooms don't have; else the room's height, else 2.7 m.
 */
function paperHeight(room, rec = null, normal = null, floorZ = 0) {
  const tris = WALLFIT && rec && normal ? occluderTris() : null;
  if (tris) {
    const k = `${rec.a}|${rec.b}|${normal.map((x) => x.toFixed(2))}|${floorZ.toFixed(2)}`;
    if (!ceilingCache.has(k)) {
      let c = null;
      try { c = ceilingHeight(tris, rec, normal, floorZ); } catch (e) { console.warn('walls: ceiling fit failed', e); }
      ceilingCache.set(k, c);
    }
    const c = ceilingCache.get(k);
    if (c != null && c > 2.0 && c < 4.0) return +(c - TOP_GAP_SCAN).toFixed(3);
  }
  const ceiling = (room && room.dims && room.dims.height > 1.8 && room.dims.height) || WALL_H;
  return Math.min(3.2, Math.max(2.2, ceiling)) - TOP_GAP;
}
const ceilingCache = new Map();
const offsetCache = new Map();

/** paperOffset, remembered per face (a neighbour's is asked for again by every wall it meets). */
function faceOffset(rec, normal, floorZ, height) {
  const k = `${rec.a}|${rec.b}|${normal.map((x) => x.toFixed(2))}|${floorZ.toFixed(2)}|${height}|${occluderTris() ? 1 : 0}`;
  if (!offsetCache.has(k)) offsetCache.set(k, paperOffset(rec, normal, floorZ, height));
  return offsetCache.get(k);
}

/**
 * Paint gaps: how far the paper on this face runs past each end of the wall's centre line, so it meets the
 * paper of the wall it turns into. At an inside corner that is short of the end (the neighbour's paper stands
 * off its own centre line, and two papers that overlap would fight now they don't write depth); at an
 * outside corner (a chimney breast, a wall end) past it, round the end of the wall, which used to stay bare.
 * [atA, atB] in metres, negative = stops short; 0 where no wall turns off that end.
 */
function cornerEnds(floor, rec, normal, offset, floorZ, height) {
  const len = Math.hypot(rec.b[0] - rec.a[0], rec.b[1] - rec.a[1]);
  const out = [0, 0];
  if (!WALLFIT || len < 0.3) return out;
  const [nx, ny] = normal;
  for (const [i, P, Q] of [[0, rec.a, rec.b], [1, rec.b, rec.a]]) {
    const da = [(Q[0] - P[0]) / len, (Q[1] - P[1]) / len];          // along this wall, away from the corner
    const near = (p) => Math.hypot(p[0] - P[0], p[1] - P[1]) < 0.03;
    let best = null;
    for (const o of floor.walls) {
      if (o === rec || (o.type && o.type !== 'wall')) continue;
      const far = near(o.a) ? o.b : near(o.b) ? o.a : null;
      if (!far) continue;
      const ol = Math.hypot(far[0] - P[0], far[1] - P[1]);
      if (ol < 0.3) continue;
      const db = [(far[0] - P[0]) / ol, (far[1] - P[1]) / ol];
      if (Math.abs(da[0] * db[0] + da[1] * db[1]) > 0.95) continue;  // straight on: nothing to meet
      // the neighbour's face on our side: at an inside corner both normals lean toward the other wall, outside both away
      const s = Math.sign(nx * db[0] + ny * db[1]);
      let nb = [-db[1], db[0]];
      if (Math.sign(nb[0] * da[0] + nb[1] * da[1]) !== s) nb = [-nb[0], -nb[1]];
      const k = da[0] * nb[0] + da[1] * nb[1];
      if (!best || Math.abs(k) > Math.abs(best.k)) best = { o, nb, k };
    }
    if (!best || Math.abs(best.k) < 0.2) continue;
    let offB = OFFSET;
    try { offB = faceOffset(best.o, best.nb, floorZ, height).offset; } catch (e) { /* keep the floor */ }
    const u = (offB - offset * (nx * best.nb[0] + ny * best.nb[1])) / best.k;   // where our paper meets theirs
    out[i] = Math.max(-0.35, Math.min(0.35, -u + 0.003));                       // and a few mm of overlap
  }
  return out;
}

/** Paint gaps: a material whose depth test stands `pull` metres out from the wall (see PULL). */
function paintMaterial(tex) {
  const material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide });
  if (!PULLS) return material;
  const pull = { value: FAR_PULL };
  material.userData.pull = pull;
  material.depthWrite = false;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPull = pull;
    shader.vertexShader = 'varying vec3 vPaintPos;\nvarying vec3 vPaintN;\n' + shader.vertexShader.replace('#include <project_vertex>',
      `#include <project_vertex>
  vPaintPos = mvPosition.xyz;
  vPaintN = normalMatrix * vec3( 0.0, 0.0, 1.0 );   // local z is the wall's normal, into the room`);
    // per pixel: the depth of where this pixel's ray meets the plane `pull` metres out from the paper, so the
    // scan counts as in front only if it is further out than that (done per pixel: a per-vertex depth
    // change isn't linear across a big quad and broke up near the camera)
    shader.fragmentShader = 'uniform float uPull;\nuniform mat4 projectionMatrix;\nvarying vec3 vPaintPos;\nvarying vec3 vPaintN;\n'
      + shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
  {
    vec3 nV = normalize( vPaintN );
    float dist = -dot( vPaintPos, nV );                       // the camera's distance from the paper's plane
    float pull = clamp( min( uPull, dist - 0.1 ), 0.0, uPull );
    vec4 c = projectionMatrix * vec4( vPaintPos * ( 1.0 - pull / max( dist, 1e-3 ) ), 1.0 );
    gl_FragDepth = clamp( c.z / c.w * 0.5 + 0.5, 0.0, 1.0 );
  }`);
  };
  material.customProgramCacheKey = () => 'walkin-paint-pull';
  return material;
}

/** Points on the paper the pull check looks at: above furniture height, clear of the openings. */
function pullSamples(rec, holes, len, height, normal, offset, floorZ) {
  const dx = (rec.b[0] - rec.a[0]) / (len || 1), dy = (rec.b[1] - rec.a[1]) / (len || 1);
  const pts = [];
  const n = Math.max(1, Math.round((len - 0.3) / 0.5));
  for (let i = 0; i <= n; i++) {
    const u = 0.15 + (len - 0.3) * (i / n);
    for (const v of [1.3, 2.0, height - 0.15]) {
      if (holes.some((h) => u > h.u0 - 0.1 && u < h.u1 + 0.1 && v > h.v0 - 0.1 && v < h.v1 + 0.1)) continue;
      pts.push([rec.a[0] + dx * u + normal[0] * (offset + 0.005), rec.a[1] + dy * u + normal[1] * (offset + 0.005), floorZ + v]);
    }
  }
  return pts;
}

/** Each papered face's pull for where the camera is now: the full PULL only where nothing but its own wall is in the way. */
function updatePull(only = null) {
  if (!PULLS) return;
  const w = window.walkin, cam = w && w.current && w.current.pos;
  const tris = occluderTris();
  for (const rec of only ? [only] : applied.values()) {
    if (!rec.pull) continue;
    let p = FAR_PULL;
    if (tris && cam && rec.samples && rec.samples.length) {
      // standing near the paper's plane (in a doorway beside it) everything you see of it is at a grazing
      // angle and "within PULL of the wall" stops meaning "part of this wall": keep NEAR_GAP clear
      const { p: q, n } = rec.plane;
      const camDist = (cam[0] - q[0]) * n[0] + (cam[1] - q[1]) * n[1];
      const want = Math.min(PULL, camDist - NEAR_GAP);
      try {
        if (want > FAR_PULL && seenFrom(tris, cam, rec.samples, rec.plane, want + 0.1) === 1) p = want;
      } catch (e) { console.warn('walls: pull check failed', e); }
    }
    rec.pull.value = p;
  }
}

/**
 * #61 step 3: how well wallpaper fits the walls of the room you're standing in. It measures them and
 * papers nothing. `walkin.wallFit()` → { ok, room, how, faces, measured, cut, fixedCut, worst, say }
 *   cut       share of the scanned wall face that is in front of the paper (so it hides it), 0..1
 *   fixedCut  the same at the old fixed 8 cm, what ?wallfit=off gives, for comparison
 *   worst     the face with the most cut: { index, cut, offset }
 * cut is null with no scan mesh to measure against (the wall-box occluders sit behind the paper anyway).
 * Meant for walkin.preflight's wallpaper row.
 */
export function wallFit() {
  const w = window.walkin;
  const cur = w && w.current;
  if (!cur || !cur.pos || !w.house) return { ok: false, why: 'no scan point yet' };
  const floors = w.house.floors || [];
  const f = floors.find((x) => x.id === cur.floor) || floors[0];
  if (!f || !f.walls || !f.walls.length) return { ok: false, why: 'no walls in the house data' };
  const tris = occluderTris();
  const here = w.roomAt(cur.pos[0], cur.pos[1], cur.floor) || null;
  const floorZ = cur.floorZ || 0, height = paperHeight(here);
  let faces = 0, measured = 0, n = 0, cutN = 0, fixedN = 0, worst = null;
  for (const [index, rec] of f.walls.entries()) {
    if (rec.type && rec.type !== 'wall') continue;
    const dx = rec.b[0] - rec.a[0], dy = rec.b[1] - rec.a[1], len = Math.hypot(dx, dy);
    if (len < 0.4) continue;
    const [nx, ny] = facingNormal(rec, cur.pos);
    // the face toward you counts if a step in front of it is the room you're in (in a hallway: within 4 m)
    const mx = (rec.a[0] + rec.b[0]) / 2, my = (rec.a[1] + rec.b[1]) / 2;
    if ((w.roomAt(mx + nx * 0.3, my + ny * 0.3, cur.floor) || null) !== here) continue;
    if (!here) {
      const t = Math.max(0, Math.min(1, ((cur.pos[0] - rec.a[0]) * dx + (cur.pos[1] - rec.a[1]) * dy) / (len * len)));
      if (Math.hypot(cur.pos[0] - rec.a[0] - dx * t, cur.pos[1] - rec.a[1] - dy * t) > 4) continue;
    }
    faces++;
    if (!tris) continue;
    const fit = wallOffset(tris, rec, [nx, ny], floorZ, height);
    if (fit.cut == null) continue;
    const cut = WALLFIT ? fit.cut : fit.fixedCut;
    measured++; n += fit.samples; cutN += cut * fit.samples; fixedN += fit.fixedCut * fit.samples;
    if (!worst || cut > worst.cut) worst = { index, cut, offset: WALLFIT ? fit.offset : OFFSET };
  }
  const cut = n ? +(cutN / n).toFixed(3) : null, fixedCut = n ? +(fixedN / n).toFixed(3) : null;
  const pc = (x) => `${Math.round(x * 100)}%`;
  const where = here && here.label ? `the ${here.label.toLowerCase()}` : 'here';
  return { ok: true, room: here ? here.label || null : null, how: !WALLFIT ? 'fixed' : tris ? 'scan' : 'thickness',
    faces, measured, cut, fixedCut, worst,
    say: cut == null ? `${faces} walls in ${where}, no scan mesh to measure against`
      : `${faces} walls in ${where}: the scan covers ${pc(cut)} of the paper`
        + (WALLFIT ? ` (${pc(fixedCut)} at a fixed 8 cm)` : ' (?wallfit=off)') };
}

/** Which way the wall faces the person looking at it. */
function facingNormal(wall, from) {
  const dx = wall.b[0] - wall.a[0], dy = wall.b[1] - wall.a[1];
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;
  const mx = (wall.a[0] + wall.b[0]) / 2, my = (wall.a[1] + wall.b[1]) / 2;
  if ((from[0] - mx) * nx + (from[1] - my) * ny < 0) { nx = -nx; ny = -ny; }
  return [nx, ny];
}

/**
 * Put `textureUrl` on `wall`, repeating every `tileMetres`.
 * `wall` is `walkin.pointer.wall` — `{floor, index, a, b, normal?}` — or anything with `a` and `b`.
 * Returns { ok, wall, tileMetres, panels, area, why }.
 */
export async function setWallMaterial(wall, textureUrl, tileMetres = 1) {
  const w = window.walkin;
  if (!w || !wall) return { ok: false, why: 'no wall given' };
  const found = findWall(wall);
  if (!found) return { ok: false, why: "that wall isn't in the house data" };
  if (!textureUrl) return { ok: false, why: 'no texture given' };
  const tile = Math.max(0.05, Math.min(8, Number(tileMetres) || 1));

  let tex;
  try { tex = await loadTexture(textureUrl); } catch (e) { return { ok: false, why: "the texture didn't load" }; }

  const rec = found.wall;
  const floorZ = (w.current && w.current.floorZ) || 0;
  const from0 = (w.current && w.current.pos) || [0, 0];
  const [pnx, pny] = facingNormal(rec, from0);
  // a wall midpoint sits exactly on the room boundary, so look the room up a step inside it
  const room = w.roomAt((rec.a[0] + rec.b[0]) / 2 + pnx * 0.3, (rec.a[1] + rec.b[1]) / 2 + pny * 0.3,
    w.current && w.current.floor);
  const from = (wall.normal && [(rec.a[0] + rec.b[0]) / 2 + wall.normal[0], (rec.a[1] + rec.b[1]) / 2 + wall.normal[1]])
    || from0;
  const [nx, ny] = facingNormal(rec, from);
  const height = paperHeight(room, rec, [nx, ny], floorZ);
  if (!wallPanels(rec, height).panels.length) return { ok: false, why: 'that wall is all doorway' };
  let fit;
  try { fit = faceOffset(rec, [nx, ny], floorZ, height); } catch (e) {
    console.warn('walls: wallfit failed, using the fixed offset', e);
    fit = { offset: OFFSET, how: 'fixed' };
  }
  let ends = [0, 0];
  try { ends = cornerEnds(found.floor, rec, [nx, ny], fit.offset, floorZ, height); } catch (e) { console.warn('walls: corner fit failed', e); }
  const { panels, len, holes } = wallPanels(rec, height, ends);

  clearWallMaterial(wall);

  // the cached texture is used as-is: the repeat is baked into uv, so no per-wall clone (and nothing to leak)
  const material = paintMaterial(tex);
  const order = PULLS ? 0.5 : 2;           // before the furniture: the paper no longer writes depth
  // the photo's own light and shade on this wall, as a light map over uv1
  const shade = await panoLuminance(rec, height, LIGHT_U, LIGHT_V, [nx, ny]);
  if (shade) {
    material.lightMap = shade;
    material.lightMapIntensity = shade.userData.scale || 1;   // the map is stored scaled to fit a byte
  }

  const mesh = new THREE.Group();
  const dirx = (rec.b[0] - rec.a[0]) / (len || 1), diry = (rec.b[1] - rec.a[1]) / (len || 1);
  for (const p of panels) {
    const m = new THREE.Mesh(panelGeometry(p, len, height, tile), material);
    m.renderOrder = order;                   // after the depth-only occluders
    mesh.add(m);
  }
  // #91: fold the paper back at the opening edges (never past the centre line)
  const returns = RETURNS ? openingReturns(holes, len, height, Math.min(RETURN, fit.offset)) : [];
  for (const q of returns) {
    const m = new THREE.Mesh(returnGeometry(q, tile), material);
    m.renderOrder = order;
    m.name = 'return';
    mesh.add(m);
  }
  // local (u, v, 0) -> world: u along the wall, v up, pushed out along the normal
  mesh.matrixAutoUpdate = false;
  mesh.matrix.set(
    dirx, 0, nx, rec.a[0] + nx * fit.offset,
    diry, 0, ny, rec.a[1] + ny * fit.offset,
    0, 1, 0, floorZ,
    0, 0, 0, 1,
  );
  group.add(mesh);
  if (!group.parent) w.scene.add(group);

  const area = panels.reduce((a, p) => a + (p.u1 - p.u0) * (p.v1 - p.v0), 0);
  const entry = {
    mesh, wall: { floor: found.floor.id, index: wall.index, a: rec.a, b: rec.b }, url: textureUrl, tile,
    pull: material.userData.pull || null, height,
    samples: pullSamples(rec, holes, len, height, [nx, ny], fit.offset, floorZ),
    plane: { p: [rec.a[0] + nx * fit.offset, rec.a[1] + ny * fit.offset, floorZ], n: [nx, ny, 0] },
  };
  applied.set(keyOf({ floor: found.floor.id, index: wall.index, a: rec.a, b: rec.b }), entry);
  updatePull(entry);
  return { ok: true, wall: { floor: found.floor.id, index: wall.index, a: rec.a, b: rec.b },
    tileMetres: tile, panels: panels.length, ends: ends.map((e) => +e.toFixed(3)),
    pull: material.userData.pull ? material.userData.pull.value : 0, returns: returns.length, length: +len.toFixed(2), height: +height.toFixed(2),
    area: +area.toFixed(1), room: room ? room.label : null,
    // #61: where the paper went and how much of the scanned face is still in front of it (cut: 0..1, null = not measured)
    fit: { offset: fit.offset, how: fit.how, samples: fit.samples || 0, cut: fit.cut ?? null },
    say: `${(area).toFixed(1)} m2 of wall${room ? ` in the ${room.label.toLowerCase()}` : ''}, repeating every ${tile} m` };
}

/** Free one wall's geometry, its material and the light map made for it (the texture itself is cached). */
function dispose(mesh) {
  const seen = new Set();
  mesh.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    if (seen.has(o.material)) return;            // one material is shared by all the panels of a wall
    seen.add(o.material);
    if (o.material.lightMap) o.material.lightMap.dispose();
    o.material.dispose();
  });
}

/** Take the material off one wall. */
export function clearWallMaterial(wall) {
  if (!wall) return 0;
  const found = findWall(wall);
  if (!found) return 0;
  const k = keyOf({ floor: found.floor.id, index: wall.index, a: found.wall.a, b: found.wall.b });
  const rec = applied.get(k);
  if (!rec) return 0;
  group.remove(rec.mesh);
  dispose(rec.mesh);
  applied.delete(k);
  return 1;
}

/** Take every wall material off. */
export function clearAllWallMaterials() {
  const n = applied.size;
  for (const rec of applied.values()) {
    group.remove(rec.mesh);
    dispose(rec.mesh);
  }
  applied.clear();
  return n;
}

/** What is on the walls now (layout.js and the agent can read this). */
export function wallMaterials() {
  return [...applied.values()].map(({ wall, url, tile }) => ({ wall, url, tileMetres: tile }));
}

// ------------------------------------------------------------------ keep the shading in step
let lastPano = null;
async function refreshShading() {
  for (const rec of applied.values()) {
    const found = findWall(rec.wall);
    if (!found) continue;
    const mats = [];
    rec.mesh.traverse((o) => { if (o.isMesh && !mats.includes(o.material)) mats.push(o.material); });
    const from = window.walkin.current.pos;
    const [rnx, rny] = facingNormal(found.wall, from);
    const room = window.walkin.roomAt((found.wall.a[0] + found.wall.b[0]) / 2 + rnx * 0.3,
      (found.wall.a[1] + found.wall.b[1]) / 2 + rny * 0.3, window.walkin.current.floor);
    const height = rec.height || paperHeight(room);          // the height the paper was cut to
    const shade = await panoLuminance(found.wall, height, LIGHT_U, LIGHT_V, facingNormal(found.wall, from));
    for (const m of mats) {
      if (m.lightMap) m.lightMap.dispose();      // the old map is replaced, not kept
      m.lightMap = shade || null;
      m.lightMapIntensity = shade ? (shade.userData.scale || 1) : 1;
      m.needsUpdate = true;
    }
  }
}

(function start(tries = 0) {
  if (!window.walkin) {
    if (tries < 600) return setTimeout(() => start(tries + 1), 50);
    return;
  }
  const w = window.walkin;
  w.setWallMaterial = setWallMaterial;
  w.clearWallMaterial = clearWallMaterial;
  w.clearAllWallMaterials = clearAllWallMaterials;
  w.wallMaterials = wallMaterials;
  w.wallFit = wallFit;
  w.scene.add(group);

  (function tick() {
    requestAnimationFrame(tick);
    if (!w.current || w.current.id === lastPano || !applied.size) { lastPano = w.current && w.current.id; return; }
    lastPano = w.current.id;
    updatePull();
    refreshShading().catch((e) => console.warn('walls: shading failed', e));
  })();
})();
