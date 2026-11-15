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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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
  // Half the patch's light is its own glow and half comes from the sun light, so a chair standing in the
  // patch casts a visible shadow inside it and nowhere else. The photographed floor keeps its own shading:
  // the only thing that ever darkens is a patch we drew.
  const mat = new THREE.MeshStandardMaterial({ color: 0xfff1c8, emissive: 0xfff1c8, emissiveIntensity: 0.55,
    roughness: 1, metalness: 0, envMapIntensity: 0, transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, side: THREE.DoubleSide });
  mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.receiveShadow = true;
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
  let nrm = g.getAttribute('normal');
  if (!nrm || nrm.array.length < attr.array.length) {
    const arr = new Float32Array(attr.array.length);
    for (let i = 2; i < arr.length; i += 3) arr[i] = 1;      // every cell faces up
    nrm = new THREE.BufferAttribute(arr, 3);
    g.setAttribute('normal', nrm);
  }
  g.setDrawRange(0, n / 3);
  mesh.material.color.set(sun.elevation < LOW_SUN ? 0xffb060 : 0xffe2a8);
  mesh.material.emissive.set(sun.elevation < LOW_SUN ? 0xffb060 : 0xffe2a8);
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
  lightScene(s, res);
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
  if (fx.light) fx.light.intensity = 0;
  if (W() && W().renderer) W().renderer.shadowMap.autoUpdate = false;
  if (fx.casters) fx.casters.visible = false;
  if (fx.grade) fx.grade.visible = false;
  if (fx.sprite) fx.sprite.visible = false;
  if (fx.glass) fx.glass.visible = false;
  if (fx.night) { fx.night = false; nightLamps(false); if (fx.envDay != null) W().scene.environmentIntensity = fx.envDay; dispatchEvent(new CustomEvent('walkin:sun', { detail: { night: false, elevation: 0 } })); }
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


// ------------------------------------------------------------------ the sun as a light
//
// The floor patches say where the sun lands; this makes the rest of the room agree with them. A real
// directional light stands where the sun is, and it shines through SHADOW CASTERS built from the wall
// graph - every wall as an invisible slab with its windows cut out, plus a ceiling - so the light only
// enters where the windows are. That gives, from one mechanism: window-shaped sun on the furniture,
// furniture shadows on the floor that swing with the time slider, and interior walls blocking the beam.
// Below 25 degrees the whole view warms up; below the horizon it goes to night and the screens and
// lamps come up, because "show me this at 9 pm" should look like 9 pm.
const fx = { light: null, target: null, plane: null, casters: null, castersFloor: null, grade: null, sprite: null, label: null, night: false };
const SHADOW_MAP = 2048;
const SHADOW_HALF = 16;            // metres around the viewer the shadow camera covers
const WALL_H = 2.7, SLAB_T = 0.12;

