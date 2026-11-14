// End-to-end test of the demo pipelines, with the REAL Gemini model (see tools/e2e.html for how to run it).
// Loads the app in an iframe (?layout=none, so nothing is saved), drives it only through window.walkin, and records
// for every step: the command, the tools John called (with arguments), the Gemini rounds, his reply, the latency
// and a state assertion. Results: the table on the page, and window.__e2e (JSON) for scripts.
//
// URL options: ?m=<model>  ?only=3a,3b,6 (step ids)  ?tts=1 (let John's voice play; muted by default)
//              ?save=1 (download e2e-results.jpg when done)
// Rate limits (serve.py buckets): ~8 text and ~2 image calls a minute. The run paces itself and retries a 429 once.

const q = new URLSearchParams(location.search);
const MODEL = q.get('m') || 'zvKHR9DHNjJ';
const ONLY = q.get('only') ? new Set(q.get('only').split(',').map((s) => s.trim())) : null;
const TTS = q.get('tts') === '1';
const LA_MIRADA = MODEL === 'zvKHR9DHNjJ';

const f = document.getElementById('app');
const tbody = document.querySelector('#results tbody');
const statusEl = document.getElementById('status');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n = 1) => new Promise((r) => { const go = () => (n-- > 0 ? f.contentWindow.requestAnimationFrame(go) : r()); go(); });
const setStatus = (t) => { statusEl.textContent = t; };

