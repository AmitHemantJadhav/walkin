// Real-size furniture. Units: metres. Local frame: x = width, y = depth (front faces -y), z up,
// origin at the centre of the footprint on the floor.
// Each kind is a CC0 glTF model from Kenney's Furniture Kit (see models/CREDITS.md), rescaled to the
// catalog's real metres. The box builders below stay as the fallback while a model loads or if it fails.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// `against` says how a piece wants to be placed when staging a room:
//   'wall'   back to a wall        'free' anywhere        'small' a small object that sits beside something else
export const FURNITURE = {
  sofa: { name: 'Sofa', w: 2.1, d: 0.95, h: 0.95, model: 'loungeSofa.glb', hero: 'hero/sofa_02/sofa_02_1k.gltf', against: 'wall',
    heroBy: { modern: 'hero/Sofa_01/Sofa_01_1k.gltf', scandi: 'hero/Sofa_01/Sofa_01_1k.gltf' } },
  armchair: { name: 'Armchair', w: 0.9, d: 0.9, h: 0.95, model: 'loungeChair.glb', hero: 'hero/modern_arm_chair_01/modern_arm_chair_01_1k.gltf', against: 'free', tone: 'fabricLt',
    heroBy: { modern: 'hero/ArmChair_01/ArmChair_01_1k.gltf', scandi: 'hero/ArmChair_01/ArmChair_01_1k.gltf' } },
  queen: { name: 'Queen bed', w: 1.6, d: 2.1, h: 0.7, model: 'bedDouble.glb', hero: 'hero/objaverse/08f7f65edfea417b8ed9ca748381e507.glb', against: 'wall' },
  king: { name: 'King bed', w: 1.95, d: 2.15, h: 0.75, model: 'bedDouble.glb', hero: 'hero/objaverse/08f7f65edfea417b8ed9ca748381e507.glb', against: 'wall' },
  table: { name: 'Dining table', w: 1.4, d: 0.7, h: 0.74, model: 'table.glb', hero: 'hero/objaverse/d7afff23c741411c82a5994ae9940669.glb', against: 'free' },
  desk: { name: 'Desk', w: 1.6, d: 0.8, h: 0.74, model: 'desk.glb', hero: 'hero/metal_office_desk/metal_office_desk_1k.gltf', against: 'wall' },
  // pieces a staged room needs
  chair: { name: 'Chair', w: 0.45, d: 0.5, h: 0.9, model: 'chairModernFrameCushion.glb', hero: 'hero/dining_chair_02/dining_chair_02_1k.gltf', against: 'small' },
  nightstand: { name: 'Nightstand', w: 0.5, d: 0.45, h: 0.55, model: 'cabinetBedDrawer.glb', hero: 'hero/ClassicNightstand_01/ClassicNightstand_01_1k.gltf', against: 'small', tone: 'woodLt' },
  sidetable: { name: 'Side table', w: 0.55, d: 0.45, h: 0.45, model: 'sideTable.glb', hero: 'hero/side_table_tall_01/side_table_tall_01_1k.gltf', against: 'small', tone: 'woodLt' },
  coffeetable: { name: 'Coffee table', w: 1.2, d: 0.7, h: 0.45, model: 'tableCoffee.glb', hero: 'hero/coffee_table_round_01/coffee_table_round_01_1k.gltf', against: 'free' },
  tvstand: { name: 'TV stand', w: 1.8, d: 0.4, h: 0.5, model: 'cabinetTelevision.glb', hero: 'hero/modern_wooden_cabinet/modern_wooden_cabinet_1k.gltf', against: 'wall', tone: 'woodLt' },
  tv: { name: 'Television', w: 1.25, d: 0.25, h: 0.78, model: 'televisionModern.glb', hero: 'hero/objaverse/51cfe336d19243eba66c5fac64a81507.glb', against: 'small' },
  bookcase: { name: 'Bookcase', w: 1.1, d: 0.38, h: 1.6, model: 'bookcaseOpen.glb', hero: 'hero/wooden_display_shelves_01/wooden_display_shelves_01_1k.gltf', heroYaw: Math.PI / 2, against: 'wall', tone: 'woodLt' },
  dresser: { name: 'Dresser', w: 1.4, d: 0.5, h: 0.75, hero: 'hero/objaverse/2a0141217f9b4ae99abaf1a1a01683f1.glb', against: 'wall' },
  diningset: { name: 'Dining set', w: 2.4, d: 2.2, h: 0.75, hero: 'hero/objaverse/774971f63ea54cdba8119439f4ff09c5.glb', against: 'free' },
  fridge: { name: 'Fridge', w: 0.9, d: 0.95, h: 1.75, hero: 'hero/objaverse/75a7a3a8146849dea698cfd04f73482b.glb', against: 'wall' },
  stove: { name: 'Stove', w: 0.9, d: 0.6, h: 0.82, hero: 'hero/objaverse/b10785bcfc6e46a080614293c3ff6e1c.glb', against: 'wall' },
  tablelamp: { name: 'Table lamp', w: 0.35, d: 0.35, h: 0.6, hero: 'hero/objaverse/8f4abf0c719d42109f316ecece72dd75.glb', against: 'small' },
  floorlamp: { name: 'Floor lamp', w: 0.55, d: 0.48, h: 1.5, model: 'lampRoundFloor.glb', hero: 'hero/objaverse/c277c4d1742b4f118becbfefd325ce71.glb', against: 'small' },
  rug: { name: 'Rug', w: 2.4, d: 1.6, h: 0.015, model: 'rugRectangle.glb', against: 'free', flat: true, tone: 'fabricLt' },
  ruground: { name: 'Round rug', w: 1.8, d: 1.8, h: 0.015, model: 'rugRound.glb', against: 'free', flat: true, tone: 'fabricLt' },
  plant: { name: 'Plant', w: 0.45, d: 0.45, h: 1.3, model: 'pottedPlant.glb', hero: 'hero/potted_plant_02/potted_plant_02_1k.gltf', against: 'small', fitBy: 'h' },
  plantsmall: { name: 'Small plant', w: 0.22, d: 0.22, h: 0.32, model: 'plantSmall1.glb', hero: 'hero/potted_plant_04/potted_plant_04_1k.gltf', against: 'small', fitBy: 'h' },
  plantfern: { name: 'Fern', w: 0.24, d: 0.22, h: 0.34, model: 'plantSmall2.glb', against: 'small' },
  plantsucculent: { name: 'Succulent', w: 0.22, d: 0.2, h: 0.33, model: 'plantSmall3.glb', against: 'small' },
  cactus: { name: 'Cactus', w: 0.3, d: 0.3, h: 0.5, model: 'cactus_short.glb', against: 'small' },
  cactustall: { name: 'Tall cactus', w: 0.35, d: 0.3, h: 0.75, model: 'cactus_tall.glb', against: 'small' },
  // styling pieces (styling.js): drawn here, no model file to load
  pouf: { name: 'Pouf', w: 0.55, d: 0.55, h: 0.42, against: 'free', tone: 'fabricLt' },
  console: { name: 'Console table', w: 1.3, d: 0.36, h: 0.78, against: 'wall', tone: 'woodLt' },
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
// hero models that face +z and need turning round. The Objaverse TV has its screen on +z: without the half turn it
// stood on its stand showing the room its back panel (checked by rendering every piece from the front).
const HERO_FLIPPED = new Set(['hero/objaverse/51cfe336d19243eba66c5fac64a81507.glb']);


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

// ------------------------------------------------------------------ surfaces (S7b)
// Recolouring alone still leaves one flat colour per part, which is what reads as Lego in a headset.
// Below are the grain and the weave the kit never shipped: drawn once on a canvas (no assets, nothing
// to download) and shared by every piece. The kit's UVs are colour-swatch islands, so a texture through
// them collapses to one flat colour; each mesh gets box-projected UVs in world metres instead
// (surfaceGeometry) and the textures tile from `repeat`.
const WOOD_REPEAT = 0.6, WEAVE_REPEAT = 0.08;     // metres per tile
let woodTex = null, weaveBumpTex = null, weaveMapTex = null;

const hash = (i) => Math.abs(Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1;

/** Wood grain, kept near-neutral so `material.color` picks the species. 512 px, one per page. */
function woodTexture() {
  if (woodTex) return woodTex;
  const N = 512;
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = '#d8cfc2'; g.fillRect(0, 0, N, N);
  const TAU = Math.PI * 2;
  // long wobbling streaks in four close tones; periodic in x so the tile has no seam, drawn a tile
  // above and below as well so the top and bottom edges match
  const streak = (y, i) => {
    g.beginPath();
    for (let x = 0; x <= N; x += 16) g.lineTo(x, y + Math.sin(TAU * x / N + i) * 2.6 + Math.sin(TAU * 4 * x / N + i * 3) * 0.8);
    g.stroke();
  };
  // broad soft bands first: the figure of a board, a few tones wide
  for (let i = 0; i < 9; i++) {
    g.strokeStyle = i % 2 ? '#e2dacd' : '#c3b5a1'; g.globalAlpha = 0.18 + 0.1 * hash(i + 50);
    g.lineWidth = 28 + 40 * hash(i + 70);
    for (const dy of [-N, 0, N]) streak((i / 9) * N + hash(i + 20) * 40 + dy, i * 7);
  }
  // then the grain lines, uneven in spacing and weight like a sawn face
  for (let i = 0; i < 130; i++) {
    const y = (i / 130) * N + hash(i) * 12;
    g.strokeStyle = ['#c3b5a1', '#e4dccf', '#b4a58f', '#cfc3b1'][i % 4];
    g.globalAlpha = 0.2 + 0.3 * Math.abs(Math.sin(i * 0.7));
    g.lineWidth = 0.7 + 3 * hash(i + 500) * hash(i + 600);
    for (const dy of [-N, 0, N]) streak(y + dy, i);
  }
  g.globalAlpha = 0.16; g.strokeStyle = '#8f7f6b';            // a few darker rays
  for (let i = 0; i < 24; i++) {
    g.lineWidth = 0.5 + hash(i + 300) * 1.4;
    for (const dy of [-N, 0, N]) streak(hash(i + 900) * N + dy, i * 5);
  }
  g.globalAlpha = 1;
  woodTex = new THREE.CanvasTexture(c);
  woodTex.colorSpace = THREE.SRGBColorSpace;
  woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
  woodTex.repeat.set(1 / WOOD_REPEAT, 1 / WOOD_REPEAT);
  woodTex.anisotropy = 8;
  return woodTex;
}

/** A plain weave, 16 threads per 8 cm tile: a height map for `bumpMap` and a faint one for `map`. */
function weaveTextures() {
  if (weaveBumpTex) return { bump: weaveBumpTex, map: weaveMapTex };
  const N = 256, cell = N / 16;
  const make = (lo, hi, noise) => {
    const c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N), d = img.data;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const warpOnTop = ((x / cell | 0) + (y / cell | 0)) % 2 === 0;   // over, under, over: alternate cells show the other thread
      const fx = (x % cell) / cell, fy = (y % cell) / cell;
      const t = Math.sin((warpOnTop ? fx : fy) * Math.PI);           // a thread is a half-round: bright in the middle, dark at the sides
      const v = Math.round(255 * THREE.MathUtils.clamp(lo + (hi - lo) * t + (hash(x * 131 + y * 7) - 0.5) * noise, 0, 1));
      const k = (y * N + x) * 4; d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / WEAVE_REPEAT, 1 / WEAVE_REPEAT);
    tex.anisotropy = 4;
    return tex;
  };
  weaveBumpTex = make(0.2, 1, 0.12); weaveBumpTex.colorSpace = THREE.NoColorSpace;
  weaveMapTex = make(0.86, 1, 0.1); weaveMapTex.colorSpace = THREE.SRGBColorSpace;
  return { bump: weaveBumpTex, map: weaveMapTex };
}

