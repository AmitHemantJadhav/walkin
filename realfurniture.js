// Move the furniture that is really in the house.
//
// Matterport gives every scan point twice: the room as scanned, and the same room digitally emptied
// (`img` and `imgEmpty`). Subtract one from the other and what is left is exactly the furniture — and
// the emptied photo is already the correct background to put behind it once it moves. That is the whole
// trick: the hard part of moving something in a photograph is inventing what was behind it, and
// Matterport has done that for us at all 39 scan points.
//
// Each piece found this way is cut out of the as-scanned photo, stood on the floor where it really
// stands (same local -> model calibration the sphere uses), and registered in FURNITURE so the
// existing physics, fit check and layout code treat it like anything else in the catalog.
//
// Exposed as walkin.realFurniture(). Talks to the viewer only through window.walkin.
import * as THREE from 'three';
import { FURNITURE } from './furniture.js';
import { localToModel } from './lighting.js';

const W = 1024, H = 512;                 // detection resolution: enough for a 25 cm object at 4 m
const DIFF = 35;                         // per-channel difference that counts as "something is here"
const MIN_PX = 1200;                     // smaller than this is clutter, not furniture
const MAX_REACH = 12;                    // metres: beyond this the floor ray is too grazing to trust

const a = document.createElement('canvas'); a.width = W; a.height = H;
const actx = a.getContext('2d', { willReadFrequently: true });
const b = document.createElement('canvas'); b.width = W; b.height = H;
const bctx = b.getContext('2d', { willReadFrequently: true });

const loaded = new Map();
function image(url) {
  if (!loaded.has(url)) loaded.set(url, new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(`can't load ${url}`));
    im.src = url;
  }));
  return loaded.get(url);
}

/** Pixel (px, py) of an equirect -> a unit direction in model space, for this pano. */
function dirAt(px, py, M) {
  const lon = ((px + 0.5) / W - 0.5) * 2 * Math.PI;
  const lat = ((1 - (py + 0.5) / H) - 0.5) * Math.PI;
  const v = new THREE.Vector3(Math.sin(lon) * Math.cos(lat), Math.sin(lat), Math.cos(lon) * Math.cos(lat));
  return v.applyMatrix4(M).normalize();
}

/** Label connected true-pixels of `mask`, iteratively (a recursive flood fill blows the stack at 1024x512). */
function label(mask) {
  const ids = new Int32Array(W * H);
  const blobs = [];
  const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || ids[i]) continue;
    const id = blobs.length + 1;
    let n = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
    const cols = new Map();                       // column -> lowest row, for the floor contact
    stack.push(i); ids[i] = id;
    while (stack.length) {
      const p = stack.pop(); n++;
      const x = p % W, y = (p / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      const low = cols.get(x);
      if (low === undefined || y > low) cols.set(x, y);
      // 4-neighbours, wrapping in x because an equirect joins at the seam
      const up = p - W, dn = p + W;
      if (y > 0 && mask[up] && !ids[up]) { ids[up] = id; stack.push(up); }
      if (y < H - 1 && mask[dn] && !ids[dn]) { ids[dn] = id; stack.push(dn); }
      const l = y * W + ((x - 1 + W) % W), r = y * W + ((x + 1) % W);
      if (mask[l] && !ids[l]) { ids[l] = id; stack.push(l); }
      if (mask[r] && !ids[r]) { ids[r] = id; stack.push(r); }
    }
    blobs.push({ id, n, x0, x1, y0, y1, cols });
  }
  return { ids, blobs };
}

/** Where a blob meets the floor, in model metres, plus how wide and tall it is. */
function standOn(blob, M, cam, floorZ) {
  const hits = [];
  for (const [x, lowY] of blob.cols) {
    const d = dirAt(x, lowY, M);
    if (d.z > -0.05) continue;                              // too shallow to be the floor
    const t = (floorZ - cam.z) / d.z;
    if (t <= 0 || t > MAX_REACH) continue;
    hits.push(new THREE.Vector3(cam.x + d.x * t, cam.y + d.y * t, floorZ));
  }
  if (hits.length < 6) return null;
  // Drop the far tail: the lowest pixel of a column is sometimes the piece's shadow or where it meets
  // the wall behind, both of which land further away than the piece does.
  hits.sort((p, q) => p.distanceToSquared(cam) - q.distanceToSquared(cam));
  const keep = hits.slice(0, Math.max(4, Math.round(hits.length * 0.8)));
  const c = keep.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / keep.length);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of keep) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const span = Math.hypot(maxX - minX, maxY - minY);
  const dist = Math.hypot(c.x - cam.x, c.y - cam.y);
  if (dist < 0.35 || span < 0.25) return null;              // under the tripod, or a sliver
  // Height: the top of the blob, read at the distance the piece actually stands at.
  const top = dirAt((blob.x0 + blob.x1) >> 1, blob.y0, M);
  const horiz = Math.hypot(top.x, top.y) || 1e-6;
  const height = cam.z + top.z * (dist / horiz) - floorZ;
  if (!(height > 0.15 && height < 2.6)) return null;
  return { pos: c, span, height, dist, yaw: Math.atan2(c.y - cam.y, c.x - cam.x) };
}

