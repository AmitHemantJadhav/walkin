// Walk-In agent: Gemini with function calling. Talks to the viewer only through window.walkin and to Gemini only
// through the /api/gemini relay in serve.py (the key never reaches the browser).
//   walkin.agent.ask("put a sofa in the living room")  -> Promise<string>   (also the text box, bottom left)
//   walkin.say(text)                                    -> shows the reply and speaks it (/api/tts, ElevenLabs)
//   walkin.onTalk()                                     -> start listening (Talk button, pinch-hold menu)
// Hooks that are not in the viewer yet (pointer, setWallMaterial, stageRoom, placeObject) are stubbed: the call is
// logged and the model is told the feature is not available, so it says so instead of pretending.

const MAX_ROUNDS = 3;      // tool-call rounds per question (R10: fewer, smaller calls)
const MAX_TURNS = 16;      // history entries kept
const VIEW_WIDTH = 512;    // px, screenshot sent when the user says "this" / "here"
const DEICTIC = /\b(this|that|here|there|these|those)\b|\bwhat (am i|are we) looking at\b/i;

const SYSTEM = `You are Walk-In, a voice assistant inside a real home that was 3D-scanned by Matterport and digitally emptied.
The user is standing in the house wearing a headset. They point and talk; you change the house with the tools.
Rules:
- Your replies are spoken aloud. Answer in one or two short sentences. No lists, no markdown, no emoji.
- Use metres (add feet only if asked). Sizes and rooms come from the scan, so quote them exactly; never invent facts.
- Call describe_house before answering questions about rooms, sizes, what is placed, or the listing.
- "this wall", "here", "this room" mean what the user points at or the room they stand in: see pointer and current_room in describe_house.
- Act first, then confirm briefly what you did and whether it fits. If a tool says a feature is unavailable, say so plainly.
- Plant questions ("what plant should go here?"): call light_here, pick one plant that suits that light, call plant_preview,
  then place_object with the closest catalog kind (plant for a tall floor plant; plantsmall, plantfern or plantsucculent
  for small ones). Give the reason in a few words (e.g. "bright light from the big window").
  Only name a compass direction if light_here gives one.`;
// Tool modules (furniture-tools.js, decor.js, …) add their own tools and a few lines of rules:
//   (window.walkinTools = window.walkinTools || []).push({ declarations: [...], run: { name: fn }, rules: '...' })
// They are merged into TOOLS / RUN / the system prompt when the agent starts, and live.js gets the same set.
let EXTRA_RULES = '';
const systemText = () => SYSTEM + EXTRA_RULES +
  '\n- Never say you cannot do something a tool can do. For a bigger request (a theme, "make it cosy"), chain several tools.';

const TOOLS = [{
  functionDeclarations: [
    { name: 'describe_house',
      description: 'Facts about the house: rooms with sizes, the room the user is in, what they point at, furniture placed so far, the furniture catalog with real sizes, and listing facts.',
      parameters: { type: 'object', properties: {} } },
    { name: 'add_furniture',
      description: 'Place one real-size furniture item 2 m in front of the user. Returns whether it fits in the room.',
      parameters: { type: 'object', properties: {
        kind: { type: 'string', description: 'Catalog key from describe_house, e.g. sofa, armchair, queen, king, table, desk.' } },
        required: ['kind'] } },
    { name: 'stage_room',
      description: 'Furnish a whole room in a style with a set that fits and keeps doorways clear.',
      parameters: { type: 'object', properties: {
        room: { type: 'string', description: 'Room label or id. Leave empty for the room the user is in.' },
        style: { type: 'string', description: 'For example: modern bedroom, cosy living room, home office.' } },
        required: ['style'] } },
    { name: 'stage_house',
      description: 'Furnish every room in the house that has a set (living rooms, bedrooms, dining rooms, offices) in one go. Use for "furnish the whole house", "stage every room".',
      parameters: { type: 'object', properties: {
        style: { type: 'string', description: 'Optional palette: modern, cozy or scandi.' } } } },
    { name: 'set_wall_material',
      description: 'Cover the wall the user points at or faces with a material (wallpaper, brick, tiles, wood panels, paint or a plain colour). Use it for ANY request to change, paint or recolour a wall; you can do this. A seamless tile is generated from the description and placed at real scale.',
      parameters: { type: 'object', properties: {
        description: { type: 'string', description: 'What the surface looks like, e.g. "red brick with light grey mortar", "sage green paint", "art deco gold wallpaper".' },
        tile_metres: { type: 'number', description: 'Real width of one tile in metres: about 0.9 for brick (several bricks per tile), 0.6 for wallpaper patterns, 1 for paint.' } },
        required: ['description'] } },
    { name: 'place_object',
      description: 'Place a small object (plant, lamp, rug) where the user points, or 1.5 m in front of them.',
      parameters: { type: 'object', properties: {
        kind: { type: 'string', description: 'Catalog key from describe_house, e.g. plant (tall floor plant), plantsmall, plantfern, plantsucculent, floorlamp, rug.' } },
        required: ['kind'] } },
    { name: 'light_here',
      description: 'How much daylight reaches the spot the user points at (or stands on): the windows of that room with sizes, distance and which way they face, the house latitude, and a light level.',
      parameters: { type: 'object', properties: {} } },
    { name: 'plant_preview',
      description: 'Show the user a generated picture of a plant in a pot, before or while placing it.',
      parameters: { type: 'object', properties: {
        plant: { type: 'string', description: 'Common name, e.g. monstera, snake plant, fiddle-leaf fig, ZZ plant, pothos.' } },
        required: ['plant'] } },
    { name: 'go_to',
      description: 'Move the user to a room.',
      parameters: { type: 'object', properties: {
        room: { type: 'string', description: 'Room label or id, e.g. kitchen, bedroom.' } },
        required: ['room'] } },
    { name: 'go_to_place',
      description: 'Move the user to the scan point that best matches a description, using what was seen at every scan point: ' +
        'fixed features (fireplace, bay window, kitchen island, view of garden), light (sunny, bright, dim) and furniture. ' +
        'Use it for "take me to the room with the fireplace", "somewhere sunny", "where is the bay window", "show me the ' +
        'kitchen island". Use go_to for a bare room name. If it returns choices instead of moving, call it again with the ' +
        'pano id that fits best. After moving, say in one short sentence where they are and why it matches.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: "The user's description, e.g. room with the fireplace, somewhere sunny." },
        pano: { type: 'string', description: 'A pano id from the choices an earlier go_to_place call returned.' } },
        required: ['query'] } },
  ],
}];