/** Box-project UVs in metres onto a copy of a geometry: tops in plan, sides with u running up the face so the grain climbs legs and panels. */
function boxUV(geometry, scale) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i).multiply(scale); b.fromBufferAttribute(pos, i + 1).multiply(scale); c.fromBufferAttribute(pos, i + 2).multiply(scale);
    n.subVectors(b, a).cross(e.subVectors(c, a));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? a : k === 1 ? b : c;
      let u, w;
      if (ay >= ax && ay >= az) { u = v.x; w = v.z; }                 // top or underside (glTF y up)
      else if (ax >= az) { u = v.y; w = v.z; } else { u = v.y; w = v.x; }
      uv[(i + k) * 2] = u; uv[(i + k) * 2 + 1] = w;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

const projected = new Map();   // `${kit geometry uuid}|${part}|${scale}` -> the box-projected copy, shared by every item of that kind

/** The kit geometry with UVs in world metres (and, for leaves, a little colour per face). The GLB cache's own geometry is never touched. */
function surfaceGeometry(geometry, part, scale) {
  const key = `${geometry.uuid}|${part}|${scale.x.toFixed(3)},${scale.y.toFixed(3)},${scale.z.toFixed(3)}`;
  if (projected.has(key)) return projected.get(key);
  const geo = boxUV(geometry, scale);
  if (part === 'leaf') {                       // one tint per face: a plant is many leaves, not one green shell
    const n = geo.getAttribute('position').count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 3) { const f = 0.86 + 0.26 * hash(i * 0.37 + 11); for (let k = 0; k < 9; k++) col[i * 3 + k] = f; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  geo.userData.shared = true;
  projected.set(key, geo);
  return geo;
}

/** The scale of a mesh inside a fitted model: the product of its own and its ancestors' up to the model root. */
function meshScale(o, root) {
  const s = new THREE.Vector3(1, 1, 1);
  for (let p = o; p; p = p.parent) { s.multiply(p.scale); if (p === root) break; }
  return s;
}

/** Which part of the palette a kit material is, for a piece: the spec's tone wins, the TV's dark panel is its screen. */
function partFor(src, spec) {
  if (spec && spec.model === 'televisionModern.glb' && /dark/i.test(src.name || '')) return 'screen';
  const tone = spec && spec.tone;
  if (tone && STYLES[DEFAULT_STYLE][tone] !== undefined) return tone;
  const hsl = { h: 0, s: 0, l: 0.5 };
  if (src.color) src.color.getHSL(hsl);
  return partOf(src.name, hsl.l);
}

const styled = new Map();   // `${style}|${part}|${source material uuid}` -> the restyled material


let quiltTex = null;
/** A quilted duvet: soft square bumps about 30 cm apart, with a stitch line between. Height map for bumpMap. */
function quiltTexture() {
  if (quiltTex) return quiltTex;
  const N = 256; const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'); const img = g.createImageData(N, N), d = img.data;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    const puff = Math.sin(u * Math.PI) * Math.sin(v * Math.PI);           // one pillow-shaped square per tile
    const seam = Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v));         // dark line at the stitching
    let h = 110 + 120 * Math.pow(puff, 0.6) - (seam < 0.03 ? 60 * (1 - seam / 0.03) : 0);
    h += (Math.sin(x * 0.7) * Math.cos(y * 0.9)) * 4;                       // a little cloth noise
    const i = (y * N + x) * 4; d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, h)); d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  quiltTex = new THREE.CanvasTexture(c);
  quiltTex.wrapS = quiltTex.wrapT = THREE.RepeatWrapping;
  quiltTex.repeat.set(1 / 3.75, 1 / 3.75);          // fabric UVs are 1 unit per 8 cm: one square every 30 cm
  quiltTex.colorSpace = THREE.NoColorSpace;
  return quiltTex;
}

