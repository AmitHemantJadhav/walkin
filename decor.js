// Decor tools for John: paint and wallpaper that always land, framed pictures on real walls, and a one-call
// themed makeover ("decorate this room as if I'm a Ronaldo fan").
//
// Everything starts procedural (drawn on a canvas: instant, offline, never refused) and is swapped for a
// generated image when the image model answers. The image model is slow here (~8-10 s through the relay's
// OpenRouter fallback) and limited to about 2 a minute, so nothing waits on it.
//
//   walkin.decor.hangPicture({ description, wall, width_m, height_m })   -> { ok, say, ... }
//   walkin.decor.decorateRoom({ theme })                                  -> { ok, say, ... }
//   walkin.decor.removeDecor({ what })                                    -> { ok, say }
//   walkin.decor.patternTile('striped navy wallpaper')                    -> { url, tile, kind } | null
//   walkin.decor.pictures                                                 -> the hung picture groups
// Tools go to the agent through window.walkinTools (agent.js merges them; live.js gets the same set).
// Units: metres, Z up, model frame.
import * as THREE from 'three';
import { wallOffset, FIT } from './wallfit.js';

const W = () => window.walkin;
const IMAGE_MODEL = new URLSearchParams(location.search).get('imageModel') || 'gemini-3.1-flash-image';
const IMAGE_TIMEOUT_MS = 40000;   // per request; nothing waits on it, so it can be generous
const EYE = 1.5;                  // centre of a picture above the floor (gallery standard ~1.45-1.55 m)
const lower = (s) => String(s || '').toLowerCase();
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ colours
const NAMED = {
  'off white': '#efeadf', white: '#f4f2ec', cream: '#f1e6cc', ivory: '#f3edd8', beige: '#d9c7a7', sand: '#dccaa5',
  greige: '#c9c0b1', taupe: '#9b8b7a', grey: '#9a9a96', gray: '#9a9a96', 'light grey': '#cfcfcb', 'light gray': '#cfcfcb',
  charcoal: '#3f4144', black: '#252525', 'sage green': '#9caf88', sage: '#9caf88', 'olive green': '#7d8450',
  olive: '#7d8450', 'forest green': '#2f5d3a', 'emerald green': '#1f7a4d', emerald: '#1f7a4d', 'bottle green': '#1e4d36',
  'mint green': '#bfe3cf', mint: '#bfe3cf', green: '#5f8f5a', 'navy blue': '#26385c', navy: '#26385c',
  'royal blue': '#2c4fa3', 'cobalt blue': '#2350a8', cobalt: '#2350a8', 'sky blue': '#a9cbe8', 'light blue': '#b9d3ea',
  'powder blue': '#c4d8e6', 'duck egg blue': '#c5ddd7', 'duck egg': '#c5ddd7', teal: '#2f7f7f', blue: '#4a74b5',
  red: '#a8322d', 'portugal red': '#b0121e', crimson: '#a3162b', scarlet: '#c0261f', burgundy: '#6b1f2a',
  maroon: '#6b1f2a', terracotta: '#c0643f', rust: '#a9502c', coral: '#e57f6b', peach: '#f2c4a6', pink: '#e8b4bc',
  'blush pink': '#ecc6c4', blush: '#ecc6c4', 'hot pink': '#d6457f', orange: '#d9813a', yellow: '#e8cf5a',
  mustard: '#c99a2e', gold: '#c9a227', golden: '#c9a227', silver: '#b8bcc2', purple: '#6e4f8f', violet: '#7a4fa8',
  lavender: '#c3b5d9', lilac: '#c8a9d6', plum: '#5e2b4f', brown: '#7a5838', chocolate: '#4e3324', tan: '#c4a57c',
  camel: '#b98c56', ochre: '#c08a2d', aqua: '#7fcfcf', turquoise: '#3fb5ad', cyan: '#4fc3d9', magenta: '#b0307a',
  lime: '#a6c84a', neon: '#39ff88',
};
const NAMES = Object.keys(NAMED).sort((a, b) => b.length - a.length);   // "sage green" before "green"
const probe = document.createElement('canvas').getContext('2d');

