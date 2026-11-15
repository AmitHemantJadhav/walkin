// Where the light comes from, morning to night: direct sun on the real floor through the real windows.
//
// A buyer asks "does the kitchen get morning sun?" and the listing can't answer it. Here the answer is drawn:
// pick a date and drag the hour, and the patches of sunlight slide across the floor of the room you are
// standing in, from the windows that really face the sun. In an office it says which bays get the afternoon
// glare, and which stay in shade behind the core.
//
// Three facts make it: the wall graph gives every window as a rectangle in model space (centre `at` along the
// wall, width, sill, height); tools/geo.py gives the compass bearing of the model's +Y axis, so a compass
// azimuth becomes a model-frame direction; the NOAA solar algorithm gives the sun's azimuth and elevation
// for the house's latitude and longitude at any civil time. Project each sunward window's four corners along
// the sun ray onto the floor and the lit quadrilateral falls out. It is cut into 15 cm cells and a cell is kept
// only if the straight line from the window to it crosses no other wall - that is what keeps the light out
// of the rooms behind, and it is why room polygons are not used (the office's big room has a broken one).
//
// Exposed as walkin.sun / walkin.sunReport / walkin.sunOff and as the voice tools set_sun_time, sun_report,
// sun_off. Also sets walkin.house.north the way agent.js already reads it. Talks to the viewer only through
// window.walkin.
import * as THREE from 'three';
import { pointInPoly } from './fit.js';

const CELL = 0.15;                 // floor cell, metres
const LIFT = 0.02;                 // patches float this far above the floor so the floor occluder doesn't eat them
const SILL_DEFAULT = 0.9;          // a window whose sill reads 0 in the graph gets this
const MAX_REACH = 12;              // metres a patch may stretch from its window at a grazing sun
const MIN_ELEV = 0.5;              // degrees: below this the sun is on the horizon, nothing is drawn
const LOW_SUN = 15;                // degrees: below this the light goes orange
const LIT_MIN_M2 = 0.05;           // a room with less floor sun than this is not "in the sun"
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const COMPASS_LONG = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

const W = () => window.walkin;

let geo = null;                    // {lat, lon, bearingY} from data/<model>/geo.json, or null
let geoReason = null;              // why there is no geo
let windows = [];                  // precomputed rectangles for the current floor
let windowsFloor = null;           // the floor they were built for
let group = null;                  // THREE.Group 'sunlight' in walkin.scene
let mesh = null;                   // the merged patch mesh
const state = { date: todayISO(), minutes: nowMinutes(), show: true, last: null };
let playTimer = null;
const sunriseCache = new Map();    // date -> {rise, set} in local minutes

// ------------------------------------------------------------------ time
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nowMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

/** Hours to add to UTC for this longitude on this date: a US time zone band plus the US daylight-saving rule. */
export function utcOffsetHours(lon, y, m, d) {
  const std = lon < -114 ? -8 : lon < -102 ? -7 : lon < -87 ? -6 : lon < -67 ? -5 : Math.round(lon / 15);
  if (lon > -67 || lon < -130) return std;              // outside the mainland: no DST guess
  // DST: second Sunday of March to first Sunday of November (2 am; the hour itself is not worth modelling)
  const dow = (yy, mm, dd) => new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();
  const secondSunMar = 8 + ((7 - dow(y, 3, 8)) % 7);
  const firstSunNov = 1 + ((7 - dow(y, 11, 1)) % 7);
  const n = m * 100 + d;
  const dst = n > 300 + secondSunMar - 1 && n < 1100 + firstSunNov ? 1 : 0;
  return std + dst;
}

/** 'YYYY-MM-DD' -> [y, m, d]; also takes a Date, 'June 21', 'December', 'today'. */
export function parseDate(s) {
  if (s instanceof Date) return [s.getFullYear(), s.getMonth() + 1, s.getDate()];
  if (!s || /today|now/i.test(s)) return parseDate(new Date());
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return [+iso[1], +iso[2], +iso[3]];
  const mi = MONTHS_LONG.findIndex((m) => new RegExp(m.slice(0, 3), 'i').test(s));
  if (mi >= 0) {
    const day = /\b(\d{1,2})\b/.exec(s);
    return [new Date().getFullYear(), mi + 1, day ? +day[1] : 15];
  }
  const t = new Date(s);
  return isNaN(t) ? parseDate(new Date()) : [t.getFullYear(), t.getMonth() + 1, t.getDate()];
}