// ------------------------------------------------------------------ instrumentation (attached to each page load)
const hard = [], soft = [], blocked = [], gemini = [], toolLog = [];
function attach() {
  const cw = f.contentWindow;
  if (!cw || cw.__e2e || cw.location.href === 'about:blank') return false;
  cw.__e2e = true;
  cw.addEventListener('error', (e) => hard.push(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
  cw.addEventListener('unhandledrejection', (e) => hard.push(`unhandled rejection: ${e.reason && (e.reason.message || e.reason)}`));
  cw.addEventListener('walkin:blocked', (e) => blocked.push(e.detail && e.detail.reason));
  const ce = cw.console.error.bind(cw.console);
  cw.console.error = (...a) => { soft.push(a.map((x) => (x && x.message) || String(x)).join(' ').slice(0, 200)); ce(...a); };
  const of = cw.fetch.bind(cw);
  cw.fetch = async (url, opts) => {
    const u = String((url && url.url) || url);
    if (!TTS && u.includes('/api/tts')) return new cw.Response('{}', { status: 503 });   // muted: no voice
    if (!u.includes('/api/gemini')) return of(url, opts);
    const image = /model=[^&]*image/.test(u);
    const rec = { at: Date.now(), image, status: 0, ms: 0, calls: [], text: '' };
    gemini.push(rec);
    const t0 = performance.now();
    try {
      const res = await of(url, opts);
      rec.status = res.status;
      rec.ms = Math.round(performance.now() - t0);
      res.clone().json().then((d) => {
        const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
        rec.calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall.name);
        rec.sig = parts.some((p) => p.thoughtSignature);   // Gemini 3 signs its calls; OpenRouter's translated reply doesn't
        rec.text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join(' ').slice(0, 200);
      }).catch(() => {});
      return res;
    } catch (e) { rec.status = -1; throw e; }
  };
  if (!TTS && cw.speechSynthesis) cw.speechSynthesis.speak = (u) => setTimeout(() => u.onend && u.onend(), 5);
  return true;
}
setInterval(attach, 5);

/** Wrap every tool John can run, so each call is logged with its arguments, result and time (idempotent). */
function wrapTools(w) {
  const RUN = w.agent.tools;
  for (const [name, fn] of Object.entries(RUN)) {
    if (fn.__e2e) continue;
    const g = async (args) => {
      const rec = { name, args, at: Date.now(), result: null };
      toolLog.push(rec);
      const t0 = performance.now();
      try { rec.result = await fn(args); return rec.result; }
      finally { rec.ms = Math.round(performance.now() - t0); }
    };
    g.__e2e = true;
    RUN[name] = g;
  }
}

async function load(params) {
  f.src = `../index.html?m=${MODEL}&layout=none${params}`;
  await sleep(300);
  for (let i = 0; i < 900; i++) {
    const w = f.contentWindow.walkin;
    if (w && w.agent && w.stageRoom && w.setWallMaterial && w.physics && w.preflight && w.live) return w;
    await sleep(100);
  }
  return f.contentWindow.walkin || null;
}

// ------------------------------------------------------------------ pacing (serve.py: 8 text / 2 image a minute)
async function pace({ text = 4, image = null } = {}) {
  for (;;) {
    const now = Date.now(), recent = gemini.filter((g) => now - g.at < 60000);
    const t = recent.filter((g) => !g.image).length, im = recent.filter((g) => g.image).length;
    if (t <= 8 - text - 1 && (image == null || im <= 2 - image - 0)) return;   // keep one call of headroom
    setStatus(`pacing for the rate limit (${t} text, ${im} image calls in the last minute)…`);
    await sleep(2000);
  }
}

// ------------------------------------------------------------------ results
const results = [];
window.__e2e = { done: false, model: MODEL, startedAt: new Date().toISOString(), results };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function render(r) {
  const tr = document.createElement('tr');
  tr.className = r.status.toLowerCase().split(' ')[0];
  const tools = (r.tools || []).map((t) => `${t.name}(${t.args && Object.keys(t.args).length ? esc(JSON.stringify(t.args)) : ''})`
    + `${t.result && t.result.ok === false ? ' ✗' : ''}`).join('<br>');
  tr.innerHTML = `<td>${esc(r.id)}</td><td><b>${esc(r.status)}</b></td><td>${esc(r.name)}${r.command ? `<br><i>“${esc(r.command)}”</i>` : ''}</td>`
    + `<td>${tools || '—'}</td><td>${esc(r.reply || '')}</td><td>${r.ms != null ? (r.ms / 1000).toFixed(1) + ' s' : ''}`
    + `${r.rounds != null ? `<br>${r.rounds} round${r.rounds === 1 ? '' : 's'}` : ''}</td><td>${esc(r.note || '')}</td>`;
  tbody.appendChild(tr);
}

async function step(id, name, fn, { command = null } = {}) {
  if (ONLY && !ONLY.has(id) && !ONLY.has(id.replace(/[a-z]$/, ''))) return;
  setStatus(`${id} ${name}…`);
  const e0 = hard.length;
  let r;
  try { r = (await fn()) || {}; } catch (e) { r = { status: 'FAIL', note: `threw ${(e && (e.stack || e.message)) || e}`.slice(0, 400) }; }
  r = { id, name, command, ...r };
  if (hard.length > e0) {
    r.note = `${r.note || ''} + ${hard.length - e0} uncaught error(s): ${hard.slice(e0).join(' | ')}`.slice(0, 600);
    if (r.status === 'PASS') r.status = 'FAIL';
  }
  r.status = r.status || 'FAIL';
  results.push(r);
  render(r);
  return r;
}

// ------------------------------------------------------------------ helpers on the app
let w = null;
const pieces = () => w.furniture.children.filter((o) => o.userData && o.userData.kind);
const roomOf = (o) => (w.roomAt(o.position.x, o.position.y, o.userData.floor) || {}).label || null;
const panoBy = (label) => w.house.panos.find((p) => String(p.label) === String(label));
const declNames = () => w.agent.declarations.map((d) => d.name);
const goTo = async (p) => { if (p && w.current.id !== p.id) { await w.goTo(p.id); await sleep(500); } return w.current.id === (p && p.id); };
const HOME = () => (LA_MIRADA ? panoBy('37') : w.house.panos[0]);            // the demo card's living-room point

/** Face a wall like a user would: La Mirada's demo wall #19 from scan point 37, else the first wall ahead. */
async function faceAWall() {
  const fl = w.house.floors.find((x) => x.id === w.current.floor) || w.house.floors[0];
  if (LA_MIRADA && fl.walls[19] && w.current.label === '37') {
    const wl = fl.walls[19];
    w.view.yaw = Math.atan2((wl.a[1] + wl.b[1]) / 2 - w.current.pos[1], (wl.a[0] + wl.b[0]) / 2 - w.current.pos[0]);
    w.view.pitch = 0;
    await frames(3);
    if (w.wallAhead()) return w.wallAhead();
  }
  for (let k = 0; k < 12; k++) {
    w.view.yaw = (k * Math.PI) / 6; w.view.pitch = 0;
    await frames(3);
    const h = w.wallAhead();
    if (h) return h;
  }
  return null;
}

/** Ask John (the real typed pipeline), with pacing and one retry on a rate limit. */
async function askJohn(text, { image = null } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await pace({ text: 3, image });
    wrapTools(w);
    const g0 = gemini.length, t0 = toolLog.length, start = performance.now();
    const reply = await w.agent.ask(text);
    const ms = Math.round(performance.now() - start);
    const rounds = gemini.slice(g0).filter((g) => !g.image);
    const limited = gemini.slice(g0).some((g) => g.status === 429);
    const tools = toolLog.slice(t0).map((t) => ({ name: t.name, args: t.args, result: t.result, ms: t.ms }));
    if (limited && attempt === 0) { setStatus('429 from the relay: waiting 30 s and retrying'); await sleep(30000); continue; }
    return { reply, ms, rounds: rounds.length, tools, limited, retried: attempt > 0,
      upstream: gemini.slice(g0).map((g) => `${g.image ? 'img ' : ''}${g.status} ${g.ms}ms${g.calls.length ? ' ' + g.calls.join('+') : ''}`
        + `${g.status === 200 && !g.image && !g.sig ? ' [unsigned: OpenRouter fallback?]' : ''}${g.status === -1 ? ' [aborted at the 25 s deadline]' : ''}`) };
  }
}
const used = (a, ...names) => a.tools.some((t) => names.includes(t.name));
const names = (a) => a.tools.map((t) => t.name).join(', ') || 'no tools';
const out = (a, status, note) => ({ status, note: `${note}${a.retried ? ' (retried after 429)' : ''}${a.limited ? ' [RATE LIMITED]' : ''}`,
  reply: a.reply, tools: a.tools.map(({ name, args, result }) => ({ name, args, result: slim(result) })), ms: a.ms, rounds: a.rounds, upstream: a.upstream });
