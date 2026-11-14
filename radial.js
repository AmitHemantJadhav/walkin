// radial.js — A5: the in-headset radial menu. Pinch and hold still in empty space for 0.6 s and a ring of options
// opens around your hand; move the hand toward one (it grows) and let go to pick it, or let go in the middle to cancel.
// It is drawn in the 3D scene (not HTML) so both eyes see it in the side-by-side headset view, and it is anchored
// to the screen point where you pinched, re-placed every frame so it stays with you while you turn your head.
// app.js owns the gesture (when a hold starts, ends, moves) and the actions; this file only draws and picks.
import * as THREE from 'three';

const RING = 0.14;  // ring radius, as a fraction of the screen height
const DEAD = 0.045; // hand closer than this to where you pinched = nothing picked (let go to cancel)
const SIZE = 0.085; // one option's size, fraction of the screen height
const DIST = 0.55;  // metres in front of the camera (about where your hands are drawn)

function tile(icon, label) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(18,18,22,0.8)';
  x.beginPath(); x.arc(64, 64, 61, 0, Math.PI * 2); x.fill();
  x.lineWidth = 4; x.strokeStyle = 'rgba(255,255,255,0.9)'; x.stroke();
  x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#fff';
  x.font = '50px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif';
  x.fillText(icon, 64, 52);
  x.font = '600 19px system-ui,-apple-system,sans-serif';
  x.fillText(label, 64, 99);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function sprite(map) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
  s.renderOrder = 60; // over the pano, the furniture and the hands
  return s;
}

/**
 * items: [{ icon, label (string or () => string), run(floor) }], six of them, clockwise from the top.
 * toWorld(sx, sy, depth, outVec3): screen point (0..1) at a distance from the camera -> world point.
 * aspect(): width / height of one eye.
 */
export function createRadial({ scene, camera, toWorld, aspect, items }) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const slots = items.map((it) => { const s = sprite(null); group.add(s); return { it, s, label: null }; });
  const centre = sprite(tile('✕', ''));
  group.add(centre);
  let st = null; // { side, sx, sy, hx, hy, floor, hot }

  function layout() { // screen-anchored: re-place in the world from the current camera every frame
    if (!st) return;
    const a = aspect(), h = 2 * DIST * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    // keep the whole ring on screen even if you pinched near an edge
    const cx = THREE.MathUtils.clamp(st.sx, (RING + SIZE) / a, 1 - (RING + SIZE) / a);
    const cy = THREE.MathUtils.clamp(st.sy, RING + SIZE, 1 - RING - SIZE);
    slots.forEach(({ s }, i) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / slots.length;
      toWorld(cx + (RING * Math.cos(ang)) / a, cy + RING * Math.sin(ang), DIST, s.position);
      s.scale.setScalar(h * SIZE * (st.hot === i ? 1.3 : 1));
      s.material.color.setScalar(st.hot === i || st.hot == null ? 1 : 0.6);
    });
    toWorld(cx, cy, DIST, centre.position);
    centre.scale.setScalar(h * SIZE * 0.45);
    centre.material.color.setScalar(st.hot == null ? 1 : 0.5);
  }

  return {
    get side() { return st ? st.side : null; },
    get state() { return st ? { side: st.side, hot: st.hot, label: st.hot == null ? null : slots[st.hot].label } : null; },
    open(side, sx, sy, floor) {
      for (const sl of slots) { // labels can change (Empty <-> Scanned): redraw only the ones that did
        const l = typeof sl.it.label === 'function' ? sl.it.label() : sl.it.label;
        if (l !== sl.label) { sl.s.material.map?.dispose(); sl.s.material.map = tile(sl.it.icon, l); sl.s.material.needsUpdate = true; sl.label = l; }
      }
      st = { side, sx, sy, hx: sx, hy: sy, floor, hot: null };
      group.visible = true;
      layout();
    },
    point(hx, hy) { // which option the hand is moving toward, from where you pinched (direction only, so edges work)
      if (!st) return;
      const dx = (hx - st.hx) * aspect(), dy = hy - st.hy;
      if (Math.hypot(dx, dy) < DEAD) { st.hot = null; return; }
      const n = slots.length, k = Math.round(((Math.atan2(dy, dx) + Math.PI / 2) * n) / (2 * Math.PI));
      st.hot = ((k % n) + n) % n;
    },
    release() { // let go: run the option you were on, if any
      if (!st) return null;
      const { hot, floor } = st;
      this.cancel();
      if (hot == null) return null;
      try { slots[hot].it.run(floor); } catch (e) { console.warn('radial menu:', e); }
      return slots[hot].label;
    },
    cancel() { st = null; group.visible = false; },
    layout,
  };
}
