// "What would look good in this room?" — John furnishes the room to suit it and shows what it would cost.
// Deterministic, so it is one quick tool call (typed and Gemini Live):
//   style  from the listing (era / architectural style) and the room's window light,
//   set    from staging.js (stageRoom: the room type's set, fitted against walls and doorways),
//   prices from a fixed catalogue of illustrative mid-market estimates (not quotes), in 3 tiers,
//   tags   floating price labels in the 3D scene (both eyes in the headset) plus a room total.
// The pieces drop in one after another so the room furnishes itself while John talks.
//   walkin.suggest.suggestRoom({ room, tier, budget })  -> plain facts for the agent
//   walkin.suggest.tagHouse()                           -> total for everything placed (after stage_house)
//   walkin.suggest.showTags(on) / walkin.suggest.clearTags()
// Nothing here edits staging.js or furniture.js: it stages through walkin.stageRoom, then reads the room.
import * as THREE from 'three';

// ------------------------------------------------------------------ catalogue (USD, illustrative estimates)
export const PRICE_NOTE = 'illustrative mid-market retail estimates, Nov 2026, not quotes';
const MID = { sofa: 1299, armchair: 649, queen: 899, king: 1199, table: 899, desk: 499, chair: 179, nightstand: 229,
  sidetable: 149, coffeetable: 399, tvstand: 449, tv: 599, bookcase: 299, floorlamp: 159, rug: 349, ruground: 299,
  plant: 89, plantsmall: 39, plantfern: 35, plantsucculent: 29, cactus: 45, cactustall: 69, pouf: 129, console: 349 };
const TIER_MULT = { budget: 0.45, mid: 1, premium: 2.4 };
export const TIERS = ['budget', 'mid', 'premium'];
const round9 = (x) => Math.max(9, Math.round(x / 10) * 10 - 1);            // $1,299 style
export function priceOf(kind, tier = 'mid') {
  const base = MID[kind];
  if (base == null) return null;
  return tier === 'mid' ? base : round9(base * (TIER_MULT[tier] || 1));
}
const OPTIONAL = ['plantsmall', 'plantfern', 'plantsucculent', 'cactus', 'cactustall', 'plant', 'floorlamp', 'tv',
  'sidetable', 'bookcase', 'armchair', 'ruground', 'rug'];                   // dropped first when over budget
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

// ------------------------------------------------------------------ what suits this house
function paletteFor(listing, light) {
  const st = String((listing && listing.style) || '').toLowerCase();
  const year = Number(listing && listing.year_built) || null;
  if (/bungalow|craftsman|victorian|tudor|colonial|cottage|farmhouse|ranch|spanish|mission/.test(st) || (year && year < 1950)) {
    return { palette: 'cozy', why: `a ${year ? `${year} ` : ''}${listing.style || 'period home'}, so a warm, classic set` };
  }
  if (/modern|contemporary|minimal|loft/.test(st)) return { palette: 'modern', why: `a ${listing.style.toLowerCase()} home, so a simple, modern set` };
  if (light === 'bright') return { palette: 'scandi', why: 'a bright room, so a light, soft set' };
  return { palette: 'modern', why: 'a simple, modern set' };
}

// ------------------------------------------------------------------ price tags (3D sprites, readable per eye)
const tags = new Map();            // item -> sprite
let totalTag = null, totalRoom = null, shown = true, hooked = false;
const W = () => window.walkin;

function makeTag(text, { big = false } = {}) {
  const c = document.createElement('canvas');
  c.width = big ? 1024 : 640; c.height = big ? 200 : 160;              // 2x, so text stays sharp at a lowered pixel ratio
  const g = c.getContext('2d'), r = c.height / 2;
  g.fillStyle = big ? 'rgba(20,22,28,0.82)' : 'rgba(24,26,32,0.74)';
  g.beginPath(); g.roundRect(4, 4, c.width - 8, c.height - 8, r - 4); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 3; g.stroke();
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `600 ${big ? 76 : 64}px system-ui, -apple-system, "SF Pro Text", sans-serif`;
  g.fillText(text, c.width / 2, c.height / 2 + 3);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  const s = new THREE.Sprite(mat);
  const hM = big ? 0.15 : 0.1;                                            // ~10 cm tall text: readable at 2-3 m per eye
  s.scale.set(hM * c.width / c.height, hM, 1);
  s.userData.size = [hM * c.width / c.height, hM];                        // world size near by; hook() grows it far away
  s.renderOrder = 55;                                                     // under the radial menu (60)
  s.raycast = () => {};                                                   // pointing and grabbing ignore the tags
  s.userData.priceTag = true;
  return s;
}

function disposeTag(s) {
  if (!s) return;
  if (s.parent) s.parent.remove(s);
  s.material.map.dispose(); s.material.dispose();
}

