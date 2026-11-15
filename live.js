// Live voice: a real two-way conversation with John over the Gemini Live API (native audio in and out).
// voice.js hands over here after "Hey John" (or Talk): the mic streams to Gemini, John's own voice streams back,
// you can interrupt him, and his tool calls run the same actions as the typed agent (agent.js). Both sides are
// captioned through 'walkin:live' events, which voice.js draws. If there's no Gemini key (/api/live-token answers
// 503), live.available() is false and voice.js keeps the old pipeline (speech-to-text -> agent -> spoken reply).
//
//   walkin.live.available()            -> Promise<boolean>
//   walkin.live.start({ firstText })   -> Promise<void>, resolves when the conversation ends
//   walkin.live.stop()
//   walkin.live.prime()                -> call inside a tap: iOS only plays audio from a context started in a gesture
// When Live fails (quota "Resource has been exhausted", 429 on /api/live-token, a dropped socket, a hung connect)
// start() resolves false, or { fallback: true, text } when the session died mid-turn with words John never answered,
// and Live is switched off for a while, so voice.js answers through the classic pipeline instead of going silent.
// URL: ?live=off disables it, ?voice=<name> picks a Gemini voice (Charon, Puck, Kore, Achird, Sulafat, …).

const params = new URLSearchParams(location.search);
const IDLE_MS = 9000;             // nobody spoke for this long: end the conversation, back to "Hey John" (short, so a
                                  // presenter talking to the room isn't taken as more conversation for long)
const CONNECT_MS = 6000;          // venue Wi-Fi: give up on a connection that hangs
const BYE = /\b(bye|goodbye|that'?s all|that'?s it|thanks?,? john|thank you,? john|cheers,? john|stop listening|we'?re done|perfect,? thanks)\b/i;
const IN_RATE = 16000, OUT_RATE = 24000;

const LIVE_STYLE = `
You are speaking out loud, live, in a real conversation. Sound like a warm, relaxed person showing a friend round a
house, not like an assistant reading a list. Keep each turn to one or two short sentences, use contractions, react
to what the person says, and ask a short follow-up question when it helps ("Want me to try it by the window?").
Never read out numbers with more than one decimal, never spell out units like "metres squared" (say "square metres"),
and never mention tools, functions or JSON. If you are running something that takes a moment, say so naturally.
If the person says goodbye or thanks you at the end, answer briefly and warmly.
Before any action that takes a moment (wallpaper, staging, plants), first say three or four words like "Sure, one sec" so
there is never dead air.`;

let sdk = null, healthLive = null, connecting = null;
let downUntil = 0, downWhy = '';                 // Live failed: skip it until then (quota resets slowly; a blip quickly)
const QUOTA = /exhaust|quota|429|rate.?limit|resource|billing|too many/i;
function markDown(why) {
  const quota = QUOTA.test(String(why || ''));
  downUntil = Date.now() + (quota ? 10 * 60e3 : 60e3);
  downWhy = String(why || 'error');
  console.info(`[live] off for ${quota ? '10 min' : '1 min'}: ${downWhy}`);
  emit({ kind: 'state', state: 'down', reason: downWhy, quota });
}
let session = null, micStream = null, micCtx = null, micNode = null, playCtx = null;
let playing = [], nextAt = 0, idleTimer = 0, ending = false, resolveEnd = null, active = false;
let pending = '', answered = false;              // words of the turn in flight, and whether John answered them yet

let speakingNow = false; // for app.js: wait for John to finish before switching house and office
const emit = (detail) => { if (detail.kind === 'speaking') speakingNow = !!detail.on; window.dispatchEvent(new CustomEvent('walkin:live', { detail })); };

// ------------------------------------------------------------------ availability
async function available() {
  if (params.get('live') === 'off') return false;
  if (Date.now() < downUntil) return false;
  if (healthLive === null) {
    try { healthLive = !!(await (await fetch('/api/health')).json()).live; } catch (e) { healthLive = false; }
  }
  return healthLive;
}

// ------------------------------------------------------------------ audio out: 24 kHz PCM16 chunks, played gap-free
function prime() {                             // call inside a tap: iOS only starts audio contexts made in a gesture
  if (!sdk) import('./vendor/genai/genai.mjs').then((m) => { sdk = sdk || m; }).catch(() => {}); // fetch the SDK now, not on "Hey John"
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) { /* Safari < 16.4 */ }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    playCtx = playCtx || new AC({ sampleRate: OUT_RATE });
    if (playCtx.state === 'suspended') playCtx.resume();
    micCtx = micCtx || new AC();                 // made here too, so the mic worklet isn't born suspended later
    if (micCtx.state === 'suspended') micCtx.resume();
  } catch (e) { /* no audio */ }
}

