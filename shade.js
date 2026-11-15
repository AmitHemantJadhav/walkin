// Read the photo's own light off a surface.
// For a wall rectangle in model space, sample the current pano in the direction of each point and build a
// small light map from it. Multiplying a new material by that map carries the room's real shadows, the
// window falloff and the darker corners onto whatever we draw there — the reason a papered wall in
// walls.js sits in the photo instead of glowing on top of it.
import * as THREE from 'three';
import { localToModel } from './lighting.js';

const SRC = 512;                 // the pano is read back at 512 x 256; plenty for a 24 x 16 light map
const cache = new Map();         // pano url -> ImageData

const canvas = document.createElement('canvas');
canvas.width = SRC;
canvas.height = SRC / 2;
const ctx = canvas.getContext('2d', { willReadFrequently: true });

/** The current pano, read back as pixels once per image. */
export function panoPixels(url) {
  if (!cache.has(url)) {
    cache.set(url, new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        try {
          ctx.drawImage(img, 0, 0, SRC, SRC / 2);
          res(ctx.getImageData(0, 0, SRC, SRC / 2));
        } catch (e) { res(null); }
      };
      img.onerror = () => res(null);
      img.src = url;
    }));
  }
  return cache.get(url);
}

/** Which pano file is on screen, as a URL. */
function currentPanoUrl() {
  const w = window.walkin;
  if (!w || !w.current) return null;
  const btn = document.getElementById('bEmpty');
  const empty = !btn || btn.classList.contains('on');
  const file = (empty && w.current.imgEmpty) || w.current.img || w.current.imgEmpty;
  if (!file) return null;
  return `${location.pathname.replace(/[^/]*$/, '')}data/${w.house.model}/${file}`;
}

const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * A light map for one wall rectangle, sampled from the pano the viewer is standing in.
 * Values are relative to the wall's own average, so the texture keeps its own brightness and only
 * picks up the shape of the light. Returns a DataTexture for `material.lightMap`, or null.
 */
export async function panoLuminance(wall, height, nu = 24, nv = 16, normal = null) {
  const w = window.walkin;
  const url = currentPanoUrl();
  if (!w || !url) return null;
  const px = await panoPixels(url);
  if (!px) return null;

  const pano = w.current;
  const [ox, oy, oz] = pano.pos;
  const floorZ = pano.floorZ || 0;
  const inv = new THREE.Matrix3().setFromMatrix4(localToModel(pano, w.cal)).invert();

  const ax = wall.a[0], ay = wall.a[1];
  const len = Math.hypot(wall.b[0] - ax, wall.b[1] - ay) || 1;
  const dx = (wall.b[0] - ax) / len, dy = (wall.b[1] - ay) / len;
  const nx = normal ? normal[0] : -dy, ny = normal ? normal[1] : dx;

  const data = new Uint8Array(nu * nv * 4);
  const vals = new Float32Array(nu * nv);
  const d = new THREE.Vector3();
  let sum = 0;

  for (let j = 0; j < nv; j++) {
    const v = ((j + 0.5) / nv) * height;
    for (let i = 0; i < nu; i++) {
      const u = ((i + 0.5) / nu) * len;
      // a point just off the wall face, in model space
      const px3 = ax + dx * u + nx * 0.02;
      const py3 = ay + dy * u + ny * 0.02;
      const pz3 = floorZ + v;
      d.set(px3 - ox, py3 - oy, pz3 - oz).normalize().applyMatrix3(inv).normalize();
      const lon = Math.atan2(d.x, d.z);
      const lat = Math.asin(Math.max(-1, Math.min(1, d.y)));
      const sx = Math.min(SRC - 1, Math.max(0, Math.round((lon / (2 * Math.PI) + 0.5) * SRC)));
      const sy = Math.min(SRC / 2 - 1, Math.max(0, Math.round((0.5 - lat / Math.PI) * (SRC / 2))));
      const k = (sy * SRC + sx) * 4;
      const value = lum(px.data[k], px.data[k + 1], px.data[k + 2]);
      vals[j * nu + i] = value;
      sum += value;
    }
  }

  const mean = sum / (nu * nv) || 1;
  for (let k = 0; k < vals.length; k++) {
    // relative to this wall's own average, and never so dark or bright that the texture disappears
    const rel = Math.max(0.45, Math.min(1.5, vals[k] / mean));
    const byte = Math.round(Math.min(255, (rel / 1.5) * 255));
    data[k * 4] = data[k * 4 + 1] = data[k * 4 + 2] = byte;
    data[k * 4 + 3] = 255;
  }

  const tex = new THREE.DataTexture(data, nu, nv, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  // The map is laid out over the whole wall, so it reads walls.js's second uv set (uv1, 0..1 over the wall).
  // Without this three.js samples it with the tiled uv (0..len/tile), the clamp smears the edge texels over
  // everything past the first tile, and the paint comes out streaky.
  tex.channel = 1;
  // walls.js multiplies lightMapIntensity back up by this. MeshBasicMaterial scales a light map by 1/PI
  // (three r155+), which left every painted wall about a third as bright as its colour: sage green came out
  // dark olive. Put the PI back here so an evenly lit wall shows its real colour.
  tex.userData.scale = 1.5 * Math.PI;
  return tex;
}