/** '16:00', '4pm', '4:30 pm', 'noon', 'sunrise', 'sunset' or a number of minutes -> minutes since midnight. */
export function parseTime(t, dateISO) {
  if (typeof t === 'number') return Math.max(0, Math.min(1439, Math.round(t)));
  if (!t) return nowMinutes();
  const s = String(t).trim().toLowerCase();
  if (/noon|midday/.test(s)) return 12 * 60;
  if (/midnight/.test(s)) return 0;
  if (/sunrise|dawn/.test(s)) return sunTimes(dateISO).rise ?? 6 * 60;
  if (/sunset|dusk|evening/.test(s)) return (sunTimes(dateISO).set ?? 18 * 60) - 30;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (!m) return nowMinutes();
  let h = +m[1]; const mm = m[2] ? +m[2] : 0;
  const ap = m[3];
  if (ap && ap.startsWith('p') && h < 12) h += 12;
  if (ap && ap.startsWith('a') && h === 12) h = 0;
  if (!ap && h <= 6 && h >= 1) h += 12;  // "4" or "4:30" with no am/pm is afternoon in a house tour
  return Math.max(0, Math.min(1439, h * 60 + mm));
}

function fmtTime(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}
function fmtHour(min) {
  // "9", "9:30", "4 pm": for the spoken report
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'am' : 'pm'}`;
}
function fmtDate([y, m, d]) { return `${MONTHS[m - 1]} ${d}`; }
function iso([y, m, d]) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }

// ------------------------------------------------------------------ the sun (NOAA)
/**
 * Sun azimuth (compass, clockwise from north) and elevation in degrees at `minutes` of local civil time on the
 * given date, for lat/lon. The same algorithm NOAA's solar calculator uses, to about a tenth of a degree.
 */
export function solar(lat, lon, [y, m, d], minutes) {
  const off = utcOffsetHours(lon, y, m, d);
  const ms = Date.UTC(y, m - 1, d, 0, minutes) - off * 3600e3;
  const jd = ms / 86400e3 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const rad = Math.PI / 180;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * rad;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T)
    + Math.sin(3 * Mr) * 0.000289;
  const omega = (125.04 - 1934.136 * T) * rad;
  const lam = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * rad;
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * rad;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lam));
  const yy = Math.tan(eps / 2) ** 2;
  const L0r = L0 * rad;
  const eot = 4 * (yy * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * yy * Math.sin(Mr) * Math.cos(2 * L0r)
    - 0.5 * yy * yy * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr)) / rad;
  const utcMin = ((ms / 60000) % 1440 + 1440) % 1440;
  const tst = (((utcMin + eot + 4 * lon) % 1440) + 1440) % 1440;
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;
  const phi = lat * rad, h = ha * rad;
  const cosz = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(h);
  const elevation = 90 - Math.acos(Math.max(-1, Math.min(1, cosz))) / rad;
  const azimuth = ((Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / rad + 180) % 360 + 360) % 360;
  return { azimuth, elevation, utcOffset: off };
}

/**
 * Compass bearing -> model-frame angle from +Y toward +X (clockwise seen from above, Z up), and the unit vector.
 * bearingY is the compass bearing of the model's +Y axis, so a model direction at angle phi has bearing
 * bearingY + phi; the inverse is phi = B - bearingY. With La Mirada's 266.4, north is phi = 93.6: roughly +X.
 */
export function compassToModel(bearingDeg, bearingY) {
  const phi = (((bearingDeg - bearingY) % 360) + 360) % 360;
  const r = phi * Math.PI / 180;
  return { phi, x: Math.sin(r), y: Math.cos(r) };
}
function modelToCompass(nx, ny, bearingY) {
  const phi = Math.atan2(nx, ny) * 180 / Math.PI;
  return (((phi + bearingY) % 360) + 360) % 360;
}
const compass8 = (b) => COMPASS[Math.round(b / 45) % 8];
const compassLong = (b) => COMPASS_LONG[Math.round(b / 45) % 8];

/** Unit vector toward the sun, model frame. */
function sunVector(date, minutes) {
  const s = solar(geo.lat, geo.lon, date, minutes);
  const { x, y } = compassToModel(s.azimuth, geo.bearingY);
  const ce = Math.cos(s.elevation * Math.PI / 180);
  return { ...s, x: ce * x, y: ce * y, z: Math.sin(s.elevation * Math.PI / 180), hx: x, hy: y };
}

/** Sunrise and sunset in local minutes for a date (null when the sun never crosses). */
function sunTimes(dateISO) {
  if (!geo) return { rise: null, set: null };
  if (sunriseCache.has(dateISO)) return sunriseCache.get(dateISO);
  const date = parseDate(dateISO);
  let rise = null, set = null, prev = solar(geo.lat, geo.lon, date, 0).elevation;
  for (let m = 1; m < 1440; m++) {
    const el = solar(geo.lat, geo.lon, date, m).elevation;
    if (prev <= 0 && el > 0 && rise == null) rise = m;
    if (prev > 0 && el <= 0) set = m;
    prev = el;
  }
  const r = { rise, set };
  sunriseCache.set(dateISO, r);
  return r;
}

// ------------------------------------------------------------------ windows, from the wall graph
/** Shoelace area of a polygon; a polygon whose area disagrees with the room's dims is not trusted. */
function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(a) / 2;
}

function usableRooms(h, floorId) {
  return h.rooms.filter((r) => {
    if (!r.poly || r.poly.length < 3 || (floorId && r.floor && r.floor !== floorId)) return false;
    const want = (r.dims || {}).areaFloor;
    return !want || polyArea(r.poly) > 0.5 * want;
  });
}

function buildWindows() {
  const w = W(), h = w.house, cur = w.current;
  const floorId = cur ? cur.floor : null;
  const floors = h.floors.filter((f) => !floorId || f.id === floorId);
  const walls = (floors.length ? floors : h.floors).flatMap((f) => f.walls.filter((x) => x.type !== 'divider'));
  const floorZ = cur ? cur.floorZ : 0;
  const rooms = usableRooms(h, floorId);
  const panos = h.panos.filter((p) => !floorId || p.floor === floorId);
  const cen = panos.reduce((s, p) => [s[0] + p.pos[0] / panos.length, s[1] + p.pos[1] / panos.length], [0, 0]);
  const out = [];
  walls.forEach((wall, wi) => {
    const [ax, ay] = wall.a, [bx, by] = wall.b;
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 0.05) return;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const n1x = uy, n1y = -ux;
    for (const o of wall.openings || []) {
      if (o.type !== 'window') continue;
      const t = o.at == null ? 0.5 : o.at;
      const cx = ax + t * L * ux, cy = ay + t * L * uy;
      const in1 = rooms.find((r) => pointInPoly(cx + n1x * 0.5, cy + n1y * 0.5, r.poly));
      const in2 = rooms.find((r) => pointInPoly(cx - n1x * 0.5, cy - n1y * 0.5, r.poly));
      let nx, ny, room = null;
      if (in1 && !in2) { nx = -n1x; ny = -n1y; room = in1; }
      else if (in2 && !in1) { nx = n1x; ny = n1y; room = in2; }
      else {
        // both sides in a room (an inner window) or neither (no trustworthy polygon): out = away from the scan points
        const away = n1x * (cx - cen[0]) + n1y * (cy - cen[1]) > 0;
        nx = away ? n1x : -n1x; ny = away ? n1y : -n1y;
        room = in1 || in2 || w.roomAt(cx - nx * 0.5, cy - ny * 0.5, floorId || undefined) || null;
      }
      const sill = o.bottom > 0.05 ? o.bottom : SILL_DEFAULT;
      const height = o.height || 1.2, width = o.width || 1;
      const bearing = geo ? modelToCompass(nx, ny, geo.bearingY) : null;
      out.push({ wall: wi, cx, cy, ux, uy, nx, ny, width, height, sill, floorZ,
        z0: floorZ + sill, z1: floorZ + sill + height,
        // Matterport labels an office's spaces "Other": say "the main floor" rather than "other"
        room: room && room.label && !/^(other|room)$/i.test(room.label) ? room.label : null, roomId: room ? room.id : null,
        bearing, facing: bearing == null ? null : compass8(bearing),
        // the other walls that could stand between this window and its patch, by their 2D segments
        others: walls.map((x, i) => ({ i, a: x.a, b: x.b })).filter((x) => x.i !== wi
          && Math.min(Math.hypot(x.a[0] - cx, x.a[1] - cy), Math.hypot(x.b[0] - cx, x.b[1] - cy)) < MAX_REACH + 8) });
    }
  });
  windows = out;
  windowsFloor = floorId;
}

function ensureWindows() {
  const cur = W().current;
  if (!windows.length || (cur && cur.floor !== windowsFloor)) buildWindows();
  return windows;
}

/** Does segment p-q cross segment a-b (proper crossing, shared endpoints don't count)? */
function crosses(px, py, qx, qy, ax, ay, bx, by) {
  const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d2 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
  if (d1 * d2 >= 0) return false;
  const d3 = (qx - px) * (ay - py) - (qy - py) * (ax - px);
  const d4 = (qx - px) * (by - py) - (qy - py) * (bx - px);
  return d3 * d4 < 0;
}

// ------------------------------------------------------------------ patches
/** Lit floor cells for every sunward window at this sun; one merged geometry. */
function computePatches(sun) {
  const res = { lit: [], floor_m2: 0, positions: [] };
  if (sun.elevation < MIN_ELEV) return res;
  const tanEl = Math.tan(sun.elevation * Math.PI / 180);
  const pos = res.positions;
  for (const win of ensureWindows()) {
    const facing = win.nx * sun.hx + win.ny * sun.hy;   // > 0: the sun is on the outside of this window
    if (facing <= 0.01) continue;
    // the lit parallelogram: the window rectangle slid down the ray onto the floor. Light enters along -h,
    // and a point at height z above the floor lands z / tan(el) metres along it.
    const r0 = Math.min(MAX_REACH, win.sill / tanEl), r1 = Math.min(MAX_REACH, (win.sill + win.height) / tanEl);
    if (r1 - r0 < 0.01) continue;
    const nA = Math.max(1, Math.ceil(win.width / CELL)), nB = Math.max(1, Math.ceil((r1 - r0) / CELL));
    const dA = win.width / nA, dB = (r1 - r0) / nB;
    const cellArea = dA * dB * Math.abs(facing);
    const ox = win.cx - win.ux * win.width / 2 - sun.hx * r0, oy = win.cy - win.uy * win.width / 2 - sun.hy * r0;
    const px = win.cx - win.nx * 0.05, py = win.cy - win.ny * 0.05;    // the light's entry point, just inside
    // only walls near the patch can block it
    const bx0 = Math.min(px, ox, ox + win.ux * win.width, ox - sun.hx * (r1 - r0), ox + win.ux * win.width - sun.hx * (r1 - r0));
    const bx1 = Math.max(px, ox, ox + win.ux * win.width, ox - sun.hx * (r1 - r0), ox + win.ux * win.width - sun.hx * (r1 - r0));
    const by0 = Math.min(py, oy, oy + win.uy * win.width, oy - sun.hy * (r1 - r0), oy + win.uy * win.width - sun.hy * (r1 - r0));
    const by1 = Math.max(py, oy, oy + win.uy * win.width, oy - sun.hy * (r1 - r0), oy + win.uy * win.width - sun.hy * (r1 - r0));
    const blockers = win.others.filter((o) => Math.max(o.a[0], o.b[0]) >= bx0 && Math.min(o.a[0], o.b[0]) <= bx1
      && Math.max(o.a[1], o.b[1]) >= by0 && Math.min(o.a[1], o.b[1]) <= by1);
    const z = win.floorZ + LIFT;
    let kept = 0;
    for (let j = 0; j < nB; j++) {
      for (let i = 0; i < nA; i++) {
        const mx = ox + win.ux * dA * (i + 0.5) - sun.hx * dB * (j + 0.5);
        const my = oy + win.uy * dA * (i + 0.5) - sun.hy * dB * (j + 0.5);
        let blocked = false;
        for (const o of blockers) {
          if (crosses(px, py, mx, my, o.a[0], o.a[1], o.b[0], o.b[1])) { blocked = true; break; }
        }
        if (blocked) continue;
        kept++;
        const x00 = ox + win.ux * dA * i - sun.hx * dB * j, y00 = oy + win.uy * dA * i - sun.hy * dB * j;
        const x10 = x00 + win.ux * dA, y10 = y00 + win.uy * dA;
        const x01 = x00 - sun.hx * dB, y01 = y00 - sun.hy * dB;
        const x11 = x10 - sun.hx * dB, y11 = y10 - sun.hy * dB;
        pos.push(x00, y00, z, x10, y10, z, x11, y11, z, x00, y00, z, x11, y11, z, x01, y01, z);
      }
    }
    if (!kept) continue;
    const m2 = kept * cellArea;
    res.floor_m2 += m2;
    res.lit.push({ window: win, m2 });
  }
  return res;
}

function ensureGroup() {
  const w = W();
  if (group) return group;
  group = new THREE.Group();
  group.name = 'sunlight';
  const mat = new THREE.MeshBasicMaterial({ color: 0xfff1c8, transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, side: THREE.DoubleSide });
  mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.renderOrder = 1;                      // after the depth-only occluders (0), before furniture (2)
  mesh.frustumCulled = false;
  group.add(mesh);
  w.scene.add(group);
  return group;
}

function draw(res, sun) {
  ensureGroup();
  const g = mesh.geometry;
  const n = res.positions.length;
  let attr = g.getAttribute('position');
  if (!attr || attr.array.length < n) {
    // grow: a slider drag re-fills the same buffer; only a bigger patch set allocates (and frees the old one)
    g.dispose();
    attr = new THREE.BufferAttribute(new Float32Array(Math.max(n, 2 * (attr ? attr.array.length : 0), 18 * 256)), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', attr);
  }
  attr.array.set(res.positions);
  attr.needsUpdate = true;
  g.setDrawRange(0, n / 3);
  mesh.material.color.set(sun.elevation < LOW_SUN ? 0xffb060 : 0xffe2a8);
  group.visible = state.show && n > 0;
}

// ------------------------------------------------------------------ the public API
function noGeo() {
  return { ok: false, say: geoReason || 'no north for this house yet - run tools/geo.py', lit_windows: 0, floor_m2: 0 };
}

/** Set the sun to a date and time (and show or hide it); returns what is lit. */
export function sun(opts = {}) {
  if (!geo) return noGeo();
  if (opts.date != null) state.date = iso(parseDate(opts.date));
  if (opts.minutes != null) state.minutes = parseTime(opts.minutes, state.date);
  if (opts.time != null) state.minutes = parseTime(opts.time, state.date);
  if (opts.show != null) state.show = !!opts.show;
  const date = parseDate(state.date);
  const s = sunVector(date, state.minutes);
  const res = computePatches(s);
  draw(res, s);
  const times = sunTimes(state.date);
  const rooms = [...new Set(res.lit.map((l) => l.window.room || 'the main floor'))];
  const when = `${fmtDate(date)}, ${fmtTime(state.minutes)}`;
  let say;
  if (s.elevation < MIN_ELEV) {
    say = `${when}: the sun is below the horizon (${times.rise != null ? `rises ${fmtTime(times.rise)}, ` : ''}${times.set != null ? `sets ${fmtTime(times.set)}` : ''}).`;
  } else if (!res.lit.length) {
    const facing = windows.filter((w) => w.nx * s.hx + w.ny * s.hy > 0.01).length;
    say = `${when}: the sun is ${s.elevation.toFixed(0)}° up in the ${compassLong(s.azimuth)}` + (facing
      ? `; ${facing} window${facing > 1 ? 's' : ''} face it, but this low the light lands on the far walls, not the floor.`
      : `, and no window on this floor faces it.`);
  } else {
    say = `${when}: sun ${s.elevation.toFixed(0)}° up in the ${compassLong(s.azimuth)}. ${res.lit.length} window${res.lit.length > 1 ? 's' : ''} lit, `
      + `${res.floor_m2.toFixed(1)} m² of floor in direct sun: ${rooms.map((r) => r.toLowerCase()).join(', ')}.`;
  }
  const out = { ok: true, say, date: state.date, time: fmtTime(state.minutes), minutes: state.minutes,
    lit_windows: res.lit.length, floor_m2: +res.floor_m2.toFixed(2),
    elevation_deg: +s.elevation.toFixed(1), azimuth_deg: +s.azimuth.toFixed(1), facing: compass8(s.azimuth),
    rooms, windows: res.lit.map((l) => ({ room: l.window.room, facing: l.window.facing, width_m: +l.window.width.toFixed(2), floor_m2: +l.m2.toFixed(2) })),
    sunrise: times.rise != null ? fmtTime(times.rise) : null, sunset: times.set != null ? fmtTime(times.set) : null };
  state.last = out;
  updatePanel(out);
  return out;
}

/** Hide the patches (the API stays live). */
export function sunOff() {
  stopPlay();
  state.show = false;
  if (group) group.visible = false;
  updatePanel(state.last);
  return { ok: true, say: 'Sunlight hidden.' };
}

/** The whole day in 15-minute steps: which rooms get direct sun when, and each window's lit hours. */
export function sunReport(opts = {}) {
  if (!geo) return noGeo();
  const dateISO = iso(parseDate(opts.date || state.date));
  const date = parseDate(dateISO);
  const STEP = 15;
  const perRoom = new Map();            // label -> {hours, first, last}
  const perWindow = new Map();          // window -> {first, last}
  const wins = ensureWindows();
  for (let m = 0; m < 1440; m += STEP) {
    const s = sunVector(date, m);
    if (s.elevation < MIN_ELEV) continue;
    const res = computePatches(s);
    const roomsLit = new Map();
    for (const l of res.lit) {
      const key = l.window.room || 'the main floor';
      roomsLit.set(key, (roomsLit.get(key) || 0) + l.m2);
      const pw = perWindow.get(l.window) || { first: m, last: m, peak_m2: 0 };
      pw.last = m; pw.peak_m2 = Math.max(pw.peak_m2, l.m2);
      perWindow.set(l.window, pw);
    }
    for (const [key, m2] of roomsLit) {
      if (m2 < LIT_MIN_M2) continue;
      const pr = perRoom.get(key) || { hours: 0, first: m, last: m, peak_m2: 0 };
      pr.hours += STEP / 60; pr.last = m; pr.peak_m2 = Math.max(pr.peak_m2, m2);
      perRoom.set(key, pr);
    }
  }
  const roomWindows = new Map();
  for (const w of wins) {
    const key = w.room || 'the main floor';
    if (!roomWindows.has(key)) roomWindows.set(key, []);
    roomWindows.get(key).push(w);
  }
  const month = MONTHS_LONG[date[1] - 1];
  const rooms = [];
  const parts = [];
  for (const [label, ws] of roomWindows) {
    const r = perRoom.get(label);
    const facings = [...new Set(ws.map((w) => w.facing).filter(Boolean))];
    const name = label === 'the main floor' ? label : `the ${label.toLowerCase()}`;
    if (r) {
      rooms.push({ room: label, direct_sun_hours: +r.hours.toFixed(2), first: fmtHour(r.first), last: fmtHour(r.last + STEP), peak_floor_m2: +r.peak_m2.toFixed(2), windows_face: facings });
      parts.push(`${name} gets direct sun ${fmtHour(r.first)} to ${fmtHour(r.last + STEP)} (${r.hours.toFixed(1)} h)`);
    } else {
      rooms.push({ room: label, direct_sun_hours: 0, first: null, last: null, peak_floor_m2: 0, windows_face: facings });
      parts.push(`${name} faces ${facings.map((f) => compassLong(COMPASS.indexOf(f) * 45)).join(' and ') || 'inward'} and gets none`);
    }
  }
  rooms.sort((a, b) => b.direct_sun_hours - a.direct_sun_hours);
  parts.sort((a, b) => (a.includes('gets none') ? 1 : 0) - (b.includes('gets none') ? 1 : 0));
  const windowsOut = wins.map((w) => {
    const pw = perWindow.get(w);
    return { room: w.room, facing: w.facing, bearing_deg: w.bearing == null ? null : +w.bearing.toFixed(0), width_m: +w.width.toFixed(2), height_m: +w.height.toFixed(2),
      first_lit: pw ? fmtHour(pw.first) : null, last_lit: pw ? fmtHour(pw.last + STEP) : null, peak_floor_m2: pw ? +pw.peak_m2.toFixed(2) : 0 };
  });
  const times = sunTimes(dateISO);
  const say = parts.length
    ? `In ${month}: ${parts.join('; ')}. Sunrise ${times.rise != null ? fmtTime(times.rise) : '-'}, sunset ${times.set != null ? fmtTime(times.set) : '-'}.`
    : `No windows on this floor in the wall graph, so nothing to say about sun.`;
  return { ok: true, say, date: dateISO, rooms, windows: windowsOut,
    sunrise: times.rise != null ? fmtTime(times.rise) : null, sunset: times.set != null ? fmtTime(times.set) : null };
}

// ------------------------------------------------------------------ panel
let panel = null, els = null;
function buildPanel() {
  if (panel) return;
  const css = document.createElement('style');
  css.textContent = `
    #sunpanel { position: fixed; right: 12px; bottom: calc(max(16px, env(safe-area-inset-bottom)) + 66px); z-index: 30;
      background: rgba(18,18,22,.78); color: #f4f2ee; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      border-radius: 14px; padding: 8px 10px; font: 13px/1.35 system-ui, -apple-system, "Inter", "Segoe UI", sans-serif;
      width: 260px; max-width: calc(100vw - 24px); box-shadow: 0 8px 32px rgba(0,0,0,.25), inset 0 0 0 1px rgba(255,255,255,.25); }
    #sunpanel.off { width: auto; padding: 4px; }
    #sunpanel.off .sunbody { display: none; }
    #sunpanel .sunrow { display: flex; align-items: center; gap: 6px; }
    #sunpanel button { background: #2a2a31; color: inherit; border: 0; border-radius: 10px; padding: 6px 9px; font: inherit; cursor: pointer; }
    #sunpanel button:hover { background: #3a3a43; }
    #sunpanel button.on { background: #ffb347; color: #16161a; }
    #sunpanel input[type=date] { background: #2a2a31; color: inherit; border: 0; border-radius: 8px; padding: 4px 6px; font: inherit; color-scheme: dark; flex: 1; min-width: 0; }
    #sunpanel input[type=range] { width: 100%; margin: 6px 0 2px; accent-color: #ffb347; }
    #sunpanel .sunlabel { font-weight: 600; margin-top: 2px; }
    #sunpanel .sunsub { color: #a9a5a0; font-size: 12px; }
    body.vr #sunpanel { display: none !important; }`;
  document.head.appendChild(css);
  panel = document.createElement('div');
  panel.id = 'sunpanel';
  panel.innerHTML = `
    <div class="sunrow">
      <button class="suntoggle on" title="Show direct sunlight on the floor">☀</button>
      <div class="sunbody sunrow" style="flex:1">
        <input type="date" class="sundate">
        <button class="sunplay" title="Run the sun through the day">▶</button>
      </div>
    </div>
    <div class="sunbody">
      <input type="range" class="suntime" min="0" max="1439" step="5">
      <div class="sunlabel">—</div>
      <div class="sunsub">—</div>
    </div>`;
  document.body.appendChild(panel);
  els = { toggle: panel.querySelector('.suntoggle'), date: panel.querySelector('.sundate'), play: panel.querySelector('.sunplay'),
    time: panel.querySelector('.suntime'), label: panel.querySelector('.sunlabel'), sub: panel.querySelector('.sunsub') };
  els.date.value = state.date;
  els.time.value = state.minutes;
  els.date.oninput = () => { if (els.date.value) sun({ date: els.date.value }); };
  els.time.oninput = () => { stopPlay(); sun({ minutes: +els.time.value }); };
  els.toggle.onclick = () => { if (state.show) sunOff(); else sun({ show: true }); };
  els.play.onclick = () => (playTimer ? stopPlay() : play());
}