function playChunk(b64) {
  prime();
  if (!playCtx) return;
  const bin = atob(b64), n = bin.length >> 1, pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v & 0x8000) v -= 0x10000;
    pcm[i] = v / 32768;
  }
  const buf = playCtx.createBuffer(1, n, OUT_RATE);
  buf.copyToChannel(pcm, 0);
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
  nextAt = Math.max(nextAt, playCtx.currentTime + 0.03);
  src.start(nextAt);
  nextAt += buf.duration;
  playing.push(src);
  src.onended = () => { playing = playing.filter((s) => s !== src); };
  emit({ kind: 'speaking', on: true });
}

function stopPlayback() {                       // barge-in: the person started talking over John
  for (const s of playing) { try { s.stop(); } catch (e) { /* already ended */ } }
  playing = [];
  nextAt = 0;
  emit({ kind: 'speaking', on: false });
}

// ------------------------------------------------------------------ audio in: mic -> 16 kHz PCM16, ~40 ms chunks
const WORKLET = `
class Down extends AudioWorkletProcessor {
  constructor(o) { super(); this.ratio = sampleRate / ${IN_RATE}; this.acc = []; this.pos = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {          // box-filter downsample to 16 kHz
      this.pos += 1;
      this.sum = (this.sum || 0) + ch[i]; this.cnt = (this.cnt || 0) + 1;
      if (this.pos >= this.ratio) { this.pos -= this.ratio; this.acc.push(this.sum / this.cnt); this.sum = 0; this.cnt = 0; }
    }
    if (this.acc.length >= 640) {
      const out = new Int16Array(this.acc.length);
      for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, this.acc[i])) * 32767;
      this.port.postMessage(out.buffer, [out.buffer]);
      this.acc = [];
    }
    return true;
  }
}
registerProcessor('walkin-down', Down);`;

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

let workletCtx = null, micSource = null;        // the processor is registered once per context
async function startMic(isCurrent = () => true) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  if (!isCurrent()) {                            // that call ended while the mic was coming up: release only this
    stream.getTracks().forEach((t) => t.stop()); // stream, never a newer call's mic
    return false;
  }
  micStream = stream;
  if (!micCtx || micCtx.state === 'closed') micCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (micCtx.state === 'suspended') await micCtx.resume();   // Safari starts it suspended outside a tap
  if (workletCtx !== micCtx) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await micCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    workletCtx = micCtx;
  }
  if (!isCurrent()) {                            // ended during the awaits above: same rule, release only ours
    stream.getTracks().forEach((t) => t.stop());
    if (micStream === stream) micStream = null;
    return false;
  }
  micNode = new AudioWorkletNode(micCtx, 'walkin-down');
  micNode.port.onmessage = (e) => {
    if (!session || ending) return;
    try { session.sendRealtimeInput({ audio: { data: toB64(e.data), mimeType: `audio/pcm;rate=${IN_RATE}` } }); } catch (err) { /* closing */ }
  };
  micSource = micCtx.createMediaStreamSource(micStream);
  micSource.connect(micNode);
}