/**
 * Fill a blob's interior holes.
 *
 * A difference mask goes quiet wherever the furniture happens to match what Matterport painted behind
 * it — a grey sofa against a grey wall, or its shadow against dark boards — so pieces come out with
 * holes you can see the floor through. Anything fully enclosed by the blob is such a hole: flood the
 * blob's bounding box inward from its border through not-mine pixels, and whatever the flood never
 * reaches is interior and belongs to the piece. Holes that touch the box border are left alone, since
 * those are genuinely see-through, like the gap under a chair.
 */
function fillHoles(blob, ids) {
  const bw = blob.x1 - blob.x0 + 1, bh = blob.y1 - blob.y0 + 1;
  if (bw < 3 || bh < 3) return 0;
  const outside = new Uint8Array(bw * bh);
  const stack = [];
  const push = (x, y) => {
    const i = y * bw + x;
    if (outside[i] || ids[(blob.y0 + y) * W + (blob.x0 + x)] === blob.id) return;
    outside[i] = 1; stack.push(i);
  };
  for (let x = 0; x < bw; x++) { push(x, 0); push(x, bh - 1); }
  for (let y = 0; y < bh; y++) { push(0, y); push(bw - 1, y); }
  while (stack.length) {
    const i = stack.pop(), x = i % bw, y = (i / bw) | 0;
    if (x > 0) push(x - 1, y);
    if (x < bw - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < bh - 1) push(x, y + 1);
  }
  let filled = 0;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = y * bw + x, sp = (blob.y0 + y) * W + (blob.x0 + x);
    if (!outside[i] && ids[sp] !== blob.id) { ids[sp] = blob.id; filled++; }
  }
  return filled;
}

/**
 * Cut a blob out of the as-scanned photo: its own pixels, everything else transparent.
 *
 * The outline is eroded by a pixel first. A difference mask always runs a little wide — the edge of a
 * sofa sits between the sofa and the wall, and in a JPEG those pixels are a blend of both — so cutting
 * on the raw mask fringes every piece with a halo of wall. Eroding loses a pixel of sofa and takes the
 * halo with it, which reads far better than the speckled edge it replaces. The alpha is then a ramp
 * rather than a step, so the edge doesn't crawl when you move.
 */
function cutOut(blob, ids, src) {
  const bw = blob.x1 - blob.x0 + 1, bh = blob.y1 - blob.y0 + 1;
  const mine = (x, y) => (x < 0 || y < 0 || x >= bw || y >= bh)
    ? false : ids[(blob.y0 + y) * W + (blob.x0 + x)] === blob.id;
  const cv = document.createElement('canvas');
  cv.width = bw; cv.height = bh;
  const ctx = cv.getContext('2d');
  const out = ctx.createImageData(bw, bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const sp = (blob.y0 + y) * W + (blob.x0 + x), dp = (y * bw + x) * 4;
    if (ids[sp] !== blob.id) { out.data[dp + 3] = 0; continue; }
    out.data[dp] = src[sp * 4]; out.data[dp + 1] = src[sp * 4 + 1];
    out.data[dp + 2] = src[sp * 4 + 2];
    // how many of the 4 neighbours are also mine: 4 inside, fewer at the edge
    const n = (mine(x - 1, y) ? 1 : 0) + (mine(x + 1, y) ? 1 : 0)
            + (mine(x, y - 1) ? 1 : 0) + (mine(x, y + 1) ? 1 : 0);
    out.data[dp + 3] = n === 4 ? 255 : n >= 3 ? 150 : 0;
  }
  ctx.putImageData(out, 0, 0);
  return cv;
}

let seq = 0;
const made = [];