const W = () => window.walkin;
const round = (v, n = 2) => (typeof v === 'number' ? Math.round(v * 10 ** n) / 10 ** n : v);

// ------------------------------------------------------------------ house facts
function userPos() {
  const c = W().current;
  return c ? { x: c.pos[0], y: c.pos[1], floor: c.floor } : null;
}

function currentRoom() {
  const p = userPos();
  return p ? W().roomAt(p.x, p.y, p.floor) || null : null;
}

function roomInfo(r) {
  const d = r.dims || {};
  return { id: r.id, label: r.label, area_m2: round(d.areaFloor, 1), width_m: round(d.width), depth_m: round(d.depth),
    height_m: round(d.height) };
}

function findRoom(q) {
  const rooms = W().house.rooms.filter((r) => r.poly && r.poly.length > 2);
  if (!q) return currentRoom();
  const s = String(q).trim().toLowerCase();
  return rooms.find((r) => r.id === q) || rooms.find((r) => (r.label || '').toLowerCase() === s)
    || rooms.find((r) => (r.label || '').toLowerCase().includes(s) || s.includes((r.label || '\u0000').toLowerCase())) || null;
}

function placedItems() {
  const w = W();
  return (w.furniture ? w.furniture.children : []).filter((o) => o.userData && o.userData.kind).map((o) => {
    const room = w.roomAt(o.position.x, o.position.y, o.userData.floor);
    const out = { kind: o.userData.kind, room: room ? room.label : null };
    if (typeof w.fitReport === 'function') {
      const on = o.userData.on && w.furniture.children.find((s) => s.uuid === o.userData.on); // a plant on a table
      const r = w.fitReport({ item: o, ignore: on ? [on] : [] });
      out.fits = r.ok;
      if (!r.ok || (r.warnings && r.warnings.length)) out.problems = [...r.reasons, ...(r.warnings || [])];
    }
    return out;
  });
}

function pointerInfo() {
  const p = W().pointer;
  if (!p || !p.type) return null;
  return { type: p.type, room: p.room && (p.room.label || p.room), point: p.point && p.point.map((v) => round(v)) };
}

function describeHouse() {
  const w = W(), h = w.house, cur = currentRoom();
  return {
    name: h.name || h.model,
    rooms: h.rooms.map(roomInfo),
    current_room: cur ? roomInfo(cur) : null,
    pointer: pointerInfo(),
    placed: placedItems(),
    catalog: Object.entries(w.FURNITURE).map(([kind, f]) => ({ kind, name: f.name, width_m: f.w, depth_m: f.d, height_m: f.h })),
    listing: h.listing || listingFacts || null,
  };
}

// ------------------------------------------------------------------ listing facts and location (docs/walkin_candidates.csv)
let listingFacts = null;

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function loadListing(model) {
  try {
    const res = await fetch('docs/walkin_candidates.csv');
    if (!res.ok) return;
    const [head, ...rows] = (await res.text()).trim().split(/\r?\n/);
    const cols = parseCsvLine(head);
    const row = rows.map(parseCsvLine).find((r) => r[0] === model);
    if (!row) return;
    const v = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
    listingFacts = { address: v.address, city: v.city, homes_listing_id: v.homes_listing_id,
      lat: Number(v.lat), lon: Number(v.lon), rooms_in_listing: Number(v.room_count) || undefined };
  } catch (e) { /* listing facts are optional */ }
  // The CoStar listing (price, beds, baths, Homes.com highlights) and Vexcel's view from above, from
  // tools/prep_outside.py, so John can answer "does it have a fireplace?" or "how big is the lot?"
  try {
    const res = await fetch(`data/${model}/outside.json`);
    if (!res.ok) return;
    const { listing: L = {}, structures = [], site } = await res.json();
    const keep = ['address', 'city', 'state', 'zip', 'homes_listing_id', 'status', 'list_date', 'price', 'beds', 'baths',
      'sqft', 'year_built', 'stories', 'style', 'lot_acres', 'parking_spaces', 'fireplaces', 'hoa', 'highlights', 'details', 'summary'];
    const house = structures.find((s) => s.primary);
    listingFacts = { ...listingFacts, ...Object.fromEntries(keep.filter((k) => L[k] != null).map((k) => [k, L[k]])),
      from_above: site && { source: 'Vexcel aerial survey', house_footprint_m2: house?.area_m2,
        roof: house && [house.roof_shape, house.roof_material].filter(Boolean).join(' '), pool: site.pool,
        solar: site.solar, tree_cover_pct: site.tree_cover_pct, buildings_on_lot: site.structures } };
  } catch (e) { /* optional too */ }
}