/** A colour word or hex as '#rrggbb', or null. Accepts our names, then any CSS colour name. */
function toHex(s) {
  const t = lower(s).trim();
  if (!t) return null;
  if (NAMED[t]) return NAMED[t];
  if (/^#?[0-9a-f]{6}$/.test(t)) return t[0] === '#' ? t : `#${t}`;
  if (/^#?[0-9a-f]{3}$/.test(t)) { const h = t.replace('#', ''); return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`; }
  probe.fillStyle = '#010203';
  probe.fillStyle = t;
  const v = probe.fillStyle;
  return v !== '#010203' && /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

/** Colours named in a description, in the order they appear (at most 3). */
function coloursIn(text) {
  const t = ` ${lower(text).replace(/[^a-z0-9# ]/g, ' ')} `;
  const found = [];
  let rest = t;
  for (const n of NAMES) {
    const re = new RegExp(`\\b${n}\\b`);
    const m = re.exec(rest);
    if (m) { found.push({ at: m.index, hex: NAMED[n] }); rest = rest.replace(re, ' '.repeat(n.length)); }
  }
  for (const m of t.matchAll(/#[0-9a-f]{6}\b/g)) found.push({ at: m.index, hex: m[0] });
  for (const m of rest.matchAll(/\b[a-z]{3,}\b/g)) {     // CSS names we don't list (e.g. "salmon", "indigo")
    if (/^(and|with|the|wall|paper|wallpaper|paint|stripe|stripes|striped|on|this|that|in|of|a|dots|check)$/.test(m[0])) continue;
    const hex = toHex(m[0]);
    if (hex) found.push({ at: m.index, hex });
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.hex))].slice(0, 3);
}

const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const hexOf = ([r, g, b]) => `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hexOf(x.map((v, i) => v + (y[i] - v) * t)); };
const luma = (hex) => { const [r, g, b] = rgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
const contrastOn = (hex) => (luma(hex) > 0.6 ? '#2a2a2a' : '#f6f2e8');

// ------------------------------------------------------------------ procedural wallpaper (seamless by construction)
const S = 512;   // tile canvas size

function canvas(w = S, h = S) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

/** Draw fn at the 9 wrapped offsets, so anything placed on the lattice tiles without a seam. */
function wrapped(g, fn) {
  for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) { g.save(); g.translate(dx, dy); fn(); g.restore(); }
}

function grain(g, w, h, amount = 1800, a = 0.04) {
  for (let i = 0; i < amount; i++) {
    g.fillStyle = Math.random() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1);
  }
}

const PATTERNS = {
  paint({ bg }) {
    const [c, g] = canvas(256, 256);
    g.fillStyle = bg; g.fillRect(0, 0, 256, 256);
    grain(g, 256, 256, 1600, 0.035);
    return { c, tile: 1 };
  },
  stripes({ bg, fg, accent }) {                 // ~6 cm stripes, regency style when there's an accent colour
    const [c, g] = canvas();
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    const n = 8, w = S / n;
    for (let i = 0; i < n; i += 2) {
      g.fillStyle = fg; g.fillRect(i * w, 0, w, S);
      if (accent) { g.fillStyle = accent; g.fillRect(i * w + w + w / 2 - 2, 0, 4, S); }
    }
    grain(g, S, S, 1200, 0.03);
    return { c, tile: 0.8 };
  },
  pinstripe({ bg, fg }) {
    const [c, g] = canvas();
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    g.fillStyle = fg;
    for (let x = 0; x < S; x += S / 8) g.fillRect(x + S / 16 - 1.5, 0, 3, S);
    grain(g, S, S, 1200, 0.03);
    return { c, tile: 0.6 };
  },
  checks({ bg, fg }) {                          // gingham: two translucent band sets
    const [c, g] = canvas();
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    const n = 8, w = S / n;
    g.globalAlpha = 0.55; g.fillStyle = fg;
    for (let i = 0; i < n; i += 2) { g.fillRect(i * w, 0, w, S); g.fillRect(0, i * w, S, w); }
    g.globalAlpha = 1;
    grain(g, S, S, 1200, 0.03);
    return { c, tile: 0.5 };
  },
  polka({ bg, fg }) {
    const [c, g] = canvas();
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    g.fillStyle = fg;
    const step = S / 4;
    wrapped(g, () => {
      for (let y = 0; y < S; y += step) for (let x = 0; x < S; x += step) {
        const ox = (y / step) % 2 ? step / 2 : 0;
        g.beginPath(); g.arc(x + ox + step / 4, y + step / 4, step * 0.16, 0, Math.PI * 2); g.fill();
      }
    });
    return { c, tile: 0.45 };
  },
  herringbone({ bg, fg }) {
    const [c, g] = canvas();
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    const cw = S / 8, pitch = S / 8;
    g.strokeStyle = fg; g.lineWidth = 5;
    for (let col = 0; col < 8; col++) {
      g.save(); g.beginPath(); g.rect(col * cw, 0, cw, S); g.clip();
      const dir = col % 2 ? -1 : 1;
      for (let y = -2 * S; y < 2 * S; y += pitch) {
        g.beginPath(); g.moveTo(col * cw, y); g.lineTo(col * cw + cw, y + dir * cw); g.stroke();
      }
      g.restore();
      g.fillStyle = fg; g.fillRect(col * cw - 1.5, 0, 3, S);
    }
    grain(g, S, S, 1200, 0.03);
    return { c, tile: 0.6 };
  },
  chevron({ bg, fg }) {
    const [c, g] = canvas();
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    g.fillStyle = fg;
    const p = S / 4, h = S / 8;               // zig period and band height
    for (let y = -S / 4; y < S + S / 4; y += S / 4) {
      g.beginPath();
      for (let x = 0; x <= S; x += p) { g.lineTo(x, y); g.lineTo(x + p / 2, y + p / 2); }
      for (let x = S; x >= 0; x -= p) { g.lineTo(x + p / 2, y + p / 2 + h); g.lineTo(x, y + h); }
      g.closePath(); g.fill();
    }
    return { c, tile: 0.7 };
  },
  damask({ bg, fg }) {
    const [c, g] = canvas();
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    g.fillStyle = fg; g.strokeStyle = fg; g.lineWidth = 3;
    const motif = (x, y, s) => {                 // a symmetric medallion: drop, leaves, scrolls
      g.save(); g.translate(x, y); g.scale(s, s);
      for (const m of [1, -1]) {
        g.save(); g.scale(m, 1);
        g.beginPath(); g.moveTo(0, -60); g.bezierCurveTo(30, -40, 34, -5, 0, 20); g.bezierCurveTo(8, -10, 6, -35, 0, -60); g.fill();
        g.beginPath(); g.moveTo(0, 20); g.bezierCurveTo(40, 10, 55, 40, 30, 60); g.bezierCurveTo(40, 35, 20, 30, 0, 40); g.fill();
        g.beginPath(); g.moveTo(4, -20); g.bezierCurveTo(50, -50, 70, -10, 46, 10); g.stroke();
        g.beginPath(); g.arc(46, 10, 5, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.moveTo(0, 60); g.bezierCurveTo(14, 70, 10, 84, 0, 90); g.fill();
        g.restore();
      }
      g.beginPath(); g.arc(0, -70, 6, 0, Math.PI * 2); g.fill();
      g.restore();
    };
    wrapped(g, () => { motif(S / 4, S / 4, 1.05); motif(3 * S / 4, 3 * S / 4, 1.05); });
    g.globalAlpha = 0.5;
    wrapped(g, () => { motif(3 * S / 4, S / 4, 0.35); motif(S / 4, 3 * S / 4, 0.35); });
    g.globalAlpha = 1;
    grain(g, S, S, 1000, 0.03);
    return { c, tile: 0.65 };
  },
  floral({ bg, fg, accent }) {
    const [c, g] = canvas();
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    const leaf = mix(fg, '#4f6b4a', 0.6);
    const flower = (x, y, r, col) => {
      g.fillStyle = leaf;
      for (const a of [0.6, 2.6]) {
        g.save(); g.translate(x, y); g.rotate(a);
        g.beginPath(); g.ellipse(r * 1.6, 0, r * 0.9, r * 0.35, 0, 0, Math.PI * 2); g.fill(); g.restore();
      }
      g.fillStyle = col;
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        g.beginPath(); g.arc(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, r * 0.5, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = accent || mix(col, '#f2d36b', 0.7);
      g.beginPath(); g.arc(x, y, r * 0.3, 0, Math.PI * 2); g.fill();
    };
    wrapped(g, () => {
      flower(S / 4, S / 4, 26, fg); flower(3 * S / 4, 3 * S / 4, 26, fg);
      flower(3 * S / 4, S / 4 + 20, 14, mix(fg, bg, 0.35)); flower(S / 4 + 10, 3 * S / 4 - 10, 14, mix(fg, bg, 0.35));
    });
    return { c, tile: 0.55 };
  },
  leaves({ bg, fg }) {
    const [c, g] = canvas();
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    const leaf = (x, y, a, s, col) => {
      g.save(); g.translate(x, y); g.rotate(a); g.scale(s, s);
      g.fillStyle = col;
      g.beginPath(); g.moveTo(0, -50); g.bezierCurveTo(30, -30, 30, 30, 0, 50); g.bezierCurveTo(-30, 30, -30, -30, 0, -50); g.fill();
      g.strokeStyle = mix(col, bg, 0.5); g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, -45); g.lineTo(0, 55); g.stroke();
      g.restore();
    };
    wrapped(g, () => {
      leaf(S / 4, S / 4, 0.5, 1, fg); leaf(3 * S / 4, 3 * S / 4, -0.6, 1, fg);
      leaf(3 * S / 4, S / 4, 2.2, 0.7, mix(fg, bg, 0.3)); leaf(S / 4, 3 * S / 4, -2.0, 0.7, mix(fg, bg, 0.3));
    });
    return { c, tile: 0.6 };
  },
  scallop({ bg, fg }) {                          // art deco fans
    const [c, g] = canvas();
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    const r = S / 8;
    g.strokeStyle = fg; g.lineWidth = 4;
    wrapped(g, () => {
      for (let row = 0; row < 8; row++) for (let col = 0; col < 4; col++) {
        const x = col * 2 * r + (row % 2 ? r : 0), y = row * r;
        for (const k of [1, 0.66, 0.33]) { g.beginPath(); g.arc(x, y + r, r * k, Math.PI, 0); g.stroke(); }
      }
    });
    return { c, tile: 0.6 };
  },
};

const PATTERN_WORDS = [
  [/pin ?stripe/, 'pinstripe'], [/stripe|striped|regency/, 'stripes'], [/gingham|check|plaid|tartan|buffalo/, 'checks'],
  [/polka|dot|spot/, 'polka'], [/herringbone/, 'herringbone'], [/chevron|zig ?zag/, 'chevron'],
  [/damask|baroque|ornate|victorian|brocade/, 'damask'], [/flor|flower|rose|blossom|chintz/, 'floral'],
  [/leaf|leaves|botanical|tropical|palm|jungle|fern|banana/, 'leaves'], [/art deco|deco|scallop|fan|geometric/, 'scallop'],
];
const PATTERN_DEFAULTS = {
  stripes: ['#f1e6cc', '#26385c'], pinstripe: ['#f1e6cc', '#26385c'], checks: ['#f4f2ec', '#4a74b5'],
  polka: ['#f4f2ec', '#26385c'], herringbone: ['#efeadf', '#9b8b7a'], chevron: ['#f4f2ec', '#3f4144'],
  damask: ['#1e4d36', '#c9a227'], floral: ['#f3edd8', '#e8b4bc'], leaves: ['#f1e6cc', '#5f8f5a'], scallop: ['#1f2a3a', '#c9a227'],
};
const BUNDLED = [
  [/brick/, 'assets/tiles/red-brick.png', 0.9], [/subway|ceramic|tiled|tiles/, 'assets/tiles/white-subway.png', 0.6],
  [/wood|oak|panel|timber|plank|shiplap/, 'assets/tiles/oak-panel.png', 1.2],
];

/**
 * A tile for a wall description, drawn now: { url, tile, kind, colours } or null when the description names
 * neither a pattern nor a colour (then the caller uses an image or a default).
 */
export function patternTile(description, { pattern, colors } = {}) {
  const d = lower(description);
  const cols = (Array.isArray(colors) ? colors.map(toHex).filter(Boolean) : []).concat(coloursIn(d)).slice(0, 3);
  let kind = pattern && PATTERNS[lower(pattern)] ? lower(pattern) : (PATTERN_WORDS.find(([re]) => re.test(d)) || [])[1];
  if (!kind) {
    const b = BUNDLED.find(([re]) => re.test(d));
    if (b) return { url: b[1], tile: b[2], kind: 'bundled', colours: [] };
    if (!cols.length) return null;
    kind = 'paint';
  }
  const def = PATTERN_DEFAULTS[kind] || ['#f4f2ec', '#26385c'];
  let bg, fg, accent;
  if (kind === 'paint') bg = cols[0];
  else if (cols.length >= 2) [fg, bg, accent] = cols;          // "navy and cream stripes": first colour is the pattern
  else if (cols.length === 1) {                               // one colour: it's the pattern on a light ground, or
    fg = cols[0];                                             // the ground under a light pattern if it's dark
    bg = luma(fg) < 0.35 && kind !== 'pinstripe' && kind !== 'stripes' ? fg : mix(fg, '#f6f1e6', 0.85);
    if (bg === fg) fg = mix(fg, '#f6f1e6', 0.75);
  } else [bg, fg] = def;
  const { c, tile } = PATTERNS[kind]({ bg, fg, accent });
  return { url: c.toDataURL('image/png'), tile, kind, colours: [bg, fg, accent].filter(Boolean) };
}

// ------------------------------------------------------------------ image generation: one at a time, cached, never awaited by a tool
const imgCache = new Map();     // prompt -> Promise<dataURL | null>
let queue = Promise.resolve();
const imageStats = { asked: 0, ok: 0, failed: 0, last: null };

async function requestImage(prompt) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/gemini?model=${encodeURIComponent(IMAGE_MODEL)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'] } }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {                       // the relay's 2-a-minute image limit: wait our turn
        const wait = clamp(Number(data.retry_after) || 30, 2, 45);
        imageStats.last = `rate limited, waiting ${wait}s`;
        await sleep(wait * 1000);
        continue;
      }
      const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
      const img = parts.find((p) => p.inlineData && p.inlineData.data);
      if (img) return `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}`;
      imageStats.last = `no image (${(((data.candidates || [])[0]) || {}).finishReason || res.status})`;
      return null;                                     // a refusal: the procedural picture stays
    } catch (e) {
      imageStats.last = e.name === 'AbortError' ? 'timed out' : String(e.message || e);
      return null;
    } finally { clearTimeout(timer); }
  }
  return null;
}

/** Generated image for `prompt` (data URL) or null. Serialised so a makeover's posters don't race the limit. */
export function generateImage(prompt) {
  if (imgCache.has(prompt)) return imgCache.get(prompt);
  imageStats.asked++;
  const p = queue.then(() => requestImage(prompt)).then((url) => {
    if (url) imageStats.ok++; else { imageStats.failed++; imgCache.delete(prompt); }
    return url;
  });
  queue = p.catch(() => null);
  imgCache.set(prompt, p);
  return p;
}

function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}

/** A generated wallpaper made seamless: the square mirrored 2 x 2, so every edge meets its own reflection. */
async function mirroredTile(src) {
  const im = await loadImage(src);
  const s = Math.min(im.width, im.height), half = 384;
  const [c, g] = canvas(half * 2, half * 2);
  for (const [mx, my] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    g.save(); g.translate(half, half); g.scale(mx, my);
    g.drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, half, half);
    g.restore();
  }
  return c.toDataURL('image/jpeg', 0.9);
}

// ------------------------------------------------------------------ walls of a room
function floorRec() {
  const w = W(), cur = w.current;
  return (w.house.floors || []).find((f) => f.id === cur.floor) || w.house.floors[0];
}
function currentRoom() {
  const w = W(), c = w.current;
  return c && c.pos ? w.roomAt(c.pos[0], c.pos[1], c.floor) || null : null;
}

/** Everything about one face of a wall that picture placement needs. */
function faceInfo(index, normal) {
  const f = floorRec(), rec = f.walls[index];
  const len = Math.hypot(rec.b[0] - rec.a[0], rec.b[1] - rec.a[1]);
  const dir = [(rec.b[0] - rec.a[0]) / len, (rec.b[1] - rec.a[1]) / len];
  const holes = (rec.openings || []).filter((o) => o && o.at != null).map((o) => {
    const c = o.at * len, half = (o.width || 0.9) / 2, bottom = Math.max(0, o.bottom || 0);
    return { u0: c - half, u1: c + half, v0: bottom, v1: bottom + (o.height || 2.05), type: o.type };
  });
  return { floor: f.id, index, rec, a: rec.a, b: rec.b, len, dir, normal: [normal[0], normal[1]], holes };
}

/** The faces of the walls that bound `room` (the side that looks into it). */
function roomFaces(room) {
  const w = W(), f = floorRec(), out = [];
  if (!room) return out;
  f.walls.forEach((rec, index) => {
    if (rec.type && rec.type !== 'wall') return;
    const dx = rec.b[0] - rec.a[0], dy = rec.b[1] - rec.a[1], len = Math.hypot(dx, dy);
    if (len < 0.6) return;
    const mx = (rec.a[0] + rec.b[0]) / 2, my = (rec.a[1] + rec.b[1]) / 2;
    for (const s of [1, -1]) {
      const n = [(-dy / len) * s, (dx / len) * s];
      if (w.roomAt(mx + n[0] * 0.3, my + n[1] * 0.3, f.id) === room) { out.push(faceInfo(index, n)); break; }
    }
  });
  return out;
}

/** {floor,index,a,b,normal} from pointer.js / wallAhead -> faceInfo. */
function faceFromWall(wall) {
  if (!wall || wall.index == null) return null;
  return faceInfo(wall.index, wall.normal);
}

/** The wall straight out from the user at eye height, turned by `turn` radians (0 ahead, PI behind). */
function wallInDirection(turn = 0) {
  const w = W(), cur = w.current, f = floorRec();
  const cd = w.camera ? w.camera.getWorldDirection(new THREE.Vector3()) : null;   // where the view really points
  const yaw = (cd && Math.hypot(cd.x, cd.y) > 1e-3 ? Math.atan2(cd.y, cd.x) : ((w.view && w.view.yaw) || 0)) + turn;
  const o = [cur.pos[0], cur.pos[1]], d = [Math.cos(yaw), Math.sin(yaw)];
  let best = null;
  f.walls.forEach((rec, index) => {
    if (rec.type && rec.type !== 'wall') return;
    const ex = rec.b[0] - rec.a[0], ey = rec.b[1] - rec.a[1], len = Math.hypot(ex, ey);
    const den = d[0] * ey - d[1] * ex;
    if (len < 0.3 || Math.abs(den) < 1e-9) return;
    const t = ((rec.a[0] - o[0]) * ey - (rec.a[1] - o[1]) * ex) / den;
    const s = ((rec.a[0] - o[0]) * d[1] - (rec.a[1] - o[1]) * d[0]) / den;
    if (t <= 0.1 || s < 0 || s > 1) return;
    if (!best || t < best.t) {
      let nx = -ey / len, ny = ex / len;
      if (nx * d[0] + ny * d[1] > 0) { nx = -nx; ny = -ny; }
      best = { t, index, normal: [nx, ny], point: [o[0] + d[0] * t, o[1] + d[1] * t] };
    }
  });
  return best;
}

const uOn = (face, x, y) => (x - face.a[0]) * face.dir[0] + (y - face.a[1]) * face.dir[1];

// how far in front of the centre line the scanned face is (so the occluder doesn't swallow a picture)
let trisOf = { mesh: null, tris: null };
function occluderTris() {
  const mesh = W().occluderMesh;
  if (!mesh) return null;
  if (trisOf.mesh === mesh) return trisOf.tris;
  const out = [], v = new THREE.Vector3();
  mesh.updateMatrixWorld(true);
  mesh.traverse((o) => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index, n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i++) { v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld); out.push(v.x, v.y, v.z); }
  });
  trisOf = { mesh, tris: Float32Array.from(out) };
  return trisOf.tris;
}
const offsetCache = new Map();
function faceOffset(face) {
  const k = `${face.floor}|${face.index}|${face.normal.map((x) => x.toFixed(2))}`;
  if (offsetCache.has(k)) return offsetCache.get(k);
  let off = Math.max(FIT.floor, (face.rec.thickness || 0.12) / 2 + FIT.margin);
  try {
    const tris = occluderTris();
    if (tris) off = wallOffset(tris, face.rec, face.normal, (W().current.floorZ || 0), 2.6).offset;
  } catch (e) { console.warn('[decor] wall fit failed, using the default offset', e); }
  offsetCache.set(k, off);
  return off;
}

// ------------------------------------------------------------------ pictures
const decorGroup = new THREE.Group();
decorGroup.name = 'decor-pictures';
export const pictures = [];          // groups; userData: { face, u, v, w, h, description, prompt }

/** A free spot of width pw x ph on `face`, centred as close to preferU as possible at height vc. */
function findSpot(face, pw, ph, preferU, vc) {
  const v0 = vc - ph / 2, v1 = vc + ph / 2, gap = 0.12, end = 0.25;
  const blocked = face.holes.filter((h) => h.v1 > v0 - gap && h.v0 < v1 + gap).map((h) => [h.u0 - gap, h.u1 + gap]);
  for (const p of pictures) {
    const d = p.userData;
    if (d.face.index !== face.index || d.face.floor !== face.floor) continue;
    if (d.v + d.h / 2 > v0 - 0.08 && d.v - d.h / 2 < v1 + 0.08) blocked.push([d.u - d.w / 2 - 0.06, d.u + d.w / 2 + 0.06]);
  }
  blocked.sort((a, b) => a[0] - b[0]);
  const free = [];
  let cursor = end;
  for (const [s, e] of blocked) { if (s > cursor) free.push([cursor, s]); cursor = Math.max(cursor, e); }
  if (face.len - end > cursor) free.push([cursor, face.len - end]);
  let best = null;
  for (const [s, e] of free) {
    if (e - s < pw) continue;
    const u = clamp(preferU, s + pw / 2, e - pw / 2);
    if (!best || Math.abs(u - preferU) < Math.abs(best - preferU)) best = u;
  }
  return best;
}

const FRAMES = { black: '#1d1d1f', gold: '#b8912f', oak: '#a3784a', white: '#f2f0ea', walnut: '#5a3d28', red: '#8e1a1f', silver: '#a9adb3' };

function basicMat(color, map = null) {
  const m = new THREE.MeshBasicMaterial({ color, map });
  m.toneMapped = false;
  return m;
}

/** Build a frame + matte + image group in its own frame: x along the wall, y up, z out of the wall. */
function buildPicture(w, h, { frame = 'black', matte = 0.05, texture }) {
  const g = new THREE.Group();
  const fw = 0.035, depth = 0.03, fc = FRAMES[frame] || toHex(frame) || FRAMES.black;
  const fm = basicMat(new THREE.Color(fc).multiplyScalar(0.85));
  const side = (sx, sy, px, py) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, depth), fm);
    m.position.set(px, py, depth / 2); g.add(m);
  };
  side(w + 2 * fw, fw, 0, h / 2 + fw / 2); side(w + 2 * fw, fw, 0, -h / 2 - fw / 2);
  side(fw, h, -w / 2 - fw / 2, 0); side(fw, h, w / 2 + fw / 2, 0);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), basicMat(new THREE.Color('#ece8de').multiplyScalar(0.9)));
  back.position.z = depth * 0.4; g.add(back);
  const iw = w - 2 * matte, ih = h - 2 * matte;
  const img = new THREE.Mesh(new THREE.PlaneGeometry(iw, ih), basicMat(new THREE.Color(0.92, 0.92, 0.92), texture));
  img.position.z = depth * 0.4 + 0.002; img.name = 'image'; g.add(img);
  g.traverse((o) => { if (o.isMesh) o.renderOrder = 3; });
  return g;
}

function canvasTexture(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Centre-crop an image to the picture's aspect, as a texture. */
async function textureFromUrl(url, aspect) {
  const im = await loadImage(url);
  const ia = im.width / im.height;
  let sw = im.width, sh = im.height;
  if (ia > aspect) sw = im.height * aspect; else sh = im.width / aspect;
  const H = 768, Wd = Math.round(H * aspect);
  const [c, g] = canvas(Wd, H);
  g.drawImage(im, (im.width - sw) / 2, (im.height - sh) / 2, sw, sh, 0, 0, Wd, H);
  return canvasTexture(c);
}

function placeGroup(group, face, u, v) {
  const w = W(), off = faceOffset(face) + 0.006;
  const n = face.normal, up = new THREE.Vector3(0, 0, 1);
  const nv = new THREE.Vector3(n[0], n[1], 0);
  const x = new THREE.Vector3().crossVectors(up, nv);          // right-handed: x = up x n
  const px = face.a[0] + face.dir[0] * u + n[0] * off, py = face.a[1] + face.dir[1] * u + n[1] * off;
  group.matrixAutoUpdate = false;
  group.matrix.makeBasis(x, up, nv).setPosition(px, py, (w.current.floorZ || 0) + v);
  group.matrixWorldNeedsUpdate = true;
}

// ---- procedural posters: drawn now, replaced by the generated image when it lands
function poster(kind, aspect, pal, text = {}) {
  const H = 768, Wd = Math.round(H * aspect);
  const [c, g] = canvas(Wd, H);
  const P = { primary: '#b0121e', secondary: '#1e6b3a', accent: '#d4af37', dark: '#101418', light: '#f6f2e8', ...pal };
  const bigText = (str, y, size, col, font = 'Impact, "Arial Black", sans-serif') => {
    if (!str) return;
    g.font = `${size}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    let s = size;
    while (g.measureText(str).width > Wd * 0.88 && s > 12) { s -= 4; g.font = `${s}px ${font}`; }
    g.fillStyle = col; g.fillText(str, Wd / 2, y);
  };
  const rays = (cx, cy, col) => {
    g.save(); g.globalAlpha = 0.18; g.fillStyle = col;
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, H * 1.2, a, a + 0.12); g.closePath(); g.fill();
    }
    g.restore();
  };
  const sky = (top, bottom) => { const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, top); gr.addColorStop(1, bottom); g.fillStyle = gr; g.fillRect(0, 0, Wd, H); };

  if (kind === 'jersey') {
    sky(mix(P.dark, P.primary, 0.25), P.dark);
    rays(Wd / 2, H * 0.12, P.accent);
    const cx = Wd / 2, top = H * 0.2, sw = Wd * 0.62, bh = H * 0.52;
    g.fillStyle = '#c9c9c9'; g.fillRect(cx - 3, top - 50, 6, 30);            // hanger
    g.strokeStyle = '#c9c9c9'; g.lineWidth = 6;
    g.beginPath(); g.moveTo(cx - sw * 0.3, top + 8); g.lineTo(cx, top - 22); g.lineTo(cx + sw * 0.3, top + 8); g.stroke();
    g.fillStyle = P.primary;
    g.beginPath();
    g.moveTo(cx - sw * 0.18, top); g.lineTo(cx - sw * 0.5, top + bh * 0.08); g.lineTo(cx - sw * 0.62, top + bh * 0.32);
    g.lineTo(cx - sw * 0.42, top + bh * 0.38); g.lineTo(cx - sw * 0.4, top + bh); g.lineTo(cx + sw * 0.4, top + bh);
    g.lineTo(cx + sw * 0.42, top + bh * 0.38); g.lineTo(cx + sw * 0.62, top + bh * 0.32); g.lineTo(cx + sw * 0.5, top + bh * 0.08);
    g.lineTo(cx + sw * 0.18, top); g.quadraticCurveTo(cx, top + bh * 0.1, cx - sw * 0.18, top); g.closePath(); g.fill();
    g.fillStyle = P.secondary;                                                 // collar + side panels
    g.beginPath(); g.moveTo(cx - sw * 0.18, top); g.quadraticCurveTo(cx, top + bh * 0.13, cx + sw * 0.18, top);
    g.quadraticCurveTo(cx, top + bh * 0.07, cx - sw * 0.18, top); g.fill();
    g.fillRect(cx - sw * 0.41, top + bh * 0.42, sw * 0.05, bh * 0.58); g.fillRect(cx + sw * 0.36, top + bh * 0.42, sw * 0.05, bh * 0.58);
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(cx - sw * 0.4, top + bh * 0.92, sw * 0.8, bh * 0.08);
    bigText(text.name || '', top + bh * 0.3, Math.round(H * 0.05), P.accent, '"Arial Black", Impact, sans-serif');
    bigText(String(text.number || '7'), top + bh * 0.62, Math.round(H * 0.26), P.accent);
    bigText(text.title || '', H * 0.86, Math.round(H * 0.11), P.light);
    bigText(text.subtitle || '', H * 0.94, Math.round(H * 0.035), P.accent, '"Arial Black", sans-serif');
  } else if (kind === 'stadium') {
    sky('#060a18', '#1b2440');
    for (const fx of [0.12, 0.88]) {                                           // floodlights
      const x = Wd * fx, y = H * 0.14;
      const gr = g.createRadialGradient(x, y, 2, x, y, H * 0.35);
      gr.addColorStop(0, 'rgba(255,255,240,0.95)'); gr.addColorStop(0.2, 'rgba(255,255,220,0.35)'); gr.addColorStop(1, 'rgba(255,255,220,0)');
      g.fillStyle = gr; g.fillRect(0, 0, Wd, H);
      g.fillStyle = '#2b2f3a'; g.fillRect(x - 3, y, 6, H * 0.4);
    }
    for (let row = 0; row < 7; row++) {                                        // stands, crowd in team colours
      const y = H * 0.36 + row * H * 0.035;
      g.fillStyle = mix('#11131a', P.primary, 0.15 + row * 0.04); g.fillRect(0, y, Wd, H * 0.035);
      for (let k = 0; k < 60; k++) {
        g.fillStyle = [P.primary, P.secondary, P.light, P.accent][(k + row) % 4];
        g.globalAlpha = 0.5; g.fillRect(Math.random() * Wd, y + Math.random() * H * 0.03, 3, 3); g.globalAlpha = 1;
      }
    }
    const py = H * 0.6;                                                         // pitch
    g.fillStyle = '#1f7a3a';
    g.beginPath(); g.moveTo(Wd * 0.18, py); g.lineTo(Wd * 0.82, py); g.lineTo(Wd * 1.1, H); g.lineTo(-Wd * 0.1, H); g.fill();
    for (let k = 0; k < 6; k++) {
      g.fillStyle = k % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
      const y0 = py + (H - py) * (k / 6) ** 1.3, y1 = py + (H - py) * ((k + 1) / 6) ** 1.3;
      g.fillRect(0, y0, Wd, y1 - y0);
    }
    g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 3;
    g.beginPath(); g.ellipse(Wd / 2, py + (H - py) * 0.45, Wd * 0.18, (H - py) * 0.12, 0, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(Wd * 0.05, py + (H - py) * 0.45); g.lineTo(Wd * 0.95, py + (H - py) * 0.45); g.stroke();
    for (const [fx, col] of [[0.25, P.primary], [0.75, P.secondary]]) {        // flares
      const gr = g.createRadialGradient(Wd * fx, H * 0.36, 2, Wd * fx, H * 0.36, H * 0.12);
      gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = 0.8; g.fillStyle = gr; g.fillRect(0, 0, Wd, H); g.globalAlpha = 1;
    }
    bigText(text.title || '', H * 0.12, Math.round(H * 0.1), P.light);
    bigText(text.subtitle || '', H * 0.22, Math.round(H * 0.035), P.accent, '"Arial Black", sans-serif');
  } else if (kind === 'trophy') {
    const gr = g.createRadialGradient(Wd / 2, H * 0.45, 10, Wd / 2, H * 0.45, H * 0.7);
    gr.addColorStop(0, mix(P.secondary, '#000000', 0.2)); gr.addColorStop(1, mix(P.secondary, '#000000', 0.85));
    g.fillStyle = gr; g.fillRect(0, 0, Wd, H);
    rays(Wd / 2, H * 0.4, '#ffe9a0');
    const gold = g.createLinearGradient(Wd * 0.3, 0, Wd * 0.7, 0);
    gold.addColorStop(0, '#8a6a12'); gold.addColorStop(0.45, '#ffe28a'); gold.addColorStop(1, '#9c7718');
    const cx = Wd / 2, cy = H * 0.42, r = Wd * 0.2;
    g.fillStyle = gold;
    g.beginPath(); g.moveTo(cx - r, cy - r * 0.9); g.lineTo(cx + r, cy - r * 0.9);
    g.bezierCurveTo(cx + r, cy + r * 0.5, cx + r * 0.3, cy + r * 0.8, cx + r * 0.12, cy + r); g.lineTo(cx - r * 0.12, cy + r);
    g.bezierCurveTo(cx - r * 0.3, cy + r * 0.8, cx - r, cy + r * 0.5, cx - r, cy - r * 0.9); g.fill();
    g.lineWidth = r * 0.12; g.strokeStyle = gold;
    for (const s of [1, -1]) { g.beginPath(); g.arc(cx + s * r * 1.05, cy - r * 0.35, r * 0.38, s > 0 ? -1.6 : 1.6 - Math.PI * 2, s > 0 ? 1.6 : -1.6 - Math.PI); g.stroke(); }
    g.fillRect(cx - r * 0.1, cy + r, r * 0.2, r * 0.5);
    g.fillRect(cx - r * 0.55, cy + r * 1.5, r * 1.1, r * 0.18);
    g.fillStyle = '#2a1d10'; g.fillRect(cx - r * 0.7, cy + r * 1.68, r * 1.4, r * 0.5);
    g.fillStyle = '#f4f4f4';                                                     // a ball at its foot
    g.beginPath(); g.arc(cx + r * 1.15, cy + r * 1.95, r * 0.28, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#222'; g.beginPath(); g.arc(cx + r * 1.15, cy + r * 1.95, r * 0.09, 0, Math.PI * 2); g.fill();
    for (let k = 0; k < 5; k++) { g.fillStyle = P.accent; g.font = `${H * 0.05}px sans-serif`; g.textAlign = 'center'; g.fillText('★', Wd * (0.2 + k * 0.15), H * 0.1); }
    bigText(text.title || '', H * 0.84, Math.round(H * 0.1), P.light);
    bigText(text.subtitle || '', H * 0.93, Math.round(H * 0.035), P.accent, '"Arial Black", sans-serif');
  } else if (kind === 'beach') {
    sky('#7fb6e6', '#f6d9b0');
    g.fillStyle = '#fff3c4'; g.beginPath(); g.arc(Wd * 0.7, H * 0.32, H * 0.07, 0, Math.PI * 2); g.fill();
    const sea = g.createLinearGradient(0, H * 0.48, 0, H * 0.7);
    sea.addColorStop(0, '#1f7fa8'); sea.addColorStop(1, '#5fc9c4');
    g.fillStyle = sea; g.fillRect(0, H * 0.48, Wd, H * 0.24);
    g.fillStyle = 'rgba(255,255,255,0.6)';
    for (let k = 0; k < 4; k++) g.fillRect(0, H * (0.52 + k * 0.045), Wd, 2);
    g.fillStyle = '#ead2a2'; g.beginPath(); g.moveTo(0, H * 0.7);
    g.quadraticCurveTo(Wd * 0.5, H * 0.66, Wd, H * 0.72); g.lineTo(Wd, H); g.lineTo(0, H); g.fill();
    g.strokeStyle = '#3d2f22'; g.lineWidth = Wd * 0.025;                         // a palm
    g.beginPath(); g.moveTo(Wd * 0.2, H * 0.95); g.quadraticCurveTo(Wd * 0.14, H * 0.6, Wd * 0.3, H * 0.33); g.stroke();
    g.fillStyle = '#24442c';
    for (let k = 0; k < 7; k++) {
      const a = -Math.PI + (k / 6) * Math.PI * 1.2 - 0.1;
      g.save(); g.translate(Wd * 0.3, H * 0.33); g.rotate(a);
      g.beginPath(); g.ellipse(Wd * 0.12, 0, Wd * 0.13, Wd * 0.025, 0.25, 0, Math.PI * 2); g.fill(); g.restore();
    }
  } else if (kind === 'mountain') {
    sky('#9cc3e0', '#f2e6d0');
    for (const [col, base, peaks] of [['#8aa1b8', 0.62, 3], ['#5f7a8f', 0.72, 4], ['#3b5266', 0.85, 5]]) {
      g.fillStyle = col; g.beginPath(); g.moveTo(0, H);
      for (let k = 0; k <= peaks; k++) g.lineTo((k / peaks) * Wd, H * (base - (k % 2 ? 0.2 : 0.05)));
      g.lineTo(Wd, H); g.fill();
    }
  } else if (kind === 'neon') {
    g.fillStyle = '#0b0820'; g.fillRect(0, 0, Wd, H);
    g.strokeStyle = P.primary; g.globalAlpha = 0.5; g.lineWidth = 2;
    for (let k = 0; k < 14; k++) {
      g.beginPath(); g.moveTo(Wd / 2, H * 0.55); g.lineTo((k / 13) * Wd * 2 - Wd / 2, H); g.stroke();
      const y = H * 0.55 + (H * 0.45) * (k / 13) ** 2; g.beginPath(); g.moveTo(0, y); g.lineTo(Wd, y); g.stroke();
    }
    g.globalAlpha = 1;
    const sun = g.createLinearGradient(0, H * 0.25, 0, H * 0.55); sun.addColorStop(0, P.accent); sun.addColorStop(1, P.secondary);
    g.fillStyle = sun; g.beginPath(); g.arc(Wd / 2, H * 0.55, Wd * 0.3, Math.PI, 0); g.fill();
    g.shadowColor = P.primary; g.shadowBlur = 20;
    bigText(text.title || 'GAME ON', H * 0.15, Math.round(H * 0.1), '#ffffff');
    g.shadowBlur = 0;
  } else {                                                                      // abstract: mid-century shapes
    g.fillStyle = P.light; g.fillRect(0, 0, Wd, H);
    const cols = [P.primary, P.secondary, P.accent, mix(P.primary, P.light, 0.5)];
    g.fillStyle = cols[0]; g.beginPath(); g.arc(Wd * 0.35, H * 0.35, Wd * 0.25, 0, Math.PI * 2); g.fill();
    g.fillStyle = cols[1]; g.fillRect(Wd * 0.45, H * 0.4, Wd * 0.4, H * 0.35);
    g.fillStyle = cols[2]; g.beginPath(); g.arc(Wd * 0.5, H * 0.85, Wd * 0.3, Math.PI, 0); g.fill();
    g.strokeStyle = cols[3]; g.lineWidth = 8;
    g.beginPath(); g.moveTo(Wd * 0.1, H * 0.7); g.bezierCurveTo(Wd * 0.4, H * 0.55, Wd * 0.6, H * 0.95, Wd * 0.9, H * 0.6); g.stroke();
    if (text.title) bigText(text.title, H * 0.08, Math.round(H * 0.05), '#333', '"Helvetica Neue", Arial, sans-serif');
  }
  grain(g, Wd, H, 2500, 0.03);
  return c;
}

function posterKindFor(text) {
  const t = lower(text);
  if (/jersey|shirt|kit\b|number \d|#\d|cr7|ronaldo|messi|football fan|soccer fan/.test(t)) return 'jersey';
  if (/stadium|pitch|arena|floodlight|match|football|soccer/.test(t)) return 'stadium';
  if (/trophy|cup|medal|champion|ballon/.test(t)) return 'trophy';
  if (/beach|sea|ocean|coast|island|surf|tropical|palm|sunset/.test(t)) return 'beach';
  if (/mountain|alps|hike|forest|lake|landscape/.test(t)) return 'mountain';
  if (/game|gaming|arcade|retro|neon|synth|cyber/.test(t)) return 'neon';
  return 'abstract';
}

// Real people: image models usually refuse a likeness, so ask for a poster *in their style* instead.
const PEOPLE = [
  [/ronaldo|cr7|cristiano/, 'a bold football poster in Cristiano Ronaldo style without showing any person: a red number 7 football jersey on a hanger, a floodlit stadium at night behind it, a gold trophy, Portugal red and green colours, big gold "CR7" lettering'],
  [/messi/, 'a bold football poster without showing any person: a light blue and white striped number 10 jersey on a hanger, a floodlit stadium at night, a gold trophy, big "10" lettering'],
  [/lebron|jordan|kobe|basketball star/, 'a bold basketball poster without showing any person: a jersey on a hanger, a lit arena, a basketball, big number lettering'],
];
function picturePrompt(description, aspect) {
  const d = String(description || 'a calm abstract painting');
  const person = PEOPLE.find(([re]) => re.test(lower(d)));
  const subject = person ? person[1] : d;
  const shape = aspect < 0.9 ? 'portrait (tall) format' : aspect > 1.1 ? 'landscape (wide) format' : 'square format';
  return `Generate an image: ${subject}. Wall art for a framed print, ${shape}, the artwork fills the whole image edge to edge, ` +
    'no frame, no border, no wall, no watermark. No real person\'s face or likeness, no brand logos.';
}

function swapImage(group, url) {
  const img = group.getObjectByName('image');
  if (!img || !group.parent) return Promise.resolve(false);
  return textureFromUrl(url, group.userData.iw / group.userData.ih).then((tex) => {
    if (!group.parent) { tex.dispose(); return false; }
    const old = img.material.map;
    img.material.map = tex; img.material.needsUpdate = true;
    if (old) old.dispose();
    group.userData.generated = true;
    return true;
  }).catch(() => false);
}

function disposeGroup(g) {
  const seen = new Set();
  g.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    if (seen.has(o.material)) return;
    seen.add(o.material);
    if (o.material.map) o.material.map.dispose();
    o.material.dispose();
  });
}

