// Real-size furniture. Units: metres. Local frame: x = width, y = depth (front faces -y), z up,
// origin at the centre of the footprint on the floor.
// Each kind is a CC0 glTF model from Kenney's Furniture Kit (see models/CREDITS.md), rescaled to the
// catalog's real metres. The box builders below stay as the fallback while a model loads or if it fails.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// `against` says how a piece wants to be placed when staging a room:
//   'wall'   back to a wall        'free' anywhere        'small' a small object that sits beside something else
export const FURNITURE = {
  sofa: { name: 'Sofa', w: 2.1, d: 0.95, h: 0.95, model: 'loungeSofa.glb', hero: 'hero/Sofa_01/Sofa_01_1k.gltf', against: 'wall' },
  armchair: { name: 'Armchair', w: 0.9, d: 0.9, h: 0.95, model: 'loungeChair.glb', hero: 'hero/ArmChair_01/ArmChair_01_1k.gltf', against: 'free', tone: 'fabricLt' },
  queen: { name: 'Queen bed', w: 1.6, d: 2.1, h: 0.7, model: 'bedDouble.glb', against: 'wall' },
  king: { name: 'King bed', w: 1.95, d: 2.15, h: 0.75, model: 'bedDouble.glb', against: 'wall' },
  table: { name: 'Dining table', w: 1.8, d: 0.9, h: 0.74, model: 'table.glb', against: 'free' },
  desk: { name: 'Desk', w: 1.4, d: 0.7, h: 0.74, model: 'desk.glb', against: 'wall' },
  // pieces a staged room needs
  chair: { name: 'Chair', w: 0.45, d: 0.5, h: 0.9, model: 'chairModernFrameCushion.glb', against: 'small' },
  nightstand: { name: 'Nightstand', w: 0.5, d: 0.45, h: 0.55, model: 'cabinetBedDrawer.glb', against: 'small', tone: 'woodLt' },
  sidetable: { name: 'Side table', w: 0.55, d: 0.45, h: 0.45, model: 'sideTable.glb', against: 'small', tone: 'woodLt' },
  coffeetable: { name: 'Coffee table', w: 1.2, d: 0.7, h: 0.45, model: 'tableCoffee.glb', against: 'free' },
  tvstand: { name: 'TV stand', w: 1.4, d: 0.4, h: 0.5, model: 'cabinetTelevision.glb', against: 'wall', tone: 'woodLt' },
  tv: { name: 'Television', w: 1.25, d: 0.25, h: 0.78, model: 'televisionModern.glb', against: 'small' },
  bookcase: { name: 'Bookcase', w: 0.8, d: 0.35, h: 1.8, model: 'bookcaseOpen.glb', against: 'wall', tone: 'woodLt' },
  floorlamp: { name: 'Floor lamp', w: 0.35, d: 0.35, h: 1.6, model: 'lampRoundFloor.glb', against: 'small' },
  rug: { name: 'Rug', w: 2.4, d: 1.6, h: 0.015, model: 'rugRectangle.glb', against: 'free', flat: true, tone: 'fabricLt' },
  ruground: { name: 'Round rug', w: 1.8, d: 1.8, h: 0.015, model: 'rugRound.glb', against: 'free', flat: true, tone: 'fabricLt' },
  plant: { name: 'Plant', w: 0.45, d: 0.45, h: 1.3, model: 'pottedPlant.glb', against: 'small' },
  plantsmall: { name: 'Small plant', w: 0.22, d: 0.22, h: 0.32, model: 'plantSmall1.glb', against: 'small' },
  plantfern: { name: 'Fern', w: 0.24, d: 0.22, h: 0.34, model: 'plantSmall2.glb', against: 'small' },
  plantsucculent: { name: 'Succulent', w: 0.22, d: 0.2, h: 0.33, model: 'plantSmall3.glb', against: 'small' },
  cactus: { name: 'Cactus', w: 0.3, d: 0.3, h: 0.5, model: 'cactus_short.glb', against: 'small' },
  cactustall: { name: 'Tall cactus', w: 0.35, d: 0.3, h: 0.75, model: 'cactus_tall.glb', against: 'small' },
};

/** The six plants, for "what plant should go here" (R5). */
export const PLANTS = ['plant', 'plantsmall', 'plantfern', 'plantsucculent', 'cactus', 'cactustall'];

// Resolved against this module, not the page, so models/preview.html loads the same files as index.html.
const MODEL_DIR = new URL('models/', import.meta.url).href;
// The kit's models are glTF Y-up and face +z before the Y-up -> Z-up turn; these face the other way,
// so they get a half turn to put the front on -y.
const FLIPPED = new Set(['loungeSofa.glb', 'loungeChair.glb']);
// Photoreal CC0 pieces from Poly Haven (see models/CREDITS.md). They are bigger than the kit models,
// so they load after it: a piece appears instantly as the kit model and sharpens when the hero arrives.
const HERO_FLIPPED = new Set();


