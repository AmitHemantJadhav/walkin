// S6 — layouts survive a reload.
// walkin.saveLayout() -> a plain JSON object, walkin.loadLayout(json) puts it back, and whatever is in
// the room is autosaved to localStorage per house, so a refresh mid-demo doesn't lose the staging.
// Add ?layout=none to the URL to start empty (and not overwrite what is stored).
import { FURNITURE } from './furniture.js';

const VERSION = 1;
const SAVE_MS = 700;                         // how long to wait after the last change before storing
const key = (model) => `walkin.layout.${model}`;
const r2 = (v) => Math.round(v * 1000) / 1000;

/** Everything in the scene, as a plain object you can JSON.stringify. */
export function saveLayout() {
  const w = window.walkin;
  if (!w) return null;
  return {
    v: VERSION,
    model: w.house.model,
    saved: new Date().toISOString(),
    items: w.furniture.children.filter((o) => o.userData.kind).map((o) => ({
      kind: o.userData.kind,
      p: [r2(o.position.x), r2(o.position.y), r2(o.position.z)],
      rot: r2(o.rotation.z),
      floor: o.userData.floor || null,
    })),
  };
}

/**
 * Put a saved layout back. Takes the object from saveLayout() or the same thing as a JSON string.
 * By default it replaces what is there; pass { replace: false } to add to it.
 * Returns { added, skipped: [{kind, why}], model }.
 */
export function loadLayout(data, { replace = true } = {}) {
  const w = window.walkin;
  if (!w) return { added: 0, skipped: [], model: null };
  let doc = data;
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch (e) { return { added: 0, skipped: [{ why: 'not JSON' }], model: null }; }
  }
  if (!doc || !Array.isArray(doc.items)) return { added: 0, skipped: [{ why: 'no items' }], model: null };

  if (replace) for (const o of [...w.furniture.children]) w.furniture.remove(o);

  const skipped = [];
  let added = 0;
  for (const it of doc.items) {
    if (!FURNITURE[it.kind]) { skipped.push({ kind: it.kind, why: 'not in the catalog' }); continue; }
    if (!Array.isArray(it.p) || it.p.length < 3 || it.p.some((v) => typeof v !== 'number' || !isFinite(v))) {
      skipped.push({ kind: it.kind, why: 'bad position' });
      continue;
    }
    w.addFurniture(it.kind);
    const obj = w.furniture.children[w.furniture.children.length - 1];
    obj.position.set(it.p[0], it.p[1], it.p[2]);
    obj.rotation.z = typeof it.rot === 'number' ? it.rot : 0;
    obj.userData.floor = it.floor || (w.current && w.current.floor);
    added++;
  }
  if (w.select) w.select(null);
  return { added, skipped, model: doc.model || null };
}

export function clearLayout() {
  const w = window.walkin;
  if (!w) return 0;
  const n = w.furniture.children.length;
  for (const o of [...w.furniture.children]) w.furniture.remove(o);
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
    if (doc && doc.items.length) localStorage.setItem(key(w.house.model), JSON.stringify(doc));
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
    if (saved && saved.items && saved.items.length) {
      const { added, skipped } = loadLayout(saved);
      console.log(`layout: restored ${added} piece${added === 1 ? '' : 's'} from the last session`
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
