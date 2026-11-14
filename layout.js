// S6 — layouts survive a reload.
// walkin.saveLayout() -> a plain JSON object, walkin.loadLayout(json) puts it back, and whatever is in
// the room is autosaved to localStorage per house, so a refresh mid-demo doesn't lose the staging.
// Add ?layout=none to the URL to start empty (and not overwrite what is stored).
import { FURNITURE } from './furniture.js';

const VERSION = 1;
const SAVE_MS = 700;                         // how long to wait after the last change before storing
const key = (model) => `walkin.layout.${model}`;
const r2 = (v) => Math.round(v * 1000) / 1000;

/**
 * The pieces, and what each one stands on. The link has to be an index into this list: uuids are new
 * every reload, so a stored uuid means nothing afterwards. Without it a restored television and its
 * stand each report the other as a collision and neither can be picked up.
 */
function items(w) {
  const kids = w.furniture.children.filter((o) => o.userData.kind);
  const at = new Map(kids.map((o, i) => [o.uuid, i]));
  return kids.map((o) => {
    const row = {
      kind: o.userData.kind,
      p: [r2(o.position.x), r2(o.position.y), r2(o.position.z)],
      rot: r2(o.rotation.z),
      floor: o.userData.floor || null,
    };
    if (o.userData.on && at.has(o.userData.on)) row.on = at.get(o.userData.on);
    return row;
  });
}

/** Everything in the scene, as a plain object you can JSON.stringify. */
export function saveLayout() {
  const w = window.walkin;
  if (!w) return null;
  return {
    v: VERSION,
    model: w.house.model,
    saved: new Date().toISOString(),
    items: items(w),
    // wall materials (A4). Only ones with a plain URL: a generated tile is usually a blob: or data:
    // URL that means nothing after a reload, and a huge data: URL would blow the localStorage quota.
    walls: (typeof w.wallMaterials === 'function' ? w.wallMaterials() : [])
      .filter((m) => typeof m.url === 'string' && /^[./a-zA-Z0-9]/.test(m.url) && !m.url.startsWith('blob:')
        && !m.url.startsWith('data:'))
      .map((m) => ({ wall: m.wall, url: m.url, tile: m.tileMetres })),
  };
}

/**
 * Put a saved layout back. Takes the object from saveLayout() or the same thing as a JSON string.
 * By default it replaces what is there; pass { replace: false } to add to it.
 * Returns { added, skipped: [{kind, why}], model }.
 */
export function loadLayout(data, { replace = true, anyHouse = false } = {}) {
  const w = window.walkin;
  if (!w) return { added: 0, skipped: [], model: null };
  let doc = data;
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch (e) { return { added: 0, skipped: [{ why: 'not JSON' }], model: null }; }
  }
  if (!doc || !Array.isArray(doc.items)) return { added: 0, skipped: [{ why: 'no items' }], model: null };

  // Every position in here is in one house's own coordinates. Putting a La Mirada layout into Dunvegan
  // doesn't give you a differently arranged room, it gives you furniture in the garden - and it clears
  // what was there first, so you lose the real layout to get it. Autosave is keyed per house and can't
  // do this; a hand or an agent passing a document around can. Pass { anyHouse: true } if you mean it.
  if (!anyHouse && doc.model && w.house && doc.model !== w.house.model) {
    return { added: 0, walls: 0, model: doc.model,
      skipped: [{ why: `that layout is for a different house (${doc.model}); `
        + 'its positions mean nothing here - pass { anyHouse: true } if you meant to' }] };
  }

  if (replace) for (const o of [...w.furniture.children]) w.furniture.remove(o);

  const skipped = [];
  const made = [];                             // same order as doc.items, null where one was skipped
  let added = 0;
  for (const it of doc.items) {
    if (!FURNITURE[it.kind]) { skipped.push({ kind: it.kind, why: 'not in the catalog' }); made.push(null); continue; }
    if (!Array.isArray(it.p) || it.p.length < 3 || it.p.some((v) => typeof v !== 'number' || !isFinite(v))) {
      skipped.push({ kind: it.kind, why: 'bad position' });
      made.push(null);
      continue;
    }
    w.addFurniture(it.kind);
    const obj = w.furniture.children[w.furniture.children.length - 1];
    obj.position.set(it.p[0], it.p[1], it.p[2]);
    obj.rotation.z = typeof it.rot === 'number' ? it.rot : 0;
    obj.userData.floor = it.floor || (w.current && w.current.floor);
    made.push(obj);
    added++;
  }
  // Put the support links back. A saved index is exact; a layout saved before we stored them (or one
  // whose support was skipped) falls back to working it out from the geometry.
  doc.items.forEach((it, i) => {
    const obj = made[i];
    if (!obj) return;
    const by = typeof it.on === 'number' ? made[it.on] : null;
    obj.userData.on = by ? by.uuid
      : (typeof w.supportUnder === 'function' ? ((w.supportUnder(obj) || {}).uuid || null) : null);
    // where it drops to if whatever it is standing on is deleted: the floor its support stands on,
    // or its own height if it is already on the floor
    const sup = by || (obj.userData.on
      ? w.furniture.children.find((o) => o.uuid === obj.userData.on) : null);
    obj.userData.z0 = sup ? sup.position.z : obj.position.z;
  });
  if (w.select) w.select(null);

  let walls = 0;
  if (Array.isArray(doc.walls) && doc.walls.length) {
    walls = doc.walls.filter((m) => m && m.wall && typeof m.url === 'string').length;
    // walls.js registers its hooks on its own timer, so don't assume it is there yet
    whenWalls((ok) => {
      if (!ok) return console.warn('layout: walls.js never appeared, wall materials not restored');
      if (replace && typeof w.clearAllWallMaterials === 'function') w.clearAllWallMaterials();
      for (const m of doc.walls) {
        if (!m || !m.wall || typeof m.url !== 'string') continue;
        Promise.resolve(w.setWallMaterial(m.wall, m.url, m.tile || 1))
          .then((r) => { if (!r || !r.ok) console.warn('layout: wall skipped -', (r || {}).why); })
          .catch((e) => console.warn('layout: wall failed', e));
      }
    });
  }
  return { added, walls, skipped, model: doc.model || null };
}

