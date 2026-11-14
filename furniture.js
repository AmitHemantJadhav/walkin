// Real-size furniture built from boxes. Units: metres. Local frame: x = width, y = depth (front faces -y), z up,
// origin at the centre of the footprint on the floor.
import * as THREE from 'three';

export const FURNITURE = {
  sofa: { name: 'Sofa', w: 2.1, d: 0.95, h: 0.85 },
  armchair: { name: 'Armchair', w: 0.9, d: 0.9, h: 0.95 },
  queen: { name: 'Queen bed', w: 1.6, d: 2.1, h: 1.1 },
  king: { name: 'King bed', w: 1.95, d: 2.15, h: 1.1 },
  table: { name: 'Dining table', w: 1.8, d: 0.9, h: 0.75 },
  desk: { name: 'Desk', w: 1.4, d: 0.7, h: 0.75 },
};

const mat = (color, roughness = 0.85) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
const M = {
  fabric: mat(0xb8b2a7), cushion: mat(0xcfc9be), dark: mat(0x2b2b2e, 0.6), wood: mat(0x8a5a3b, 0.6),
  sheet: mat(0xf3f0ea), pillow: mat(0xe7e2d8), top: mat(0x6e4a33, 0.5),
};

let shadowTex;
function shadow(w, d) {
  if (!shadowTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 10, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    shadowTex = new THREE.CanvasTexture(c);
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.25, d * 1.25),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  m.position.z = 0.002;
  m.renderOrder = 1;
  return m;
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

export function buildFurniture(kind) {
  const spec = FURNITURE[kind];
  const g = new THREE.Group();
  g.userData.kind = kind;
  const builder = BUILDERS[kind] || BUILDERS[kind === 'queen' || kind === 'king' ? 'bed' : 'table'];
  builder(g, spec);
  g.add(shadow(spec.w, spec.d));
  return g;
}