/**
 * Hang one framed picture. opts: { description, face?, u?, v?, width_m, height_m, frame, matte, poster:{kind,pal,text},
 * prompt?, generate=true, tag }. Returns { ok, group, face, say } (no geometry for the model).
 */
function hangOn(face, opts) {
  const w = clamp(Number(opts.width_m) || 0.6, 0.2, 2.5), h = clamp(Number(opts.height_m) || 0.9, 0.2, 2.0);
  const vc = clamp(opts.v != null ? opts.v : EYE, h / 2 + 0.3, 2.45 - h / 2);
  const u = findSpot(face, w + 0.07, h + 0.07, opts.u != null ? opts.u : face.len / 2, vc);
  if (u == null) return null;
  const matte = opts.matte != null ? opts.matte : 0.05;
  const iw = w - 2 * matte, ih = h - 2 * matte;
  const pk = opts.poster || {};
  const c = poster(pk.kind || posterKindFor(opts.description), iw / ih, pk.pal || {}, pk.text || {});
  const group = buildPicture(w, h, { frame: opts.frame || 'black', matte, texture: canvasTexture(c) });
  group.name = 'decor-picture';
  group.userData = { face, u, v: vc, w, h, iw, ih, description: opts.description, tag: opts.tag || null, generated: false };
  placeGroup(group, face, u, vc);
  decorGroup.add(group);
  pictures.push(group);
  if (opts.generate !== false) {
    const prompt = opts.prompt || picturePrompt(opts.description, iw / ih);
    group.userData.prompt = prompt;
    generateImage(prompt).then((url) => url && swapImage(group, url));
  }
  return group;
}

