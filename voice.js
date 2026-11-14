// R9 — "Hey John": hands-free voice. After one tap, the browser listens all the time for the wake phrase; then
// a glow rises along the bottom edge, the command appears as live captions, it goes to the agent (agent.js),
// and John's spoken reply is captioned too. The text box is collapsed into a small orb (tap it, or press /).
// Talks to the rest only through window.walkin (agent.ask, agent.isSpeaking) and the 'walkin:speech' events.

const WAKE = /\b(hey|hi|ok(?:ay)?)[\s,.!]+(john|jon)\b[\s,.!]*/i;
const END_SILENCE_MS = 1200;     // a command ends after this much silence
const WAKE_TIMEOUT_MS = 6000;    // "Hey John" and then nothing: go back to listening
const RESUME_AFTER_SPEECH_MS = 350;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const $ = (id) => document.getElementById(id);
const state = { mode: 'off', heard: '', interim: '', carry: '', wakeIdx: -1, silenceTimer: 0, wakeTimer: 0, paused: false, rec: null, wanted: false };

// ------------------------------------------------------------------ DOM: glow, captions (one per eye in the headset), orb
function el(tag, cls, parent = document.body) { const e = document.createElement(tag); e.className = cls; parent.appendChild(e); return e; }
const glow = el('div', 'vx-glow');
const capWrap = el('div', 'vx-captions');
const caps = [el('div', 'vx-cap', capWrap), el('div', 'vx-cap vx-cap-right', capWrap)];   // 2nd is only shown in the headset
const orb = el('button', 'vx-orb');
orb.type = 'button';
orb.title = 'Type to John (/)';
orb.setAttribute('aria-label', 'Type to John');
const hint = el('div', 'vx-hint');

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.voice = mode;                          // voice.css styles glow and orb from this
}

function showCaption(finalText, interimText = '', who = 'user') {
  for (const c of caps) {
    c.className = `vx-cap${c === caps[1] ? ' vx-cap-right' : ''} vx-${who}`;
    c.replaceChildren();
    if (finalText) c.append(document.createTextNode(finalText + (interimText ? ' ' : '')));
    if (interimText) { const s = document.createElement('span'); s.className = 'vx-interim'; s.textContent = interimText; c.append(s); }
  }
  capWrap.classList.toggle('on', !!(finalText || interimText));
}
const clearCaption = () => capWrap.classList.remove('on');

function showHint(text, ms = 4000) {
  hint.textContent = text;
  hint.classList.add('on');
  clearTimeout(showHint.t);
  showHint.t = setTimeout(() => hint.classList.remove('on'), ms);
}

// ------------------------------------------------------------------ the typed fallback: an orb that opens the Ask panel
function setPanel(open) {
  document.body.classList.toggle('agent-open', open);
  if (open) setTimeout(() => $('agentIn') && $('agentIn').focus(), 50);
}
orb.addEventListener('click', (e) => { e.stopPropagation(); unlock(); setPanel(!document.body.classList.contains('agent-open')); });
addEventListener('keydown', (e) => {
  const typing = e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); setPanel(true); }
  else if (e.key === 'Escape' && document.body.classList.contains('agent-open')) setPanel(false);
});
for (const ev of ['pointerdown', 'mousedown', 'touchstart']) orb.addEventListener(ev, (e) => e.stopPropagation());

// ------------------------------------------------------------------ sound and mic level (the glow pulses with your voice)
let audioCtx = null, analyser = null, levelBuf = null;
function chime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    for (const [f, at] of [[660, 0], [990, 0.09]]) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.12, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.28);
      o.connect(g).connect(audioCtx.destination); o.start(t + at); o.stop(t + at + 0.3);
    }
  } catch (e) { /* no audio: the glow still shows */ }
}

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
async function startLevel() {
  // iOS Safari: a second microphone stream next to speech recognition can stop either one, so the glow
  // pulses on its own there instead of following the mic.
  if (analyser || isIOS || !navigator.mediaDevices) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    levelBuf = new Uint8Array(analyser.fftSize);
    audioCtx.createMediaStreamSource(stream).connect(analyser);
  } catch (e) { analyser = null; }
}
// Only while a command is being spoken (the glow is up), and only when the level moved: the headset is fps-bound.
let pulsing = false, lastLvl = -1;
function pulse() {
  if (state.mode !== 'awake' && state.mode !== 'live') { pulsing = false; return; }
  let lvl = 0.35 + 0.15 * Math.sin(performance.now() / 260);  // gentle breathing when there's no mic level
  if (analyser) {
    analyser.getByteTimeDomainData(levelBuf);
    let sum = 0;
    for (const v of levelBuf) sum += (v - 128) * (v - 128);
    lvl = Math.min(1, Math.sqrt(sum / levelBuf.length) / 40 + 0.25);
  }
  if (Math.abs(lvl - lastLvl) > 0.03) { glow.style.setProperty('--lvl', lvl.toFixed(2)); lastLvl = lvl; }
  requestAnimationFrame(pulse);
}
function startPulse() { if (!pulsing) { pulsing = true; requestAnimationFrame(pulse); } }

