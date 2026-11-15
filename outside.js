// Outside → on the market → inside. CoStar's own slide for this track is "Inside, outside, on the market", and it
// uses our demo house: Matterport inside, Vexcel from above, the CoStar / Homes.com listing. This is the first two
// before the third: on load you see the house from Vexcel's aircraft with its parcel and footprint, next to the
// listing, and "Walk in" dives into the roof and fades into the scan.
//
// Data: data/<model>/outside.json + outside/ortho.jpg from tools/prep_outside.py (geometry in metres east / north of
// the photo's centre). No file, ?outside=off, the headset or the ?a1 one-tap test: nothing is shown.
// Back to it any time: ⋯ → Outside. window.walkin.showOutside() does the same.

const params = new URLSearchParams(location.search);
const MODEL = params.get('m') || 'zvKHR9DHNjJ';
const BASE = `data/${MODEL}/`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (v) => (v ? `$${Math.round(v).toLocaleString('en-US')}` : '');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const month = (d) => (d && /^\d{4}-\d{2}/.test(d) ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : '');

function svgPath(rings) { // rings in metres (x east, y north) -> SVG path in the same units, y flipped
  return rings.map((r) => 'M' + r.map(([x, y]) => `${x.toFixed(2)},${(-y).toFixed(2)}`).join('L') + 'Z').join('');
}

