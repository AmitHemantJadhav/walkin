// How furniture feels in the hand. Only looks: where a piece is stays physics.js's and app.js's business.
//
//  - Carried: a piece that is moving lifts a couple of centimetres off its contact shadow and leans a little
//    against the way it is going, like something heavy being walked across a room. Set down, it settles on
//    a spring. The lift and lean are applied to the piece's model, never to the piece, so physics, the fit
//    check and the agent all keep seeing the real position.
//  - Arrives: a new piece drops in softly and lands with a small bounce, its shadow growing in under it;
//    a rug unrolls. Several at once (a staged room) come in one after the other.
//  - Selected: an outline at the piece's real footprint, turned with it (the old box was axis-aligned in the
//    world, so a turned sofa got a box much bigger than itself), green when it fits and red when it doesn't.
//    Nothing else is drawn on the piece.
// Talks to the viewer only through window.walkin and the dock buttons. ?feel=off turns it all off.
import * as THREE from 'three';

const OFF = new URLSearchParams(location.search).get('feel') === 'off';
const LIFT = 0.025;          // metres a carried piece rises
const LEAN = 0.035;          // radians at full speed
const LEAN_V = 0.9;          // m/s that counts as full speed
const MOVING = 0.04;         // m/s: slower than this is standing still
const DROP_H = 0.42;         // an arriving piece starts this high
const DROP_MS = 560;
const UNROLL_MS = 900;       // a rug takes a little longer: it rolls out
const STAGGER = 110;         // ms between pieces arriving together
const W = () => window.walkin;

const st = new WeakMap();    // item -> { px, py, t, lift, liftV, lx, ly, arrive0, arriveDelay, flat }
const seen = new WeakSet();
let started = 0;
// walkin.feel.slow = 4 plays arrivals four times slower (to show them off, or to check them frame by frame)
const feel = { slow: 1, removeSelected: (...a) => removeSelected(...a), LIFT, LEAN };

// the parts of a piece that move with it visually: everything but its contact shadow and price tags
const bodyParts = (item) => item.children.filter((c) => !c.userData.shadow && !c.userData.priceTag && !c.isSprite && !c.userData.feelRoll);
const shadows = (item) => item.children.filter((c) => c.userData.shadow && !c.userData.feelRoll);
function base(c) {
  if (!c.userData.feelBase) c.userData.feelBase = { y: c.position.y, z: c.position.z, rx: c.rotation.x, ry: c.rotation.y, sx: c.scale.x, sy: c.scale.y, sz: c.scale.z };
  return c.userData.feelBase;
}