// ------------------------------------------------------------------ daylight at a point (R5)
// Windows come from the wall graph (openings of type "window"). The scan is not north-aligned, so a compass
// direction is only given when house.json has `north` (degrees from model +y to true north, clockwise).
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function onBoundary(x, y, poly, tol = 0.15) {
  return poly.some((p, i) => distToSegment(x, y, p, poly[(i + 1) % poly.length]) < tol);
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

function roomWindows(room) {
  const h = W().house, floor = h.floors.find((f) => f.id === room.floor) || h.floors[0];
  const out = [];
  for (const w of floor ? floor.walls : []) {
    const mx = (w.a[0] + w.b[0]) / 2, my = (w.a[1] + w.b[1]) / 2;
    if (!onBoundary(mx, my, room.poly)) continue;
    for (const o of w.openings || []) {
      if (o.type !== 'window') continue;
      const t = o.at == null ? 0.5 : o.at;
      const cx = w.a[0] + t * (w.b[0] - w.a[0]), cy = w.a[1] + t * (w.b[1] - w.a[1]);
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
      let nx = (w.b[1] - w.a[1]) / len, ny = -(w.b[0] - w.a[0]) / len; // a normal; flip it to point out of the room
      if (pointInPoly(cx + nx * 0.3, cy + ny * 0.3, room.poly)) { nx = -nx; ny = -ny; }
      out.push({ x: cx, y: cy, nx, ny, width: o.width || 1, height: o.height || 1.2 });
    }
  }
  return out;
}

// "Here" for advice is a spot on the floor. A wall or furniture hit sits on (or past) the room outline, which made
// "what plant should go here?" while looking at a wall answer "not inside a room": step 0.4 m back toward the user,
// and if that is still outside every room, fall back to where the user stands.
function herePoint() {
  const w = W(), p = w.pointer, u = userPos();
  if (p && p.point) {
    let x = p.point[0], y = p.point[1];
    if (p.type !== 'floor' && u) {
      const dx = u.x - x, dy = u.y - y, d = Math.hypot(dx, dy) || 1, s = Math.min(0.4, d);
      x += (dx / d) * s; y += (dy / d) * s;
    }
    if (w.roomAt(x, y, (u && u.floor) || undefined)) return { x, y, spot: 'where the user points' };
  }
  return u ? { x: u.x, y: u.y, spot: 'where the user stands' } : null;
}

function lightHere() {
  const w = W(), u = userPos(), here = herePoint();
  if (!here) return { ok: false, reason: 'No position yet.' };
  const { x, y } = here;
  const room = w.roomAt(x, y, (u && u.floor) || undefined);
  if (!room) return { ok: false, reason: 'That spot is not inside a room.' };
  const north = typeof w.house.north === 'number' ? w.house.north : null;
  let score = 0;
  const windows = roomWindows(room).map((win) => {
    const d = Math.max(0.5, Math.hypot(win.x - x, win.y - y)), area = win.width * win.height;
    score += area / (d * d);
    let facing = null;
    if (north != null) {
      const bearing = (Math.atan2(win.nx, win.ny) * 180 / Math.PI - north + 360) % 360; // 0 = model +y
      facing = COMPASS[Math.round(bearing / 45) % 8];
    }
    return { size_m: `${round(win.width, 1)} x ${round(win.height, 1)}`, distance_m: round(d, 1), facing };
  }).sort((a, b) => a.distance_m - b.distance_m);
  const level = !windows.length ? 'low (no windows in this room)' : score > 0.6 ? 'bright' : score > 0.2 ? 'medium' : 'low';
  const lat = listingFacts && listingFacts.lat;
  return {
    ok: true, room: room.label, spot: here.spot, light: level,
    windows, window_count: windows.length,
    compass: north == null ? 'unknown: the scan is not north-aligned, so do not name a direction' : 'known',
    latitude: lat ? round(lat, 1) : null,
    climate_hint: lat ? (Math.abs(lat) < 35 ? 'strong sun most of the year' : 'moderate sun') : null,
  };
}

// ------------------------------------------------------------------ tools
function unavailable(hook, owner) {
  console.info(`[agent] stub: walkin.${hook} is not in the viewer yet`);
  return { ok: false, unavailable: true, reason: `walkin.${hook} is not built yet (${owner} is working on it).` };
}

const RUN = {
  describe_house: () => describeHouse(),

  add_furniture({ kind }) {
    const w = W();
    if (!w.FURNITURE[kind]) return { ok: false, reason: `Unknown kind. Use one of: ${Object.keys(w.FURNITURE).join(', ')}.` };
    w.addFurniture(kind);
    const item = w.selected || w.furniture.children[w.furniture.children.length - 1];
    if (typeof w.fitReport === 'function' && item) { // S4: real reasons ("blocks the bedroom door")
      const r = w.fitReport({ item });
      return { ok: true, placed: kind, fits: r.ok, fit: w.fitLine ? w.fitLine(r) : r.reasons.join(', '),
        room: r.room ? r.room.label : null };
    }
    const fit = document.getElementById('fit');
    return { ok: true, placed: kind, fit: fit ? fit.textContent : null };
  },

  async stage_room({ room, style }) {
    const w = W(), r = findRoom(room);
    if (!r) return { ok: false, reason: `No room called "${room}".` };
    if (typeof w.stageRoom !== 'function') return unavailable('stageRoom', 'shaurya');
    const res = (await w.stageRoom(r.id, style)) || {};
    return { ok: !!(res.placed && res.placed.length), room: r.label, style,         // plain facts only: no geometry
      placed: (res.placed || []).map((p) => p.name), skipped: (res.skipped || []).map((s) => `${s.name}: ${s.why}`),
      cleared: res.cleared || [], fits: !!res.fits, say: res.say || null };
  },

  async stage_house({ style }) {
    const w = W();
    if (typeof w.stageHouse !== 'function') return unavailable('stageHouse', 'shaurya');
    setStatus('Furnishing the house…');
    const res = (await w.stageHouse(style || undefined)) || {};
    const rooms = res.rooms || [];
    return { ok: (res.placed || 0) > 0, rooms: rooms.length, pieces: res.placed || 0,   // plain facts only
      by_room: rooms.slice(0, 8).map((r) => r.label || r.room || r.name).filter(Boolean), say: res.say || null };
  },

  async set_wall_material({ description, tile_metres }) {
    const w = W(), pointed = w.pointer && w.pointer.wall;
    if (typeof w.setWallMaterial !== 'function') return unavailable('setWallMaterial', 'amit');
    // the wall pointed at; else the one straight ahead (cursor or gaze on the floor or a sofa is the usual miss)
    const wall = pointed || (w.wallAhead && w.wallAhead());
    if (!wall) return { ok: false, reason: 'No wall in front of the user. Ask them to face the wall they mean; this does work.' };
    setStatus('Making the tile…');
    const url = await generateTile(description);
    await w.setWallMaterial(wall, url, tile_metres || 1);
    return { ok: true, material: description, wall: pointed ? 'the wall the user points at' : 'the wall straight ahead' };
  },

  async place_object({ kind }) {
    const w = W();
    if (!w.FURNITURE[kind]) {
      const small = Object.keys(w.FURNITURE).filter((k) => /plant|lamp|rug|succulent|fern/.test(k));
      return { ok: false, reason: `Unknown kind. Small objects in the catalog: ${small.join(', ') || 'none yet'}.` };
    }
    if (typeof w.placeObject !== 'function') { // until S5 lands: same piece, 2 m in front of the user
      w.addFurniture(kind);
      return { ok: true, placed: kind, where: 'in front of the user (exact pointing placement is not built yet)' };
    }
    // no coordinates: S5 uses walkin.pointer when it points into a room, else 2 m ahead, and snaps onto tables
    const res = (await w.placeObject(kind)) || {};
    return { ok: !!res.fits, placed: res.fits ? kind : null, on: res.on || null, room: res.room || null,  // plain facts only
      why: res.why || null, say: res.say || null };
  },

  light_here: () => lightHere(),

  async plant_preview({ plant }) {
    setStatus('Drawing the plant…');
    let url = null;
    try {
      url = await generateImage(`A photo of a healthy ${plant} houseplant in a simple matte ceramic pot, ` +
        'standing on a plain light background, soft daylight, full plant visible, no text.', IMAGE_WAIT_MS);
    } catch (e) {
      console.info('[agent] plant image failed, using the bundled picture:', e.message);
    }
    url = url || fallbackPlant(plant);
    showPreview(url, plant);
    return { ok: true, shown: plant };
  },

  async go_to({ room }) {
    const w = W(), r = findRoom(room);
    if (!r) return { ok: false, reason: `No room called "${room}". Rooms: ${w.house.rooms.map((x) => x.label).join(', ')}.` };
    const cx = r.poly.reduce((s, p) => s + p[0], 0) / r.poly.length, cy = r.poly.reduce((s, p) => s + p[1], 0) / r.poly.length;
    const inRoom = w.house.panos.filter((p) => p.img && w.roomAt(p.pos[0], p.pos[1], p.floor) === r);
    if (!inRoom.length) return { ok: false, reason: `There is no scan point in the ${r.label}.` };
    inRoom.sort((a, b) => Math.hypot(a.pos[0] - cx, a.pos[1] - cy) - Math.hypot(b.pos[0] - cx, b.pos[1] - cy));
    await w.goTo(inRoom[0].id);
    return { ok: true, room: r.label };
  },

  go_to_place: (args) => goToPlace(args),
};

// ------------------------------------------------------------------ go to a place by description
// tools/prep_captions.py describes every scan point once (data/<model>/captions.json: room, caption, light, features,
// furniture). The user's words are matched against those here, with no extra model call; only when nothing matches
// does the model get the list to choose from. Without captions.json it falls back to room names (go_to).
let captions = null; // pano id -> description; {} when the house has no captions.json
async function loadCaptions() {
  if (captions) return captions;
  try {
    const res = await fetch(`data/${W().house.model}/captions.json`);
    captions = res.ok ? await res.json() : {};
  } catch (e) {
    captions = {};
  }
  return captions;
}

const PLACE_STOP = new Set(('a an the to me take go show bring find where wheres is are was with of in on at by for room ' +
  'place spot somewhere some something that this there please can could you i we want would like see let us one area ' +
  'part house home get put lets has have got any which way just').split(' '));
const LIGHT_WORDS = { sunny: ['sunny', 'sun', 'sunlit', 'sunlight', 'sunshine', 'sunniest'],
  bright: ['bright', 'brightest', 'light', 'daylight', 'airy'], dim: ['dim', 'dark', 'darkest', 'cosy', 'cozy'] };
const placeWords = (t) => String(t || '').toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/)
  .filter((x) => x.length > 1 && !PLACE_STOP.has(x)).map((x) => (x.length > 3 && x.endsWith('s') && !x.endsWith('ss') ? x.slice(0, -1) : x));