function styleMaterial(src, style, part) {
  const pal = STYLES[style] || STYLES[DEFAULT_STYLE];
  part = part || partFor(src, null);
  const key = `${pal.name}|${part}|${src.uuid}`;
  if (styled.has(key)) return styled.get(key);

  const hsl = { h: 0, s: 0, l: 0.5 };
  if (src.color) src.color.getHSL(hsl);
  const m = src.clone();
  m.map = m.bumpMap = null; m.vertexColors = false; m.emissive.setHex(0); m.emissiveIntensity = 1;
  m.color = new THREE.Color(pal[part] !== undefined ? pal[part] : 0x0a0b0d);
  // keep a little of the original light/dark variation, so pillows stay lighter than the duvet
  m.color.multiplyScalar(THREE.MathUtils.clamp(0.88 + 0.24 * hsl.l, 0.78, 1.18));
  const base = part.replace(/Lt|Dk/, '');
  m.roughness = ROUGH[base] !== undefined ? ROUGH[base] : 0.85;
  m.metalness = 0;
  if (base === 'wood') {
    m.map = woodTexture(); m.color.multiplyScalar(1.12);            // the grain's mean is below white: put some brightness back
    m.roughness = 0.5; m.envMapIntensity = 0.9;
  } else if (part === 'quilt') {
    // the duvet: the palette's fabric colour, lifted, with a quilted relief instead of a flat weave
    m.color = new THREE.Color(pal.fabric).multiplyScalar(1.15);
    m.map = weaveTextures().map; m.bumpMap = quiltTexture(); m.bumpScale = 0.02;
    m.roughness = 0.95;
  } else if (base === 'fabric') {
    const t = weaveTextures();
    m.map = t.map; m.bumpMap = t.bump; m.bumpScale = 0.0025; m.color.multiplyScalar(1.06);
    m.roughness = 0.95;
  } else if (part === 'metal') {
    m.metalness = 0.8; m.roughness = 0.3;
  } else if (part === 'leaf') {
    m.roughness = 0.75; m.vertexColors = true;                       // surfaceGeometry gives leaf parts a colour attribute
  } else if (part === 'shade') {
    m.emissive.setHex(0xffc784); m.emissiveIntensity = 0.15;         // a lamp reads as a lamp even when it is off
  } else if (part === 'screen') {
    m.roughness = 0.2; m.metalness = 0.1; m.envMapIntensity = 1;     // near-black glass that reflects the room
  }
  m.userData.sharedMap = true;   // the textures are module singletons: not yours to dispose
  m.name = `${part}:${pal.name}`;
  styled.set(key, m);
  return m;
}