export function clearTags() {
  for (const [, s] of tags) disposeTag(s);
  tags.clear();
  disposeTag(totalTag); totalTag = null; totalRoom = null;
}

function tagItem(item, price) {
  const old = tags.get(item); if (old) disposeTag(old);
  const spec = (W().FURNITURE || {})[item.userData.kind] || {};
  const s = makeTag(`${spec.name || item.userData.kind} · ${usd(price)}`);
  // In the scene, not a child of the piece: Box3.setFromObject counts children, and app.js uses that box for the
  // hand grab and the selection box. hook() moves the tag onto its piece every frame (follows a drag, goes on delete).
  s.userData.lift = spec.flat ? 0.35 : (spec.h || 0.8) + 0.22;
  W().scene.add(s);
  item.userData.price = price;
  tags.set(item, s);
}

function hook() {
  if (hooked || !W().beforeRender) return;
  hooked = true;
  const cam = new THREE.Vector3(), fwd = new THREE.Vector3(), p = new THREE.Vector3();
  // same apparent size past 2.2 m (tags sit in the scene, so this is their world size)
  const fit = (s, d) => {
    const k = Math.max(1, d / 2.2), [sw, sh] = s.userData.size;
    s.scale.set(sw * k, sh * k, 1);
  };
  W().beforeRender.add(() => {
    const w = W(), cur = w.current;
    if (!cur) return;
    const here = w.roomAt(cur.pos[0], cur.pos[1], cur.floor);
    w.camera.getWorldPosition(cam); w.camera.getWorldDirection(fwd);
    const near = [];
    for (const [item, s] of tags) {
      if (!item.parent) { disposeTag(s); tags.delete(item); continue; }   // deleted piece
      item.getWorldPosition(p); p.z += s.userData.lift; s.position.copy(p);
      const inRoom = w.roomAt(item.position.x, item.position.y, item.userData.floor) === here;
      const d = p.distanceTo(cam), ahead = p.clone().sub(cam).dot(fwd) > 0;
      s.visible = false;
      fit(s, d);
      if (shown && inRoom && item.visible && d < 7) near.push([d + (ahead ? 0 : 100), s]);   // pieces in view win the 8 slots
    }
    near.sort((a, b) => a[0] - b[0]).slice(0, 8).forEach(([, s]) => { s.visible = true; });   // max 8: no clutter
    if (totalTag) { totalTag.visible = shown && totalRoom === here; fit(totalTag, totalTag.getWorldPosition(p).distanceTo(cam)); }
  });
}

export function showTags(on = !shown) { shown = !!on; return shown; }