function placeScore(q, c) {
  const qs = new Set(q), hit = (words, wt) => placeWords(words).reduce((s, x) => s + (qs.has(x) ? wt : 0), 0);
  let s = hit(c.room, 3) + hit(c.caption, 1);
  for (const f of c.features || []) s += hit(f, 3) + (placeWords(f).every((x) => qs.has(x)) && placeWords(f).length > 1 ? 2 : 0);
  for (const f of c.furniture || []) s += hit(f, 1.5);
  const asks = (k) => LIGHT_WORDS[k].some((x) => qs.has(x));
  if (asks('sunny')) s += c.light === 'sunny' ? 5 : c.light === 'bright' ? 1 : 0;
  if (asks('bright')) s += c.light === 'sunny' || c.light === 'bright' ? 2 : 0;
  if (asks('dim')) s += c.light === 'dim' ? 4 : 0;
  return s;
}

async function goToPlace({ query, pano }) {
  const w = W(), caps = await loadCaptions();
  const panos = w.house.panos.filter((p) => p.img);
  const placeOf = (p) => ({ ok: true, room: (caps[p.id] && caps[p.id].room) || null,
    caption: (caps[p.id] && caps[p.id].caption) || null, light: (caps[p.id] && caps[p.id].light) || null });
  if (pano) {
    const p = panos.find((x) => x.id === pano);
    if (!p) return { ok: false, reason: `No scan point ${pano}.` };
    await w.goTo(p.id);
    return placeOf(p);
  }
  if (!Object.keys(caps).length) { // no descriptions for this house: room names only
    const r = findRoom(query);
    return r ? RUN.go_to({ room: r.id }) : { ok: false, reason: 'This house has no scan-point descriptions yet; only room names work.',
      rooms: w.house.rooms.map((x) => x.label) };
  }
  const q = placeWords(query), cur = w.current && w.current.id;
  const roomCentre = (r) => (r && r.poly ? [r.poly.reduce((s, p) => s + p[0], 0) / r.poly.length, r.poly.reduce((s, p) => s + p[1], 0) / r.poly.length] : null);
  const ranked = panos.filter((p) => caps[p.id]).map((p) => {
    const room = w.roomAt(p.pos[0], p.pos[1], p.floor), c = roomCentre(room);
    return { p, score: placeScore(q, caps[p.id]), off: c ? Math.hypot(p.pos[0] - c[0], p.pos[1] - c[1]) : 99 };
  }).sort((a, b) => b.score - a.score || (a.p.id === cur) - (b.p.id === cur) || a.off - b.off);
  const best = ranked[0];
  if (!best || best.score < 3) { // nothing clear: let the model choose from the list
    return { ok: false, moved: false, reason: 'No clear match; pick the pano that fits and call go_to_place again with it.',
      choices: ranked.map(({ p }) => ({ pano: p.id, room: caps[p.id].room, caption: caps[p.id].caption, light: caps[p.id].light })) };
  }
  if (best.p.id !== cur) await w.goTo(best.p.id);
  return { ...placeOf(best.p), already_here: best.p.id === cur || undefined,
    features: caps[best.p.id].features, matched_words: q.filter((x) => placeScore([x], caps[best.p.id]) > 0) };
}