const slim = (r) => { try { const s = JSON.stringify(r); return s && s.length > 300 ? JSON.parse(JSON.stringify(r, (k, v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v))) : r; } catch (e) { return String(r); } };

/** A step for a tool other people are building: MISSING if no declaration matches, else run it and assert. */
async function johnNeeds(re, command, assert, opts) {
  const have = declNames().filter((n) => re.test(n));
  const a = await askJohn(command, opts);
  if (!have.length) return out(a, 'MISSING', `MISSING (tool not built): no declaration matches ${re}; John used ${names(a)}`);
  const [ok, note] = assert(a);
  return out(a, ok ? 'PASS' : 'FAIL', `${note}; tools available: ${have.join(', ')}`);
}

// ------------------------------------------------------------------ the run
(async () => {
  const T0 = performance.now();
  let captions = {};
  try { captions = await (await fetch(`../data/${MODEL}/captions.json`)).json(); } catch (e) { /* optional */ }

  // 2. Outside opener (?outside=on): the overlay shows over the photo, and "Walk in" lands in a pano.
  //    Runs first, on its own page load; everything else runs on ?outside=off.
  if (!ONLY || ONLY.has('2')) {
    w = await load('&outside=on');
    await step('2', 'Outside opener', async () => {
      if (!w) return { status: 'FAIL', note: 'the viewer never loaded' };
      const doc = f.contentDocument;
      let el = null;
      for (let i = 0; i < 50 && !(el = doc.getElementById('outside')); i++) await sleep(100);
      if (!el) return { status: 'FAIL', note: 'no #outside overlay (data/<model>/outside.json missing?)' };
      const shown = !el.hidden && el.classList.contains('shown');
      const go = el.querySelector('.os-go');
      for (let i = 0; i < 50 && go.disabled; i++) await sleep(100);
      const label = go.textContent;
      go.click();
      await sleep(1800);
      const gone = el.hidden, inPano = !!(w.current && w.current.id);
      const ok = shown && gone && inPano;
      return { status: ok ? 'PASS' : 'FAIL', note: `overlay shown: ${shown}, button "${label}", after click hidden: ${gone}, `
        + `standing at scan point ${w.current && w.current.label}` };
    });
  }

  w = await load('&outside=off');
  if (!w) { setStatus('FAIL: the viewer never loaded'); return; }
  await goTo(HOME());

  // 1. App boots: preflight rows and no console errors.
  await step('1', 'App boots + preflight', async () => {
    const rows = await w.preflight({ quiet: true });
    const bad = rows.filter((r) => !r.ok);
    const ok = !bad.length && !hard.length && !soft.length;
    return { status: ok ? 'PASS' : 'FAIL', reply: rows.map((r) => `${r.ok ? '✓' : '✗'} ${r.name}: ${r.note || ''}`).join(' | '),
      note: `${rows.length - bad.length}/${rows.length} preflight rows pass; ${hard.length} uncaught errors, ${soft.length} console.error`
        + `${soft.length ? ': ' + soft.slice(0, 3).join(' | ') : ''}`, rows };
  });

  // 3. Typed John, through walkin.agent.ask (the text box).
  await goTo(HOME());
  await step('3a', 'Room size', async () => {
    const a = await askJohn('how big is this room?');
    const metres = /\d+(\.\d+)?\s*(m\b|metre|meter|square)/i.test(a.reply);
    return out(a, used(a, 'describe_house') && metres ? 'PASS' : 'FAIL', `describe_house: ${used(a, 'describe_house')}, metres in reply: ${metres}`);
  }, { command: 'how big is this room?' });

  await step('3b', 'Add a sofa', async () => {
    const n0 = pieces().filter((o) => o.userData.kind === 'sofa').length;
    const a = await askJohn('add a sofa');
    const n1 = pieces().filter((o) => o.userData.kind === 'sofa').length;
    return out(a, n1 === n0 + 1 ? 'PASS' : 'FAIL', `sofas ${n0} -> ${n1}`);
  }, { command: 'add a sofa' });

  await step('3c', 'Queen bed in the bedroom', async () => {
    const before = new Set(pieces());
    const a = await askJohn('add a queen bed in the bedroom');
    const beds = pieces().filter((o) => !before.has(o) && /queen|bed/.test(o.userData.kind));
    const where = beds.map((o) => `${o.userData.kind} in ${roomOf(o)}`).join(', ') || 'no new bed';
    const ok = beds.some((o) => /bed ?room/i.test(roomOf(o) || ''));
    return out(a, ok ? 'PASS' : 'FAIL', `${where}; standing at ${w.current.label} (${(w.roomAt(w.current.pos[0], w.current.pos[1], w.current.floor) || {}).label})`);
  }, { command: 'add a queen bed in the bedroom' });

  await step('3d', 'King bed fit question', async () => {
    const a = await askJohn('will a king bed fit in the master bedroom?');
    const answers = /\b(yes|no|fits?|won'?t|will|doesn'?t|does)\b/i.test(a.reply) && /\d/.test(a.reply);
    const ok = answers && a.tools.length > 0;
    return out(a, ok ? 'PASS' : 'FAIL', `answers with a number: ${answers}; tools: ${names(a)}`);
  }, { command: 'will a king bed fit in the master bedroom?' });

  await goTo(HOME());
  await step('3e', 'Stage a modern living room', async () => {
    const n0 = pieces().length;
    const a = await askJohn('stage this room as a modern living room');
    const n1 = pieces().length, room = (w.roomAt(w.current.pos[0], w.current.pos[1], w.current.floor) || {}).label;
    const st = a.tools.find((t) => t.name === 'stage_room');
    return out(a, used(a, 'stage_room') && n1 - n0 >= 3 ? 'PASS' : 'FAIL',
      `pieces ${n0} -> ${n1} in ${room}${st && st.result ? `; skipped: ${(st.result.skipped || []).join('; ') || 'none'}` : ''}`);
  }, { command: 'stage this room as a modern living room' });

  await goTo(HOME());
  const wall = await faceAWall();
  const wallKey = (m) => m.map((x) => `${x.wall && x.wall.index}:${String(x.url).slice(0, 40)}:${String(x.url).length}`).join('|');
  await step('3f', 'Paint the wall sage green', async () => {
    const m0 = wallKey(w.wallMaterials());
    const a = await askJohn('paint this wall sage green');
    const m1 = w.wallMaterials(), changed = wallKey(m1) !== m0;
    return out(a, changed && used(a, 'set_wall_material') ? 'PASS' : 'FAIL',
      `facing wall #${wall ? wall.index : 'none'}; wall materials changed: ${changed} (${m1.length} wall(s) covered)`);
  }, { command: 'paint this wall sage green' });

  await step('3g', 'Brick on this wall', async () => {
    const m0 = wallKey(w.wallMaterials());
    const a = await askJohn('put brick on this wall', { image: 1 });
    const m1 = w.wallMaterials(), changed = wallKey(m1) !== m0;
    const last = m1[m1.length - 1], src = last ? (String(last.url).startsWith('data:image/jpeg') ? 'generated by the image model'
      : String(last.url).startsWith('data:') ? 'painted locally' : `bundled fallback ${last.url}`) : 'none';
    const img = a.upstream.filter((u) => u.startsWith('img'));
    return out(a, changed && used(a, 'set_wall_material') ? 'PASS' : 'FAIL',
      `wall materials changed: ${changed}; tile: ${src}; image calls: ${img.join(', ') || 'none'}`);
  }, { command: 'put brick on this wall' });

  await step('3h', 'Plant advice', async () => {
    const before = new Set(pieces());
    const a = await askJohn('what plant should go here?', { image: 1 });
    const plants = pieces().filter((o) => !before.has(o) && /plant|cactus|succulent|fern/.test(o.userData.kind));
    const ok = plants.length > 0;
    return out(a, ok ? 'PASS' : 'FAIL', `${plants.map((o) => `${o.userData.kind} in ${roomOf(o)}`).join(', ') || 'no plant placed'}; `
      + `light_here ${used(a, 'light_here')}, plant_preview ${used(a, 'plant_preview')}, place_object ${used(a, 'place_object')}`);
  }, { command: 'what plant should go here?' });

  await step('3i', 'Take me to the fireplace', async () => {
    const bed = w.house.panos.find((p) => /bed/i.test((captions[p.id] || {}).room || ''))
      || w.house.panos.find((p) => /bed/i.test((w.roomAt(p.pos[0], p.pos[1], p.floor) || {}).label || ''));
    await goTo(bed);
    const from = w.current.id, fromLabel = w.current.label;
    const a = await askJohn('take me to the room with the fireplace');
    const cap = captions[w.current.id] || {};
    const moved = w.current.id !== from, fire = /fireplace/i.test(JSON.stringify(cap));
    return out(a, moved && fire ? 'PASS' : 'FAIL', `scan point ${fromLabel} -> ${w.current.label}; caption there mentions a fireplace: ${fire}`);
  }, { command: 'take me to the room with the fireplace' });

  // Tools being built in parallel: MISSING until a declaration exists, then a real state assertion.
  await goTo(HOME());
  const sofaOf = () => pieces().filter((o) => o.userData.kind === 'sofa').pop();
  if (!sofaOf()) w.addFurniture('sofa');
  await step('3j', 'Move the sofa', async () => {
    const s = sofaOf(), p0 = s && [s.position.x, s.position.y];
    return johnNeeds(/move|arrange|reposition/i, 'move the sofa against the window', () => {
      const s1 = sofaOf(), d = s1 && p0 ? Math.hypot(s1.position.x - p0[0], s1.position.y - p0[1]) : 0;
      return [d > 0.2, `sofa moved ${d.toFixed(2)} m`];
    });
  }, { command: 'move the sofa against the window' });

  await step('3k', 'Turn it', async () => {
    const s = sofaOf(), r0 = s && s.rotation.z;
    return johnNeeds(/rotat|turn/i, 'turn it', () => {
      const s1 = sofaOf(), d = s1 ? Math.abs(Math.atan2(Math.sin(s1.rotation.z - r0), Math.cos(s1.rotation.z - r0))) : 0;
      return [d > 0.1, `sofa turned ${(d * 180 / Math.PI).toFixed(0)}°`];
    });
  }, { command: 'turn it' });

  await step('3l', 'Remove the sofa', async () => {
    const n0 = pieces().filter((o) => o.userData.kind === 'sofa').length;
    return johnNeeds(/remove|delete|clear_furniture/i, 'remove the sofa', () => {
      const n1 = pieces().filter((o) => o.userData.kind === 'sofa').length;
      return [n1 === n0 - 1, `sofas ${n0} -> ${n1}`];
    });
  }, { command: 'remove the sofa' });

  await step('3m', 'Make the bed blue', async () => {
    const colours = () => pieces().filter((o) => /queen|king|bed/.test(o.userData.kind)).map((o) => {
      const c = []; o.traverse((m) => { if (m.isMesh && m.material && m.material.color) c.push(m.material.color.getHexString()); }); return c.join(',');
    }).join('|');
    const c0 = colours();
    return johnNeeds(/colou?r|restyle|recolou?r|finish/i, 'make the bed blue', () => {
      const c1 = colours();
      return [c1 !== c0 && c1.length > 0, c1 ? `bed colours changed: ${c1 !== c0}` : 'no bed in the house'];
    });
  }, { command: 'make the bed blue' });

  await goTo(HOME());
  await faceAWall();
  await step('3n', 'Ronaldo-fan decor', async () => {
    const n0 = pieces().length, k0 = new Set(pieces()), m0 = wallKey(w.wallMaterials());
    return johnNeeds(/decor|theme|picture|poster|art/i, "decorate this room as if I'm a Ronaldo fan", () => {
      const added = pieces().filter((o) => !k0.has(o)), pics = added.filter((o) => /picture|frame|poster|art|print/.test(o.userData.kind));
      const wallChanged = wallKey(w.wallMaterials()) !== m0;
      return [pics.length > 0 && wallChanged, `+${pieces().length - n0} pieces (${pics.length} pictures), accent wall: ${wallChanged}`];
    }, { image: 1 });
  }, { command: "decorate this room as if I'm a Ronaldo fan" });

  // 4. Physics door beat (tools/door-test.mjs, docs/demo-card.md beat 5): broadside stops at the door with
  //    "turn it", end-on goes through. No model call.
  await step('4', 'Physics: sofa through the door', async () => {
    const sofa0 = w.FURNITURE.sofa, narrow = Math.min(sofa0.w, sofa0.d), wide = Math.max(sofa0.w, sofa0.d);
    let door = null;
    for (const fl of w.house.floors) for (const wl of fl.walls || []) {
      const len = Math.hypot(wl.b[0] - wl.a[0], wl.b[1] - wl.a[1]);
      if (len < 0.05) continue;
      const ux = (wl.b[0] - wl.a[0]) / len, uy = (wl.b[1] - wl.a[1]) / len;
      for (const o of wl.openings || []) {
        if (o.at == null || /window/i.test(o.type || '') || (o.bottom || 0) >= 0.3) continue;
        if (!(narrow <= o.width - 0.02 && wide > o.width - 0.02)) continue;
        const d = { floor: fl.id, x: wl.a[0] + ux * o.at * len, y: wl.a[1] + uy * o.at * len, ux, uy, width: o.width };
        d.pano = w.house.panos.filter((p) => p.floor === fl.id || p.floor == null)
          .map((p) => ({ p, d: Math.hypot(p.pos[0] - d.x, p.pos[1] - d.y) })).sort((a, b) => a.d - b.d)[0].p;
        const want = LA_MIRADA ? String(d.pano.label) === '37' : true;
        if (want && (!door || d.width > door.width)) door = d;
      }
    }
    if (!door) return { status: 'FAIL', note: 'no doorway that a sofa fits only when turned' };
    await goTo(door.pano);
    // a clean doorway: earlier steps (John's beds, staging) may have left pieces in it; that is reported, then cleared
    const inWay = pieces().filter((o) => Math.hypot(o.position.x - door.x, o.position.y - door.y) < 2.2).map((o) => o.userData.kind);
    for (const o of pieces()) o.parent.remove(o);
    w.addFurniture('sofa');
    const sofa = pieces().find((o) => o.userData.kind === 'sofa'), ph = w.physics;
    let nx = -door.uy, ny = door.ux;
    const roomAhead = (s) => !!w.roomAt(door.x + nx * s, door.y + ny * s, door.floor);
    if (roomAhead(-1.6) === roomAhead(1.6) ? (door.pano.pos[0] - door.x) * nx + (door.pano.pos[1] - door.y) * ny > 0 : roomAhead(-1.6)) { nx = -nx; ny = -ny; }
    const at = (s) => [door.x + nx * s, door.y + ny * s];
    const endOn = Math.atan2(ny, nx), broad = endOn + Math.PI / 2;
    const sideU = () => (sofa.position.x - door.x) * nx + (sofa.position.y - door.y) * ny;
    [sofa.position.x, sofa.position.y] = at(-1.6); sofa.rotation.z = broad;
    await frames(40);
    const carry = async (from, to, yaw, speed = 0.6) => {
      const t0 = performance.now(), dist = Math.abs(to - from), dir = Math.sign(to - from);
      for (;;) {
        const s = Math.min(dist, ((performance.now() - t0) / 1000) * speed);
        ph.moveTarget('e2e', at(from + dir * s), yaw);
        await frames(1);
        if (s >= dist) break;
      }
      await sleep(600);
    };
    const b0 = blocked.length;
    ph.grab(sofa, 'e2e', at(-1.6));
    await carry(-1.6, 2.0, broad);
    const broadEnd = sideU(), said = blocked.slice(b0).filter(Boolean).pop() || '';
    await carry(Math.min(broadEnd, 2.0), -1.6, broad);
    ph.release('e2e'); await sleep(1500);
    [sofa.position.x, sofa.position.y] = at(-1.6); sofa.rotation.z = endOn; await frames(40);
    ph.grab(sofa, 'e2e', at(-1.6));
    await carry(-1.6, 2.0, endOn);
    ph.release('e2e'); await sleep(300);
    const through = sideU();
    const ok = broadEnd < 0.3 && through > 1.0 && /turn/i.test(said);
    return { status: ok ? 'PASS' : 'FAIL', reply: said, note: `${door.width.toFixed(2)} m door by scan point ${door.pano.label}: broadside `
      + `stopped ${(-broadEnd).toFixed(2)} m short (blocked: ${broadEnd < 0.3}); end-on ended ${through.toFixed(2)} m past it in ${roomOf(sofa)}`
      + `${inWay.length ? `; cleared ${inWay.join(', ')} left within 2.2 m of the door by earlier steps` : ''}` };
  });

  // 5. The home's own furniture, cut from the MatterPak.
  await step('5', 'Own furniture (meshFurniture)', async () => {
    const t0 = performance.now();
    const r = await w.meshFurniture();
    const ms = Math.round(performance.now() - t0);
    const n = pieces().filter((o) => o.userData.meshPiece).length;
    w.clearMeshFurniture && w.clearMeshFurniture();
    return { status: r && r.placed > 0 ? 'PASS' : 'FAIL', ms, reply: r && r.say, note: `placed ${r && r.placed}, ${n} mesh pieces in the scene` };
  });

  // 6. Live voice plumbing: a token, and the config live.js sends carries every tool John has. Then a real Live
  //    session, text in, to prove the model accepts those declarations and calls a tool (no microphone needed).
  await step('6', 'Live voice plumbing', async () => {
    const health = await (await fetch('/api/health')).json();
    const t0 = performance.now();
    const res = await fetch('/api/live-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const t = await res.json().catch(() => ({}));
    const tokMs = Math.round(performance.now() - t0);
    const decl = w.live._upperTypes(w.agent.declarations), dn = decl.map((d) => d.name), run = Object.keys(w.agent.tools);
    const undeclared = run.filter((n) => !dn.includes(n)), unrunnable = dn.filter((n) => !run.includes(n));
    const lower = JSON.stringify(decl).match(/"type":"[a-z]+"/g) || [];
    const notes = [`health.live ${health.live} (${health.live_model})`, `token ${res.status}${t.token ? ' ok' : ' MISSING'} in ${tokMs} ms, model ${t.model}`,
      `${dn.length} declarations: ${dn.join(', ')}`];
    if (undeclared.length) notes.push(`tools John can run but Live can't call: ${undeclared.join(', ')}`);
    if (unrunnable.length) notes.push(`declared but no runner: ${unrunnable.join(', ')}`);
    if (lower.length) notes.push(`lower-case schema types left: ${lower.length}`);
    let live = 'not tried';
    if (t.token) {
      try {
        const sdk = await import('../vendor/genai/genai.mjs');
        const ai = new sdk.GoogleGenAI({ apiKey: t.token, httpOptions: { apiVersion: t.apiVersion || 'v1beta' } });
        const got = { tools: [], text: '', closed: null, err: null };
        let session;
        const done = new Promise((resolve) => {
          const t1 = performance.now();
          const timer = setTimeout(() => resolve('timeout'), 20000);
          ai.live.connect({ model: t.model, config: {
            responseModalities: [sdk.Modality.AUDIO], systemInstruction: { parts: [{ text: w.agent.system }] },
            tools: [{ functionDeclarations: decl }], outputAudioTranscription: {} },
          callbacks: {
            onmessage: async (m) => {
              if (m.toolCall) {
                const responses = [];
                for (const fc of m.toolCall.functionCalls || []) {
                  got.tools.push(fc.name);
                  responses.push({ id: fc.id, name: fc.name, response: await w.agent.runTool(fc.name, fc.args || {}) });
                }
                try { session.sendToolResponse({ functionResponses: responses }); } catch (e) { /* closed */ }
              }
              const sc = m.serverContent;
              if (sc && sc.outputTranscription && sc.outputTranscription.text) got.text += sc.outputTranscription.text;
              if (sc && sc.turnComplete && got.tools.length) { got.ms = Math.round(performance.now() - t1); clearTimeout(timer); resolve('turn'); }
            },
            onerror: (e) => { got.err = String((e && e.message) || e); },
            onclose: (e) => { got.closed = (e && (e.reason || e.code)) || 'closed'; clearTimeout(timer); resolve('closed'); },
          } }).then((s) => {
            session = s;
            s.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'How big is this room?' }] }], turnComplete: true });
          }).catch((e) => { got.err = String((e && e.message) || e); clearTimeout(timer); resolve('failed'); });
        });
        const how = await done;
        try { session && session.close(); } catch (e) { /* closed */ }
        live = `real Live session: ${how}; tools called ${got.tools.join(', ') || 'none'}; said "${got.text.trim().slice(0, 160)}"`
          + `${got.ms ? ` in ${got.ms} ms` : ''}${got.err ? `; error ${got.err}` : ''}${got.closed && how !== 'turn' ? `; closed: ${got.closed}` : ''}`;
        window.__e2e.liveOk = how === 'turn' && got.tools.length > 0;
      } catch (e) { live = `real Live session threw: ${e.message || e}`; }
    }
    const ok = res.ok && !!t.token && !undeclared.length && !unrunnable.length && !lower.length && window.__e2e.liveOk;
    return { status: ok ? 'PASS' : 'FAIL', reply: live, ms: tokMs, note: notes.join('; ') };
  });

  // 7. Real hands: realhands.js on a synthetic camera (a canvas with a drawn hand, through captureStream).
  await step('7', 'Real hands cut-out', async () => {
    const { createRealHands } = await import('../realhands.js');
    const cam = document.createElement('canvas'); cam.width = 640; cam.height = 480;
    const g = cam.getContext('2d');
    // 21 landmarks (MediaPipe order), in 0..1 image units: a right hand, thumb tip touching the index tip (pinch)
    const L = [[0.5, 0.85], [0.42, 0.78], [0.37, 0.7], [0.35, 0.62], [0.38, 0.55],
      [0.45, 0.6], [0.42, 0.52], [0.4, 0.5], [0.39, 0.53],
      [0.52, 0.58], [0.52, 0.47], [0.52, 0.4], [0.52, 0.34],
      [0.58, 0.6], [0.6, 0.5], [0.61, 0.43], [0.62, 0.37],
      [0.64, 0.64], [0.67, 0.56], [0.69, 0.5], [0.7, 0.45]];
    const SKIN = [224, 172, 140];
    const paint = () => {
      g.fillStyle = '#28324a'; g.fillRect(0, 0, 640, 480);
      g.fillStyle = g.strokeStyle = `rgb(${SKIN})`; g.lineCap = 'round'; g.lineWidth = 26;
      g.beginPath(); [0, 1, 2, 5, 9, 13, 17].forEach((i, k) => (k ? g.lineTo(L[i][0] * 640, L[i][1] * 480) : g.moveTo(L[i][0] * 640, L[i][1] * 480)));
      g.closePath(); g.fill(); g.stroke();
      for (const [a, b] of [[1, 2], [2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12], [13, 14], [14, 15], [15, 16], [17, 18], [18, 19], [19, 20]]) {
        g.beginPath(); g.moveTo(L[a][0] * 640, L[a][1] * 480); g.lineTo(L[b][0] * 640, L[b][1] * 480); g.stroke();
      }
    };
    paint();
    const iv = setInterval(paint, 33);
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = cam.captureStream(30);
    await video.play().catch(() => {});
    for (let i = 0; i < 50 && !video.videoWidth; i++) await sleep(50);
    const camRect = { mirror: false, cx: 0, cy: 0, sx: 1, sy: 1 };
    const pts = L.map(([x, y]) => ({ x, y, z: 0 }));
    const px = (pts[4].x + pts[8].x) / 2, py = (pts[4].y + pts[8].y) / 2;
    const notes = [];
    let ok = !!video.videoWidth;
    for (const [scale, seg] of [[1, false], [0.6, false], [1, true]]) {
      const rh = createRealHands(video, { scale, seg });
      const cv = rh.canvas, c = cv.getContext('2d');
      rh.snap(camRect);
      rh.draw([{ side: 'Right', pts, pinch: false, x: px, y: py }], camRect, false);
      const W = cv.width, H = cv.height, data = c.getImageData(0, 0, W, H).data;
      let n = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 20) n++;
      const at = (x, y) => { const i = (Math.round(y) * W + Math.round(x)) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
      const Ax = px * W, Ay = py * H;   // the cursor (hands.js: pinch point in screen units)
      const where = (p) => [Ax + scale * (p.x * W - Ax), Ay + scale * (p.y * H - Ay)];   // landmark on screen after the shrink
      const checks = [0, 9, 5, 4].map((i) => at(...where(pts[i])));
      const skinAt = checks.filter(([r, gg, b, a]) => a > 100 && Math.abs(r - SKIN[0]) < 40 && Math.abs(gg - SKIN[1]) < 40 && Math.abs(b - SKIN[2]) < 40).length;
      const cursor = at(Ax, Ay);
      // the pinch glow is drawn at the cursor
      rh.draw([{ side: 'Right', pts, pinch: true, x: px, y: py }], camRect, false);
      const glow = c.getImageData(Math.round(Ax), Math.round(Ay), 1, 1).data;
      const pass = n > 500 && skinAt >= 3 && cursor[3] > 100 && glow[0] > 200 && glow[1] > 150;
      ok = ok && pass;
      notes.push(`scale ${scale}${seg ? ' +skin-seg' : ''}: ${n} px drawn, ${skinAt}/4 landmarks show skin, hand under cursor ${cursor[3] > 100}, glow at cursor ${glow[0] > 200}`);
      cv.remove();
    }
    clearInterval(iv);
    video.srcObject.getTracks().forEach((tr) => tr.stop());
    return { status: ok ? 'PASS' : 'FAIL', note: notes.join('; ') };
  });

  // ------------------------------------------------------------------ summary
  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = { pass: count('PASS'), fail: count('FAIL'), missing: count('MISSING'), seconds: Math.round((performance.now() - T0) / 1000),
    uncaught: hard.slice(), consoleErrors: soft.slice(), geminiCalls: gemini.length, rateLimited: gemini.filter((g) => g.status === 429).length };
  Object.assign(window.__e2e, { done: true, summary, finishedAt: new Date().toISOString() });
  setStatus(`${summary.pass} pass, ${summary.fail} fail, ${summary.missing} missing · ${summary.seconds} s · ${summary.geminiCalls} Gemini calls`
    + ` (${summary.rateLimited} rate-limited) · ${hard.length} uncaught, ${soft.length} console.error`);
  document.getElementById('json').textContent = JSON.stringify(window.__e2e, null, 1);
  document.body.classList.add('done');
  if (q.get('save') === '1') saveImage();
})();