function stopMic() {                             // keep micCtx: it was unlocked by a tap, and iOS won't redo that later
  try { micSource && micSource.disconnect(); } catch (e) { /* gone */ }
  try { micNode && micNode.disconnect(); micNode.port.onmessage = null; } catch (e) { /* gone */ }
  if (micStream) micStream.getTracks().forEach((t) => t.stop());   // the mic light goes off between calls
  micStream = micNode = micSource = null;
}

// ------------------------------------------------------------------ tools: John's own actions (agent.js)
function upperTypes(schema) {                    // Gemini's Schema.type enum is upper case (OBJECT, STRING, …)
  if (Array.isArray(schema)) return schema.map(upperTypes);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === 'type' && typeof v === 'string' ? v.toUpperCase() : upperTypes(v);
  return out;
}

async function onToolCall(toolCall) {
  const agent = window.walkin && window.walkin.agent;
  const functionResponses = [];
  for (const fc of toolCall.functionCalls || []) {
    emit({ kind: 'tool', name: fc.name });
    let response;
    try { response = agent ? await agent.runTool(fc.name, fc.args || {}) : { ok: false, reason: 'agent not ready' }; }
    catch (e) { response = { ok: false, reason: String(e && e.message || e) }; }
    functionResponses.push({ id: fc.id, name: fc.name, response: response && typeof response === 'object' ? response : { result: response } });
  }
  if (session && !ending) session.sendToolResponse({ functionResponses });
}

// ------------------------------------------------------------------ the conversation
function touch() {                               // someone said something: push the idle cut-off back
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stop('idle'), IDLE_MS);
}

let userLine = '', johnLine = '', saidBye = false;
function onMessage(m) {
  if (m.toolCall) { touch(); answered = true; onToolCall(m.toolCall); }
  const sc = m.serverContent;
  if (!sc) return;
  if (sc.interrupted) { stopPlayback(); johnLine = ''; }
  if (sc.inputTranscription && sc.inputTranscription.text) {
    touch();
    userLine = (userLine + sc.inputTranscription.text).replace(/\s+/g, ' ');
    pending = userLine; answered = false;
    if (BYE.test(userLine)) saidBye = true;
    emit({ kind: 'user', text: userLine.trim() });
  }
  for (const p of (sc.modelTurn && sc.modelTurn.parts) || []) {
    if (p.inlineData && p.inlineData.data) { touch(); answered = true; playChunk(p.inlineData.data); }
  }
  if (sc.outputTranscription && sc.outputTranscription.text) {
    johnLine = (johnLine + sc.outputTranscription.text).replace(/\s+/g, ' ');
    emit({ kind: 'john', text: johnLine.trim() });
  }
  if (sc.turnComplete) {
    pending = '';
    userLine = ''; johnLine = '';
    emit({ kind: 'turn' });
    if (saidBye) {                               // let the goodbye finish playing, then hang up
      const left = playCtx ? Math.max(0, nextAt - playCtx.currentTime) : 0;
      setTimeout(() => stop('bye'), left * 1000 + 300);
    }
  }
}

function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(msg)), ms))]);
}

/** Say this exact line in John's own voice inside the open conversation (one voice, and he won't answer himself). */
function sayExact(line) {
  if (!active || !session || ending) return false;
  try {
    session.sendClientContent({ turns: [{ role: 'user', parts: [{ text:
      `(Not the user speaking: the app noticed something. Say exactly this, in your own voice, then wait: "${line}")` }] }],
    turnComplete: true });
    touch();
    return true;
  } catch (e) { return false; }
}