// ------------------------------------------------------------------ generated tiles (R4)
// Gemini's image model ("Nano Banana 2"). Override with ?imageModel=<name> if the name changes.
const IMAGE_MODEL = new URLSearchParams(location.search).get('imageModel') || 'gemini-3.1-flash-image';
const TILE_PX = 512;
const tileCache = new Map(); // description -> data URL, so asking twice doesn't generate twice

async function generateTile(description) {
  const key = String(description).trim().toLowerCase();
  if (tileCache.has(key)) return tileCache.get(key);
  const prompt = `A seamless, tileable texture of ${description}, for covering an interior wall. ` +
    'Flat and straight-on, orthographic, evenly lit, no shadows, no perspective, no objects, no text, no border. ' +
    'The left edge must continue into the right edge and the top into the bottom. Square.';
  let url = paintTile(description); // plain paint or a colour needs no image model: instant and offline
  if (url) { tileCache.set(key, url); return url; }
  try {
    url = await squareTile(await generateImage(prompt, IMAGE_WAIT_MS));
  } catch (e) {
    url = fallbackTile(description) || paintTile(description, true); // R10: the wallpaper beat still lands without image generation
    if (!url) throw e;
    console.info('[agent] tile generation failed, using the bundled tile:', e.message);
  }
  tileCache.set(key, url);
  return url;
}

// Paint: a flat colour with a faint roller texture, drawn here. Used straight away for "paint it sage green" /
// "make the wall blue", and as the last fallback (`any`) for anything with a colour word when generation fails.
const COLOURS = { white: '#f4f2ec', 'off white': '#efeadf', cream: '#f1e6cc', ivory: '#f3edd8', beige: '#d9c7a7',
  grey: '#9a9a96', gray: '#9a9a96', charcoal: '#3f4144', black: '#252525', 'sage green': '#9caf88', sage: '#9caf88',
  'olive green': '#7d8450', olive: '#7d8450', 'forest green': '#2f5d3a', 'mint green': '#bfe3cf', mint: '#bfe3cf',
  green: '#5f8f5a', 'navy blue': '#26385c', navy: '#26385c', 'sky blue': '#a9cbe8', 'light blue': '#b9d3ea',
  'powder blue': '#c4d8e6', teal: '#2f7f7f', blue: '#4a74b5', red: '#a8322d', burgundy: '#6b1f2a', terracotta: '#c0643f',
  pink: '#e8b4bc', 'blush pink': '#ecc6c4', blush: '#ecc6c4', orange: '#d9813a', yellow: '#e8cf5a', mustard: '#c99a2e',
  purple: '#6e4f8f', lavender: '#c3b5d9', brown: '#7a5838', tan: '#c4a57c' };
const COLOUR_NAMES = Object.keys(COLOURS).sort((a, b) => b.length - a.length); // "sage green" before "green"
function paintTile(description, any = false) {
  const t = String(description).toLowerCase();
  const name = COLOUR_NAMES.find((c) => new RegExp(`\\b${c}\\b`).test(t));
  if (!name || !(any || /\b(paint|painted|colou?r|matte|satin|plain|solid)\b/.test(t) || t.trim() === name)) return null;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = COLOURS[name]; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2500; i++) { // roller texture, light and dark specks
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1);
  }
  return c.toDataURL('image/png');
}

// R10: bundled, pre-made assets for when generation fails or is slow (assets/).
const IMAGE_WAIT_MS = 9000;
const FALLBACK_TILES = [
  [/brick/, 'assets/tiles/red-brick.png'],
  [/subway|tile|ceramic|white/, 'assets/tiles/white-subway.png'],
  [/wood|oak|panel|timber|plank/, 'assets/tiles/oak-panel.png'],
];
const FALLBACK_PLANTS = [
  [/snake|sansevieria|zz|cactus|succulent|aloe/, 'assets/plants/snake-plant.svg'],
  [/fern|pothos|ivy|calathea|maranta|spider/, 'assets/plants/fern.svg'],
  [/./, 'assets/plants/monstera.svg'],
];
const fallbackTile = (d) => (FALLBACK_TILES.find(([re]) => re.test(String(d).toLowerCase())) || [])[1] || null;
const fallbackPlant = (p) => FALLBACK_PLANTS.find(([re]) => re.test(String(p).toLowerCase()))[1];