/** Re-material one piece (or everything under a group) in the given style. */
export function applyStyle(root, style = currentStyle) {
  const spec = FURNITURE[root.userData.kind];
  const pal = STYLES[style] || STYLES[DEFAULT_STYLE];
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.userData.hero) o.material.color.copy(o.userData.heroBase || new THREE.Color(1, 1, 1)).multiply(new THREE.Color(pal.hero)); // tint, keep the authored colour
    else if (o.userData.styleSrc) o.material = styleMaterial(o.userData.styleSrc, style, o.userData.stylePart || partFor(o.userData.styleSrc, spec));
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

// a knitted texture (cable rows) for the pouf and throws, drawn once per colour
const knits = new Map();
export function knit(color) {
  const key = new THREE.Color(color).getHexString();
  if (knits.has(key)) return knits.get(key);
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), base = new THREE.Color(color);
  g.fillStyle = `#${key}`; g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 16) for (let x = 0; x < 128; x += 16) {   // V-shaped stitches
    for (const [dx, a] of [[0, 0.16], [8, -0.16]]) {
      const grad = g.createLinearGradient(x + dx, y, x + dx + 8, y + 16);
      grad.addColorStop(0, `rgba(255,255,255,${0.16 + a})`); grad.addColorStop(1, 'rgba(0,0,0,0.22)');
      g.fillStyle = grad;
      g.beginPath(); g.ellipse(x + dx + 4, y + 8, 3.6, 7.4, dx ? -0.5 : 0.5, 0, Math.PI * 2); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 3); t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({ map: t, roughness: 1, metalness: 0, color: base.lerp(new THREE.Color(0xffffff), 0.35) });
  knits.set(key, m);
  return m;
}