// ------------------------------------------------------------------ materials (S7)
// The Kenney kits ship a pastel palette (salmon sofas, pale tan wood) that reads as toys next to a
// photo of a real room. Every material in those files is named by what it is - wood, metal, carpet,
// plant, lamp - so we can swap in a neutral palette part by part instead of guessing from colours.
export const STYLES = {
  modern: { fabric: 0x8e8a84, fabricLt: 0xcfc8bb, fabricDk: 0x46464a, wood: 0x6b4a32, woodLt: 0xa9825a,
            metal: 0x2a2a2d, leaf: 0x4f6b4a, shade: 0xeee5d2, hero: 0xdedcd8, name: 'modern' },
  cozy:   { fabric: 0xa07a63, fabricLt: 0xe0d3bd, fabricDk: 0x55402f, wood: 0x5c3b25, woodLt: 0x946a42,
            metal: 0x3a3430, leaf: 0x55693f, shade: 0xf2e3c4, hero: 0xe8c6a0, name: 'cozy' },
  scandi: { fabric: 0xb6b2aa, fabricLt: 0xe6e2d9, fabricDk: 0x5d6168, wood: 0xb08a5e, woodLt: 0xd2b58a,
            metal: 0x3c3f44, leaf: 0x5d7a55, shade: 0xf6f1e6, hero: 0xf2efe7, name: 'scandi' },
};
const DEFAULT_STYLE = 'modern';
let currentStyle = DEFAULT_STYLE;

const ROUGH = { fabric: 0.94, wood: 0.55, metal: 0.35, leaf: 0.72, shade: 0.6 };

/** Which part of the palette one of the kit's materials belongs to. */
function partOf(name, lightness) {
  const n = (name || '').toLowerCase();
  if (n.includes('wood')) return n.includes('dark') ? 'wood' : 'woodLt';
  if (n.includes('metal')) return 'metal';
  if (n.includes('plant') || n.includes('leaf') || n.includes('green')) return 'leaf';
  if (n.includes('lamp') || n.includes('light')) return 'shade';
  if (lightness > 0.85) return 'fabricLt';
  if (lightness < 0.4) return 'fabricDk';
  return 'fabric';
}

const styled = new Map();   // `${style}|${source material uuid}` -> the restyled material

function styleMaterial(src, style, tone) {
  const pal = STYLES[style] || STYLES[DEFAULT_STYLE];
  const key = `${pal.name}|${tone || '-'}|${src.uuid}`;
  if (styled.has(key)) return styled.get(key);

  const hsl = { h: 0, s: 0, l: 0.5 };
  if (src.color) src.color.getHSL(hsl);
  const part = tone && pal[tone] !== undefined ? tone : partOf(src.name, hsl.l);
  const m = src.clone();
  m.color = new THREE.Color(pal[part]);
  // keep a little of the original light/dark variation, so pillows stay lighter than the duvet
  m.color.multiplyScalar(THREE.MathUtils.clamp(0.88 + 0.24 * hsl.l, 0.78, 1.18));
  m.roughness = ROUGH[part] !== undefined ? ROUGH[part] : (ROUGH[part.replace(/Lt|Dk/, '')] || 0.85);
  m.metalness = part === 'metal' ? 0.65 : 0;
  m.name = `${part}:${pal.name}`;
  styled.set(key, m);
  return m;
}

/** Re-material one piece (or everything under a group) in the given style. */
export function applyStyle(root, style = currentStyle) {
  const tone = (FURNITURE[root.userData.kind] || {}).tone;
  const pal = STYLES[style] || STYLES[DEFAULT_STYLE];
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.userData.hero) o.material.color.setHex(pal.hero);   // tint the photo texture, keep its detail
    else if (o.userData.styleSrc) o.material = styleMaterial(o.userData.styleSrc, style, tone);
  });
  root.userData.style = style;
  return root;
}

/** The style new pieces get; with a group it also restyles everything already in it. */
export function setStyle(style, group) {
  if (!STYLES[style]) return currentStyle;
  currentStyle = style;
  if (group) for (const child of group.children) applyStyle(child, style);
  return currentStyle;
}

export const getStyle = () => currentStyle;