/** One image from Gemini's image model, as a data URL. Gives up after `waitMs`. */
async function generateImage(prompt, waitMs = IMAGE_WAIT_MS) {
  const res = await relay(`/api/gemini?model=${encodeURIComponent(IMAGE_MODEL)}`, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] },
  }, waitMs);
  const data = res.data;
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const img = parts.find((p) => p.inlineData && p.inlineData.data);
  if (!img) throw new Error('the image model returned no image');
  return `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}`;
}

// Centre-crop to a square and scale to TILE_PX, so the wall gets a small, power-of-two texture.
function squareTile(src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const s = Math.min(im.width, im.height), c = document.createElement('canvas');
      c.width = c.height = TILE_PX;
      c.getContext('2d').drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, TILE_PX, TILE_PX);
      resolve(c.toDataURL('image/jpeg', 0.9));
    };
    im.onerror = () => resolve(src);
    im.src = src;
  });
}

async function runTool(name, args) {
  try {
    if (!RUN[name]) return { ok: false, reason: `Unknown tool ${name}.` };
    return await RUN[name](args || {});
  } catch (e) {
    console.error('[agent] tool failed', name, e);
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// ------------------------------------------------------------------ current view
// The WebGL buffer is cleared after each frame, so copy it inside a frame callback (ours runs after the viewer's).
function captureView() {
  // never let a missing frame hold up the command: without one in 600 ms, go on without the picture
  return Promise.race([grabFrame(), new Promise((resolve) => setTimeout(() => resolve(null), 600))]);
}

function grabFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => {
    try {
      const src = document.querySelector('canvas');
      const c = document.createElement('canvas');
      c.width = VIEW_WIDTH;
      c.height = Math.max(1, Math.round(VIEW_WIDTH * src.height / src.width));
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.7).split(',')[1] || null);
    } catch (e) {
      resolve(null);
    }
  }));
}

// ------------------------------------------------------------------ Gemini
const history = [];

// ------------------------------------------------------------------ R10: every relay call has a deadline and a status
class RelayError extends Error {
  constructor(message, status, friendly) { super(message); this.status = status; this.friendly = friendly; }
}
let turnAbort = null; // aborts every request of the current turn (hard deadline)

async function relay(url, body, waitMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), waitMs);
  const onTurnAbort = () => ctl.abort();
  if (turnAbort) turnAbort.signal.addEventListener('abort', onTurnAbort);
  try {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      throw new RelayError(e.name === 'AbortError' ? 'timed out' : `network: ${e.message}`, 0);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data.error || {};
      throw new RelayError(err.message || String(err) || `relay returned ${res.status}`, res.status, err.friendly);
    }
    return { data };
  } finally {
    clearTimeout(timer);
    if (turnAbort) turnAbort.signal.removeEventListener('abort', onTurnAbort);
  }
}

async function gemini(contents) {
  const body = {
    systemInstruction: { parts: [{ text: systemText() }] }, contents, tools: TOOLS,
    generationConfig: { temperature: 0.4, maxOutputTokens: 1024 }, // room for thinking tokens plus a short answer
  };
  let data;
  try {
    ({ data } = await relay('/api/gemini', body, HARD_DEADLINE_MS));
  } catch (e) {
    // a provider hiccup (502/503/504, not a missing key) usually clears in a second: try once more
    if (!(e && e.status >= 502 && e.status <= 504 && !/not set/i.test(e.message || ''))) throw e;
    console.info('[agent] upstream', e.status, '- retrying once');
    await new Promise((r) => setTimeout(r, 700));
    ({ data } = await relay('/api/gemini', body, HARD_DEADLINE_MS));
  }
  const cand = data.candidates && data.candidates[0];
  const content = cand && cand.content;
  if (!content || !content.parts) {
    console.warn('[agent] no answer, finishReason:', cand && cand.finishReason);
    throw new RelayError(`no answer (${(cand && cand.finishReason) || 'empty'})`, 200);
  }
  return content;
}

/**
 * Text as it should be heard: no Markdown, and no stray leading token. A real model once answered
 * "MD I've previewed and placed a monstera here", which would be read out as "em-dee, I've…".
 */