// ------------------------------------------------------------------ the table as a JPEG (for the PR / the team chat)
function saveImage() {
  const rows = results, W = 1800, pad = 14, lh = 18;
  const c = document.createElement('canvas'), g = c.getContext('2d');
  const cols = [[60, 'id'], [90, 'status'], [330, 'step / command'], [360, 'tools'], [520, 'John said'], [80, 'time'], [360, 'note']];
  const wrap = (text, width) => {
    g.font = '13px -apple-system, Helvetica, sans-serif';
    const words = String(text || '').split(/\s+/), lines = [];
    let line = '';
    for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (g.measureText(t).width > width - 10 && line) { lines.push(line); line = wd; } else line = t; }
    if (line) lines.push(line);
    return lines.slice(0, 9);
  };
  const cells = rows.map((r) => [r.id, r.status, `${r.name}${r.command ? ` — “${r.command}”` : ''}`,
    (r.tools || []).map((t) => t.name).join(', '), r.reply, r.ms != null ? `${(r.ms / 1000).toFixed(1)} s` : '', r.note]);
  const heights = cells.map((cs) => Math.max(...cs.map((v, i) => wrap(v, cols[i][0]).length)) * lh + 10);
  c.width = W; c.height = 80 + heights.reduce((a, b) => a + b, 0) + pad;
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, c.height);
  g.fillStyle = '#111'; g.font = 'bold 18px -apple-system, Helvetica, sans-serif';
  g.fillText(`Walk-In e2e · ${MODEL} · ${statusEl.textContent}`, pad, 28);
  let y = 50, x = pad;
  g.font = 'bold 13px -apple-system, Helvetica, sans-serif';
  for (const [wd, h] of cols) { g.fillText(h, x, y + 14); x += wd; }
  y += 26;
  const colour = { PASS: '#e6f6ea', FAIL: '#fde8e8', MISSING: '#fff4d6' };
  cells.forEach((cs, k) => {
    g.fillStyle = colour[rows[k].status] || '#fff'; g.fillRect(pad - 4, y - 4, W - 2 * pad + 8, heights[k]);
    x = pad;
    cs.forEach((v, i) => {
      g.fillStyle = '#111'; g.font = `${i === 1 ? 'bold ' : ''}13px -apple-system, Helvetica, sans-serif`;
      wrap(v, cols[i][0]).forEach((ln, j) => g.fillText(ln, x, y + 12 + j * lh));
      x += cols[i][0];
    });
    y += heights[k];
  });
  const a = document.createElement('a');
  a.download = 'e2e-results.jpg';
  a.href = c.toDataURL('image/jpeg', 0.9);
  a.click();
}
window.saveE2EImage = saveImage;
