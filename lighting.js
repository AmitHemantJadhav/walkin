// S2 — make the furniture sit in the photo.
// Reads the current pano, and from it sets the scene's ambient tint, a key light pointing the way the
// brightest part of the photo does (usually a window), and the strength of each piece's contact shadow.
// No shadow maps: phones can't afford them. Talks to the viewer only through window.walkin.
import * as THREE from 'three';
import { setContactShadow } from './furniture.js';

const SIZE = 64;                       // the pano is sampled at 64 x 32 — plenty for an average and a bright spot
const AXES = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1); // local y -> model z

const canvas = document.createElement('canvas');
canvas.width = SIZE;
canvas.height = SIZE / 2;
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const cache = new Map();               // pano url -> light description

/** local (pano) direction -> model direction, the same matrix app.js builds for the sphere shader. */
function localToModel(pano, cal) {
  const q = new THREE.Quaternion();
  if (pano.rot && cal.qMode) {
    q.set(pano.rot[0], pano.rot[1], pano.rot[2], pano.rot[3]).normalize();
    if (cal.qMode === 2) q.invert();
  }
  return new THREE.Matrix4().makeRotationFromQuaternion(q)
    .multiply(AXES)
    .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(cal.yaw)))
    .multiply(new THREE.Matrix4().makeScale(cal.mirror ? -1 : 1, 1, 1));
}

const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.4722 * b) / 255 / 1.4;

/**
 * Average colours and the brightest direction of one equirectangular pano.
 * Returns sRGB 0..1 colours, a pano-local unit vector for the key light, and mean luminance 0..1.
 */
function readPano(img) {
  ctx.drawImage(img, 0, 0, SIZE, SIZE / 2);
  const px = ctx.getImageData(0, 0, SIZE, SIZE / 2).data;
  const up = [0, 0, 0], down = [0, 0, 0];
  let upW = 0, downW = 0, mean = 0, total = 0;
  const cells = [];

  for (let y = 0; y < SIZE / 2; y++) {
    const lat = (0.5 - (y + 0.5) / (SIZE / 2)) * Math.PI;   // +pi/2 at the top row
    const w = Math.cos(lat);                                // equirect rows near the poles cover less sphere
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const l = lum(r, g, b);
      const target = lat >= 0 ? up : down;
      target[0] += r * w; target[1] += g * w; target[2] += b * w;
      if (lat >= 0) upW += w; else downW += w;
      mean += l * w; total += w;
      if (lat > -0.25) cells.push({ x, y, lat, l, r, g, b });  // keep everything at or above the floor line
    }
  }

  // key light: luminance^6-weighted centroid of the brightest cells, so a window wins over a bright wall
  cells.sort((a, b) => b.l - a.l);
  const bright = cells.slice(0, Math.max(4, Math.round(cells.length * 0.02)));
  const dir = new THREE.Vector3();
  const sun = [0, 0, 0];
  let sw = 0;
  for (const c of bright) {
    const w = Math.pow(c.l, 6);
    const lon = ((c.x + 0.5) / SIZE - 0.5) * 2 * Math.PI;
    dir.add(new THREE.Vector3(Math.sin(lon) * Math.cos(c.lat), Math.sin(c.lat), Math.cos(lon) * Math.cos(c.lat))
      .multiplyScalar(w));
    sun[0] += c.r * w; sun[1] += c.g * w; sun[2] += c.b * w;
    sw += w;
  }
  if (dir.lengthSq() < 1e-9) dir.set(0, 1, 0);
  dir.normalize();

  const norm = (c, w) => (w ? [c[0] / w / 255, c[1] / w / 255, c[2] / w / 255] : [1, 1, 1]);
  return {
    sky: norm(up, upW), ground: norm(down, downW), sun: norm(sun, sw),
    local: dir, mean: mean / (total || 1),
    bright: bright.length ? bright.reduce((a, c) => a + c.l, 0) / bright.length : 0.5,
  };
}

