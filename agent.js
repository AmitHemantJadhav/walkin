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
- Act first, then confirm briefly what you did and whether it fits. If a tool says a feature is unavailable, say so plainly.`;

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
      description: 'Cover the wall the user points at with a tiling texture (wallpaper, brick, paint, wood).',
      parameters: { type: 'object', properties: {
        texture_url: { type: 'string', description: 'URL or data URL of a seamless tile image.' },
        tile_metres: { type: 'number', description: 'Real width of one tile in metres. Default 1.' } },
        required: ['texture_url'] } },
    { name: 'place_object',
      description: 'Place a small object (plant, lamp, rug) where the user points, or 1.5 m in front of them.',
      parameters: { type: 'object', properties: {
        kind: { type: 'string', description: 'Object key, e.g. plant-monstera, plant-snake, lamp, rug.' } },
        required: ['kind'] } },
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
    return { kind: o.userData.kind, room: room ? room.label : null };
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
    listing: h.listing || null,
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
    const fit = document.getElementById('fit');
    return { ok: true, placed: kind, fit: fit ? fit.textContent : null };
  },

  async stage_room({ room, style }) {
    const w = W(), r = findRoom(room);
    if (!r) return { ok: false, reason: `No room called "${room}".` };
    if (typeof w.stageRoom !== 'function') return unavailable('stageRoom', 'shaurya');
    return { ok: true, room: r.label, result: (await w.stageRoom(r.id, style)) ?? null };
  },

  async set_wall_material({ texture_url, tile_metres }) {
    const w = W(), wall = w.pointer && w.pointer.wall;
    if (typeof w.setWallMaterial !== 'function') return unavailable('setWallMaterial', 'amit');
    if (!wall) return { ok: false, reason: 'The user is not pointing at a wall.' };
    await w.setWallMaterial(wall, texture_url, tile_metres || 1);
    return { ok: true };
  },

  async place_object({ kind }) {
    const w = W();
    if (typeof w.placeObject !== 'function') return unavailable('placeObject', 'shaurya');
    const pt = w.pointer && w.pointer.point, u = userPos();
    const x = pt ? pt[0] : u.x + Math.cos(w.view.yaw) * 1.5, y = pt ? pt[1] : u.y + Math.sin(w.view.yaw) * 1.5;
    return { ok: true, placed: kind, result: (await w.placeObject(kind, x, y)) ?? null };
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
let statusEl, inputEl, talkEl;
function setStatus(t) { if (statusEl) statusEl.textContent = t; }

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
    body.vr #agent { display: none !important; }`;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'agent';
  el.className = 'panel';
  el.innerHTML = `<div id="agentSay">Ask me about this house, or tell me what to change.</div>
    <form><input id="agentIn" placeholder="add a sofa · how big is this room?" autocomplete="off" enterkeyhint="send">
    <button>Ask</button><button type="button" id="agentTalk" title="Talk to the agent">🎤 Talk</button></form>`;
  document.body.appendChild(el);
  statusEl = el.querySelector('#agentSay');
  inputEl = el.querySelector('#agentIn');
  talkEl = el.querySelector('#agentTalk');
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
  window.walkin.agent = { ask, describeHouse, history, tools: RUN, speak };
  window.walkin.say = say;
  window.walkin.onTalk = onTalk; // called by the pinch-hold menu (A5)
})();