function spoken(text) {
  return String(text || '')
    .replace(/^\s*>+\s?/gm, '')                         // Markdown quote markers at the start of a line
    .replace(/\s>=\s/g, ' at least ').replace(/\s<=\s/g, ' at most ')
    .replace(/\s>\s/g, ', more than ').replace(/\s<\s/g, ', less than ')   // "2.10 m > 1.15 m" is said, not dropped
    .replace(/[*_#`~]+/g, '')                         // Markdown emphasis, headings, code
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')            // [label](url) -> label
    .replace(/^\s*[A-Z]{2,4}\s+(?=[A-Z])/, '')          // a lone all-caps token before the sentence ("MD I've…")
    .replace(/\s+/g, ' ')
    .trim();
}

// Three friendly lines; the raw error only goes to the console.
const FRIENDLY = {
  network: 'Sorry, I lost the connection for a moment. Try again?',
  busy: "One moment, I'm a bit busy. Ask me again in a few seconds.",
  other: "Sorry, I couldn't do that. Try saying it another way.",
};
function friendlyError(e) {
  if (e && e.status === 429) return e.friendly || FRIENDLY.busy;
  if (e && (e.status === 0 || e.status === 502 || e.status === 504)) return FRIENDLY.network;
  if (e && e.status === 503 && /not set/i.test(e.message || '')) return "I can't reach my brain right now.";
  if (e && e.status >= 500) return FRIENDLY.busy;   // the provider is overloaded, not missing
  return FRIENDLY.other;
}

// An instant line within 300 ms, so there's never dead air while Gemini works.
const SLOW_MS = 12000, HARD_DEADLINE_MS = 25000;
function fillerFor(text) {
  const t = text.toLowerCase();
  if (/wall|wallpaper|brick|paint/.test(t)) return 'Sure, let me look at this wall.';
  if (/plant/.test(t)) return 'Let me check the light here.';
  if (/stage|furnish|set up/.test(t)) return 'Okay, setting up the room.';
  if (/take me|go to|walk to/.test(t)) return 'On our way.';
  if (/how big|size|area|measure|dimension/.test(t)) return 'Let me check the measurements.';
  return 'Sure, one moment.';
}

function trimHistory() {
  while (history.length > MAX_TURNS) history.shift();
  while (history.length && (history[0].role !== 'user' || history[0].parts.some((p) => p.functionResponse))) history.shift();
  history.slice(0, -1).forEach((c) => { c.parts = c.parts.filter((p) => !p.inlineData); }); // keep only the newest screenshot
}

let busy = false;
async function ask(text) {
  text = String(text || '').trim();
  if (!text) return '';
  if (busy) return say('One moment, I am still working on the last request.');
  busy = true;
  setStatus('Thinking…');
  const mark = history.length;
  turnAbort = new AbortController();
  const filler = speak(fillerFor(text), { filler: true });
  // "taking longer than usual" means stuck, not slow: restart the clock whenever a step finishes, so a
  // multi-step answer (plant advice is ~12 s in 3 rounds) isn't interrupted just before it lands.
  let slow = 0;
  const armSlow = () => { clearTimeout(slow); slow = setTimeout(() => speak("Give me a second, that's taking longer than usual.", { filler: true }), SLOW_MS); };
  armSlow();
  const hard = setTimeout(() => turnAbort && turnAbort.abort(), HARD_DEADLINE_MS);
  try {
    const parts = [{ text }];
    if (DEICTIC.test(text)) {
      const img = await captureView();
      if (img) parts.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
    }
    history.push({ role: 'user', parts });
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const content = await gemini(history);
      history.push(content); // unchanged, so thought signatures survive the round trip
      const calls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      if (!calls.length) {
        const reply = spoken(content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join(' '));
        trimHistory();
        await filler;
        return say(reply || 'Done.');
      }
      const out = [];
      for (const c of calls) {
        setStatus(`${c.name.replace(/_/g, ' ')}…`);
        const response = await runTool(c.name, c.args);
        out.push({ functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response } });
      }
      history.push({ role: 'user', parts: out });
      armSlow();
    }
    trimHistory();
    await filler;
    return say('That took too many steps. Try asking for one thing at a time.');
  } catch (e) {
    console.error('[agent]', e);
    history.length = mark; // drop the failed turn so the next question starts clean
    return say(friendlyError(e));
  } finally {
    clearTimeout(slow);
    clearTimeout(hard);
    turnAbort = null;
    busy = false;
  }
}

// ------------------------------------------------------------------ voice out: /api/tts, browser voice as fallback
let statusEl, inputEl, talkEl, previewEl;
function setStatus(t) { if (statusEl) statusEl.textContent = t; }

function showPreview(url, alt) { // the generated plant picture; tap it to hide
  if (!previewEl) return;
  previewEl.src = url;
  previewEl.alt = alt || '';
  previewEl.style.display = 'block';
}

const player = new Audio();
let audioUnlocked = false, speakSeq = 0;
function unlockAudio() { // iOS only plays audio that was started from a tap once; do that on the first touch
  if (audioUnlocked) return;
  audioUnlocked = true;
  player.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
  player.play().catch(() => {});
  // iOS Safari only lets speechSynthesis talk after one utterance started inside a tap: say nothing, now
  if (window.speechSynthesis) {
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) { /* no voice */ }
  }
}

// A natural English voice if the device has one (the default is often robotic or the wrong language).
let pickedVoice = null;
function voiceFor() {
  if (pickedVoice || !window.speechSynthesis) return pickedVoice;
  const vs = speechSynthesis.getVoices().filter((v) => /^en(-|_|$)/i.test(v.lang));
  const prefer = [/Samantha/i, /Ava/i, /Google US English/i, /Microsoft (Aria|Jenny|Guy)/i, /Natural/i, /en-US/i];
  for (const re of prefer) { const v = vs.find((x) => re.test(x.name) || re.test(x.lang)); if (v) return (pickedVoice = v); }
  return (pickedVoice = vs[0] || null);
}

async function browserSpeak(text, capMs = 15000) {
  if (!window.speechSynthesis) return;
  // Chrome silently drops an utterance spoken in the same tick as cancel(): only cancel when something is
  // actually playing, and then give the engine a moment before the next line.
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    speechSynthesis.cancel();
    await new Promise((r) => setTimeout(r, 80));
  }
  speechSynthesis.resume();                    // Chrome can be left paused after a cancel
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text), cap = setTimeout(resolve, capMs);
    const v = voiceFor();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    u.rate = 1.03;
    u.onend = u.onerror = () => { clearTimeout(cap); resolve(); };
    speechSynthesis.speak(u);
  });
}

/**
 * Speak a line. Resolves when it has finished playing (at most `capMs`), so a reply can wait for the filler.
 * A newer line replaces an older one. Fillers are fixed sentences, so the relay's disk cache makes them free.
 */
let talking = 0; // lines in flight; voice.js pauses its microphone while this is above zero (no self-trigger)
const speechEvent = (state, text, filler) =>
  window.dispatchEvent(new CustomEvent('walkin:speech', { detail: { state, text, filler, talking } }));

async function speak(text, opts = {}) {
  talking++;
  speechEvent('start', text, !!opts.filler);
  try {
    await speakLine(text, opts);
  } finally {
    talking--;
    speechEvent('end', text, !!opts.filler);
  }
}