const ABOVE = /\b(above|over)\s+(the\s+)?(bed|sofa|couch|headboard|desk|table|dresser|fireplace)\b/;
const KIND_OF = { bed: ['king', 'queen'], headboard: ['king', 'queen'], sofa: ['sofa'], couch: ['sofa'], desk: ['desk'],
  table: ['table', 'coffeetable', 'sidetable'], dresser: ['tvstand', 'nightstand'] };

/** The piece of furniture an "above the bed" refers to, and the wall face behind it. */
function anchorAbove(word) {
  const w = W(), room = currentRoom();
  const kinds = KIND_OF[word] || [];
  const items = (w.furniture ? w.furniture.children : []).filter((o) => kinds.includes(o.userData.kind)
    && (!room || w.roomAt(o.position.x, o.position.y, o.userData.floor) === room));
  if (!items.length) return null;
  const cur = w.current.pos;
  items.sort((a, b) => Math.hypot(a.position.x - cur[0], a.position.y - cur[1]) - Math.hypot(b.position.x - cur[0], b.position.y - cur[1]));
  const it = items[0], spec = w.FURNITURE[it.userData.kind];
  const c = Math.cos(it.rotation.z), s = Math.sin(it.rotation.z);
  const back = [it.position.x - s * (spec.d / 2), it.position.y + c * (spec.d / 2)];   // local +y is the back
  let best = null;
  for (const f of roomFaces(room)) {
    const u = uOn(f, back[0], back[1]);
    if (u < 0 || u > f.len) continue;
    const dist = Math.abs((back[0] - f.a[0]) * f.normal[0] + (back[1] - f.a[1]) * f.normal[1]);
    if (!best || dist < best.dist) best = { face: f, dist, u: uOn(f, it.position.x, it.position.y), item: it, spec };
  }
  return best && best.dist < 1.0 ? best : null;
}

