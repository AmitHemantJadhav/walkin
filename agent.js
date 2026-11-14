// Walk-In agent: Gemini with function calling. Talks to the viewer only through window.walkin and to Gemini only
// through the /api/gemini relay in serve.py (the key never reaches the browser).
//   walkin.agent.ask("put a sofa in the living room")  -> Promise<string>   (also the text box, bottom left)
//   walkin.say(text)                                    -> shows the reply and speaks it (/api/tts, ElevenLabs)
//   walkin.onTalk()                                     -> start listening (Talk button, pinch-hold menu)
// Hooks that are not in the viewer yet (pointer, setWallMaterial, stageRoom, placeObject) are stubbed: the call is
// logged and the model is told the feature is not available, so it says so instead of pretending.

const MAX_ROUNDS = 5;      // tool-call rounds per question
const MAX_TURNS = 16;      // history entries kept
const VIEW_WIDTH = 768;    // px, screenshot sent when the user says "this" / "here"
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
    { name: 'set_wall_material',
      description: 'Cover the wall the user points at with a material (wallpaper, brick, tiles, wood panels, paint). A seamless tile is generated from the description and placed at real scale.',
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
      const r = w.fitReport({ item: o });
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

function lightHere() {
  const w = W(), pt = w.pointer && w.pointer.point, u = userPos();
  const x = pt ? pt[0] : u && u.x, y = pt ? pt[1] : u && u.y;
  if (x == null) return { ok: false, reason: 'No position yet.' };
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
    ok: true, room: room.label, spot: pt ? 'where the user points' : 'where the user stands', light: level,
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

  async set_wall_material({ description, tile_metres }) {
    const w = W(), wall = w.pointer && w.pointer.wall;
    if (typeof w.setWallMaterial !== 'function') return unavailable('setWallMaterial', 'amit');
    if (!wall) return { ok: false, reason: 'The user is not pointing at a wall. Ask them to point at the wall first.' };
    setStatus('Making the tile…');
    const url = await generateTile(description);
    await w.setWallMaterial(wall, url, tile_metres || 1);
    return { ok: true, material: description };
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
    const pt = w.pointer && w.pointer.point, u = userPos();
    const x = pt ? pt[0] : u.x + Math.cos(w.view.yaw) * 1.5, y = pt ? pt[1] : u.y + Math.sin(w.view.yaw) * 1.5;
    return { ok: true, placed: kind, where: pt ? 'where the user points' : 'in front of the user',
      result: (await w.placeObject(kind, x, y)) ?? null };
  },

  light_here: () => lightHere(),

  async plant_preview({ plant }) {
    setStatus('Drawing the plant…');
    const url = await generateImage(`A photo of a healthy ${plant} houseplant in a simple matte ceramic pot, ` +
      'standing on a plain light background, soft daylight, full plant visible, no text.');
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
};

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
  const url = await squareTile(await generateImage(prompt));
  tileCache.set(key, url);
  return url;
}

/** One image from Gemini's image model, as a data URL. */
async function generateImage(prompt) {
  const res = await fetch(`/api/gemini?model=${encodeURIComponent(IMAGE_MODEL)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'] } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && (data.error.message || data.error)) || `image relay returned ${res.status}`);
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

async function gemini(contents) {
  const res = await fetch('/api/gemini', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] }, contents, tools: TOOLS,
      generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && (data.error.message || data.error)) || `Gemini relay returned ${res.status}`);
  const content = data.candidates && data.candidates[0] && data.candidates[0].content;
  if (!content || !content.parts) throw new Error('Gemini returned no answer.');
  return content;
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
        const reply = content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join(' ').trim();
        trimHistory();
        return say(reply || 'Done.');
      }
      const out = [];
      for (const c of calls) {
        setStatus(`${c.name.replace(/_/g, ' ')}…`);
        const response = await runTool(c.name, c.args);
        out.push({ functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response } });
      }
      history.push({ role: 'user', parts: out });
    }
    trimHistory();
    return say('That took too many steps. Try asking for one thing at a time.');
  } catch (e) {
    console.error('[agent]', e);
    history.length = mark; // drop the failed turn so the next question starts clean
    return say(/not set/.test(e.message) ? 'The agent has no Gemini key yet. Add GEMINI_API_KEY to .env and restart the server.'
      : `Sorry, that didn't work: ${e.message}`);
  } finally {
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
}

function browserSpeak(text) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

async function speak(text) {
  const seq = ++speakSeq; // a newer reply replaces an older one
  try {
    const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`tts relay returned ${res.status}`);
    const blob = await res.blob();
    if (seq !== speakSeq) return;
    if (player.src.startsWith('blob:')) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(blob);
    await player.play();
  } catch (e) {
    console.info('[agent] ElevenLabs voice unavailable, using the browser voice:', e.message);
    if (seq === speakSeq) browserSpeak(text);
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
  talkEl.addEventListener('click', onTalk);
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
  window.walkin.agent = { ask, describeHouse, history, tools: RUN, speak, lightHere };
  window.walkin.say = say;
  window.walkin.onTalk = onTalk; // called by the pinch-hold menu (A5)
})();
