// Real-size furniture. Units: metres. Local frame: x = width, y = depth (front faces -y), z up,
// origin at the centre of the footprint on the floor.
// Each kind is a CC0 glTF model from Kenney's Furniture Kit (see models/CREDITS.md), rescaled to the
// catalog's real metres. The box builders below stay as the fallback while a model loads or if it fails.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const FURNITURE = {
  sofa: { name: 'Sofa', w: 2.1, d: 0.95, h: 0.95, model: 'loungeSofa.glb' },
  armchair: { name: 'Armchair', w: 0.9, d: 0.9, h: 0.95, model: 'loungeChair.glb' },
  queen: { name: 'Queen bed', w: 1.6, d: 2.1, h: 0.7, model: 'bedDouble.glb' },
  king: { name: 'King bed', w: 1.95, d: 2.15, h: 0.75, model: 'bedDouble.glb' },
  table: { name: 'Dining table', w: 1.8, d: 0.9, h: 0.74, model: 'table.glb' },
  desk: { name: 'Desk', w: 1.4, d: 0.7, h: 0.74, model: 'desk.glb' },
};

// Resolved against this module, not the page, so models/preview.html loads the same files as index.html.
const MODEL_DIR = new URL('models/', import.meta.url).href;
// The kit's models are glTF Y-up and face +z before the Y-up -> Z-up turn; these face the other way,
// so they get a half turn to put the front on -y.
const FLIPPED = new Set(['loungeSofa.glb', 'loungeChair.glb']);

// ------------------------------------------------------------------ box fallback (also used by preview.html)
const mat = (color, roughness = 0.85) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
const M = {
  fabric: mat(0xb8b2a7), cushion: mat(0xcfc9be), dark: mat(0x2b2b2e, 0.6), wood: mat(0x8a5a3b, 0.6),
  sheet: mat(0xf3f0ea), pillow: mat(0xe7e2d8), top: mat(0x6e4a33, 0.5),
};

// ------------------------------------------------------------------ contact shadow
// A soft blob under each piece, not a shadow map: phones can't afford one, and the photo already
// contains the room's real shadows. lighting.js sets the strength from how bright the pano is.
let shadowTex;
const shadows = new Set();
let shadowOpacity = 0.45;

function shadowTexture() {
  if (!shadowTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.45, 'rgba(0,0,0,0.62)');   // dark right under the piece, then falls off fast
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    shadowTex = new THREE.CanvasTexture(c);
  }
  return shadowTex;
}

function shadow(w, d) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.22, d * 1.22),
    new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: shadowOpacity }));
  m.position.z = 0.002;
  m.renderOrder = 1;
  shadows.add(m);
  return m;
}

/** How dark the contact shadows are (lighting.js calls this with the room's brightness). */
export function setContactShadow({ opacity }) {
  if (opacity == null) return;
  shadowOpacity = THREE.MathUtils.clamp(opacity, 0, 1);
  for (const m of shadows) {
    if (m.parent) m.material.opacity = shadowOpacity;
    else shadows.delete(m);                       // the piece was deleted
  }
}

function box(group, w, d, h, x, y, z, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), material);
  m.position.set(x, y, z + h / 2);
  m.renderOrder = 2;
  group.add(m);
  return m;
}

function legs(g, w, d, h, inset = 0.06, size = 0.05, material = M.dark) {
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(g, size, size, h, sx * (w / 2 - inset), sy * (d / 2 - inset), 0, material);
}