// ------------------------------------------------------------------ contact shadow
// A soft blob under each piece, not a shadow map: phones can't afford one, and the photo already
// contains the room's real shadows. lighting.js sets the strength from how bright the pano is.
let shadowTex;
const shadows = new Set();
let shadowOpacity = 0.45;

export function shadowTexture() {
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
  m.userData.shadow = true;   // not part of the piece: the selection box and outline measure the furniture, not its shadow
  m.raycast = () => {};       // and a click on the floor next to a piece doesn't pick up the piece
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
  pouf(g, { w, h }) {                                              // a chunky knitted pouf, slightly domed
    const r = w / 2, pts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12, z = t * h;
      const bulge = Math.sin(t * Math.PI) * 0.06 * r;              // fuller in the middle, rounded top and bottom edges
      const edge = t < 0.08 ? (t / 0.08) * 0.94 + 0.06 : t > 0.86 ? 1 - ((t - 0.86) / 0.14) * 0.32 : 1;
      pts.push(new THREE.Vector2(Math.max(0.001, (r - 0.02 + bulge) * edge), z));
    }
    pts.push(new THREE.Vector2(0.001, h));
    const geo = new THREE.LatheGeometry(pts, 40);
    geo.rotateX(Math.PI / 2);                                       // lathe is round y; ours stands on z
    const m = new THREE.Mesh(geo, knit(0xd8cbb4));
    m.castShadow = true; m.renderOrder = 2;
    g.add(m);
  },
  console(g, { w, d, h }) {                                        // a slim walnut console with a lower shelf
    const walnut = mat(0x5a3d29, 0.5);
    box(g, w, d, 0.03, 0, 0, h - 0.03, walnut);
    box(g, w - 0.08, d - 0.06, 0.02, 0, 0, 0.18, walnut);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(g, 0.035, 0.035, h - 0.03, sx * (w / 2 - 0.04), sy * (d / 2 - 0.04), 0, walnut);
  },
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

export function load(file) {
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
  return Promise.all([...new Set(Object.values(FURNITURE).flatMap((s) => [s.hero, ...Object.values(s.heroBy || {})]))]
    .filter(Boolean).map(load));
}

/**
 * Turn a glTF model (Y-up, arbitrary origin and scale) into our frame: x = width, y = depth with the front
 * on -y, z up from the floor, sized to the catalog's real `w x d x h`.
 */