function loadPano(url) {
  if (!cache.has(url)) {
    cache.set(url, new Promise((res) => {
      const img = new Image();
      img.onload = () => { try { res(readPano(img)); } catch (e) { console.warn('lighting: pano unreadable', e); res(null); } };
      img.onerror = () => res(null);
      img.src = url;
    }));
  }
  return cache.get(url);
}

/** Pull the colour out of an sRGB triple and leave the brightness as a separate number. */
function split(rgb) {
  const peak = Math.max(rgb[0], rgb[1], rgb[2], 1e-3);
  return { color: new THREE.Color().setRGB(rgb[0] / peak, rgb[1] / peak, rgb[2] / peak, THREE.SRGBColorSpace), level: peak };
}

function findLights(scene) {
  let hemi = null, dir = null;
  scene.traverse((o) => {
    if (o.isHemisphereLight && !hemi) hemi = o;
    else if (o.isDirectionalLight && !dir) dir = o;
  });
  return { hemi, dir };
}

/** Apply one pano's light to the scene. Exposed as walkin.relight() for the agent and for debugging. */
export async function relight(panoOverride) {
  const w = window.walkin;
  if (!w || !w.current) return null;
  const pano = panoOverride || w.current;
  const base = location.pathname.replace(/[^/]*$/, '');
  const file = (showingEmpty() && pano.imgEmpty) || pano.img || pano.imgEmpty;
  if (!file) return null;
  const light = await loadPano(`${base}data/${w.house.model}/${file}`);
  if (!light) return null;

  const { hemi, dir } = findLights(w.scene);
  const sky = split(light.sky), ground = split(light.ground), sun = split(light.sun);

  // the photo already contains all the bounced light, so the scene light only has to match its colour and level
  if (hemi) {
    hemi.color.copy(sky.color);
    hemi.groundColor.copy(ground.color);
    hemi.intensity = THREE.MathUtils.clamp(light.mean * 2.7, 0.5, 1.9);
  }
  if (dir) {
    const d = light.local.clone().applyMatrix4(localToModel(pano, w.cal)).normalize();
    if (d.z < 0.08) { d.z = 0.08; d.normalize(); }     // never light a room from below the floor
    dir.position.copy(d).multiplyScalar(8);
    dir.color.copy(sun.color);
    dir.intensity = THREE.MathUtils.clamp((light.bright - light.mean) * 4.2, 0.35, 2.0);
    dir.target.position.set(0, 0, 0);
  }

  // a dark room gets a lighter shadow, a bright one a deeper contact
  setContactShadow({ opacity: THREE.MathUtils.clamp(0.18 + light.mean * 0.55, 0.16, 0.6) });

  const d = dir ? dir.position.clone().normalize() : new THREE.Vector3();
  console.log(`lighting ${pano.id}: mean ${light.mean.toFixed(2)} · ambient ${hemi ? hemi.intensity.toFixed(2) : '-'}`
    + ` ${split(light.sky).color.getHexString()} · key ${dir ? dir.intensity.toFixed(2) : '-'}`
    + ` ${sun.color.getHexString()} from (${d.x.toFixed(2)}, ${d.y.toFixed(2)}, ${d.z.toFixed(2)})`);
  return light;
}

// ------------------------------------------------------------------ keep it in step with the viewer
// Which pano is on screen: the empty/as-scanned toggle changes the photo without changing the scan point,
// and app.js doesn't publish that state, so read it off its button.
const emptyBtn = document.getElementById('bEmpty');
const showingEmpty = () => !emptyBtn || emptyBtn.classList.contains('on');

let last = null;
function tick() {
  const w = window.walkin;
  if (w && w.current) {
    const key = `${w.current.id}/${showingEmpty()}`;
    if (key !== last) {
      last = key;
      relight().catch((e) => console.warn('lighting failed', e));
    }
  }
  requestAnimationFrame(tick);
}

(function start(tries = 0) {
  if (!window.walkin) {
    if (tries < 600) return setTimeout(() => start(tries + 1), 50);  // app.js awaits the house before it publishes
    return console.warn('lighting: window.walkin never appeared');
  }
  window.walkin.relight = relight;
  tick();
})();