const easeOutBack = (t) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function tick(dt) {
  const w = W();
  if (!w || !w.furniture) return;
  const now = performance.now();
  const k = Math.min(dt || 0.016, 0.05);
  let arrivals = 0;
  for (const item of w.furniture.children) {
    if (!item.userData || !item.userData.kind) continue;
    let s = st.get(item);
    if (!s) {
      s = { px: item.position.x, py: item.position.y, lift: 0, liftV: 0, lx: 0, ly: 0 };
      st.set(item, s);
      // arrive: not the home's own furniture (it was already there), not what a page load or a saved layout
      // brings back in the first moments
      if (!seen.has(item) && !item.userData.meshPiece && now - started > 2500) {
        s.arrive0 = now + Math.min(arrivals, 12) * STAGGER;
        s.flat = !!((w.FURNITURE[item.userData.kind] || {}).flat);
        arrivals++;
      }
      seen.add(item);
    }
    // speed from where the piece actually is (physics' result), in the piece's own frame
    const vx = (item.position.x - s.px) / k, vy = (item.position.y - s.py) / k;
    s.px = item.position.x; s.py = item.position.y;
    const speed = Math.hypot(vx, vy);
    const carried = speed > MOVING && speed < 8;           // a teleport (placement) is not a carry
    // lift: critically damped spring towards LIFT while carried, 0 when not (a small overshoot on landing)
    const target = carried ? LIFT : 0;
    const wn = carried ? 18 : 14, zeta = carried ? 1 : 0.55;
    s.liftV += (-(2 * zeta * wn) * s.liftV - wn * wn * (s.lift - target)) * k;
    s.lift += s.liftV * k;
    // lean against the motion, in the item's frame
    const c = Math.cos(-item.rotation.z), sn = Math.sin(-item.rotation.z);
    const lvx = c * vx - sn * vy, lvy = sn * vx + c * vy;
    const f = carried ? Math.min(1, speed / LEAN_V) * LEAN / (speed || 1) : 0;
    const a = 1 - Math.exp(-k / 0.09);
    s.lx += ((lvy * f) - s.lx) * a;                       // about x: top leans towards -y when moving +y
    s.ly += ((-lvx * f) - s.ly) * a;                      // about y: top leans towards -x when moving +x

    // arrival
    let drop = 0, unroll = 1, shadowK = 1, hidden = false;
    if (s.arrive0 !== undefined) {
      const t = (now - s.arrive0) / ((s.flat ? UNROLL_MS : DROP_MS) * (feel.slow || 1));
      if (t < 0) { hidden = true; shadowK = 0; }
      else if (t < 1) {
        if (s.flat) unroll = Math.max(0.001, easeOutCubic(t));
        else drop = Math.max(0, DROP_H * (1 - easeOutBack(Math.min(1, t * 1.05))));
        shadowK = easeOutCubic(t);
      } else { s.arrive0 = undefined; if (s.roll) { s.roll.parent && s.roll.parent.remove(s.roll); s.roll.geometry.dispose(); s.roll = null; } }
    }
    if (s.flat && s.arrive0 !== undefined && !hidden) rollOut(w, item, s, unroll);
    const active = s.arrive0 !== undefined || Math.abs(s.lift) > 1e-4 || Math.abs(s.liftV) > 1e-3
      || Math.abs(s.lx) > 1e-4 || Math.abs(s.ly) > 1e-4;
    if (!active) {
      if (s.dirty) {                                       // back to exactly what the piece had, then hands off
        for (const p of item.children) {
          const b = p.userData.feelBase;
          if (!b) continue;
          p.position.y = b.y; p.position.z = b.z; p.rotation.x = b.rx; p.rotation.y = b.ry; p.scale.set(b.sx, b.sy, b.sz);
          if (p.userData.feelHid) { p.visible = true; delete p.userData.feelHid; }
          delete p.userData.feelBase;
        }
        s.dirty = false;
      }
      continue;
    }
    s.dirty = true;
    for (const p of bodyParts(item)) {
      const b = base(p);
      if (hidden) { if (p.visible) { p.visible = false; p.userData.feelHid = true; } }
      else if (p.userData.feelHid) { p.visible = true; delete p.userData.feelHid; }
      p.position.z = b.z + s.lift + drop;
      p.rotation.x = b.rx + s.lx;
      p.rotation.y = b.ry + s.ly;
      p.scale.set(b.sx, b.sy * (s.flat ? unroll : 1), b.sz);
      // a rug grows from its back edge (+y) towards you, not out of its middle
      if (s.flat) p.position.y = b.y + (1 - unroll) * (s.depth || 0) / 2;
    }
    for (const sh of shadows(item)) {
      const b = base(sh);
      // the shadow spreads a touch as the piece rises, and grows in under an arriving piece
      const g = (1 + s.lift * 4) * (0.5 + 0.5 * shadowK);
      sh.scale.set(b.sx * g, b.sy * g, b.sz);
      if (hidden) { if (sh.visible) { sh.visible = false; sh.userData.feelHid = true; } }
      else if (sh.userData.feelHid) { sh.visible = true; delete sh.userData.feelHid; }
    }
  }
  selection(w);
}

