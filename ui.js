// R8 — behaviour for the glass dock: the Add and More popovers, and the idle fade.
// Pure DOM; doesn't need window.walkin. app.js still binds every button by id / data-add, unchanged.

const IDLE_MS = 4000;
const $ = (id) => document.getElementById(id);
const dock = $('bar');
const pops = { bAdd: $('addPop'), bMore: $('morePop') };

// ------------------------------------------------------------------ popovers
let openBtn = null;

function closePop() {
  if (!openBtn) return;
  const pop = pops[openBtn.id];
  pop.classList.remove('open');
  openBtn.setAttribute('aria-expanded', 'false');
  setTimeout(() => { if (!pop.classList.contains('open')) pop.hidden = true; }, 250); // after the fade
  document.body.classList.remove('pop-open');
  openBtn = null;
}

function openPop(btn) {
  if (openBtn === btn) return closePop();
  closePop();
  const pop = pops[btn.id];
  pop.hidden = false;
  void pop.offsetWidth;          // apply the closed state first, so the fade-in runs (no frame wait: a busy phone drops frames)
  pop.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  document.body.classList.add('pop-open');
  openBtn = btn;
  wake();
}

for (const id of Object.keys(pops)) {
  const btn = $(id);
  if (btn && pops[id]) btn.addEventListener('click', (e) => { e.stopPropagation(); openPop(btn); });
}
// picking something in Add closes it; More stays open so Rotate can be pressed a few times
$('addPop')?.addEventListener('click', (e) => { if (e.target.closest('[data-add]')) closePop(); });
addEventListener('pointerdown', (e) => {
  if (openBtn && !e.target.closest('.pop') && !e.target.closest('#bar')) closePop();
}, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });

// keep taps and keys on the UI from also turning the view or dragging furniture behind it
for (const el of [dock, ...Object.values(pops)]) {
  if (!el) continue;
  for (const ev of ['pointerdown', 'mousedown', 'touchstart', 'wheel']) el.addEventListener(ev, (e) => e.stopPropagation());
}

// ------------------------------------------------------------------ idle fade
let idleTimer = 0;
let hovering = false;

function wake() {
  dock.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!hovering && !openBtn) dock.classList.add('idle');
  }, IDLE_MS);
}

if (dock) {
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, wake, { passive: true });
  dock.addEventListener('pointerenter', () => { hovering = true; wake(); });
  dock.addEventListener('pointerleave', () => { hovering = false; wake(); });
  // a pinch with tracked hands counts as input too (walkin.handRay changes while a hand is up)
  let lastRay = null;
  setInterval(() => {
    const r = window.walkin && window.walkin.handRay;
    const key = r ? r.dir.map((v) => v.toFixed(2)).join() : null;
    if (key && key !== lastRay) wake();
    lastRay = key;
  }, 500);
  wake();
}