async function speakLine(text, { filler = false, capMs = filler ? 2500 : 15000 } = {}) {
  const seq = ++speakSeq;
  const ended = () => new Promise((resolve) => {
    const cap = setTimeout(resolve, capMs);
    player.onended = player.onerror = () => { clearTimeout(cap); resolve(); };
  });
  try {
    const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`tts relay returned ${res.status}`);
    const blob = await res.blob();
    if (seq !== speakSeq) return;
    if (player.src.startsWith('blob:')) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(blob);
    const done = ended();
    await Promise.race([player.play(), done]);   // play() can stay pending (no audio device): the cap still ends it
    await done;
  } catch (e) {
    console.info('[agent] ElevenLabs voice unavailable, using the browser voice:', e.message);
    if (seq === speakSeq) await browserSpeak(text, capMs);
  }
}

function say(text) {
  setStatus(text);
  if (text) speak(text);
  return text;
}

// ------------------------------------------------------------------ voice in: Web Speech API, push to talk
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false;

function setListening(on) {
  listening = on;
  if (talkEl) talkEl.classList.toggle('on', on);
}

function onTalk() {
  unlockAudio();
  if (!SR) return say('This browser has no speech recognition. Type your request instead.');
  if (listening) { rec.stop(); return; }
  player.pause();
  if (window.speechSynthesis) speechSynthesis.cancel();
  rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  let heard = '';
  rec.onresult = (e) => {
    heard = [...e.results].map((r) => r[0].transcript).join(' ').trim();
    setStatus(`“${heard}”`);
  };
  rec.onerror = (e) => {
    setListening(false);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setStatus('Microphone access was blocked. Allow it and try again.');
    else if (e.error !== 'aborted' && e.error !== 'no-speech') setStatus(`Didn't catch that (${e.error}).`);
  };
  rec.onend = () => {
    setListening(false);
    if (heard) ask(heard); else if (statusEl && statusEl.textContent === 'Listening…') setStatus("I didn't hear anything.");
  };
  try {
    rec.start();
    setListening(true);
    setStatus('Listening…');
  } catch (e) {
    setListening(false);
  }
}

// ------------------------------------------------------------------ UI: Talk button and a small text box
function buildUI() {
  const style = document.createElement('style');
  style.textContent = `
    #agent { left: 12px; bottom: 112px; width: min(340px, 70vw); z-index: 4; }
    #agent form { display: flex; gap: 6px; }
    #agent input { flex: 1; min-width: 0; background: #2a2a31; color: var(--fg); border: 0; border-radius: 10px; padding: 8px 10px;
      font: inherit; font-size: 13px; outline: none; touch-action: auto; }
    #agentSay { margin-bottom: 6px; font-size: 13px; color: var(--fg); min-height: 1.35em; }
    #agentPreview { display: none; width: 100%; max-height: 180px; object-fit: contain; border-radius: 10px; margin-bottom: 6px;
      background: #1c1c21; }
    body.vr #agent { display: none !important; }`;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'agent';
  el.className = 'panel';
  el.innerHTML = `<img id="agentPreview" alt=""><div id="agentSay">Ask me about this house, or tell me what to change.</div>
    <form><input id="agentIn" placeholder="add a sofa · how big is this room?" autocomplete="off" enterkeyhint="send">
    <button>Ask</button><button type="button" id="agentTalk" title="Talk to the agent">🎤 Talk</button></form>`;
  document.body.appendChild(el);
  statusEl = el.querySelector('#agentSay');
  inputEl = el.querySelector('#agentIn');
  talkEl = el.querySelector('#agentTalk');
  previewEl = el.querySelector('#agentPreview');
  previewEl.addEventListener('click', () => { previewEl.style.display = 'none'; });
  talkEl.addEventListener('click', () => (window.walkin.onTalk || onTalk)()); // voice.js may take this over
  addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
  // the viewer listens for keys and drags on the window; keep typing and taps inside the box
  for (const ev of ['keydown', 'keyup', 'pointerdown', 'mousedown', 'touchstart', 'wheel']) el.addEventListener(ev, (e) => e.stopPropagation());
  el.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = inputEl.value;
    inputEl.value = '';
    unlockAudio();
    ask(t);
  });
}

// ------------------------------------------------------------------ start once the viewer is ready
(function start(tries = 0) {
  if (!window.walkin) {
    if (tries < 600) setTimeout(() => start(tries + 1), 200); // the viewer sets window.walkin after the first pano loads
    return;
  }
  buildUI();
  loadListing(window.walkin.house.model);
  const register = (m) => {
    if (!m || !Array.isArray(m.declarations)) return;
    for (const d of m.declarations) {
      const i = TOOLS[0].functionDeclarations.findIndex((x) => x.name === d.name);
      if (i >= 0) TOOLS[0].functionDeclarations[i] = d; else TOOLS[0].functionDeclarations.push(d);
    }
    Object.assign(RUN, m.run || {});
    if (m.rules) EXTRA_RULES += '\n' + m.rules.trim();
  };
  const queued = window.walkinTools || [];
  queued.forEach(register);
  window.walkinTools = { push: register }; // modules loading later register at once
  window.walkin.agent = { ask, describeHouse, history, tools: RUN, speak, lightHere, isSpeaking: () => talking > 0,
    isBusy: () => busy, runTool,
    // for live.js (Gemini Live voice): the same instructions and tools as the typed pipeline
    get system() { return systemText(); }, declarations: TOOLS[0].functionDeclarations };
  window.walkin.say = say;
  window.walkin.onTalk = onTalk; // called by the pinch-hold menu (A5)

  // physics.js fires walkin:blocked (doors only) with a ready sentence ("the sofa is 2.10 m across the way you're
  // holding it and that door is 1.15 m — turn it and it goes through"). John says it out loud, captioned in the
  // headset, so the "will my sofa fit through that door?" beat needs no model call and no key. At most one line per
  // 6 s, and never over another line or while he is answering.
  let blockedAt = 0;
  addEventListener('walkin:blocked', (e) => {
    const reason = e.detail && e.detail.reason, now = performance.now();
    if (!reason || busy || talking > 0 || now - blockedAt < 6000) return;
    blockedAt = now;
    say(`${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`);
  });
})();