function ensureLight() {
  const w = W();
  if (fx.light) return;
  // enabling shadow maps is a renderer setting; app.js owns the renderer, so this is the one thing here it
  // did not already allow for (told Amit on #133). Nothing else about the renderer is touched.
  w.renderer.shadowMap.enabled = true;
  w.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const light = new THREE.DirectionalLight(0xfff1d6, 0);
  light.castShadow = true;
  light.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  light.shadow.camera.near = 1; light.shadow.camera.far = 90;
  light.shadow.camera.left = -SHADOW_HALF; light.shadow.camera.right = SHADOW_HALF;
  light.shadow.camera.top = SHADOW_HALF; light.shadow.camera.bottom = -SHADOW_HALF;
  light.shadow.bias = -0.0006; light.shadow.normalBias = 0.02;
  const target = new THREE.Object3D();
  w.scene.add(target); light.target = target; w.scene.add(light);
  // the view-level grade: a quad on the camera, in both eyes, warm at dusk and dark at night
  const grade = new THREE.Mesh(new THREE.PlaneGeometry(4, 4),
    new THREE.MeshBasicMaterial({ color: 0xffa050, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
  grade.position.z = -0.6; grade.renderOrder = 999; grade.frustumCulled = false; grade.visible = false;
  w.camera.add(grade);
  if (!w.camera.parent) w.scene.add(w.camera);
  // the sun itself, out along its own direction: what you grab in the headset
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); const rg = g.createRadialGradient(64, 64, 8, 64, 64, 62);
  rg.addColorStop(0, 'rgba(255,250,220,1)'); rg.addColorStop(0.35, 'rgba(255,215,120,0.9)'); rg.addColorStop(1, 'rgba(255,180,60,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sprite.scale.setScalar(1.6); sprite.renderOrder = 50; sprite.visible = false;
  w.scene.add(sprite);
  Object.assign(fx, { light, target, grade, sprite });
}

/** Invisible slabs for every wall on this floor, with the windows cut out, and a ceiling: what the sun has to get past. */
function ensureCasters(floorZ) {
  const w = W();
  const floorId = w.current && w.current.floor;
  if (fx.casters && fx.castersFloor === floorId) return;
  if (fx.casters) { w.scene.remove(fx.casters); fx.casters.traverse((o) => o.geometry && o.geometry.dispose()); }
  const grp = new THREE.Group(); grp.name = 'sun-casters';
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });   // casts, never draws
  const pieces = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of w.house.floors || []) {
    if (floorId && f.id && f.id !== floorId) continue;
    for (const wall of f.walls || []) {
      const [ax, ay] = wall.a, [bx, by] = wall.b;
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 0.05) continue;
      x0 = Math.min(x0, ax, bx); x1 = Math.max(x1, ax, bx); y0 = Math.min(y0, ay, by); y1 = Math.max(y1, ay, by);
      const ang = Math.atan2(by - ay, bx - ax);
      // the wall as pieces: full height between windows, and above and below each window
      const spans = [];                                   // along the wall: [t0, t1, zlo, zhi]
      const wins = (wall.openings || []).filter((o) => /window/i.test(o.type || '') && o.at != null)
        .map((o) => ({ t0: o.at - (o.width || 1) / 2 / L, t1: o.at + (o.width || 1) / 2 / L, lo: (o.bottom || 0) > 0 ? o.bottom : SILL_DEFAULT, hi: ((o.bottom || 0) > 0 ? o.bottom : SILL_DEFAULT) + (o.height || 1.2) }))
        .sort((a, b) => a.t0 - b.t0);
      let t = 0;
      for (const o of wins) {
        if (o.t0 > t) spans.push([t, o.t0, 0, WALL_H]);
        spans.push([Math.max(t, o.t0), o.t1, 0, o.lo]);              // under the sill
        spans.push([Math.max(t, o.t0), o.t1, Math.min(o.hi, WALL_H), WALL_H]);  // above the head
        t = Math.max(t, o.t1);
      }
      if (t < 1) spans.push([t, 1, 0, WALL_H]);
      for (const [s0, s1, zlo, zhi] of spans) {
        if (s1 - s0 < 1e-3 || zhi - zlo < 1e-3) continue;
        const box = new THREE.BoxGeometry((s1 - s0) * L, SLAB_T, zhi - zlo);
        box.applyMatrix4(new THREE.Matrix4().makeRotationZ(ang).setPosition(
          ax + (bx - ax) * (s0 + s1) / 2, ay + (by - ay) * (s0 + s1) / 2, floorZ + (zlo + zhi) / 2));
        pieces.push(box);
      }
    }
  }
  if (isFinite(x0)) {
    const ceil = new THREE.PlaneGeometry(x1 - x0 + 4, y1 - y0 + 4);
    ceil.translate((x0 + x1) / 2, (y0 + y1) / 2, floorZ + WALL_H);
    pieces.push(ceil);
  }
  if (pieces.length) {
    // one mesh, one draw call into the shadow map - 122 separate slabs cost 122 draw calls each frame
    const merged = mergeGeometries(pieces.map((g) => g.index ? g.toNonIndexed() : g), false);
    for (const g of pieces) g.dispose();
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = true; m.frustumCulled = false;
    grp.add(m);
  }
  w.scene.add(grp);
  fx.casters = grp; fx.castersFloor = floorId;
}