export function fitToSpec(src, spec, flipped, style, hero) {
  let b = new THREE.Box3().setFromObject(src);
  let size = b.getSize(new THREE.Vector3());
  if (hero && spec.w !== spec.d && (size.x < size.z) !== (spec.w < spec.d) && Math.abs(size.x - size.z) > 0.1 * Math.max(size.x, size.z)) {
    // the model's long side is on the other axis than the catalog's: turn it, don't squash it
    const inner = new THREE.Group(); for (const ch of [...src.children]) inner.add(ch);
    inner.rotation.y = Math.PI / 2; src.add(inner); src.updateMatrixWorld(true);
    b = new THREE.Box3().setFromObject(src); size = b.getSize(new THREE.Vector3());
  }
  const c = b.getCenter(new THREE.Vector3());
  // model x -> our width, model z -> our depth, model y -> our height
  let sx = spec.w / size.x, sd = spec.d / size.z, sh = spec.h / size.y;
  if (hero) {
    // A photoscanned piece keeps its proportions: the kit is made to be stretched to the catalog
    // box, a real coffee table squashed to 1.2 x 0.7 comes out as a skewed box. Fit inside the
    // catalog footprint and height uniformly; a little non-uniformity (10%) is allowed so a
    // nearly-right model still fills its box.
    // Plants go by height (fitBy 'h'): leaves spread wider than the pot, so fitting the 45 cm footprint left a
    // 1.3 m floor plant 60 cm tall. Their footprint is the pot, which is what collides.
    const u = spec.fitBy === 'h' ? Math.min(sh, sx * 1.5, sd * 1.5) : Math.min(sx, sd, sh);   // ...but not a pot wider than 1.5x its footprint
    if (spec.fitBy === 'h') { sx = sd = sh = u; }
    else { sx = Math.min(sx, u * 1.1); sd = Math.min(sd, u * 1.1); sh = Math.min(sh, u * 1.1); }
  }
  src.scale.set(sx, sh, sd);
  src.position.set(-c.x * sx, -b.min.y * sh, -c.z * sd); // centred on x/z, standing on y = 0
  src.traverse((o) => {
    if (!o.isMesh) return;
    o.renderOrder = 2;          // after the depth-only occluders
    o.castShadow = true;        // sun.js draws the sun's shadow of it; nothing is drawn onto it
    o.receiveShadow = false;
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
      // relative to the authored colour: four models (TV, table, lamp, stove) have no textures, only colours
      o.userData.heroBase = o.material.color.clone();
      o.material.color.copy(o.userData.heroBase).multiply(new THREE.Color((STYLES[style] || STYLES[DEFAULT_STYLE]).hero));
    } else {
      let part = partFor(o.material, spec);
      if (/cover/i.test(o.name || '') && /bedDouble/.test((spec && spec.model) || '')) part = 'quilt';   // the duvet, not the sheet
      o.userData.styleSrc = o.material;        // the kit's own material, kept so the style can change
      o.userData.stylePart = part;
      // the kit's UVs are colour swatches: swap in the copy with UVs in world metres, shared by every
      // item of this kind (the clone shares the GLB cache's geometry, which stays as it was)
      o.geometry = surfaceGeometry(o.geometry, part === 'quilt' ? 'fabric' : part, meshScale(o, src));
      o.userData.sharedGeo = true;
      o.material = styleMaterial(o.material, style, part);
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


// ------------------------------------------------------------------ props
//
// What made the test-fit desks read as desks was not polygons: it was the monitor and keyboard on
// top. The kit's bed is a slab, its bookcase is an empty frame, its nightstand a box. A few small,
// cheap things on them - cushions and a folded throw, rows of books, a mug - do more for the eye in
// a headset than any amount of texture. All procedural, built in the item's own frame (width along
// x, depth along y, front at -y, standing on z = 0), so they move, rotate and style with the piece.
const PROP_COLOURS = [0x6b4e3d, 0x2f4858, 0x8c3b3b, 0x3d5a4c, 0xa67c52, 0x4a4a68, 0x9c6b4a, 0x586b8c, 0xb08a5a, 0x5e4b56];
let propMats = null;
function propMaterials() {
  if (propMats) return propMats;
  const weave = weaveTextures();
  propMats = {
    books: PROP_COLOURS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 })),
    pages: new THREE.MeshStandardMaterial({ color: 0xf1ead9, roughness: 0.95 }),
    cushion: PROP_COLOURS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, bumpMap: weave.bump, bumpScale: 0.0025 })),
    throw: new THREE.MeshStandardMaterial({ color: 0x8c6d5b, roughness: 0.95, bumpMap: weave.bump, bumpScale: 0.003 }),
    mug: new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.35 }),
    bowl: new THREE.MeshStandardMaterial({ color: 0x2f3b45, roughness: 0.3, metalness: 0.1, side: THREE.DoubleSide }),
  };
  for (const m of [...propMats.cushion, propMats.throw]) m.userData.sharedMap = true;
  return propMats;
}
const seeded = (i) => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