/** Which wall a hang_picture call means: the words, then what they point at, then straight ahead. */
function chooseFace(where, description) {
  const w = W(), t = lower(`${where || ''} ${description || ''}`);
  const above = ABOVE.exec(t);
  if (above) {
    const a = anchorAbove(above[3]);
    if (a) return { face: a.face, u: a.u, v: a.spec.h + 0.35, above: lower(w.FURNITURE[a.item.userData.kind].name), anchored: true };
  }
  const turn = /\bleft\b/.test(lower(where)) ? Math.PI / 2 : /\bright\b/.test(lower(where)) ? -Math.PI / 2
    : /\b(behind|opposite|back)\b/.test(lower(where)) ? Math.PI : null;
  if (turn != null) {
    const hit = wallInDirection(turn);
    if (hit) { const f = faceInfo(hit.index, hit.normal); return { face: f, u: uOn(f, hit.point[0], hit.point[1]) }; }
  }
  const p = w.pointer;
  if (p && p.type === 'wall' && p.wall) {
    const f = faceFromWall(p.wall);
    return { face: f, u: p.point ? uOn(f, p.point[0], p.point[1]) : f.len / 2 };
  }
  const hit = wallInDirection(0);
  if (hit) { const f = faceInfo(hit.index, hit.normal); return { face: f, u: uOn(f, hit.point[0], hit.point[1]) }; }
  return null;
}