function updatePanel(out) {
  if (!panel) return;
  panel.classList.toggle('off', !state.show);
  els.toggle.classList.toggle('on', state.show);
  els.play.textContent = playTimer ? '◼' : '▶';
  if (els.date.value !== state.date) els.date.value = state.date;
  if (+els.time.value !== state.minutes) els.time.value = state.minutes;
  if (!out || !out.ok) { els.label.textContent = 'no north yet'; els.sub.textContent = out ? out.say : ''; return; }
  const d = parseDate(out.date);
  els.label.textContent = `${fmtDate(d)} · ${out.time} · ` + (out.elevation_deg > 0
    ? `sun ${out.elevation_deg.toFixed(0)}° at ${out.azimuth_deg.toFixed(0)}° (${out.facing})` : 'sun below the horizon');
  els.sub.textContent = `${out.lit_windows} window${out.lit_windows === 1 ? '' : 's'} lit · ${out.floor_m2.toFixed(1)} m² of floor in direct sun`;
}

function play() {
  stopPlay();
  if (!geo) return;
  const set = (sunTimes(state.date).set ?? 1440) - 1;      // the last minute the sun is still up
  const rise = sunTimes(state.date).rise ?? 0;
  if (state.minutes >= set - 10 || state.minutes < rise) state.minutes = Math.max(0, rise - 10);
  state.show = true;
  playTimer = setInterval(() => {
    state.minutes += 10;
    if (state.minutes > set || state.minutes > 1439) { state.minutes = Math.min(1439, set); sun({}); stopPlay(); return; }
    sun({});
  }, 100);
  updatePanel(state.last);
}
function stopPlay() {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  if (panel) els.play.textContent = '▶';
}