// ------------------------------------------------------------------ the room furnishes itself
function dropIn(items) {
  const t0 = performance.now(), D = 380, GAP = 130, H = 0.45;
  const state = items.map((it, i) => ({ it, z: it.position.z, start: t0 + i * GAP, rug: !!((W().FURNITURE[it.userData.kind] || {}).flat) }));
  for (const s of state) { s.it.visible = false; }
  const step = () => {
    const now = performance.now();
    let busy = false;
    for (const s of state) {
      const k = (now - s.start) / D;
      if (k < 0) { busy = true; continue; }
      s.it.visible = true;
      if (k >= 1) { if (!s.done) { s.it.position.z = s.z; if (s.rug) s.it.scale.y = 1; s.done = true; } continue; }
      busy = true;
      const e = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);   // ease-out with a small overshoot
      if (s.rug) { s.it.position.z = s.z; s.it.scale.y = Math.max(0.02, e); } // rugs unroll
      else s.it.position.z = s.z + H * (1 - Math.min(1, e));
    }
    if (busy) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------------ the tool
let lastTier = 'mid';
function itemsIn(room) {
  const w = W();
  return w.furniture.children.filter((o) => o.userData.kind && w.roomAt(o.position.x, o.position.y, o.userData.floor) === room);
}

export async function suggestRoom({ room, tier, budget } = {}) {
  const w = W(), agent = w.agent;
  const cur = w.current;
  const r = room ? (w.house.rooms.find((x) => x.id === room) || w.house.rooms.find((x) => (x.label || '').toLowerCase().includes(String(room).toLowerCase())))
    : (cur && w.roomAt(cur.pos[0], cur.pos[1], cur.floor));
  if (!r) return { ok: false, reason: 'Stand inside a room (or name one) and ask again.' };
  const listing = (agent && agent.describeHouse && agent.describeHouse().listing) || {};
  let light = null;
  try { light = agent && agent.lightHere ? (agent.lightHere() || {}).light : null; } catch (e) { /* optional */ }
  light = light ? String(light).split(' ')[0] : null;
  const pick = paletteFor(listing, light);

  // tier: "cheaper"/"nicer" step from last time; a budget picks the best tier that fits, then trims extras
  if (tier === 'cheaper') tier = TIERS[Math.max(0, TIERS.indexOf(lastTier) - 1)];
  else if (tier === 'nicer') tier = TIERS[Math.min(2, TIERS.indexOf(lastTier) + 1)];
  if (!TIERS.includes(tier)) tier = Number(listing.price) >= 1500000 ? 'premium' : 'mid';

  const res = (await w.stageRoom(r.id, pick.palette)) || {};
  // only priced set pieces: a room with no set (kitchen, bath) keeps the home's own scanned pieces, which aren't for sale
  let items = itemsIn(r).filter((it) => priceOf(it.userData.kind) != null);
  if (!items.length) return { ok: false, room: r.label, reason: res.say || 'nothing to furnish in this room', say: res.say || undefined };

  const sum = (t) => items.reduce((s, it) => s + (priceOf(it.userData.kind, t) || 0), 0);
  const dropped = [];
  if (budget > 0) {
    tier = [...TIERS].reverse().find((t) => sum(t) <= budget) || 'budget';
    while (sum(tier) > budget) {
      const it = OPTIONAL.map((k) => items.find((x) => x.userData.kind === k)).find(Boolean);
      if (!it) break;
      w.furniture.remove(it); dropped.push(((w.FURNITURE[it.userData.kind] || {}).name || it.userData.kind).toLowerCase());
      items = items.filter((x) => x !== it);
    }
  }
  lastTier = tier;

  clearTags(); hook();
  const pieces = items.map((it) => ({ it, kind: it.userData.kind, name: (w.FURNITURE[it.userData.kind] || {}).name || it.userData.kind,
    price: priceOf(it.userData.kind, tier) || 0 }));
  for (const p of pieces) tagItem(p.it, p.price);
  const total = pieces.reduce((s, p) => s + p.price, 0);
  const label = (r.label || 'room').toLowerCase();
  totalTag = makeTag(`${r.label || 'Room'} · about ${usd(total)}`, { big: true });
  const cx = r.poly.reduce((s, q) => s + q[0], 0) / r.poly.length, cy = r.poly.reduce((s, q) => s + q[1], 0) / r.poly.length;
  totalTag.position.set(cx, cy, ((cur && cur.floorZ) || 0) + 2.05);
  w.scene.add(totalTag); totalRoom = r;

  // the order they land: rug first, then the big piece, then the rest
  const order = [...items].sort((a, b) => ((w.FURNITURE[b.userData.kind] || {}).flat ? 1 : 0) - ((w.FURNITURE[a.userData.kind] || {}).flat ? 1 : 0)
    || (w.FURNITURE[b.userData.kind].w * w.FURNITURE[b.userData.kind].d) - (w.FURNITURE[a.userData.kind].w * w.FURNITURE[a.userData.kind].d));
  if (!w.feel) dropIn(order);
  // the soft layer: pillows and a throw on the sofa, the coffee table styled (no new priced pieces, so the total holds)
  if (w.styling) w.styling.styleRoom({ room: r.id, add: ['pillows', 'throw', 'coffee_table'] }).catch(() => {});                            // feel.js animates every arrival; this is the fallback

  const lamp = light === 'low' && items.some((it) => it.userData.kind === 'floorlamp') ? ' and a floor lamp because it is a darker room' : '';
  const say = `It's ${pick.why}${lamp}. About ${usd(total)} for the ${label}`
    + (budget > 0 ? (total <= budget ? `, under your ${usd(budget)}` : `, the closest I can get to ${usd(budget)}`) : '')
    + (dropped.length ? ` (I left out the ${dropped.join(' and ')})` : '') + '.';
  return {
    ok: true, room: r.label, style: pick.palette, style_reason: pick.why, light, tier, budget_usd: budget || null,
    pieces: pieces.map((p) => `${p.name} ${usd(p.price)}`), total_usd: total, dropped, fits: !!res.fits,
    listing_price_usd: Number(listing.price) || null, price_note: PRICE_NOTE, say,
  };
}

/** After "furnish the whole house": tag every piece and return the house total (mid tier). */
export function tagHouse(tier = 'mid') {
  const w = W();
  clearTags(); hook();
  let total = 0, n = 0;
  for (const it of w.furniture.children) {
    const p = it.userData.kind && priceOf(it.userData.kind, tier);
    if (!p) continue;
    tagItem(it, p); total += p; n++;
  }
  return { total_usd: total, pieces: n, tier, price_note: PRICE_NOTE };
}

(function attach(tries = 0) {
  if (!window.walkin || !window.walkin.stageRoom) { if (tries < 600) setTimeout(() => attach(tries + 1), 200); return; }
  window.walkin.suggest = { suggestRoom, tagHouse, clearTags, showTags, priceOf, PRICE_NOTE };
})();