/** Point the sun light, size the shadows around the viewer, set the grade and the night lights. */
function lightScene(s, res) {
  const w = W();
  if (!w.renderer || !w.camera) return;
  ensureLight();
  const floorZ = (w.current && w.current.floorZ) || 0;
  ensureCasters(floorZ);
  const up = s.elevation >= MIN_ELEV && state.show;
  const here = w.current ? w.current.pos : [0, 0, floorZ];
  fx.target.position.set(here[0], here[1], floorZ);
  // light comes FROM the sun: sit it 40 m out along the sun vector (hx, hy point toward the sun, z up)
  const dz = Math.tan(s.elevation * Math.PI / 180);
  const len = Math.hypot(s.hx, s.hy, dz) || 1;
  fx.light.position.set(here[0] + s.hx / len * 40, here[1] + s.hy / len * 40, floorZ + dz / len * 40);
  fx.light.color.set(s.elevation < LOW_SUN ? 0xffc080 : 0xfff1d6);
  fx.light.shadow.camera.updateProjectionMatrix();
  fx.casters.visible = up;
  w.renderer.shadowMap.autoUpdate = up;  // no shadow pass while the sun is off or down (phone fps)
  if (up) w.renderer.shadowMap.needsUpdate = true;
  // the sun has to light the patch brightly enough to show shade in it: compensate for the grazing angle
  fx.light.intensity = up ? Math.min(6, 1.4 / Math.max(0.15, Math.sin(s.elevation * Math.PI / 180))) : 0;
  // the sun in the sky, 9 m out, for the hand to grab
  fx.sprite.position.set(here[0] + s.hx / len * 9, here[1] + s.hy / len * 9, (w.current ? here[2] : floorZ + 1.5) + dz / len * 9);
  fx.sprite.visible = state.show && s.elevation > -8;
  // grade: warm below 25 degrees, night below the horizon
  const e = s.elevation;
  // Night has no data behind it - nobody scanned the house in the dark - so it is built from what we
  // do know: the windows go black, the room goes to a near-dark blue, the environment light drops to a
  // quarter, and the lamps and screens become the only light. That reads as night; 0.6 of blue over a
  // daylight photo read as a dim afternoon.
  let op = 0, col = 0xffa050;
  // the grade sits over the emissive screens and lamps too, so it stops at 0.76 and they are driven hard
  if (e < -6) { op = 0.76; col = 0x05080f; }
  else if (e < 0) { const k = -e / 6; op = 0.22 + 0.54 * k; col = new THREE.Color(0xff8040).lerp(new THREE.Color(0x05080f), k).getHex(); }
  else if (e < 25) { op = 0.2 * (1 - e / 25); col = 0xffa050; }
  fx.grade.material.color.set(col); fx.grade.material.opacity = op; fx.grade.visible = state.show && op > 0.01;
  // night: screens and lamps come up
  const night = state.show && e < 0;
  nightGlass(night, floorZ);
  if (night !== fx.night) {
    fx.night = night;
    if (fx.envDay == null) fx.envDay = w.scene.environmentIntensity;
    w.scene.environmentIntensity = night ? fx.envDay * 0.25 : fx.envDay;
    nightLamps(night);
    dispatchEvent(new CustomEvent('walkin:sun', { detail: { night, elevation: e } }));
    for (const o of (w.furniture ? w.furniture.children : [])) o.traverse((m) => {
      if (m.isMesh && m.material && /shade|lamp|light/i.test(m.material.name || '')) {
        m.material.emissive && m.material.emissive.set(0xffd9a0);
        m.material.emissiveIntensity = night ? 5.0 : 0.15;
        // draw after the grade so the shade glows instead of being dimmed with the room
        m.material.transparent = night; m.material.needsUpdate = true;
        m.renderOrder = night ? 1000 : 2;
      }
    });
  }
}