// ------------------------------------------------------------------ speech recognition: always on, restarted when it stops
function startRec() {
  if (!SR || !state.wanted || state.paused || state.rec) return;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';
  rec.onresult = onResult;
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      state.wanted = false;
      setMode('off');
      showHint('Microphone blocked. Allow it, or tap the orb to type.', 6000);
    }
  };
  rec.onend = () => {                       // iOS stops after silence or about a minute: start again
    if (state.rec === rec) state.rec = null;
    if (state.wanted && !state.paused) setTimeout(startRec, 250);
  };
  if (state.mode === 'awake') { state.carry = `${state.heard} ${state.interim}`.trim(); state.wakeIdx = 0; }
  try {
    rec.start();
    state.rec = rec;
    if (state.mode === 'off') setMode('listening');
  } catch (e) { state.rec = null; }
}

function stopRec() {
  const r = state.rec;
  state.rec = null;
  if (r) { r.onend = null; try { r.abort(); } catch (e) { /* already stopped */ } }
}

function pause() { state.paused = true; stopRec(); }
function resume() {
  state.paused = false;
  if (state.mode !== 'thinking' && state.mode !== 'live') startRec();   // live.js has the mic
}

function onResult(e) {
  const rs = e.results;
  if (state.mode === 'listening') {
    for (let i = e.resultIndex; i < rs.length; i++) {
      if (WAKE.test(rs[i][0].transcript)) { wake(); state.wakeIdx = i; break; }
    }
  }
  if (state.mode !== 'awake') return;
  if (state.wakeIdx < 0) state.wakeIdx = e.resultIndex;     // push to talk: everything from now on is the command
  // the command = every result since the wake, with the wake phrase (and anything before it) cut off
  let fin = '', inter = '';
  for (let i = state.wakeIdx; i < rs.length; i++) {
    let t = rs[i][0].transcript;
    if (i === state.wakeIdx) { const m = WAKE.exec(t); if (m) t = t.slice(m.index + m[0].length); }
    if (rs[i].isFinal) fin += ` ${t}`; else inter += ` ${t}`;
  }
  const tidy = (t) => t.replace(/\s+/g, ' ').trim();
  onCommandWords(tidy(`${state.carry} ${fin}`), tidy(inter), !tidy(inter) && !!tidy(fin));
}

function onCommandWords(finalPart, interimPart, allFinal) {
  state.heard = finalPart;
  state.interim = interimPart;
  showCaption(state.heard, state.interim, 'user');
  if (!state.heard && !state.interim) return;
  clearTimeout(state.wakeTimer);
  clearTimeout(state.silenceTimer);
  if (allFinal && state.heard) { state.silenceTimer = setTimeout(finishCommand, 250); return; }   // brief grace for a trailing word
  state.silenceTimer = setTimeout(finishCommand, END_SILENCE_MS);
}

function wake() {
  setMode('awake');
  try { const p = window.walkin && window.walkin.pointer; window.walkin.wakeWall = p && p.wall ? { wall: p.wall, at: performance.now() } : null; } catch (e) { /* no pointer */ }
  startPulse();
  state.wakeIdx = -1;
  state.carry = state.heard = state.interim = '';
  chime();
  showCaption('', '', 'user');
  clearTimeout(state.wakeTimer);
  state.wakeTimer = setTimeout(() => { if (state.mode === 'awake' && !state.heard && !state.interim) backToListening(); }, WAKE_TIMEOUT_MS);
}

async function finishCommand() {
  clearTimeout(state.silenceTimer);
  clearTimeout(state.wakeTimer);
  const command = `${state.heard} ${state.interim}`.trim();
  state.heard = state.interim = state.carry = '';
  if (!command) return backToListening();
  showCaption(command, '', 'user');
  setMode('thinking');
  stopRec();                                 // the agent's filler and reply will be spoken now
  const w = window.walkin;
  if (await liveConversation(command)) return;   // a real two-way conversation (live.js) when there's a Gemini key
  try {
    if (!w || !w.agent) throw new Error('agent not ready');
    await w.agent.ask(command);             // speaks a filler at once, then the reply (captioned via walkin:speech)
  } catch (e) {
    console.warn('[voice]', e);
    if (w && w.agent) w.agent.speak("I can't reach my brain right now.");
  }
  setMode('replying');
  // back to listening once John has finished talking (the 'end' event resumes the microphone)
  if (!w || !w.agent || !w.agent.isSpeaking()) setTimeout(backToListening, 600);
}