/** hang_picture: a framed picture on the wall the user means, real size, clear of doors and windows. */
export function hangPicture({ description, wall, width_m, height_m, frame } = {}) {
  const w = W();
  if (!w || !w.current) return { ok: false, reason: 'the viewer is not ready' };
  const d = String(description || 'a calm abstract painting');
  const choice = chooseFace(wall, d);
  if (!choice) return { ok: false, reason: 'No wall in front of the user. Ask them to face the wall they mean; this does work.' };
  const wide = /\b(landscape|wide|panorama|panoramic)\b/.test(lower(d)) || choice.anchored;
  const pw = width_m || (wide ? 1.0 : 0.6), ph = height_m || (wide ? 0.65 : 0.9);
  const opts = { description: d, width_m: pw, height_m: ph, frame: frame || (/poster|jersey|football|sport/.test(lower(d)) ? 'black' : 'oak'),
    matte: /poster|jersey|football|sport/.test(lower(d)) ? 0.0 : 0.05 };
  let g = hangOn(choice.face, { ...opts, u: choice.u, v: choice.anchored ? choice.v + ph / 2 : undefined });
  let moved = false;
  if (!g) {                                      // that wall is full or all window: the nearest other wall of the room
    const room = currentRoom();
    const cur = w.current.pos;
    const faces = roomFaces(room).filter((f) => f.index !== choice.face.index)
      .sort((a, b) => Math.hypot((a.a[0] + a.b[0]) / 2 - cur[0], (a.a[1] + a.b[1]) / 2 - cur[1])
        - Math.hypot((b.a[0] + b.b[0]) / 2 - cur[0], (b.a[1] + b.b[1]) / 2 - cur[1]));
    for (const f of faces) { g = hangOn(f, opts); if (g) { moved = true; break; } }
  }
  if (!g) return { ok: false, reason: 'There is no free wall space here clear of doors and windows. Try another wall.' };
  const size = `${g.userData.w.toFixed(1)} by ${g.userData.h.toFixed(1)} m`;
  return { ok: true, hung: d, size, wall: moved ? 'the nearest free wall (the one asked for was blocked by a door or window)'
    : choice.above ? `above the ${choice.above}` : 'the wall the user faces', centre_height_m: +g.userData.v.toFixed(2),
  pictures_on_walls: pictures.length,
  note: 'A drawn version is up now; the artwork sharpens in a few seconds when the image arrives.' };
}

// ------------------------------------------------------------------ furniture colours (local tint unless set_furniture_color exists)
const tinted = new Map();   // item -> { fabric, fabricLt, fabricDk }
function tintMesh(o, map) {
  const name = (o.userData.decorOrig || o.material).name || '';
  const part = o.userData.hero ? 'fabric' : (name.split(':')[0] || '');
  const col = map[part];
  if (!col || !o.material || !o.material.color) return;
  if (!o.userData.decorOrig) o.userData.decorOrig = o.material;
  if (o.material.userData && o.material.userData.decor === col) return;
  const m = o.userData.decorOrig.clone();
  m.color = new THREE.Color(col);
  m.userData = { decor: col };
  o.material = m;
}
function tintItem(item, map) {
  tinted.set(item, map);
  item.traverse((o) => { if (o.isMesh) tintMesh(o, map); });
}
function untintAll() {
  for (const item of tinted.keys()) {
    item.traverse((o) => {
      if (o.isMesh && o.userData.decorOrig) { if (o.material !== o.userData.decorOrig) o.material.dispose(); o.material = o.userData.decorOrig; delete o.userData.decorOrig; }
    });
  }
  const n = tinted.size;
  tinted.clear();
  return n;
}
// a model that swaps in after the tint (kit -> hero) comes in untinted: keep re-applying for a while
setInterval(() => { for (const [item, map] of tinted) { if (item.parent) item.traverse((o) => { if (o.isMesh) tintMesh(o, map); }); else tinted.delete(item); } }, 1000);

async function colourItem(item, map) {
  const run = W().agent && W().agent.tools && W().agent.tools.set_furniture_color;
  if (typeof run === 'function') {
    try {
      const r = await run({ kind: item.userData.kind, color: map.fabric, colour: map.fabric });
      if (r && r.ok) return;
    } catch (e) { /* fall through to the local tint */ }
  }
  tintItem(item, map);
}

// ------------------------------------------------------------------ themes
// accent: the feature wall; soft: the other walls; bed/sofa/rug colours; frame; three posters (procedural kind +
// text, and the prompt for the generated version).
const THEMES = [
  { re: /ronaldo|cr7|cristiano|portugal|al nassr|seleç|selec/, name: 'Ronaldo fan',
    accent: '#a5121c', soft: '#f1ebe0', pal: { primary: '#b0121e', secondary: '#1e6b3a', accent: '#d4af37', dark: '#0e1412' },
    bed: { fabric: '#b0121e', fabricLt: '#f2efe6', fabricDk: '#1e6b3a' }, sofa: '#b0121e', rug: '#1f6b3a', frame: 'gold', style: 'modern',
    posters: [
      { kind: 'jersey', text: { name: 'RONALDO', number: 7, title: 'CR7', subtitle: 'SIUUU' },
        prompt: 'a red football jersey with the number 7 and the name RONALDO in gold on the back, on a hanger in a dark locker room with a dramatic spotlight, big gold "CR7" lettering at the bottom' },
      { kind: 'stadium', text: { title: 'PORTUGAL', subtitle: 'FORÇA' },
        prompt: 'a packed football stadium at night seen from the stands, floodlights, red and green flares and flags in Portugal colours, poster art with the word PORTUGAL across the top' },
      { kind: 'trophy', text: { title: 'CHAMPION', subtitle: '5 X BALLON D\'OR' },
        prompt: 'a gold football trophy and a classic football on a dark green velvet pedestal, dramatic gold light rays, poster art with gold stars and the word CHAMPION' },
    ] },
  { re: /real madrid|madridista|bernab/, name: 'Real Madrid fan',
    accent: '#1c2a5a', soft: '#f4f1ea', pal: { primary: '#f4f4f4', secondary: '#1c2a5a', accent: '#d4af37', dark: '#0d1430', light: '#ffffff' },
    bed: { fabric: '#f2f2f2', fabricLt: '#d4af37', fabricDk: '#1c2a5a' }, sofa: '#1c2a5a', rug: '#f0ede4', frame: 'gold', style: 'modern',
    posters: [
      { kind: 'jersey', text: { name: 'MADRID', number: 7, title: 'HALA MADRID' }, prompt: 'an all-white football jersey with gold trim and the number 7 on a hanger, dramatic spotlight, navy background, big gold "HALA MADRID" lettering' },
      { kind: 'stadium', text: { title: 'MADRID' }, prompt: 'a huge football stadium at night with white and purple flags and floodlights, poster art' },
      { kind: 'trophy', text: { title: 'CHAMPIONS' }, prompt: 'a big silver European football cup trophy with confetti, navy and gold poster art' },
    ] },
  { re: /man(chester)? ?u(nited|td)?\b|red devils|old trafford/, name: 'Manchester United fan',
    accent: '#c8102e', soft: '#f2ede4', pal: { primary: '#c8102e', secondary: '#111111', accent: '#f2c018', dark: '#0a0a0a' },
    bed: { fabric: '#c8102e', fabricLt: '#f2efe6', fabricDk: '#111111' }, sofa: '#1a1a1a', rug: '#c8102e', frame: 'black', style: 'modern',
    posters: [
      { kind: 'jersey', text: { name: 'UNITED', number: 7, title: 'RED DEVILS' }, prompt: 'a red football jersey with the number 7 on a hanger, black background, yellow accents, big "RED DEVILS" lettering' },
      { kind: 'stadium', text: { title: 'THEATRE OF DREAMS' }, prompt: 'an English football stadium at night, red seats, floodlights, red flares, poster art' },
      { kind: 'trophy', text: { title: 'GLORY GLORY' }, prompt: 'a gold football trophy with red ribbons on a black background, poster art' },
    ] },
  { re: /messi|argentina|barcelona|barça|barca/, name: 'Messi fan',
    accent: '#6cace4', soft: '#f4f2ec', pal: { primary: '#75aadb', secondary: '#ffffff', accent: '#f6b40e', dark: '#0d1b2e', light: '#ffffff' },
    bed: { fabric: '#75aadb', fabricLt: '#ffffff', fabricDk: '#1d3557' }, sofa: '#75aadb', rug: '#f4f2ec', frame: 'white', style: 'scandi',
    posters: [
      { kind: 'jersey', text: { name: 'MESSI', number: 10, title: 'GOAT' }, prompt: 'a light blue and white striped football jersey with the number 10 on a hanger, spotlight, big gold "10" lettering' },
      { kind: 'stadium', text: { title: 'VAMOS' }, prompt: 'a football stadium at night with light blue and white flags and confetti, poster art' },
      { kind: 'trophy', text: { title: 'CAMPEONES' }, prompt: 'a gold world football trophy with light blue and white confetti, poster art' },
    ] },
  { re: /football|soccer|sport/, name: 'football fan',
    accent: '#1f5f3a', soft: '#f1ede4', pal: { primary: '#1f5f3a', secondary: '#f4f4f4', accent: '#d4af37', dark: '#0d1510' },
    bed: { fabric: '#1f5f3a', fabricLt: '#f2efe6', fabricDk: '#222222' }, sofa: '#2b2b2b', rug: '#1f6b3a', frame: 'black', style: 'modern',
    posters: [
      { kind: 'stadium', text: { title: 'MATCH DAY' }, prompt: 'a football stadium at night with floodlights, poster art, the words MATCH DAY' },
      { kind: 'jersey', text: { number: 10, title: 'TEAM' }, prompt: 'a green football jersey with the number 10 on a hanger, spotlight, poster art' },
      { kind: 'trophy', text: { title: 'CHAMPIONS' }, prompt: 'a gold football trophy, dramatic light, poster art' },
    ] },
  { re: /gam(e|ing|er)|esport|arcade|neon|cyber/, name: 'gaming',
    accent: '#2a1b4a', soft: '#e9e6ef', pal: { primary: '#ff2bd6', secondary: '#2bd9ff', accent: '#ffd23f', dark: '#0b0820' },
    bed: { fabric: '#2a1b4a', fabricLt: '#2bd9ff', fabricDk: '#ff2bd6' }, sofa: '#2a1b4a', rug: '#ff2bd6', frame: 'black', style: 'modern',
    posters: [
      { kind: 'neon', text: { title: 'GAME ON' }, prompt: 'a retro synthwave poster, neon grid, sunset, the words GAME ON' },
      { kind: 'neon', text: { title: 'PLAYER 1' }, prompt: 'pixel-art arcade poster with a game controller and neon colours, the words PLAYER 1' },
      { kind: 'abstract', text: {}, prompt: 'abstract neon geometric art, magenta and cyan on dark purple' },
    ] },
  { re: /beach|coast|seaside|nautical|ocean|surf/, name: 'beach house',
    accent: '#5f9ea8', soft: '#f3efe5', pal: { primary: '#2f7f9a', secondary: '#e9d3a6', accent: '#f2a65a', light: '#f7f3ea' },
    bed: { fabric: '#e9f1f3', fabricLt: '#ffffff', fabricDk: '#2f7f9a' }, sofa: '#e7dfcf', rug: '#d8c7a3', frame: 'white', style: 'scandi',
    posters: [
      { kind: 'beach', prompt: 'a sunny tropical beach with turquoise water and a palm tree, soft painterly travel poster' },
      { kind: 'beach', prompt: 'calm ocean waves at sunset, watercolour' },
      { kind: 'abstract', prompt: 'minimal coastal abstract art, sand, sea blue and coral shapes' },
    ] },
  { re: /scandi|nordic|hygge|minimal/, name: 'Scandinavian',
    accent: '#a7b6a3', soft: '#f3f1ec', pal: { primary: '#a7b6a3', secondary: '#d9c7a7', accent: '#3f4144', light: '#f6f4ef' },
    bed: { fabric: '#e6e2d9', fabricLt: '#ffffff', fabricDk: '#a7b6a3' }, sofa: '#cfcac0', rug: '#e8e2d6', frame: 'oak', style: 'scandi',
    posters: [
      { kind: 'abstract', prompt: 'minimal Scandinavian line-and-shape art in sage, sand and charcoal' },
      { kind: 'mountain', prompt: 'a calm Nordic mountain lake landscape, muted colours, minimalist print' },
      { kind: 'abstract', prompt: 'a single botanical line drawing on off-white paper' },
    ] },
  { re: /cos(y|ie)|warm|cottage|rustic|autumn/, name: 'cosy',
    accent: '#a0583c', soft: '#efe4d2', pal: { primary: '#a0583c', secondary: '#d8b384', accent: '#5c3b25', light: '#f5ecdc' },
    bed: { fabric: '#b9774f', fabricLt: '#efe2cc', fabricDk: '#5c3b25' }, sofa: '#8a5a3c', rug: '#c8a27a', frame: 'walnut', style: 'cozy',
    posters: [
      { kind: 'mountain', prompt: 'a cosy autumn forest cabin landscape, warm painterly print' },
      { kind: 'abstract', prompt: 'warm terracotta and mustard mid-century abstract art' },
      { kind: 'abstract', prompt: 'a vintage botanical print of autumn leaves' },
    ] },
];
const DEFAULT_THEME = THEMES.find((t) => t.name === 'Scandinavian');