/** The windows go dark after sunset: one near-black pane in every window rectangle, just inside the wall. */
function nightGlass(on, floorZ) {
  const w = W();
  if (!on) { if (fx.glass) fx.glass.visible = false; return; }
  const floorId = w.current && w.current.floor;
  if (!fx.glass || fx.glassFloor !== floorId) {
    if (fx.glass) { w.scene.remove(fx.glass); fx.glass.geometry.dispose(); }
    const panes = [];
    for (const win of ensureWindows()) {
      const g = new THREE.PlaneGeometry(win.width, win.height);
      // a plane faces +z; stand it up (rotate about x) and turn it to the wall, then slide it just inside
      const ang = Math.atan2(win.uy, win.ux);
      g.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      g.applyMatrix4(new THREE.Matrix4().makeRotationZ(ang));
      g.translate(win.cx - win.nx * 0.04, win.cy - win.ny * 0.04, win.floorZ + win.sill + win.height / 2);
      panes.push(g);
    }
    if (!panes.length) return;
    const merged = mergeGeometries(panes.map((g) => g.index ? g.toNonIndexed() : g), false);
    for (const g of panes) g.dispose();
    fx.glass = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ color: 0x0a1424, transparent: true, opacity: 0.92, depthWrite: false, side: THREE.DoubleSide }));
    fx.glass.renderOrder = 1; fx.glass.frustumCulled = false;
    w.scene.add(fx.glass);
    fx.glassFloor = floorId;
  }
  fx.glass.visible = true;
}

/** After dark, the staged lamps throw warm light: a point light at each floor lamp, up to four. */
function nightLamps(on) {
  const w = W();
  for (const l of fx.lamps || []) w.scene.remove(l);
  fx.lamps = [];
  if (!on || !w.furniture) return;
  const lamps = w.furniture.children.filter((o) => /lamp/i.test(o.userData.kind || '')).slice(0, 4);
  for (const o of lamps) {
    const l = new THREE.PointLight(0xffc27a, 9, 8, 1.6);
    l.position.set(o.position.x, o.position.y, o.position.z + 1.45);
    w.scene.add(l); fx.lamps.push(l);
  }
}