function mesh(geo, mat) { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.renderOrder = 2; m.userData.prop = true; return m; }

/** A row of books between x0 and x1 on a shelf at height z, depth d available: thin boxes, varied. */
function bookRow(group, x0, x1, z, d, seed) {
  const M = propMaterials();
  let x = x0 + 0.02, i = 0;
  while (x < x1 - 0.04) {
    const t = 0.022 + seeded(seed + i) * 0.03, h = 0.17 + seeded(seed + i + 7) * 0.1, dd = Math.min(d - 0.03, 0.16 + seeded(seed + i + 3) * 0.05);
    const lean = (seeded(seed + i + 11) < 0.12) ? 0.12 : 0;
    const b = mesh(new THREE.BoxGeometry(t, dd, h), M.books[(seed + i) % M.books.length]);
    b.position.set(x + t / 2, 0.01, z + h / 2); b.rotation.y = lean;
    group.add(b);
    x += t + 0.004; i++;
    if (seeded(seed + i + 5) < 0.08) x += 0.06;              // a gap now and then, like a real shelf
  }
}

/** Shelf heights of a bookcase, read from its own geometry: the upward-facing faces, clustered by height. */
function shelfHeights(root, spec) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const zs = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  root.traverse((m) => {
    if (!m.isMesh || m.userData.prop) return;
    const pos = m.geometry.getAttribute('position'), idx = m.geometry.getIndex();
    const M = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    const cnt = idx ? idx.count : pos.count;
    for (let i = 0; i < cnt; i += 3) {
      const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(M); b.fromBufferAttribute(pos, ib).applyMatrix4(M); c.fromBufferAttribute(pos, ic).applyMatrix4(M);
      n.subVectors(b, a).cross(c.clone().sub(a));
      const area = n.length() / 2;
      if (area < 0.01 || n.z / (area * 2) < 0.9) continue;        // only sizeable faces that face up
      zs.push(((a.z + b.z + c.z) / 3));
    }
  });
  zs.sort((p, q) => p - q);
  const shelves = [];
  for (const z of zs) { if (z < 0.05 || z > spec.h - 0.12) continue; if (!shelves.length || z - shelves[shelves.length - 1] > 0.12) shelves.push(z); }
  return shelves;
}