/** A theme from the built-in map, or one made from colours the model passes for anything else. */
function resolveTheme(theme, palette, posterIdeas) {
  const t = lower(theme);
  const known = THEMES.find((x) => x.re.test(t));
  if (known) return known;
  const cols = (palette || []).map(toHex).filter(Boolean).concat(coloursIn(t));
  const base = DEFAULT_THEME;
  if (!cols.length) return { ...base, name: theme || base.name, posters: posterIdeasFor(theme, posterIdeas, base) };
  const [p, s = mix(p, '#ffffff', 0.6), a = mix(p, '#000000', 0.4)] = cols;
  return { name: theme, accent: p, soft: mix(p, '#f4f1ea', 0.88), pal: { primary: p, secondary: s, accent: a },
    bed: { fabric: p, fabricLt: mix(s, '#ffffff', 0.5), fabricDk: a }, sofa: p, rug: s, frame: luma(p) < 0.4 ? 'gold' : 'black',
    style: 'modern', posters: posterIdeasFor(theme, posterIdeas, base) };
}
function posterIdeasFor(theme, ideas, base) {
  const list = (Array.isArray(ideas) && ideas.length ? ideas : [`${theme}, poster art`, `${theme}, abstract art print`])
    .slice(0, 3).map((d) => ({ kind: posterKindFor(d), text: {}, prompt: d }));
  return list.length ? list : base.posters;
}

const added = [];   // furniture decorate_room added (so remove_decor can take it away)
const painted = []; // walls decorate_room / set_wall_material painted: { floor, index, a, b, normal }

async function paintFace(face, url, tile) {
  const wall = { floor: face.floor, index: face.index, a: face.a, b: face.b, normal: face.normal };
  const r = await W().setWallMaterial(wall, url, tile);
  if (r && r.ok) painted.push(wall);
  return r;
}

/** decorate_room: a themed makeover of the room the user is in, in one call, all procedural first. */
export async function decorateRoom({ theme, palette, poster_ideas } = {}) {
  const w = W(), t0 = performance.now();
  const room = currentRoom();
  if (!room) return { ok: false, reason: 'Stand inside a room first (the user is between rooms).' };
  const T = resolveTheme(theme, palette, poster_ideas);
  const faces = roomFaces(room);
  // a second makeover replaces the first one's posters instead of stacking more (the user's own pictures stay)
  for (const g of pictures.filter((p) => p.userData.tag === 'theme' && faces.some((f) => f.index === p.userData.face.index))) {
    pictures.splice(pictures.indexOf(g), 1); decorGroup.remove(g); disposeGroup(g);
  }
  const done = [];

  // 1. walls: the one they face is the accent (else the longest, emptiest); soft colour on the rest
  const pw = w.pointer && w.pointer.type === 'wall' && w.pointer.wall;
  const ahead = pw ? { index: pw.index } : wallInDirection(0);
  const holeLen = (f) => f.holes.reduce((s, h) => s + (h.u1 - h.u0), 0);
  let accent = ahead && faces.find((f) => f.index === ahead.index);
  if (!accent || accent.len - holeLen(accent) < 1.5) accent = [...faces].sort((a, b) => (b.len - holeLen(b)) - (a.len - holeLen(a)))[0];
  const accentTile = PATTERNS.paint({ bg: T.accent }).c.toDataURL('image/png');
  // a swatch colour shown at full strength glows next to the photo's walls (they sit in room light), so the
  // big soft walls go a little greyer; the accent stays saturated on purpose
  const softTile = PATTERNS.paint({ bg: mix(T.soft, '#77726a', 0.2) }).c.toDataURL('image/png');
  if (typeof w.setWallMaterial === 'function') {
    for (const f of faces) {
      try { await paintFace(f, f === accent ? accentTile : softTile, 1); } catch (e) { console.warn('[decor] wall failed', e); }
    }
    done.push(`a ${colourName(T.accent)} accent wall and soft ${colourName(T.soft)} on the other ${faces.length - 1}`);
  }

  // 2. furniture: stage an empty room first, then recolour the bed, sofa and rug
  const inRoom = () => w.furniture.children.filter((o) => o.userData.kind && w.roomAt(o.position.x, o.position.y, o.userData.floor) === room);
  const before = new Set(w.furniture.children);
  if (!inRoom().length && typeof w.stageRoom === 'function' && /bed|living|family|den|room|office|study/i.test(room.label || '')) {
    try { await w.stageRoom(room.id, T.style || 'modern'); } catch (e) { console.warn('[decor] staging failed', e); }
  }
  if (typeof w.placeObject === 'function') {
    const kinds = () => inRoom().map((o) => o.userData.kind);
    const centre = room.poly && room.poly.length
      ? room.poly.reduce((s, p) => [s[0] + p[0] / room.poly.length, s[1] + p[1] / room.poly.length], [0, 0]) : null;
    if (!kinds().some((k) => k === 'rug' || k === 'ruground')) {
      try { if (centre) w.placeObject('rug', centre[0], centre[1], { onFloor: true }); } catch (e) { /* no room for a rug */ }
    }
    if (!kinds().some((k) => /plant|cactus/.test(k))) { try { w.placeObject('plant'); } catch (e) { /* fine */ } }
  }
  for (const o of w.furniture.children) if (!before.has(o)) added.push(o);
  const recoloured = [];
  for (const it of inRoom()) {
    const k = it.userData.kind;
    if (k === 'king' || k === 'queen') { await colourItem(it, T.bed); recoloured.push('bed'); }
    else if (k === 'sofa' || k === 'armchair') { await colourItem(it, { fabric: T.sofa, fabricLt: mix(T.sofa, '#ffffff', 0.5), fabricDk: mix(T.sofa, '#000000', 0.4) }); recoloured.push(k); }
    else if (k === 'rug' || k === 'ruground') { await colourItem(it, { fabric: T.rug, fabricLt: T.rug, fabricDk: mix(T.rug, '#000000', 0.3) }); recoloured.push('rug'); }
  }
  if (recoloured.length) done.push(`the ${[...new Set(recoloured)].join(', ')} in ${T.name} colours`);
  if (w.select) w.select(null);

  // 3. pictures: a gallery of three on the accent wall (big one in the middle), else wherever there is room
  const hung = [];
  if (accent) {
    const posters = T.posters.slice(0, 3);
    const sizes = [[0.6, 0.85], [0.42, 0.6], [0.42, 0.6]];
    const mid = accent.len / 2;
    const bed = anchorAbove('bed');
    const span = 0.63 + 0.21 + 0.06;                // centre of the gallery to the outer edge of a side frame
    let centreU = bed && bed.face.index === accent.index ? bed.u : mid;
    if (accent.len - 0.5 > 2 * span) centreU = clamp(centreU, 0.25 + span, accent.len - 0.25 - span);
    const centreV = bed && bed.face.index === accent.index ? Math.max(EYE, bed.spec.h + 0.35 + 0.85 / 2) : EYE;
    const spots = [[centreU, centreV], [centreU - 0.63, centreV], [centreU + 0.63, centreV]];
    posters.forEach((p, i) => {
      const [pw, ph] = sizes[i];
      const opts = { description: p.prompt, width_m: pw, height_m: ph, frame: T.frame, matte: i === 0 ? 0 : 0.03,
        poster: { kind: p.kind, pal: T.pal, text: p.text || {} }, prompt: picturePrompt(p.prompt, (pw - 0.06) / (ph - 0.06)), tag: 'theme' };
      let g = hangOn(accent, { ...opts, u: spots[i][0], v: spots[i][1] });
      if (!g) for (const f of faces) { if (f !== accent && (g = hangOn(f, opts))) break; }
      if (g) hung.push(p.kind);
    });
  }
  if (hung.length) done.push(`${hung.length} framed poster${hung.length > 1 ? 's' : ''} (${hung.join(', ')})`);

  const ms = Math.round(performance.now() - t0);
  return { ok: true, theme: T.name, room: room.label, seconds: +(ms / 1000).toFixed(1), did: done,
    say: `Done: ${done.join('; ')}. The posters sharpen in a few seconds as the artwork arrives.` };
}