// ------------------------------------------------------------------ the hand on the sun
//
// In the headset there is no slider. The sun is a sprite in the sky along its real direction: pinch
// while pointing at it and drag across the sky, and time follows the hand - a full screen width is
// twelve hours. Pinching with a raised hand anywhere does the same, for when the sun is behind you.
let scrub = null;
function handScrub() {
  const w = W();
  if (!w || !geo || !w.hands || !state.show) return;
  const h = w.hands.find((x) => x.pinch) || null;
  if (!h) { if (scrub) { scrub = null; if (fx.label) fx.label.visible = false; } return; }
  if (!scrub) {
    let atSun = false;
    if (w.handRay && fx.sprite && fx.sprite.visible) {
      const d = new THREE.Vector3(...w.handRay.dir);
      const to = fx.sprite.position.clone().sub(new THREE.Vector3(...w.handRay.origin)).normalize();
      atSun = d.dot(to) > Math.cos(14 * Math.PI / 180);
    }
    const raised = h.y < 0.22;                              // hand high in the view
    if (!atSun && !raised) return;
    scrub = { x0: h.x, m0: state.minutes, side: h.side };
    return;
  }
  if (h.side !== scrub.side) return;
  const minutes = Math.max(0, Math.min(1439, Math.round(scrub.m0 + (h.x - scrub.x0) * 720)));
  if (minutes !== state.minutes) {
    state.minutes = minutes;
    sun({});
    showSkyLabel();
  }
}
function showSkyLabel() {
  if (!fx.sprite) return;
  if (!fx.label) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    fx.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
    fx.label.scale.set(2.4, 0.6, 1); fx.label.renderOrder = 51; fx.label.userData.canvas = c;
    W().scene.add(fx.label);
  }
  const c = fx.label.userData.canvas, g = c.getContext('2d');
  g.clearRect(0, 0, 512, 128); g.fillStyle = 'rgba(20,20,24,0.75)'; g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#fff'; g.font = 'bold 60px -apple-system, Helvetica, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(`${fmtDate(parseDate(state.date))} · ${fmtTime(state.minutes)}`, 256, 64);
  fx.label.material.map.needsUpdate = true;
  fx.label.position.copy(fx.sprite.position); fx.label.position.z -= 1.2;
  fx.label.visible = true;
}
function hookHands() {
  const w = W();
  if (w && w.beforeRender && !fx.hooked) { w.beforeRender.add(() => handScrub()); fx.hooked = true; }
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
  // through agent.js's registry, so John's instructions and Gemini Live get these tools and rules too
  (window.walkinTools = window.walkinTools || []).push({
    run: {
      set_sun_time: (args = {}) => sun({ date: args.date, time: args.time, show: true }),
      sun_report: (args = {}) => sunReport({ date: args.date }),
      sun_off: () => sunOff(),
    },
    rules: `- Sunlight ("where does the sun come in", "show me 4 pm in December", "is this room bright in the morning"): call set_sun_time,
  or sun_report for a whole day room by room. Say the time, how many windows are lit and which rooms; keep it to two sentences.
  If the user gives no time, leave time empty. "Hide the sun" -> sun_off.`,
    declarations: [
    { name: 'set_sun_time',
      description: 'Show where direct sunlight falls on the floor of this house through its real windows at a date and time. Use for "where does the sun come in", "morning light", "show me 4 pm in December", "is this room bright in the afternoon". Returns the lit windows, square metres of floor in direct sun, and the sun\'s elevation and compass direction.',
      parameters: { type: 'object', properties: {
        date: { type: 'string', description: 'YYYY-MM-DD, or a month name like "December". Leave empty for today.' },
        time: { type: 'string', description: 'Local time: "16:00", "4pm", "9:30 am", "noon", "sunrise", "sunset". Leave empty for now.' } } } },
    { name: 'sun_report',
      description: 'Which rooms get direct sun and when, over a whole day, from the real windows: hours per room, first and last lit hour, and the compass direction each window faces. Use for "does the kitchen get morning sun", "which room is sunniest", "which way does this house face".',
      parameters: { type: 'object', properties: {
        date: { type: 'string', description: 'YYYY-MM-DD or a month name. Leave empty for today.' } } } },
    { name: 'sun_off', description: 'Hide the sunlight patches again.', parameters: { type: 'object', properties: {} } }
    ],
  });
}

async function start() {
  hookHands();
  const w = W();
  if (!w || w.sun) return;
  w.sun = sun;
  w.sunReport = sunReport;
  w.sunOff = sunOff;
  await loadGeo();
  buildPanel();
  if (!geo) updatePanel(noGeo());
  else {
    // a demo in the evening should not open at night: when the sun is down now, start the slider at 10 am
    const t = sunTimes(state.date);
    if (t.rise != null && t.set != null && (state.minutes < t.rise + 30 || state.minutes > t.set - 30)) state.minutes = 600;
    // off until asked (tap the sun, or ask John), so the shadow pass costs nothing on the phone; ?sun=on starts it lit
    if (/[?&]sun=on\b/.test(location.search)) sun({ show: true });
    else { state.show = false; updatePanel(null); if (panel) { els.label.textContent = 'Sunlight · tap ☀ or ask John'; els.sub.textContent = ''; } }
  }
}
registerTools();
if (window.walkin) start(); else addEventListener('walkin:ready', start, { once: true });
