// #61 — where the scanned wall really is, so wallpaper can sit just in front of it.
// The wall graph is an idealised centre line; the empty-house mesh (the occluder) is the scan, and in
// places it bulges further into the room than walls.js's fixed OFFSET (8 cm from the centre line).
// There the occluder wins and the paper is cut off (314 Gale St, dining room, a diagonal near the floor).
// This file only measures: cast a ray from inside the room straight at the wall and see where the mesh is.
// Pure maths on a flat triangle list, no three.js, so `node tools/wallfit-test.mjs` runs it on real houses.

/**
 * Triangles of `tris` (flat [ax,ay,az, bx,by,bz, cx,cy,cz, ...] in model space, Z up) that come within
 * `reach` metres of the wall segment in plan and overlap [z0, z1]. A cheap filter so each ray only tests
 * a few hundred triangles instead of 50k.
 */
export function trianglesNearWall(tris, wall, z0, z1, reach = 0.4) {
  const [ax, ay] = wall.a, [bx, by] = wall.b;
  const minX = Math.min(ax, bx) - reach, maxX = Math.max(ax, bx) + reach;
  const minY = Math.min(ay, by) - reach, maxY = Math.max(ay, by) + reach;
  const out = [];
  for (let i = 0; i < tris.length; i += 9) {
    const x0 = Math.min(tris[i], tris[i + 3], tris[i + 6]), x1 = Math.max(tris[i], tris[i + 3], tris[i + 6]);
    if (x1 < minX || x0 > maxX) continue;
    const y0 = Math.min(tris[i + 1], tris[i + 4], tris[i + 7]), y1 = Math.max(tris[i + 1], tris[i + 4], tris[i + 7]);
    if (y1 < minY || y0 > maxY) continue;
    const zl = Math.min(tris[i + 2], tris[i + 5], tris[i + 8]), zh = Math.max(tris[i + 2], tris[i + 5], tris[i + 8]);
    if (zh < z0 || zl > z1) continue;
    for (let k = 0; k < 9; k++) out.push(tris[i + k]);
  }
  return out;
}

/** Nearest hit distance of the ray o + t·d against `tris` (both faces), or Infinity. Möller–Trumbore. */
export function rayHit(tris, o, d, tMax = Infinity) {
  let best = tMax;
  for (let i = 0; i < tris.length; i += 9) {
    const e1x = tris[i + 3] - tris[i], e1y = tris[i + 4] - tris[i + 1], e1z = tris[i + 5] - tris[i + 2];
    const e2x = tris[i + 6] - tris[i], e2y = tris[i + 7] - tris[i + 1], e2z = tris[i + 8] - tris[i + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const sx = o[0] - tris[i], sy = o[1] - tris[i + 1], sz = o[2] - tris[i + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 0 && t < best) best = t;
  }
  return best;
}

/**
 * How far in front of the wall's centre line the scan surface is, on a grid over one face of the wall.
 * `normal` = unit [nx, ny] pointing into the room on the side being measured.
 * Returns [{u, v, depth}] with depth in metres from the centre line toward the room (null = no surface
 * found within `reach`, e.g. an exterior face the scanner never saw).
 */
export function wallDepths(tris, wall, normal, floorZ, height, { step = 0.2, reach = 0.4, endTrim = 0.15 } = {}) {
  const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
  if (len < 2 * endTrim + 0.05) return [];
  const dx = (wall.b[0] - wall.a[0]) / len, dy = (wall.b[1] - wall.a[1]) / len;
  const [nx, ny] = normal;
  const near = trianglesNearWall(tris, wall, floorZ, floorZ + height, reach);
  const holes = (wall.openings || []).filter((o) => o && o.at != null).map((o) => {
    const c = o.at * len, half = (o.width || 0.9) / 2, bottom = Math.max(0, o.bottom || 0);
    return { u0: c - half - 0.05, u1: c + half + 0.05, v0: bottom - 0.05, v1: bottom + (o.height || 2.05) + 0.05 };
  });
  const dir = [-nx, -ny, 0];
  const out = [];
  for (let u = endTrim; u <= len - endTrim + 1e-9; u += step) {
    for (let v = 0.1; v <= height - 0.1 + 1e-9; v += step) {
      if (holes.some((h) => u > h.u0 && u < h.u1 && v > h.v0 && v < h.v1)) continue;
      const o = [wall.a[0] + dx * u + nx * reach, wall.a[1] + dy * u + ny * reach, floorZ + v];
      const t = rayHit(near, o, dir, reach + 0.3);
      out.push({ u: +u.toFixed(2), v: +v.toFixed(2), depth: Number.isFinite(t) && t <= reach + 0.3 ? reach - t : null });
    }
  }
  return out;
}

export const FIT = {
  floor: 0.08,      // never closer to the centre line than walls.js's old fixed offset
  cap: 0.25,        // deeper than this is a thing (fireplace, cabinet), not the wall: the occluder should win
  // stand in front of this share of the scanned face... 0.75 leaves 3-5% of samples cut (0.9: 1-2%) but
  // keeps the paper nearer the wall, so a fireplace covering part of it still wins (node tools/wallfit-test.mjs)
  pct: 0.75,
  margin: 0.015,    // ...by this much
};

/**
 * #61 step 2: how far from the centre line one face of a wall should be papered so the scan doesn't cut it.
 * A percentile of the measured face plus a small margin, between FIT.floor and FIT.cap. On purpose, it
 * does not chase the worst sample: a percentile plus a cap means a few samples (a bump, a skirting
 * board, the edge of a fireplace) stay in front of the paper, the way a real fireplace would.
 * Returns { offset, samples, cut, fixedCut } where cut = share of measured samples still in front of the
 * paper, and fixedCut = the same at FIT.floor (the old fixed offset, what ?wallfit=off gives).
 * With under 4 mesh samples (a face the scanner never saw) it returns the floor and both cuts null.
 */
export function wallOffset(tris, wall, normal, floorZ, height, opts = {}) {
  const o = { ...FIT, ...opts };
  const d = wallDepths(tris, wall, normal, floorZ, height)
    .map((x) => x.depth)
    .filter((x) => x != null && x > -0.02 && x <= o.cap);
  if (d.length < 4) return { offset: o.floor, samples: d.length, cut: null, fixedCut: null };
  d.sort((a, b) => a - b);
  const p = d[Math.min(d.length - 1, Math.floor(o.pct * d.length))];
  const offset = Math.min(o.cap, Math.max(o.floor, p + o.margin));
  const cutAt = (off) => +(d.filter((x) => x > off + 0.01).length / d.length).toFixed(3);
  return { offset: +offset.toFixed(3), samples: d.length, cut: cutAt(offset), fixedCut: cutAt(o.floor) };
}