async function start({ firstText = '' } = {}) {
  if (active) return;
  active = true; ending = false; saidBye = false; userLine = ''; johnLine = '';
  const done = new Promise((r) => { resolveEnd = r; });
  try {
    const tok = await fetch('/api/live-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const t = await tok.json().catch(() => ({}));
    if (!tok.ok || !t.token) throw new Error(`live-token ${tok.status}: ${(t.error && (t.error.message || t.error)) || 'no token'}`);
    sdk = sdk || await import('./vendor/genai/genai.mjs');
    const ai = new sdk.GoogleGenAI({ apiKey: t.token, httpOptions: { apiVersion: t.apiVersion || 'v1beta' } });
    const agent = window.walkin.agent;
    const voiceName = params.get('voice') || t.voice || 'Charon';
    emit({ kind: 'state', state: 'connecting' });
    connecting = ai.live.connect({
      model: t.model,
      config: {
        responseModalities: [sdk.Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        systemInstruction: { parts: [{ text: `${agent.system}\n${LIVE_STYLE}` }] },
        tools: [{ functionDeclarations: upperTypes(agent.declarations) }],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onmessage: onMessage,
        onerror: (e) => { console.warn('[live] error', e && (e.message || e)); fail((e && (e.message || e)) || 'error'); },
        onclose: (e) => {
          if (ending) return;
          const why = (e && (e.reason || e.code)) || 'closed';
          console.info('[live] closed', why);
          // 1000 is a normal close; anything else (1011 "Resource has been exhausted", 1006 dropped) is a failure
          if (e && e.code && e.code !== 1000) fail(why); else stop('closed');
        },
      },
    });
    session = await withTimeout(connecting, CONNECT_MS, 'connecting to Gemini Live timed out');
    if (ending || !active) {                     // it failed or was stopped while connecting: don't keep the socket
      try { session.close(); } catch (e) { /* already closed */ }
      session = null;
      return false;
    }
    emit({ kind: 'state', state: 'live' });
    touch();
    pending = firstText; answered = false;
    if (firstText) {                             // what was said after "Hey John" is the first turn: send it now,
      emit({ kind: 'user', text: firstText });   // don't make it wait for the microphone to come up
      session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: firstText }] }], turnComplete: true });
    }
    const mine = session;                        // then open the mic in the background: a slow or missing mic
    const current = () => session === mine && !ending;
    Promise.race([startMic(current), new Promise((_, no) => setTimeout(() => no(new Error('mic timed out')), 5000))])
      .then((ok) => { if (ok !== false && !current()) stopMic(); })   // ended after the mic came up: let go of it
      .catch((e) => {
        console.warn('[live] microphone unavailable:', e && (e.message || e));
        if (session === mine && !ending) emit({ kind: 'state', state: 'nomic' });
      });
  } catch (e) {
    if (connecting) connecting.then((late) => { if (late !== session) { try { late.close(); } catch (err) { /* gone */ } } }).catch(() => {});
    console.warn('[live] could not start:', e && (e.message || e));
    markDown(e && (e.message || e));
    emit({ kind: 'state', state: 'failed', reason: String(e && e.message || e) });
    cleanup();
    active = false;
    resolveEnd && resolveEnd(false);
    return false;
  }
  return done;
}

function cleanup() {
  clearTimeout(idleTimer);
  stopMic();
  try { session && session.close(); } catch (e) { /* already closed */ }
  session = null;
}

/** The session broke: switch Live off for a while and hand back what John still owed an answer to. */
function fail(why) {
  if (!active || ending) return;
  markDown(why);
  stop('error', !answered && pending.trim() ? { fallback: true, text: pending.trim(), why: String(why) } : { fallback: true, why: String(why) });
}

function stop(why = 'stop', result = true) {
  if (!active || ending) return;
  ending = true;
  cleanup();
  setTimeout(stopPlayback, playCtx ? Math.max(0, (nextAt - playCtx.currentTime) * 1000) : 0);
  active = false;
  emit({ kind: 'state', state: 'ended', why });
  const r = resolveEnd; resolveEnd = null;
  r && r(result);
}

(function attach(tries = 0) {
  if (!window.walkin || !window.walkin.agent) { if (tries < 600) setTimeout(() => attach(tries + 1), 200); return; }
  window.walkin.live = { available, start, stop, prime, sayExact, isActive: () => active, isSpeaking: () => speakingNow, _onMessage: onMessage, _upperTypes: upperTypes,
    markDown, down: () => (Date.now() < downUntil ? downWhy : null), _fail: fail };
})();