// ------------------------------------------------------------------ a rug rolling out
// The flat part grows from the back edge; at its front edge a roll of the same rug turns as it travels and
// shrinks to nothing. A rug of length d and thickness t rolled up is a cylinder of radius sqrt(d·t/π).
const RUG_T = 0.012;
function rollOut(w, item, s, u) {
  const spec = w.FURNITURE[item.userData.kind] || {};
  const d = spec.d || 1.6, wid = spec.w || 2.4;
  s.depth = d;
  if (!s.roll) {
    let mat = null;
    item.traverse((n) => { if (!mat && n.isMesh && !n.userData.shadow && n.material) mat = Array.isArray(n.material) ? n.material[0] : n.material; });
    if (!mat) return;
    const g = new THREE.CylinderGeometry(1, 1, wid * 0.98, 28, 1);
    g.rotateZ(Math.PI / 2);                                // axis along the rug's width (x)
    s.roll = new THREE.Mesh(g, mat);
    s.roll.renderOrder = 2;
    s.roll.userData.feelRoll = true;
    s.roll.userData.shadow = true;                        // not part of the piece: outlines and fit checks skip it
    item.add(s.roll);
  }
  const r0 = Math.sqrt((d * RUG_T) / Math.PI);
  const r = Math.max(0.004, r0 * Math.sqrt(Math.max(0, 1 - u)));
  const y = d / 2 - u * d;                                 // the front edge of what is already down
  s.roll.scale.set(1, r, r);
  s.roll.position.set(0, y - r * 0.3, r + 0.004);
  s.roll.rotation.x = -(u * d) / r0;                       // turns as it travels
  s.roll.visible = u < 0.995;
}

// ------------------------------------------------------------------ selection
let outline = null, chip = null, chipFor = null, footCache = null;
const baseColor = new THREE.Color(0x3ccf8e);
const _m = new THREE.Matrix4(), _b = new THREE.Box3(), _v = new THREE.Vector3();

/** The piece's footprint in its own frame, from its visible meshes (not the catalog box, not the shadow). */
function localFootprint(item) {
  const inv = _m.copy(item.matrixWorld).invert();
  const box = new THREE.Box3();
  item.updateMatrixWorld(true);
  item.traverse((n) => {
    if (!n.isMesh || !n.visible || n.userData.shadow || n.userData.priceTag) return;
    let p = n; let skip = false;
    while (p && p !== item) { if (p.userData.shadow || p.userData.priceTag) skip = true; p = p.parent; }
    if (skip) return;
    if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
    _b.copy(n.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, n.matrixWorld));
    box.union(_b);
  });
  return box.isEmpty() ? null : box;
}

