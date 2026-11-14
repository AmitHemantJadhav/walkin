// House picker: a small dropdown in the info panel that switches between the demo houses (?m=<model id>).
// Houses that haven't been downloaded yet are listed but disabled, with the command to fetch them.
// Standalone: it doesn't need window.walkin, so it also works when a house failed to load.

const DEMO = [ // single floor, residential, defurnished view; from docs/walkin_candidates.csv
  { id: 'zvKHR9DHNjJ', name: 'La Mirada' },
  { id: '7axUS8XrcSc', name: '314 Gale St, Houston' },
  { id: '1FFftrgRFBd', name: '10319 Dunvegan Way, Houston' },
];

const params = new URLSearchParams(location.search);
const current = params.get('m') || DEMO[0].id;

async function downloaded() {
  try {
    const res = await fetch('/api/houses');
    if (res.ok) return new Map((await res.json()).map((h) => [h.id, h]));
  } catch (e) { /* plain static server: no /api */ }
  return null; // unknown: don't disable anything
}

function go(id) {
  const p = new URLSearchParams(location.search);
  p.set('m', id);
  p.delete('p'); // a pano id from one house means nothing in another
  location.search = p.toString();
}

async function build() {
  const have = await downloaded();
  const list = [...DEMO];
  if (have) for (const [id, h] of have) if (!list.some((d) => d.id === id)) list.push({ id, name: h.name || id });
  if (!list.some((d) => d.id === current)) list.push({ id: current, name: current });

  const style = document.createElement('style');
  style.textContent = `
    #picker { margin-top: 6px; max-width: 100%; background: #2a2a31; color: var(--fg); border: 0; border-radius: 8px;
      padding: 4px 6px; font: inherit; font-size: 12px; touch-action: auto; }
    #pickerHint { color: var(--muted); font-size: 11px; margin-top: 3px; display: none; }
    #loading #picker { display: block; margin: 12px auto 0; font-size: 14px; }`;
  document.head.appendChild(style);

  const sel = document.createElement('select');
  sel.id = 'picker';
  sel.title = 'Switch house';
  for (const d of list) {
    const o = document.createElement('option');
    const h = have && have.get(d.id);
    o.value = d.id;
    o.textContent = h ? `${d.name} · ${h.rooms} rooms` : have ? `${d.name} (not downloaded)` : d.name;
    o.disabled = !!have && !h && d.id !== current;
    o.selected = d.id === current;
    sel.appendChild(o);
  }
  const hint = document.createElement('div');
  hint.id = 'pickerHint';
  const missing = have ? list.filter((d) => !have.has(d.id)).map((d) => d.id) : [];
  if (missing.length) hint.textContent = `To add: python prep_house.py ${missing[0]}`;
  for (const ev of ['keydown', 'pointerdown', 'mousedown', 'touchstart']) sel.addEventListener(ev, (e) => e.stopPropagation());
  sel.addEventListener('focus', () => { if (missing.length) hint.style.display = 'block'; });
  sel.addEventListener('change', () => go(sel.value));

  // In the info panel normally; on the loading screen if the house is missing (that screen covers everything).
  const loading = document.getElementById('loading');
  const host = loading && /Couldn't load/.test(loading.textContent) ? loading : document.getElementById('info');
  if (!host) return;
  host.appendChild(sel);
  if (host.id === 'info') host.appendChild(hint);
}

// Wait until app.js has either loaded the house (it removes #loading) or failed (#loading says "Couldn't load").
(function wait(tries = 0) {
  const loading = document.getElementById('loading');
  if (!loading || /Couldn't load/.test(loading.textContent) || tries > 300) build();
  else setTimeout(() => wait(tries + 1), 200);
})();