// ------------------------------------------------------------------ wiring
async function loadGeo() {
  const w = W();
  const base = location.pathname.replace(/[^/]*$/, '') + 'data/' + w.house.model + '/';
  try {
    const r = await fetch(base + 'geo.json');
    if (!r.ok) throw new Error(`${r.status}`);
    const g = await r.json();
    if (typeof g.lat !== 'number' || typeof g.lon !== 'number' || typeof g.bearingY !== 'number') throw new Error('incomplete');
    geo = g;
    // agent.js reads house.north as the model-frame angle (from +Y toward +X) at which true north lies
    w.house.north = (360 - g.bearingY) % 360;
  } catch (e) {
    geo = null;
    geoReason = `no north for this house yet - run tools/geo.py (${e.message})`;
    console.info(`[sun] ${geoReason}`);
  }
}

function registerTools() {
  const w = W();
  const a = w && w.agent;
  if (!a || !a.tools || !a.declarations || a.tools.set_sun_time) return;
  a.tools.set_sun_time = (args = {}) => sun({ date: args.date, time: args.time, show: true });
  a.tools.sun_report = (args = {}) => sunReport({ date: args.date });
  a.tools.sun_off = () => sunOff();
  a.declarations.push(
    { name: 'set_sun_time',
      description: 'Show where direct sunlight falls on the floor of this house through its real windows at a date and time. Use for "where does the sun come in", "morning light", "show me 4 pm in December", "is this room bright in the afternoon". Returns the lit windows, square metres of floor in direct sun, and the sun\'s elevation and compass direction.',
      parameters: { type: 'object', properties: {
        date: { type: 'string', description: 'YYYY-MM-DD, or a month name like "December". Leave empty for today.' },
        time: { type: 'string', description: 'Local time: "16:00", "4pm", "9:30 am", "noon", "sunrise", "sunset". Leave empty for now.' } } } },
    { name: 'sun_report',
      description: 'Which rooms get direct sun and when, over a whole day, from the real windows: hours per room, first and last lit hour, and the compass direction each window faces. Use for "does the kitchen get morning sun", "which room is sunniest", "which way does this house face".',
      parameters: { type: 'object', properties: {
        date: { type: 'string', description: 'YYYY-MM-DD or a month name. Leave empty for today.' } } } },
    { name: 'sun_off', description: 'Hide the sunlight patches again.', parameters: { type: 'object', properties: {} } },
  );
}

async function start() {
  const w = W();
  if (!w || w.sun) return;
  w.sun = sun;
  w.sunReport = sunReport;
  w.sunOff = sunOff;
  await loadGeo();
  buildPanel();
  if (geo) sun({}); else updatePanel(noGeo());
  registerTools();
}
if (window.walkin) start(); else addEventListener('walkin:ready', start, { once: true });
// agent.js attaches walkin.agent a moment after the viewer is ready; try again then
// agent.js attaches walkin.agent some time after the viewer is ready - later still on a phone over a
// tunnel - so keep trying until the tools are on it, for up to a minute.
{
  let tries = 0;
  const again = setInterval(() => {
    registerTools();
    const a = window.walkin && window.walkin.agent;
    if ((a && a.tools && a.tools.set_sun_time) || ++tries > 120) clearInterval(again);
  }, 500);
}