/** Add the props that make a piece read as itself. `root` is the fitted model group in the item's frame. */
export function addProps(root, kind, spec) {
  if (!root || root.userData.propped) return;
  root.userData.propped = true;
  const M = propMaterials();
  const grp = new THREE.Group(); grp.name = 'props';
  const w = spec.w, d = spec.d, h = spec.h;
  if (kind === 'queen' || kind === 'king') {
    // two accent cushions against the pillows, a folded throw across the foot
    const top = h * 0.78;                                            // the mattress top, roughly: the frame is the rest
    // cushions are puffy, not boxes: a flattened sphere leaning on the pillows
    for (let i = 0; i < 2; i++) {
      const cu = mesh(new THREE.SphereGeometry(1, 24, 16).scale(0.21, 0.075, 0.2), M.cushion[(i * 3 + 1) % M.cushion.length]);
      cu.position.set((i ? 1 : -1) * w * 0.2, d * 0.5 - 0.38, top + 0.16);
      cu.rotation.x = -0.95 + (i ? 0.08 : -0.05); cu.rotation.z = (i ? -1 : 1) * 0.1;
      grp.add(cu);
    }
    // a throw rolled across the foot of the bed reads as a blanket; a flat slab reads as a plank
    const th = mesh(new THREE.CapsuleGeometry(0.085, w * 0.7, 6, 14), M.throw);
    th.rotation.z = Math.PI / 2; th.rotation.y = 0.04;
    th.position.set(w * 0.03, -d * 0.5 + 0.5, top + 0.085);
    grp.add(th);
  } else if (kind === 'bookcase') {
    const shelves = shelfHeights(root, spec);
    const inner = w - 0.08;
    shelves.forEach((z, i) => { if (i % 4 !== 3) bookRow(grp, -inner / 2, inner / 2 - (i % 2 ? 0.18 : 0), z + 0.005, d, 17 + i * 31); });
    if (shelves.length) {                                             // a leaning book or a bowl on one shelf
      const z = shelves[Math.min(1, shelves.length - 1)];
      const bw = mesh(new THREE.SphereGeometry(0.07, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.bowl);
      bw.position.set(inner / 2 - 0.1, 0, z + 0.075); bw.rotation.x = -Math.PI / 2; // sphere poles are on Y, the item is Z up: this puts the rim flat and up
      grp.add(bw);
    }
  } else if (kind === 'nightstand' || kind === 'sidetable') {
    let z = h + 0.002;
    for (let i = 0; i < 2; i++) {
      const b = mesh(new THREE.BoxGeometry(0.19 - i * 0.02, 0.14 - i * 0.015, 0.025), M.books[(i * 4 + 2) % M.books.length]);
      b.position.set(-w * 0.12, 0, z + 0.0125); b.rotation.z = i * 0.18; grp.add(b); z += 0.025;
    }
    const mug = mesh(new THREE.CylinderGeometry(0.038, 0.034, 0.095, 16), M.mug);
    mug.rotation.x = Math.PI / 2; mug.position.set(w * 0.25, -0.05, h + 0.05); grp.add(mug);
  } else if (kind === 'coffeetable') {
    const b = mesh(new THREE.BoxGeometry(0.3, 0.23, 0.025), M.books[5]); b.position.set(-w * 0.2, 0.05, h + 0.0125); b.rotation.z = 0.2; grp.add(b);
    const b2 = mesh(new THREE.BoxGeometry(0.28, 0.21, 0.02), M.books[8]); b2.position.set(-w * 0.2, 0.05, h + 0.035); b2.rotation.z = -0.1; grp.add(b2);
    const bw = mesh(new THREE.SphereGeometry(0.11, 18, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), M.bowl);
    bw.position.set(w * 0.22, -0.02, h + 0.11); bw.rotation.x = Math.PI / 2; grp.add(bw);
  } else if (kind === 'table') {
    const bw = mesh(new THREE.SphereGeometry(0.13, 18, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), M.bowl);
    bw.position.set(0, 0, h + 0.13); bw.rotation.x = Math.PI / 2; grp.add(bw);
  } else if (kind === 'desk') {
    const b = mesh(new THREE.BoxGeometry(0.24, 0.17, 0.03), M.books[3]); b.position.set(w * 0.3, 0.12, h + 0.015); b.rotation.z = -0.3; grp.add(b);
    const mug = mesh(new THREE.CylinderGeometry(0.038, 0.034, 0.095, 16), M.mug); mug.rotation.x = Math.PI / 2; mug.position.set(-w * 0.35, 0.1, h + 0.05); grp.add(mug);
  } else {
    return;
  }
  root.add(grp);
}

/**
 * A piece of furniture, ready to add to the scene. Returns synchronously: the group starts with the box
 * fallback and swaps in the real model when it arrives (the boxes stay if the model can't be loaded).
 */
export function buildFurniture(kind, style = currentStyle) {
  const spec = FURNITURE[kind];
  // a style may have its own photoreal model: a tint can't turn a black leather Chesterfield into pale linen,
  // so modern and Scandinavian rooms get the grey fabric sofa and armchair, cozy ones keep the leather
  const hero = (spec.heroBy && spec.heroBy[style]) || spec.hero;
  const g = new THREE.Group();
  g.userData.kind = kind;
  g.userData.style = style;
  const boxes = buildBoxes(kind);
  g.add(boxes);
  g.add(shadow(spec.w, spec.d));

  let shown = boxes;
  const swapIn = (file, flipSet, isHero) => load(file).then((src) => {
    if (!src || (hero && g.userData.model === hero)) return;  // load failed, or the hero already won
    let model = src.clone(true);
    if (isHero && spec.heroYaw) {              // a model whose front is on x: turn it before it is measured
      const wrap = new THREE.Group(); model.rotation.y = spec.heroYaw; wrap.add(model); wrap.updateMatrixWorld(true); model = wrap;
    }
    const next = fitToSpec(model, spec, flipSet.has(file), g.userData.style || currentStyle, isHero);
    g.remove(shown);
    g.add(next);
    shown = next;
    g.userData.model = file;
    if (!isHero) addProps(next, kind, spec);   // a hero is already dressed; the kit-sized cushions floated over the bed
  });

  if (spec.model) swapIn(spec.model, FLIPPED, false);
  if (hero) swapIn(hero, HERO_FLIPPED, true);   // bigger, so it lands second and replaces it
  return g;
}

preloadModels(); // 65 KB in total: fetch them while the house loads, so the first click is instant