// ------------------------------------------------------------------ box fallback (also used by preview.html)
const mat = (color, roughness = 0.85) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
const M = {
  fabric: mat(0x8e8a84, 0.94), cushion: mat(0xcfc8bb, 0.94), dark: mat(0x2a2a2d, 0.35), wood: mat(0x6b4a32, 0.55),
  sheet: mat(0xe6e2d9, 0.94), pillow: mat(0xcfc8bb, 0.94), top: mat(0xa9825a, 0.55),
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
    const grad = g.createRadialGradient(64, 64, 6, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.38, 'rgba(0,0,0,0.88)');   // solid right under the piece...
    grad.addColorStop(0.62, 'rgba(0,0,0,0.42)');   // ...then a soft edge, like real contact shading
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    shadowTex = new THREE.CanvasTexture(c);
  }
  return shadowTex;
}

function shadow(w, d) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.3, d * 1.3),
    new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: shadowOpacity }));
  m.position.z = 0.002;
  m.renderOrder = 1;
  shadows.add(m);
  return m;
}

const heroMats = new Set();            // hero materials, so the metalness clamp can be lifted later
let envReady = false;

/**
 * Whether the scene has an environment map. lighting.js calls this once it has built one from the photo.
 * Hero models ship metalness maps that drive parts of them to fully metallic; with nothing to reflect
 * those parts render black, so they are clamped until there is something. This flips them back.
 */
export function setEnvironmentReady(on) {
  if (envReady === !!on) return;
  envReady = !!on;
  for (const m of heroMats) {
    const authored = m.userData.authoredMetalness;
    if (typeof authored !== 'number') continue;
    m.metalness = envReady ? authored : Math.min(authored, 0.12);
    m.needsUpdate = true;
  }
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
  const builder = BUILDERS[kind] || (kind === 'queen' || kind === 'king' ? BUILDERS.bed : null);
  if (builder) builder(g, spec);
  else box(g, spec.w, spec.d, spec.h, 0, 0, 0, spec.flat ? M.fabric : M.cushion); // plain block until the model lands
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

/** The photoreal pieces, fetched once something is actually placed (2.2 MB, so not on page load). */
export function preloadHeroModels() {
  return Promise.all([...new Set(Object.values(FURNITURE).map((s) => s.hero))].filter(Boolean).map(load));
}

/**
 * Turn a glTF model (Y-up, arbitrary origin and scale) into our frame: x = width, y = depth with the front
 * on -y, z up from the floor, sized to the catalog's real `w x d x h`.
 */
function fitToSpec(src, spec, flipped, style, hero) {
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
    if (hero) {
      // These models ship real PBR maps — colour, roughness, metalness and normal — and the packed map
      // drives metalness to 1 on parts of them. A fully metallic surface with nothing to reflect renders
      // black, so while the scene had no environment this was clamped to 0.12 and the models were lit as
      // if they were made of paper. lighting.js now builds an environment from the photo, so the clamp
      // is lifted when there is one and the maps are used as the model's author intended. Without an
      // environment (?env=off, or before the first relight) the old clamp still applies.
      o.material = o.material.clone();
      o.material.userData.authoredMetalness = o.material.metalness;   // so the clamp can be undone
      heroMats.add(o.material);
      if (!envReady) o.material.metalness = Math.min(o.material.metalness, 0.12);
      o.material.envMapIntensity = 1;
      // CoffeeTable_01 ships a baked COLOR_0 attribute that multiplies its texture to black.
      // The textures already carry the look, so vertex colours are never wanted here.
      o.material.vertexColors = false;
      o.userData.hero = true;                  // styles tint these instead of recolouring them
      o.material.color.setHex((STYLES[style] || STYLES[DEFAULT_STYLE]).hero);
    } else {
      o.userData.styleSrc = o.material;        // the kit's own material, kept so the style can change
      o.material = styleMaterial(o.material, style, spec.tone);
    }
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
export function buildFurniture(kind, style = currentStyle) {
  const spec = FURNITURE[kind];
  const g = new THREE.Group();
  g.userData.kind = kind;
  g.userData.style = style;
  const boxes = buildBoxes(kind);
  g.add(boxes);
  g.add(shadow(spec.w, spec.d));

  let shown = boxes;
  const swapIn = (file, flipSet, isHero) => load(file).then((src) => {
    if (!src || (spec.hero && g.userData.model === spec.hero)) return;  // load failed, or the hero already won
    const next = fitToSpec(src.clone(true), spec, flipSet.has(file), g.userData.style || currentStyle, isHero);
    g.remove(shown);
    g.add(next);
    shown = next;
    g.userData.model = file;
  });

  if (spec.model) swapIn(spec.model, FLIPPED, false);
  if (spec.hero) swapIn(spec.hero, HERO_FLIPPED, true);   // bigger, so it lands second and replaces it
  return g;
}

preloadModels(); // 65 KB in total: fetch them while the house loads, so the first click is instant