function build(d) {
  const L = d.listing || {}, site = d.site || {}, o = d.ortho;
  const house = (d.structures || []).find((s) => s.primary) || null;
  const H = o?.half_m || 32;
  // the house's centre, to dive into it
  let hx = 0, hy = 0;
  if (house?.footprint?.[0]?.length) {
    const r = house.footprint[0];
    hx = r.reduce((a, p) => a + p[0], 0) / r.length; hy = r.reduce((a, p) => a + p[1], 0) / r.length;
  } else if (d.model_xy) [hx, hy] = d.model_xy;

  const el = document.createElement('div');
  el.id = 'outside';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'The house from outside');

  let map = '';
  if (o) {
    const others = (d.structures || []).filter((s) => !s.primary && s.footprint?.length);
    map = `
      <div class="os-map" style="transform-origin:${(((hx + H) / (2 * H)) * 100).toFixed(1)}% ${(((H - hy) / (2 * H)) * 100).toFixed(1)}%">
        <img src="${BASE}${esc(o.file)}" alt="Vexcel aerial photo of ${esc(L.address || 'the house')}" draggable="false">
        <svg viewBox="${-H} ${-H} ${2 * H} ${2 * H}" preserveAspectRatio="none" aria-hidden="true">
          ${d.parcel?.length ? `<path class="os-parcel" d="${svgPath(d.parcel)}"/>` : ''}
          ${others.map((s) => `<path class="os-other" d="${svgPath(s.footprint)}"/>`).join('')}
          ${house ? `<path class="os-house" d="${svgPath(house.footprint)}"/>`
                  : `<circle class="os-pin" cx="${hx}" cy="${-hy}" r="1.6"/>`}
        </svg>
      </div>`;
  }

  const facts = [L.beds && `${L.beds} bd`, L.baths && `${L.baths} ba`, L.sqft && `${L.sqft.toLocaleString('en-US')} sq ft`,
    L.year_built && `built ${L.year_built}`, L.style].filter(Boolean);
  const chips = (L.highlights || []).filter((t) => !/walk to|minute/i.test(t)).slice(0, 6);
  const above = [house?.area_m2 && `${Math.round(house.area_m2)} m² footprint`,
    house?.roof_shape && `${house.roof_shape}${house.roof_material ? ' ' + house.roof_material : ''} roof`,
    site.pool === false ? 'no pool' : site.pool ? 'pool' : '',
    site.solar ? 'solar' : '', site.tree_cover_pct != null && `${Math.round(site.tree_cover_pct)}% tree cover`].filter(Boolean);
  const addr = [L.address, [L.city, L.state].filter(Boolean).join(', '), L.zip].filter(Boolean).join(' · ');

  el.innerHTML = `
    ${map}
    <div class="os-shade"></div>
    <div class="os-card glass">
      <div class="os-steps"><span class="on">Outside</span><i></i><span class="on">On the market</span><i></i><span>Inside</span></div>
      ${L.price ? `<div class="os-price">${money(L.price)}${L.status === 'ForSale' ? '<em>For sale</em>' : ''}</div>` : ''}
      ${addr ? `<div class="os-addr">${esc(addr)}</div>` : ''}
      ${facts.length ? `<div class="os-facts">${facts.map(esc).join(' · ')}</div>` : ''}
      ${chips.length ? `<div class="os-chips">${chips.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      ${above.length ? `<div class="os-above"><b>From above</b> ${above.map(esc).join(' · ')}</div>` : ''}
      <button class="os-go" disabled>Loading the house…</button>
      <div class="os-src">${[L.homes_listing_id && `Homes.com listing ${esc(L.homes_listing_id)} via the CoStar kit`,
        o && `Vexcel aerial${o.date ? ', ' + esc(month(o.date)) : ''}${o.gsd_m ? `, ${Math.round(o.gsd_m * 100)} cm/px` : ''}`,
        'Matterport scan'].filter(Boolean).join(' · ')}</div>
    </div>`;
  return el;
}

let data = null, el = null, keyHandler = null;

function walkIn() {
  if (!el || el.classList.contains('walking') || !window.walkin?.house) return;
  el.classList.add('walking');
  removeEventListener('keydown', keyHandler, true);
  setTimeout(() => { el.hidden = true; el.classList.remove('walking', 'shown'); }, 1300);
}

function show() {
  if (!data || document.body.classList.contains('vr')) return false;
  if (!el) {
    el = build(data);
    document.body.appendChild(el);
    // taps and keys on the overlay must not turn the view or trigger app shortcuts behind it
    for (const ev of ['pointerdown', 'mousedown', 'touchstart', 'wheel']) el.addEventListener(ev, (e) => e.stopPropagation());
    el.querySelector('.os-go').addEventListener('click', walkIn);
    keyHandler = (e) => {
      if (el.hidden) return;
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') { e.preventDefault(); walkIn(); }
    };
  }
  dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // close the ⋯ popover (ui.js) if it was open
  el.hidden = false;
  el.classList.remove('walking');
  void el.offsetWidth;
  el.classList.add('shown');
  addEventListener('keydown', keyHandler, true);
  const go = el.querySelector('.os-go');
  (function ready() { // the house loads behind the photo; Walk in works once it is there
    if (window.walkin?.house) { go.disabled = false; go.textContent = 'Walk in'; go.focus({ preventScroll: true }); }
    else setTimeout(ready, 150);
  })();
  return true;
}

function addMenuEntry() {
  const grid = document.querySelector('#morePop .pop-grid');
  if (!grid || document.getElementById('bOutside')) return;
  const b = document.createElement('button');
  b.id = 'bOutside';
  b.title = 'The house from above, and its listing';
  b.textContent = '⌖ Outside';
  b.addEventListener('click', show);
  grid.prepend(b);
}

async function init() {
  try {
    const res = await fetch(BASE + 'outside.json', { cache: 'no-store' });
    if (!res.ok) return;
    data = await res.json();
  } catch { return; }
  if (!data || (!data.ortho && !data.listing)) { data = null; return; }
  addMenuEntry();
  (function hook() { // expose once app.js has made window.walkin
    if (window.walkin) window.walkin.showOutside = show; else setTimeout(hook, 300);
  })();
  // resume: John switched house/office from inside At eyes; the phone is in the headset, so nothing to tap
  const skip = params.get('outside') === 'off' || params.has('a1') || params.has('resume') || document.body.classList.contains('vr');
  if (!skip) show();
}
init();