// ------------------------------------------------------------------ live conversation (live.js, Gemini Live)
let liveOk = null;
// Captions are two lines (~90 characters per eye in the headset): show the sentence being said, not the start of the turn.
function tail(text, max = 90) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();   // one line: '.' in the split below doesn't cross a newline
  if (t.length <= max) return t;
  const parts = (t.match(/[^.!?]+[.!?]*\s*/g) || [t]).map((s) => s.trim()); // no lookbehind: Safari < 16.4 can't parse it
  let out = parts.pop();
  while (parts.length && out.length + parts[parts.length - 1].length + 1 <= max) out = `${parts.pop()} ${out}`;
  return out.length > max ? `…${out.slice(-max + 1)}` : out;
}
async function liveAvailable() {
  const live = window.walkin && window.walkin.live;
  if (!live) return false;
  if (liveOk === null) liveOk = await live.available();
  return liveOk;
}

/** Hand the mic to Gemini Live for a back-and-forth; resolves true when it ran, false to use the old pipeline. */
async function liveConversation(firstText) {
  if (!(await liveAvailable())) return false;
  setMode('live');
  startPulse && startPulse();
  const ran = await window.walkin.live.start({ firstText });
  if (ran === false) {                         // couldn't connect (token, network): fall back for this command
    setMode('thinking');
    liveOk = false;                            // don't retry on every command: try Live again in a minute
    setTimeout(() => { liveOk = null; }, 60000);
    return false;
  }
  backToListening();
  return true;
}

addEventListener('walkin:live', (e) => {
  const d = e.detail || {};
  if (d.kind === 'user') { clearTimeout(capTimer); showCaption(tail(d.text), '', 'user'); }
  else if (d.kind === 'john') { clearTimeout(capTimer); showCaption(tail(d.text), '', 'john'); }
  else if (d.kind === 'turn') { capTimer = setTimeout(clearCaption, 2500); }
  else if (d.kind === 'state' && d.state === 'connecting') showHint('Connecting to John…', 2500);
  else if (d.kind === 'state' && d.state === 'nomic') showHint("John can't hear you: allow the microphone, or tap the orb to type.", 6000);
});
let capTimer = 0;

function backToListening() {
  if (window.walkin && window.walkin.agent && window.walkin.agent.isSpeaking()) return; // the 'end' event will call us
  setTimeout(() => { if (state.mode !== 'awake') clearCaption(); }, 1800);
  setMode(state.wanted && SR ? 'listening' : 'off');
  resume();
}

// John's own lines: caption them in the reply style, and keep the mic off while he talks
addEventListener('walkin:speech', (e) => {
  const { state: s, text } = e.detail || {};
  if (s === 'start') {
    pause();
    if (state.mode === 'thinking' || state.mode === 'replying' || state.mode === 'listening') showCaption(text, '', 'john');
  } else if (s === 'end' && !(window.walkin && window.walkin.agent && window.walkin.agent.isSpeaking())) {
    setTimeout(() => {
      if (window.walkin && window.walkin.agent && window.walkin.agent.isSpeaking()) return;
      if (state.mode === 'replying' || state.mode === 'listening' || state.mode === 'off') backToListening();
      else { state.paused = false; }      // still thinking: the filler ended, the reply is coming
    }, RESUME_AFTER_SPEECH_MS);
  }
});

// ------------------------------------------------------------------ start after one tap (iOS needs a gesture once)
let unlocked = false;
function unlock() {
  if (unlocked) return;
  unlocked = true;
  try { window.walkin && window.walkin.live && window.walkin.live.prime(); } catch (e) { /* no live */ }
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (e) { /* ignore */ }
  if (!SR) { showHint('Voice needs Chrome or Safari here. Tap the orb to type.', 6000); return; }
  state.wanted = true;
  startRec();
  startLevel();
  showHint('Say "Hey John, …"', 3500);
}
addEventListener('pointerdown', unlock, { capture: true });
addEventListener('keydown', (e) => { if (e.key !== '/' && e.key !== 'Escape') unlock(); }, { capture: true });

// push to talk (Talk button, pinch-and-hold menu): skip the wake phrase
function talkNow() {
  unlock();
  if (state.mode === 'live') return window.walkin.live.stop('talk');   // Talk again = hang up
  if (state.mode === 'thinking') return;
  liveAvailable().then((ok) => {               // push to talk: straight into a live conversation if we can
    if (ok) { stopRec(); liveConversation(''); return; }
    talkClassic();
  });
}

function talkClassic() {
  if (!SR) { setPanel(true); return; }
  state.wanted = true;
  window.walkin && window.walkin.agent && window.walkin.agent.isSpeaking() && stopRec();
  state.paused = false;
  startRec();
  wake();
}

(function attach(tries = 0) {
  const w = window.walkin;
  if (!w || !w.agent) { if (tries < 600) setTimeout(() => attach(tries + 1), 200); return; }
  w.onTalk = talkNow;                        // replaces agent.js's own one-shot recognizer
  w.voice = { talk: talkNow, state: () => state.mode, openPanel: () => setPanel(true), _onResult: onResult, _finish: finishCommand };
  if (!SR) document.body.classList.add('vx-no-speech');
  setMode(state.wanted ? state.mode : 'off');
})();