function colourName(hex) {
  let best = null, bd = Infinity;
  const [r, g, b] = rgb(hex);
  for (const [n, h] of Object.entries(NAMED)) {
    if (/gray|golden/.test(n)) continue;
    const [x, y, z] = rgb(h), d = (r - x) ** 2 + (g - y) ** 2 + (b - z) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best || 'colour';
}

/** remove_decor: take pictures, wall colour, theme furniture and tints back off. */
export function removeDecor({ what = 'pictures' } = {}) {
  const w = W(), t = lower(what);
  const all = /all|every|everything|reset|undo|theme|makeover|decor/.test(t);
  const out = [];
  if (all || /pic|poster|frame|art|photo|print/.test(t)) {
    const n = pictures.length;
    for (const g of pictures.splice(0)) { decorGroup.remove(g); disposeGroup(g); }
    out.push(`${n} picture${n === 1 ? '' : 's'}`);
  }
  if (all || /wall|paint|paper/.test(t)) {
    const n = typeof w.clearAllWallMaterials === 'function' ? w.clearAllWallMaterials() : 0;
    painted.length = 0;
    out.push(`${n} wall finish${n === 1 ? '' : 'es'}`);
  }
  if (all || /colou?r|tint|furniture/.test(t)) out.push(`colours on ${untintAll()} pieces`);
  if (all || /furniture|bed|sofa|rug|plant/.test(t)) {
    let n = 0;
    for (const o of added.splice(0)) if (o.parent) { o.parent.remove(o); n++; }
    if (n) out.push(`${n} added piece${n === 1 ? '' : 's'}`);
  }
  if (w.select) w.select(null);
  return { ok: true, removed: out, say: out.length ? `Removed ${out.join(', ')}.` : 'Nothing to remove.' };
}

// ------------------------------------------------------------------ set_wall_material, replacing agent.js's version
const wallJobs = new Map();   // wall key -> the url we put up, so a late generated tile only replaces our own
export async function setWallFinish({ description, tile_metres, pattern, colors } = {}) {
  const w = W(), pointed = w.pointer && w.pointer.type === 'wall' && w.pointer.wall;
  if (typeof w.setWallMaterial !== 'function') return { ok: false, reason: 'walls are not loaded yet' };
  const wall = pointed || (w.wallAhead && w.wallAhead());
  if (!wall) return { ok: false, reason: 'No wall in front of the user. Ask them to face the wall they mean; this does work.' };
  const d = String(description || 'wallpaper');
  let tile = patternTile(d, { pattern, colors });
  // paint and named patterns are exact; anything else (floral photo-real, "art deco gold") gets the closest
  // drawn pattern now and the generated design when it arrives
  const exact = tile && (tile.kind === 'paint' || tile.kind === 'bundled' || pattern
    || /stripe|pinstripe|check|gingham|plaid|polka|dot|herringbone|chevron/.test(lower(d)));
  if (!tile) tile = patternTile(`${d} damask`, { colors });            // no colour, no pattern: a classic damask
  const r = await w.setWallMaterial(wall, tile.url, tile.kind === 'bundled' ? (tile_metres || tile.tile) : tile.tile);
  if (!r || !r.ok) return { ok: false, reason: (r && r.why) || 'that wall could not be covered' };
  painted.push({ ...wall });
  const key = `${wall.floor}|${wall.index}`;
  wallJobs.set(key, tile.url);
  let upgrading = false;
  if (!exact) {
    upgrading = true;
    const prompt = `Generate an image: an original wallpaper design, ${d}, a repeating pattern, a flat straight-on scan of the paper filling the whole square, even light, no room, no furniture, no text.`;
    generateImage(prompt).then(async (url) => {
      if (!url || wallJobs.get(key) !== tile.url) return;            // failed, or the wall was changed since
      const seamless = await mirroredTile(url);
      const t2 = 2 * clamp(Number(tile_metres) || 0.6, 0.3, 1.5);
      const r2 = await w.setWallMaterial(wall, seamless, t2);
      if (r2 && r2.ok) wallJobs.set(key, seamless);
    }).catch((e) => console.warn('[decor] generated wallpaper failed', e));
  }
  return { ok: true, material: d, finish: tile.kind === 'paint' ? 'paint' : tile.kind === 'bundled' ? 'bundled tile' : `${tile.kind} pattern`,
    colours: tile.colours.map(colourName), wall: pointed ? 'the wall the user points at' : 'the wall straight ahead',
    area_m2: r.area, room: r.room,
    note: upgrading ? 'A drawn pattern is up now; a generated design replaces it in a few seconds if the image model answers.' : undefined };
}

// ------------------------------------------------------------------ registration
const declarations = [
  { name: 'set_wall_material',
    description: 'Paint or paper the wall the user points at or faces: plain paint in any colour, wallpaper patterns (stripes, pinstripe, checks/gingham, polka dots, herringbone, chevron, damask, floral, leaves, art deco), brick, tiles or wood. Use it for ANY request to paint, paper or recolour one wall. It always works and is instant.',
    parameters: { type: 'object', properties: {
      description: { type: 'string', description: 'What the wall should look like, in the user\'s words, e.g. "sage green paint", "striped navy wallpaper", "gold damask on deep green".' },
      pattern: { type: 'string', description: 'Optional: paint, stripes, pinstripe, checks, polka, herringbone, chevron, damask, floral, leaves or scallop.' },
      colors: { type: 'array', items: { type: 'string' }, description: 'Optional colours as names or #hex, pattern colour first, background second.' },
      tile_metres: { type: 'number', description: 'Optional real size of one repeat in metres (bricks ~0.9). Leave out for paint and patterns.' } },
      required: ['description'] } },
  { name: 'hang_picture',
    description: 'Hang a framed picture, poster, print or photo on a wall, real size, at eye height, clear of doors and windows. It goes on the wall the user points at or faces, or above the bed/sofa if they say so. The artwork is generated from the description (a drawn version shows at once).',
    parameters: { type: 'object', properties: {
      description: { type: 'string', description: 'What the picture shows, e.g. "a beach at sunset", "a Ronaldo poster". For real people describe a poster in their style without their face (e.g. a red number 7 jersey, a stadium, a trophy).' },
      wall: { type: 'string', description: 'Optional: "above the bed", "above the sofa", "left", "right", "behind". Empty = the wall the user faces.' },
      width_m: { type: 'number', description: 'Optional width in metres (default 0.6, or 1.0 for a wide one).' },
      height_m: { type: 'number', description: 'Optional height in metres (default 0.9, or 0.65 for a wide one).' },
      frame: { type: 'string', description: 'Optional frame: black, gold, oak, walnut, white or silver.' } },
      required: ['description'] } },
  { name: 'decorate_room',
    description: 'Decorate the room the user is in for a theme in one go: a feature wall in the theme colour and soft colour on the others, a gallery of 1-3 framed themed posters, the bed and sofa recoloured in the theme colours (furnished first if the room is empty), a rug and a plant. Use it for "decorate this room as …", "make it a Ronaldo fan\'s room", "give this room a beach / cosy / gaming / Scandinavian look". Returns a summary to speak.',
    parameters: { type: 'object', properties: {
      theme: { type: 'string', description: 'The theme in the user\'s words, e.g. "Ronaldo fan", "Real Madrid", "beach house", "cosy", "gaming", "Scandinavian".' },
      palette: { type: 'array', items: { type: 'string' }, description: 'Optional for themes not listed above: 2-3 colours (#hex or names), main colour first.' },
      poster_ideas: { type: 'array', items: { type: 'string' }, description: 'Optional for themes not listed above: up to 3 short picture descriptions (no real faces).' } },
      required: ['theme'] } },
  { name: 'remove_decor',
    description: 'Take decor back off: the pictures/posters, the wall paint and wallpaper, the furniture colours, or all of it (the whole themed makeover).',
    parameters: { type: 'object', properties: {
      what: { type: 'string', description: 'pictures, walls, colours, furniture or all.' } },
      required: ['what'] } },
];

const rules = `- Paint or wallpaper on a wall ("paint this wall sage green", "striped navy wallpaper") -> set_wall_material once, with pattern and colors when the user names them.
- "Decorate this room as / for / like a …", a theme or a fan room ("as if I'm a Ronaldo fan") -> decorate_room with that theme, once, nothing else; then say its summary in one or two sentences.
- "Put up / hang a poster, frame, picture, print or photo" -> hang_picture. For a real person, describe a poster in their style (jersey, number, stadium, trophy) without their face. Never refuse a decor request.
- "Remove / take down the pictures" -> remove_decor with what="pictures"; "undo the makeover" -> what="all".`;

(window.walkinTools = window.walkinTools || []).push({
  declarations,
  run: {
    set_wall_material: (a) => setWallFinish(a || {}),
    hang_picture: (a) => hangPicture(a || {}),
    decorate_room: (a) => decorateRoom(a || {}),
    remove_decor: (a) => removeDecor(a || {}),
  },
  rules,
});

(function start(tries = 0) {
  const w = window.walkin;
  if (!w || !w.scene) { if (tries < 600) setTimeout(() => start(tries + 1), 200); return; }
  w.scene.add(decorGroup);
  w.decor = { pictures, hangPicture, decorateRoom, removeDecor, patternTile, setWallFinish, generateImage, imageStats,
    themes: () => THEMES.map((t) => t.name) };
})();