/** walls.js publishes its hooks from its own start timer; wait a moment for it. */
function whenWalls(cb, tries = 0) {
  if (window.walkin && typeof window.walkin.setWallMaterial === 'function') return cb(true);
  if (tries > 60) return cb(false);
  setTimeout(() => whenWalls(cb, tries + 1), 50);
}

export function clearLayout() {
  const w = window.walkin;
  if (!w) return 0;
  const n = w.furniture.children.length;
  for (const o of [...w.furniture.children]) w.furniture.remove(o);
  if (typeof w.clearAllWallMaterials === 'function') w.clearAllWallMaterials();
  if (w.select) w.select(null);
  store(null);
  return n;
}

// ------------------------------------------------------------------ autosave to localStorage
let enabled = true;

function store(doc) {
  const w = window.walkin;
  if (!w || !enabled) return;
  try {
    const has = doc && (doc.items.length || (doc.walls && doc.walls.length));
    if (has) localStorage.setItem(key(w.house.model), JSON.stringify(doc));
    else localStorage.removeItem(key(w.house.model));
  } catch (e) { /* private window, full disk: not worth bothering anyone about */ }
}

/** The layout stored for this house, or null. */
export function storedLayout(model) {
  try {
    const raw = localStorage.getItem(key(model || (window.walkin && window.walkin.house.model)));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/** A cheap fingerprint of the scene, so autosave only runs when something actually moved. */
function signature(w) {
  let s = `${w.furniture.children.length}`;
  if (typeof w.wallMaterials === 'function') {
    for (const m of w.wallMaterials()) s += `|W${m.wall.floor}:${m.wall.index}:${m.tileMetres}`;
  }
  for (const o of w.furniture.children) {
    s += `|${o.userData.kind}${o.position.x.toFixed(2)},${o.position.y.toFixed(2)},`
      + `${o.position.z.toFixed(2)},${o.rotation.z.toFixed(2)}`;
  }
  return s;
}

(function start(tries = 0) {
  if (!window.walkin) {
    if (tries < 600) return setTimeout(() => start(tries + 1), 50);
    return;
  }
  const w = window.walkin;
  w.saveLayout = saveLayout;
  w.loadLayout = loadLayout;
  w.clearLayout = clearLayout;
  w.storedLayout = storedLayout;

  const params = new URLSearchParams(location.search);
  if (params.get('layout') === 'none') {
    enabled = false;
  } else {
    const saved = storedLayout(w.house.model);
    if (saved && ((saved.items && saved.items.length) || (saved.walls && saved.walls.length))) {
      const { added, walls, skipped } = loadLayout(saved);
      console.log(`layout: restored ${added} piece${added === 1 ? '' : 's'}`
        + `${walls ? ` and ${walls} wall${walls === 1 ? '' : 's'}` : ''} from the last session`
        + `${skipped.length ? `, skipped ${skipped.length}` : ''} — walkin.clearLayout() to start over`);
    }
  }

  let last = signature(w);
  let timer = null;
  (function tick() {
    requestAnimationFrame(tick);
    const sig = signature(w);
    if (sig === last) return;
    last = sig;
    clearTimeout(timer);
    timer = setTimeout(() => store(saveLayout()), SAVE_MS);
  })();
})();