/**
 * Find the real furniture at the scan point you are standing on and stand it in the room as objects
 * you can pick up. Returns what it found. `walkin.realFurniture()`.
 */
export async function realFurniture({ minPx = MIN_PX, max = 8 } = {}) {
  const w = window.walkin;
  if (!w || !w.current) return { ok: false, say: 'the viewer is not ready' };
  const pano = w.current;
  if (!pano.imgEmpty) return { ok: false, say: 'this scan point has no emptied photo, so there is nothing to subtract' };
  const base = location.pathname.replace(/[^/]*$/, '') + `data/${w.house.model}/`;
  const t0 = performance.now();

  const [full, empty] = await Promise.all([image(base + pano.img), image(base + pano.imgEmpty)]);
  actx.drawImage(full, 0, 0, W, H);
  bctx.drawImage(empty, 0, 0, W, H);
  const A = actx.getImageData(0, 0, W, H).data, B = bctx.getImageData(0, 0, W, H).data;

  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    const d = Math.max(Math.abs(A[p] - B[p]), Math.abs(A[p + 1] - B[p + 1]), Math.abs(A[p + 2] - B[p + 2]));
    if (d > DIFF) mask[i] = 1;
  }
  const { ids, blobs } = label(mask);

  const M = localToModel(pano, w.cal);
  const cam = new THREE.Vector3(pano.pos[0], pano.pos[1], pano.pos[2]);
  const floorZ = pano.floorZ ?? 0;

  const found = [];
  for (const blob of blobs.sort((p, q) => q.n - p.n)) {
    if (found.length >= max) break;
    if (blob.n < minPx) continue;
    fillHoles(blob, ids);                                  // before measuring: a holed blob reads thin
    const st = standOn(blob, M, cam, floorZ);
    if (!st) continue;
    const room = w.roomAt(st.pos.x, st.pos.y);
    if (!room) continue;                                   // outside the plan: a reflection or the sky
    found.push({ blob, ...st, room: room.label });
  }

  for (const f of found) {
    const kind = `real${++seq}`;
    // Registered in the catalog so footprint(), the fit check, staging and layout all understand it.
    // fit.js and physics.js both write "the <name>", so the name must not start with an article:
    // "the the living room's own furniture" is what the first version said.
    FURNITURE[kind] = { name: 'piece the home already had', real: true,
                        w: +f.span.toFixed(2), d: +Math.min(f.span, 0.9).toFixed(2), h: +f.height.toFixed(2),
                        against: 'free' };
    const tex = new THREE.CanvasTexture(cutOut(f.blob, ids, A));
    tex.colorSpace = THREE.SRGBColorSpace;
    const g = new THREE.Group();
    const card = new THREE.Mesh(
      new THREE.PlaneGeometry(f.span, f.height),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, toneMapped: false, depthWrite: true }));
    card.rotation.x = Math.PI / 2;                         // stand it up: the plane's +y becomes world +z
    card.position.z = f.height / 2;
    card.renderOrder = 2;
    g.add(card);
    g.position.set(f.pos.x, f.pos.y, floorZ);
    g.rotation.z = f.yaw + Math.PI / 2;                    // face the scan point it was cut from
    g.userData.kind = kind;
    g.userData.real = true;
    g.userData.z0 = floorZ;
    w.furniture.add(g);
    f.kind = kind;
    made.push(g);
  }

  const ms = Math.round(performance.now() - t0);
  return { ok: true, ms, scanPoint: String(pano.label), blobs: blobs.length, placed: found.length,
           items: found.map((f) => ({ kind: f.kind, room: f.room, widthM: +f.span.toFixed(2),
                                      heightM: +f.height.toFixed(2), distM: +f.dist.toFixed(2),
                                      at: [+f.pos.x.toFixed(2), +f.pos.y.toFixed(2)] })),
           say: found.length ? `I found ${found.length} piece${found.length > 1 ? 's' : ''} of the home's own furniture — pick one up and move it.`
                             : 'I could not pick the real furniture out from here.' };
}

/** Take them all away again. */
export function clearRealFurniture() {
  let n = 0;
  for (const g of made.splice(0)) { if (g.parent) { g.parent.remove(g); n++; } }
  return n;
}

(function start(tries = 0) {
  if (!window.walkin) {
    if (tries < 600) return setTimeout(() => start(tries + 1), 50);
    return console.warn('realfurniture: window.walkin never appeared');
  }
  window.walkin.realFurniture = realFurniture;
  window.walkin.clearRealFurniture = clearRealFurniture;
})();