const BUILDERS = {
  sofa(g, { w, d }) {
    legs(g, w, d, 0.1);
    box(g, w, d, 0.32, 0, 0, 0.1, M.fabric);                       // base
    box(g, w, 0.22, 0.45, 0, d / 2 - 0.11, 0.42, M.fabric);         // back
    for (const s of [-1, 1]) box(g, 0.2, d, 0.3, s * (w / 2 - 0.1), 0, 0.42, M.fabric); // arms
    const cw = (w - 0.42) / 3;
    for (let i = 0; i < 3; i++) box(g, cw - 0.02, d - 0.27, 0.12, -w / 2 + 0.21 + cw * (i + 0.5), -0.1, 0.42, M.cushion);
  },
  armchair(g, { w, d }) {
    legs(g, w, d, 0.12);
    box(g, w, d, 0.3, 0, 0, 0.12, M.fabric);
    box(g, w, 0.2, 0.53, 0, d / 2 - 0.1, 0.42, M.fabric);
    for (const s of [-1, 1]) box(g, 0.16, d, 0.25, s * (w / 2 - 0.08), 0, 0.42, M.fabric);
    box(g, w - 0.34, d - 0.25, 0.1, 0, -0.08, 0.42, M.cushion);
  },
  bed(g, { w, d, h }) {
    box(g, w, d, 0.3, 0, 0, 0.05, M.wood);                          // frame
    legs(g, w, d, 0.05, 0.05, 0.06, M.wood);
    box(g, w - 0.06, d - 0.1, 0.24, 0, -0.03, 0.35, M.sheet);       // mattress
    box(g, w + 0.06, 0.08, h, 0, d / 2 + 0.02, 0, M.wood);          // headboard
    const pw = (w - 0.3) / 2;
    for (const s of [-1, 1]) box(g, pw, 0.4, 0.12, s * (pw / 2 + 0.05), d / 2 - 0.35, 0.59, M.pillow);
    box(g, w - 0.04, d * 0.45, 0.04, 0, -d / 2 + d * 0.25, 0.59, M.cushion); // blanket fold
  },
  table(g, { w, d, h }) {
    legs(g, w, d, h - 0.04, 0.1, 0.07, M.top);
    box(g, w, d, 0.04, 0, 0, h - 0.04, M.top);
  },
  desk(g, { w, d, h }) {
    box(g, w, d, 0.035, 0, 0, h - 0.035, M.top);
    for (const s of [-1, 1]) box(g, 0.04, d, h - 0.035, s * (w / 2 - 0.02), 0, 0, M.dark);
    box(g, w - 0.08, 0.02, 0.3, 0, d / 2 - 0.03, h - 0.335, M.dark);
  },
};

export function buildBoxes(kind) {
  const spec = FURNITURE[kind];
  const g = new THREE.Group();
  const builder = BUILDERS[kind] || BUILDERS[kind === 'queen' || kind === 'king' ? 'bed' : 'table'];
  builder(g, spec);
  return g;
}

// ------------------------------------------------------------------ glTF models
const loader = new GLTFLoader();
const loads = new Map(); // file -> Promise<THREE.Object3D> (one fetch per file, cloned per item)

function load(file) {
  if (!loads.has(file)) {
    loads.set(file, loader.loadAsync(MODEL_DIR + file).then((gltf) => gltf.scene).catch((e) => {
      console.warn(`furniture: ${file} failed to load, using boxes`, e);
      return null;
    }));
  }
  return loads.get(file);
}

/** Load every catalog model now, so the first click doesn't wait on the network. */
export function preloadModels() {
  return Promise.all([...new Set(Object.values(FURNITURE).map((s) => s.model))].filter(Boolean).map(load));
}

/**
 * Turn a glTF model (Y-up, arbitrary origin and scale) into our frame: x = width, y = depth with the front
 * on -y, z up from the floor, sized to the catalog's real `w x d x h`.
 */
function fitToSpec(src, spec, flipped) {
  const b = new THREE.Box3().setFromObject(src);
  const size = b.getSize(new THREE.Vector3());
  const c = b.getCenter(new THREE.Vector3());
  // model x -> our width, model z -> our depth, model y -> our height
  const sx = spec.w / size.x, sd = spec.d / size.z, sh = spec.h / size.y;
  src.scale.set(sx, sh, sd);
  src.position.set(-c.x * sx, -b.min.y * sh, -c.z * sd); // centred on x/z, standing on y = 0
  src.traverse((o) => {
    if (!o.isMesh) return;
    o.renderOrder = 2;          // after the depth-only occluders
    o.castShadow = o.receiveShadow = false;
  });

  const zUp = new THREE.Group();
  zUp.rotation.x = Math.PI / 2; // glTF Y-up -> world Z-up (model +z ends up on -y)
  zUp.add(src);

  const g = new THREE.Group();
  if (flipped) g.rotation.z = Math.PI;
  g.add(zUp);
  return g;
}

/**
 * A piece of furniture, ready to add to the scene. Returns synchronously: the group starts with the box
 * fallback and swaps in the real model when it arrives (the boxes stay if the model can't be loaded).
 */
export function buildFurniture(kind) {
  const spec = FURNITURE[kind];
  const g = new THREE.Group();
  g.userData.kind = kind;
  const boxes = buildBoxes(kind);
  g.add(boxes);
  g.add(shadow(spec.w, spec.d));

  if (spec.model) {
    load(spec.model).then((src) => {
      if (!src) return;          // load failed: keep the boxes
      g.remove(boxes);
      g.add(fitToSpec(src.clone(true), spec, FLIPPED.has(spec.model)));
      g.userData.model = spec.model;
    });
  }
  return g;
}

preloadModels(); // 65 KB in total: fetch them while the house loads, so the first click is instant