function roundedRect(w, d, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -d / 2;
  r = Math.min(r, w / 2, d / 2);
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function ringGeometry(w, d) {
  const band = 0.022, pad = 0.05;
  const outer = roundedRect(w + 2 * pad + band, d + 2 * pad + band, 0.09);
  outer.holes.push(new THREE.Path(roundedRect(w + 2 * pad - band, d + 2 * pad - band, 0.07).getPoints(24).reverse()));
  return new THREE.ShapeGeometry(outer, 24);
}

function selection(w) {
  // the old axis-aligned box: keep it hidden while this draws the outline
  for (const c of w.scene.children) if (c.type === 'Box3Helper' && c.renderOrder === 30) c.visible = false;
  const item = w.selected && w.selected.parent ? w.selected : null;
  const vr = document.body.classList.contains('vr');
  if (!outline) {
    outline = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: 0x3ccf8e, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
    // opaque on purpose: three draws every transparent object after every opaque one, whatever its renderOrder,
    // so a see-through outline was drawn across the piece instead of under it
    // drawn after the scan's depth-only occluders (which would hide it: they sit a centimetre above the floor)
    // and before the furniture (renderOrder 2), so the piece paints over its own part of the outline
    outline.renderOrder = 1.5;
    w.scene.add(outline);
  }
  if (!item) { outline.visible = false; hideChip(); footCache = null; return; }
  if (!footCache || footCache.item !== item || performance.now() - footCache.t > 600) {
    const fb = localFootprint(item);
    if (fb) {
      const fw = fb.max.x - fb.min.x, fd = fb.max.y - fb.min.y;
      const same = footCache && footCache.item === item && Math.abs(footCache.w - fw) < 0.01 && Math.abs(footCache.d - fd) < 0.01;
      if (!same) { outline.geometry.dispose(); outline.geometry = ringGeometry(fw, fd); }
      footCache = { item, t: performance.now(), w: fw, d: fd, cx: (fb.min.x + fb.max.x) / 2, cy: (fb.min.y + fb.max.y) / 2, top: fb.max.z };
    }
  }
  if (!footCache) { outline.visible = false; return; }
  // fit colour: app.js colours its own (hidden) box; read it so both agree
  const helper = w.scene.children.find((c) => c.type === 'Box3Helper' && c.renderOrder === 30);
  if (helper) baseColor.copy(helper.material.color);
  const pulse = 0.8 + 0.2 * Math.sin(performance.now() / 260);   // breathe the colour, not the opacity
  outline.material.color.copy(baseColor).multiplyScalar(pulse);
  outline.position.copy(item.position);
  outline.position.z = item.position.z + 0.012;
  outline.rotation.set(0, 0, item.rotation.z);
  outline.translateX(footCache.cx); outline.translateY(footCache.cy);
  outline.visible = true;
  // no floating buttons on the piece: rotate and remove stay in the menu, on the keys (R, Delete) and by voice
}

function makeChip() {
  const el = document.createElement('div');
  el.id = 'feel-chip';
  el.innerHTML = '<button data-a="rot" title="Turn 45°">⟳ Rotate</button><button data-a="del" title="Remove this piece">✕ Remove</button>';
  const css = document.createElement('style');
  css.textContent = `#feel-chip{position:fixed;z-index:8;display:flex;gap:4px;padding:4px;border-radius:999px;
    background:rgba(20,22,26,.72);backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);
    box-shadow:0 8px 30px rgba(0,0,0,.35);transform:translate(-50%,-100%);transition:opacity .18s;pointer-events:auto;opacity:0}
    #feel-chip.on{opacity:1}
    #feel-chip button{all:unset;cursor:pointer;color:#fff;font:600 12px/1 system-ui,-apple-system,sans-serif;padding:8px 12px;border-radius:999px;white-space:nowrap}
    #feel-chip button:hover{background:rgba(255,255,255,.14)} #feel-chip button[data-a=del]:hover{background:rgba(255,90,95,.3)}`;
  document.head.appendChild(css);
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'rot') document.getElementById('bRotate')?.click();
    if (a === 'del') removeSelected();
  });
  document.body.appendChild(el);
  return el;
}
function hideChip() { if (chip) chip.classList.remove('on'); chipFor = null; }
function showChip(w, item) {
  if (!chip) chip = makeChip();
  const top = _v.set(footCache.cx, footCache.cy, footCache.top + 0.12);
  top.applyMatrix4(item.matrixWorld);
  const p = top.clone().project(w.camera);
  const behind = p.z > 1 || p.z < -1;
  if (behind || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05) { chip.classList.remove('on'); return; }
  chip.style.left = `${(p.x * 0.5 + 0.5) * innerWidth}px`;
  chip.style.top = `${(-p.y * 0.5 + 0.5) * innerHeight - 8}px`;
  chip.classList.add('on');
  chipFor = item;
}

/** Remove the selected piece with a short shrink, then the dock's Delete (so app.js clears its state). */
function removeSelected() {
  const w = W(), item = w && w.selected;
  if (!item) return;
  const t0 = performance.now(), parts = bodyParts(item);
  const bases = parts.map((p) => ({ p, s: p.scale.clone() }));
  hideChip();
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / 180);
    for (const { p, s } of bases) p.scale.set(s.x * (1 - 0.6 * t), s.y * (1 - 0.6 * t), s.z * (1 - t * 0.95));
    if (t < 1) requestAnimationFrame(step);
    else {
      if (w.selected === item) document.getElementById('bDelete')?.click();
      else if (item.parent) item.parent.remove(item);
    }
  };
  requestAnimationFrame(step);
}

(function start(tries = 0) {
  if (OFF) return;
  const w = W();
  if (!w || !w.beforeRender || !w.furniture) { if (tries < 600) setTimeout(() => start(tries + 1), 50); return; }
  started = performance.now();
  for (const item of w.furniture.children) seen.add(item);
  w.beforeRender.add(tick);
  w.feel = feel;
})();
