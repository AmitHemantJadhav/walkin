// John's extra tools for what real visitors say, not what the catalog expects:
//   add_object(description)  "add a fireplace / piano / crib / treadmill": the closest catalog piece, or an honest,
//                            real-size procedural stand-in (labelled) when the catalog has nothing like it
//   undo                     "undo that", "go back", "never mind": reverts John's last change (one spoken request)
//   estimate_cost            "how much would this cost": the total for what is placed (suggest.js prices), clearly rough
// Registered through window.walkinTools like furniture-tools.js and decor.js, so live.js gets them too.
// Talks to the viewer only through window.walkin. Units are metres, z up; a piece's front faces -y.
import * as THREE from 'three';

const W = () => window.walkin;
const lower = (s) => String(s || '').toLowerCase();
const r2 = (v) => Math.round(v * 100) / 100;

// ------------------------------------------------------------------ words -> catalog kinds
// Most specific first. A catalog kind keeps its real model; colour words in the description are passed on.
const CATALOG = [
  [/\b(king)\b/, 'king'], [/\b(queen|double bed|full bed|bed for two|master bed)\b/, 'queen'],
  [/\bcoffee table\b/, 'coffeetable'], [/\b(side|end|accent) table\b/, 'sidetable'],
  [/\b(night ?stand|bedside)\b/, 'nightstand'], [/\b(tv|television) (stand|unit|cabinet|console)|media (console|unit)\b/, 'tvstand'],
  [/\b(tv|television|flat ?screen)\b/, 'tv'], [/\b(dining|kitchen) table|table for (four|six|eight|4|6|8)\b/, 'table'],
  [/\b(desk|workstation|work station|writing table)\b/, 'desk'],
  [/\b(arm ?chair|recliner|lounge chair|accent chair|reading chair)\b/, 'armchair'],
  [/\b(office chair|dining chair|desk chair|stool|chair)\b/, 'chair'],
  [/\b(couch|settee|loveseat|love seat|sofa)\b(?!.*\bsectional)/, 'sofa'],
  [/\b(bookcase|bookshelf|book shelf|bookshelves|shelving|shelves|shelf)\b/, 'bookcase'],
  [/\b(floor lamp|standing lamp|lamp)\b(?!.*\b(table|desk|bedside)\b)/, 'floorlamp'],
  [/\bround (rug|carpet)\b/, 'ruground'], [/\b(rug|carpet|mat)\b/, 'rug'],
  [/\btall cactus\b/, 'cactustall'], [/\bcactus\b/, 'cactus'], [/\bsucculent\b/, 'plantsucculent'], [/\bfern\b/, 'plantfern'],
  [/\b(small|little|tiny|desk|table) (plant|pot)\b/, 'plantsmall'],
  [/\b(plant|tree in a pot|potted|monstera|fiddle|ficus|palm)\b/, 'plant'],
  [/\btable\b/, 'table'],
];

// ------------------------------------------------------------------ procedural stand-ins (real sizes)
const mats = new Map();
function mat(part, hex, opts = {}) {                 // part names follow furniture-tools: fabric, wood, metal
  const key = `${part}:${hex}:${JSON.stringify(opts)}`;
  if (!mats.has(key)) {
    const m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.75, metalness: 0, ...opts });
    m.name = `${part}:john`;
    mats.set(key, m);
  }
  return mats.get(key);
}
function box(g, w, d, h, x, y, z, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), material);
  m.position.set(x, y, z + h / 2);
  m.renderOrder = 2;
  g.add(m);
  return m;
}
function cyl(g, rTop, rBot, h, x, y, z, material, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), material);
  m.rotation.x = Math.PI / 2;                        // three's cylinders stand on y; ours stand on z
  m.position.set(x, y, z + h / 2);
  m.renderOrder = 2;
  g.add(m);
  return m;
}

const BUILD = {
  fireplace(g, { w, d, h }, c) {
    const stone = mat('wood', c || 0xe9e4da), dark = mat('metal', 0x111111, { roughness: 0.95 });
    box(g, w + 0.3, d + 0.25, 0.06, 0, -0.12, 0, mat('wood', 0x8d8a85));            // hearth
    box(g, w, d, h - 0.06, 0, 0, 0.06, stone);                                        // surround
    box(g, w * 0.55, 0.04, h * 0.5, 0, -d / 2 - 0.005, 0.06, dark);                    // firebox opening
    const fire = new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff5a00, emissiveIntensity: 1.4 });
    fire.name = 'fire:john';
    box(g, w * 0.35, 0.03, 0.12, 0, -d / 2 - 0.02, 0.08, fire);                        // embers
    box(g, w + 0.2, d + 0.12, 0.07, 0, -0.04, h, mat('wood', 0x6b4a32));               // mantel shelf
  },
  piano(g, { w, d, h }, c) {                          // upright
    const body = mat('wood', c || 0x141414, { roughness: 0.25 }), keys = mat('fabricLt', 0xf5f3ee), black = mat('metal', 0x0a0a0a);
    box(g, w, d * 0.55, h, 0, d * 0.22, 0, body);                                     // case
    box(g, w, d * 0.45, 0.08, 0, -d * 0.27, 0.68, body);                               // key bed
    box(g, w * 0.92, d * 0.3, 0.02, 0, -d * 0.3, 0.76, keys);                          // white keys
    for (let i = 0; i < 36; i++) box(g, 0.012, d * 0.16, 0.015, -w * 0.45 + i * (w * 0.9 / 36), -d * 0.22, 0.78, black);
    for (const s of [-1, 1]) box(g, 0.06, 0.06, 0.68, s * (w / 2 - 0.05), -d / 2 + 0.05, 0, body); // front legs
    box(g, w * 0.6, 0.02, 0.25, 0, 0.0, 0.88, mat('fabricLt', 0xe8e0cc));              // music stand
  },
  grandpiano(g, { w, d }, c) {
    const body = mat('wood', c || 0x111111, { roughness: 0.2 }), keys = mat('fabricLt', 0xf5f3ee);
    box(g, w, d * 0.8, 0.3, 0, d * 0.1, 0.65, body);                                  // case
    cyl(g, w * 0.5, w * 0.5, 0.3, 0, d * 0.25, 0.65, body);                            // curved tail
    box(g, w * 0.9, 0.22, 0.04, 0, -d / 2 + 0.11, 0.72, keys);
    for (const [x, y] of [[-w / 2 + 0.1, -d / 2 + 0.25], [w / 2 - 0.1, -d / 2 + 0.25], [0, d / 2 - 0.1]]) box(g, 0.08, 0.08, 0.65, x, y, 0, body);
    box(g, 0.75, 0.35, 0.48, 0, -d / 2 - 0.3, 0, body);                                // bench
  },
  crib(g, { w, d, h }, c) {
    const wood = mat('wood', c || 0xf3efe6), sheet = mat('fabricLt', 0xdfe9f2);
    box(g, w - 0.06, d - 0.06, 0.12, 0, 0, 0.3, sheet);                                // mattress
    box(g, w, d, 0.04, 0, 0, 0.26, wood);                                              // base
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(g, 0.05, 0.05, h, sx * (w / 2 - 0.025), sy * (d / 2 - 0.025), 0, wood);
    for (const sy of [-1, 1]) {
      box(g, w, 0.04, 0.04, 0, sy * (d / 2 - 0.02), h - 0.04, wood);                   // top rails
      for (let x = -w / 2 + 0.1; x < w / 2 - 0.05; x += 0.09) box(g, 0.022, 0.022, h - 0.34, x, sy * (d / 2 - 0.02), 0.3, wood);
    }
    for (const sx of [-1, 1]) box(g, 0.04, d, h - 0.3, sx * (w / 2 - 0.02), 0, 0.3, wood);
  },
  bunkbed(g, { w, d, h }, c) {
    const wood = mat('wood', c || 0x9c7a55), sheet = mat('fabricLt', 0xe6e2d9), blanket = mat('fabric', 0x5b7da8);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(g, 0.07, 0.07, h, sx * (w / 2 - 0.035), sy * (d / 2 - 0.035), 0, wood);
    for (const z of [0.25, 1.25]) {
      box(g, w, d, 0.06, 0, 0, z, wood);
      box(g, w - 0.1, d - 0.08, 0.15, 0, 0, z + 0.06, sheet);
      box(g, w * 0.6, d - 0.06, 0.03, -w * 0.15, 0, z + 0.21, blanket);
    }
    box(g, w, 0.04, 0.25, 0, -d / 2 + 0.02, 1.5, wood);                                // guard rail
    for (let z = 0.4; z < 1.4; z += 0.28) box(g, 0.04, 0.05, 0.04, w / 2 - 0.1, -d / 2 - 0.02, z, wood); // ladder rungs
  },
  dresser(g, { w, d, h }, c) {
    const wood = mat('wood', c || 0x8a6646), handle = mat('metal', 0xc9b27a, { metalness: 0.6, roughness: 0.35 });
    box(g, w, d, h - 0.08, 0, 0, 0.08, wood);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(g, 0.05, 0.05, 0.08, sx * (w / 2 - 0.05), sy * (d / 2 - 0.05), 0, wood);
    const rows = Math.max(2, Math.round((h - 0.1) / 0.22));
    for (let i = 0; i < rows; i++) {
      const z = 0.12 + i * ((h - 0.14) / rows);
      box(g, w - 0.04, 0.005, 0.006, 0, -d / 2 - 0.003, z, mat('metal', 0x3a2a1c));    // drawer gap
      for (const sx of [-0.25, 0.25]) box(g, 0.1, 0.02, 0.02, sx * w, -d / 2 - 0.01, z + (h - 0.14) / rows / 2, handle);
    }
  },
  wardrobe(g, { w, d, h }, c) {
    const wood = mat('wood', c || 0xd9d2c5), handle = mat('metal', 0x888888, { metalness: 0.6 });
    box(g, w, d, h, 0, 0, 0, wood);
    box(g, 0.006, 0.005, h - 0.1, 0, -d / 2 - 0.003, 0.05, mat('metal', 0x555555));
    for (const s of [-1, 1]) box(g, 0.02, 0.03, 0.35, s * 0.05, -d / 2 - 0.015, h / 2, handle);
  },
  sectional(g, { w, d }, c) {
    const fab = mat('fabric', c || 0x8e8a84), cushion = mat('fabricLt', 0xcfc8bb);
    const seat = 0.95;
    box(g, w, seat, 0.42, 0, d / 2 - seat / 2, 0, fab);                                // long run
    box(g, w, 0.2, 0.42, 0, d / 2 - 0.1, 0.42, fab);                                  // back
    box(g, seat, d - seat, 0.42, w / 2 - seat / 2, -seat / 2, 0, fab);                 // chaise
    box(g, 0.2, d, 0.25, -w / 2 + 0.1, 0, 0.42, fab);                                  // arm
    for (let i = 0; i < 3; i++) box(g, (w - seat) / 3 - 0.03, seat - 0.27, 0.12, -w / 2 + 0.2 + ((w - seat - 0.2) / 3) * (i + 0.5), d / 2 - seat / 2 - 0.1, 0.42, cushion);
    box(g, seat - 0.2, d - seat - 0.05, 0.12, w / 2 - seat / 2, -seat / 2, 0.42, cushion);
  },
  christmastree(g, { w, h }, c) {
    const needles = mat('fabric', c || 0x2f5d3a), red = mat('metal', 0xc0392b, { roughness: 0.3, metalness: 0.4 });
    cyl(g, 0.05, 0.06, 0.25, 0, 0, 0, mat('wood', 0x5c3b25), 10);
    cyl(g, 0.0, w / 2, h - 0.35, 0, 0, 0.25, needles, 18);
    for (let i = 0; i < 14; i++) {
      const t = (i % 7) / 7, a = i * 2.4, r = (w / 2) * (1 - t) * 0.9, z = 0.3 + t * (h - 0.5);
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), i % 2 ? red : mat('metal', 0xd4af37, { metalness: 0.5, roughness: 0.3 }));
      b.position.set(Math.cos(a) * r, Math.sin(a) * r, z);
      g.add(b);
    }
    const star = new THREE.MeshStandardMaterial({ color: 0xffd34d, emissive: 0xffb000, emissiveIntensity: 0.8 });
    star.name = 'star:john';
    box(g, 0.12, 0.03, 0.12, 0, 0, h - 0.12, star);
  },
  cattree(g, { w, d, h }, c) {
    const post = mat('fabricLt', 0xd8c7a3), pad = mat('fabric', c || 0x9e9a94);
    box(g, w, d, 0.05, 0, 0, 0, pad);
    cyl(g, 0.05, 0.05, h - 0.05, -w * 0.2, 0, 0.05, post, 12);
    cyl(g, 0.05, 0.05, h * 0.6, w * 0.25, d * 0.15, 0.05, post, 12);
    box(g, w * 0.7, d * 0.7, 0.04, w * 0.1, 0, h * 0.62, pad);
    box(g, w * 0.55, d * 0.55, 0.15, -w * 0.15, 0, h - 0.15, pad);
  },
  treadmill(g, { w, d, h }, c) {
    const frame = mat('metal', c || 0x2d2d30, { roughness: 0.5 }), belt = mat('fabric', 0x151515);
    box(g, w, d, 0.18, 0, 0, 0, frame);
    box(g, w * 0.75, d * 0.85, 0.01, 0, 0.05, 0.18, belt);
    for (const s of [-1, 1]) box(g, 0.05, 0.08, h - 0.2, s * (w / 2 - 0.04), -d / 2 + 0.12, 0.18, frame);
    box(g, w, 0.25, 0.08, 0, -d / 2 + 0.1, h - 0.1, frame);                            // console
  },
  floormirror(g, { w, d, h }, c) {
    box(g, w, d, h, 0, 0, 0, mat('wood', c || 0xb08d57));
    const glass = mat('metal', 0xcfdde6, { metalness: 0.9, roughness: 0.05 });
    box(g, w - 0.08, 0.005, h - 0.08, 0, -d / 2 - 0.003, 0.04, glass);
  },
  tablelamp(g, { w, h }, c) {
    cyl(g, 0.07, 0.09, 0.03, 0, 0, 0, mat('metal', 0x8a7a5c, { metalness: 0.5 }), 16);
    cyl(g, 0.012, 0.012, h * 0.55, 0, 0, 0.03, mat('metal', 0x8a7a5c, { metalness: 0.5 }), 8);
    const shade = new THREE.MeshStandardMaterial({ color: c || 0xf3ead6, emissive: 0xffe2a8, emissiveIntensity: 0.35, roughness: 0.9 });
    shade.name = 'fabricLt:john';
    cyl(g, w * 0.32, w / 2, h * 0.4, 0, 0, h * 0.58, shade, 20);
  },
  boxy(g, { w, d, h }, c) { box(g, w, d, h, 0, 0, 0, mat('fabric', c || 0xb9b2a6)); },
  round(g, { w, h }, c) { cyl(g, w / 2, w / 2, h, 0, 0, 0, mat('fabric', c || 0xb9b2a6), 24); },
};

// description -> procedural kind with a real default size (metres) and how it stands
const PROCEDURAL = [
  [/\b(grand piano|baby grand)\b/, 'grandpiano', { name: 'Grand piano', w: 1.5, d: 1.75, h: 1.0, against: 'free' }],
  [/\b(piano|keyboard)\b/, 'piano', { name: 'Upright piano', w: 1.5, d: 0.6, h: 1.25, against: 'wall' }],
  [/\b(fireplace|fire place|hearth|wood ?stove|log burner)\b/, 'fireplace', { name: 'Fireplace', w: 1.5, d: 0.45, h: 1.15, against: 'wall' }],
  [/\b(crib|cot|cradle|bassinet)\b/, 'crib', { name: 'Crib', w: 1.35, d: 0.75, h: 0.95, against: 'wall' }],
  [/\b(bunk ?beds?)\b/, 'bunkbed', { name: 'Bunk bed', w: 2.0, d: 1.0, h: 1.7, against: 'wall' }],
  [/\b(dresser|chest of drawers|drawers|sideboard|credenza|buffet)\b/, 'dresser', { name: 'Dresser', w: 1.2, d: 0.5, h: 0.85, against: 'wall' }],
  [/\b(wardrobe|armoire|closet|cupboard)\b/, 'wardrobe', { name: 'Wardrobe', w: 1.0, d: 0.6, h: 2.0, against: 'wall' }],
  [/\b(sectional|corner sofa|l-? ?shaped sofa|l-? ?shaped couch)\b/, 'sectional', { name: 'Sectional sofa', w: 2.8, d: 1.7, h: 0.85, against: 'wall' }],
  [/\b(christmas tree|xmas tree)\b/, 'christmastree', { name: 'Christmas tree', w: 1.1, d: 1.1, h: 2.0, against: 'free' }],
  [/\b(cat tree|cat tower|scratching post)\b/, 'cattree', { name: 'Cat tree', w: 0.6, d: 0.5, h: 1.5, against: 'wall' }],
  [/\b(treadmill|running machine)\b/, 'treadmill', { name: 'Treadmill', w: 0.8, d: 1.8, h: 1.4, against: 'free' }],
  [/\b(mirror)\b/, 'floormirror', { name: 'Floor mirror', w: 0.6, d: 0.05, h: 1.7, against: 'wall' }],
  [/\b(table lamp|desk lamp|bedside lamp|reading lamp)\b/, 'tablelamp', { name: 'Table lamp', w: 0.3, d: 0.3, h: 0.5, against: 'small' }],
  [/\b(single bed|twin bed|kids'? bed|child'?s bed|toddler bed)\b/, 'boxy', { name: 'Single bed', w: 1.0, d: 2.0, h: 0.5, against: 'wall' }],
];
const ROUND = /\b(round|circular|cylinder|cylindrical|drum|barrel|pouf|pouffe|ottoman|stool|bean ?bag|tub|planter|vase|ball)\b/;

/** What a description becomes: { catalog: kind } or { proc, spec }. */
export function matchObject(description, dims = {}) {
  const t = ` ${lower(description).replace(/[^a-z0-9' -]+/g, ' ')} `;
  for (const [re, proc, spec] of PROCEDURAL) {
    if (re.test(t)) return { proc, spec: { ...spec, ...sizeFrom(dims, spec) } };
  }
  const F = W().FURNITURE;
  const bare = t.trim();
  if (F[bare] && !F[bare].real) return { catalog: bare };          // a catalog key as is ("plantfern")
  for (const [re, k] of CATALOG) if (re.test(t) && F[k]) return { catalog: k };
  // anything else: an honest stand-in at the size the model gave (or a modest default)
  const name = String(description || 'object').trim().replace(/^(an?|the|some)\s+/i, '').slice(0, 28);
  const base = { name: name.charAt(0).toUpperCase() + name.slice(1), w: 0.6, d: 0.6, h: 0.8, against: 'free' };
  return { proc: ROUND.test(t) ? 'round' : 'boxy', spec: { ...base, ...sizeFrom(dims, base) }, generic: true };
}
function sizeFrom({ width_m, depth_m, height_m } = {}, spec) {
  const ok = (v, lo, hi) => (typeof v === 'number' && v >= lo && v <= hi ? v : null);
  const out = {};
  const w = ok(width_m, 0.05, 6), d = ok(depth_m, 0.02, 6), h = ok(height_m, 0.01, 3.2);
  if (w) out.w = w;
  if (d) out.d = d;
  if (h) out.h = h;
  return out;
}

const COLOR_WORDS = /\b(white|black|grey|gray|red|blue|navy|green|sage|olive|yellow|mustard|orange|pink|blush|purple|lavender|brown|tan|beige|cream|ivory|teal|gold|brass|silver|walnut|oak|pine|cherry|mahogany|charcoal|terracotta|burgundy)\b/;
const HEX = { white: 0xf2f0ea, black: 0x1c1c1c, grey: 0x8f8f8c, gray: 0x8f8f8c, red: 0xa8322d, blue: 0x4a74b5, navy: 0x26385c,
  green: 0x5f8f5a, sage: 0x9caf88, olive: 0x7d8450, yellow: 0xe8cf5a, mustard: 0xc99a2e, orange: 0xd9813a, pink: 0xe8b4bc,
  blush: 0xecc6c4, purple: 0x6e4f8f, lavender: 0xc3b5d9, brown: 0x7a5838, tan: 0xc4a57c, beige: 0xd9c7a7, cream: 0xf1e6cc,
  ivory: 0xf3edd8, teal: 0x2f7f7f, gold: 0xc9a24a, brass: 0xb5a160, silver: 0xbfc3c7, walnut: 0x5a3d28, oak: 0xb08a5e,
  pine: 0xd2b58a, cherry: 0x8b3a2b, mahogany: 0x5b2a1e, charcoal: 0x3f4144, terracotta: 0xc0643f, burgundy: 0x6b1f2a };
function colourOf(text, hex) {
  if (hex && /^#?[0-9a-f]{6}$/i.test(String(hex).trim())) return parseInt(String(hex).trim().replace('#', ''), 16);
  const m = lower(text).match(COLOR_WORDS);
  return m ? HEX[m[1]] : null;
}

// a small floating name tag, so a stand-in never pretends to be a real model
function label(text, height) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(20,20,24,0.72)';
  g.beginPath();
  if (g.roundRect) g.roundRect(4, 8, 504, 80, 36); else g.rect(4, 8, 504, 80);
  g.fill();
  g.fillStyle = '#fff';
  g.font = '500 40px system-ui, -apple-system, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text.slice(0, 26), 256, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(0.8, 0.15, 1);
  s.position.set(0, 0, height + 0.18);
  s.renderOrder = 3;
  s.raycast = () => {};                              // never picked, never blocks a drag
  s.userData.johnLabel = true;
  return s;
}

function slug(s) { return lower(s).replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'object'; }

/** Register (once) a FURNITURE entry for a procedural kind, so fit, physics, move and remove all work on it. */
function register(proc, spec, generic) {
  const F = W().FURNITURE;
  const kind = generic ? `x${slug(spec.name)}` : proc;
  const want = { name: spec.name, w: r2(spec.w), d: r2(spec.d), h: r2(spec.h), against: spec.against || 'free', john: true, proc };
  const have = F[kind];
  if (!have || have.w !== want.w || have.d !== want.d || have.h !== want.h) {
    // a different size of the same thing gets its own key (pieces already placed keep their size)
    const k = have ? `${kind}${Math.round(want.w * 100)}x${Math.round(want.d * 100)}` : kind;
    if (!F[k]) F[k] = want;
    return k;
  }
  return kind;
}

function dress(item, proc, colour) {
  const spec = W().FURNITURE[item.userData.kind];
  const g = new THREE.Group();
  BUILD[proc](g, spec, colour);
  const old = item.children[0];                        // buildFurniture's plain block (no model to swap in)
  if (old) item.remove(old);
  item.add(g);
  item.add(label(spec.name, spec.h));
  item.userData.john = proc;
}

const tools = () => (W().furnitureTools && W().furnitureTools.run) || W().agent.tools;

async function addObject(args = {}) {
  const w = W(), desc = String(args.description || args.kind || '').trim();
  if (!desc) return { ok: false, reason: 'Say what to add.' };
  if (args.room && !findRoom(args.room)) {             // "the nursery" on a plan that calls it "Bedroom": let the model pick
    return { ok: false, reason: `No room called "${args.room}". Pick one of these and call again: ${w.house.rooms.map((r) => r.label).join(', ')}.` };
  }
  const m = matchObject(desc, args);
  const colourText = args.color || (desc.match(COLOR_WORDS) || [])[0] || '';
  const kind = m.catalog || register(m.proc, m.spec, m.generic);
  let res;
  if (args.on) {                                       // "a lamp on the desk": stand it on that piece
    const ft = w.furnitureTools, support = ft && ft.resolve(args.on)[0];
    if (!support) return { ok: false, reason: `There is no ${args.on} placed yet. Add it first, then put this on it.` };
    const r = w.placeObject ? w.placeObject(kind, support.position.x, support.position.y) : null;
    if (!r || !r.fits) return { ok: false, reason: (r && r.say) || 'It does not fit on there.' };
    res = { ok: true, placed: kind, on: r.on, room: r.room || null };
  } else {
    // a wall piece (fireplace, piano, crib, dresser) goes against a wall of the room, not 2 m out in the open
    const against = args.against || (!args.room && w.FURNITURE[kind].against === 'wall' ? 'wall' : undefined);
    res = await tools().add_furniture({ kind, room: args.room, against });
    if (res && res.ok !== false && res.where_problem && !args.against && against) {   // no free wall: fall back to the default spot
      const last = [...w.furniture.children].reverse().find((o) => o.userData.kind === kind);
      if (last) last.parent.remove(last);
      res = await tools().add_furniture({ kind, room: args.room });
    }
    if (!res || res.ok === false) return { ...(res || {}), described: desc };
  }
  const item = w.selected && w.selected.userData.kind === kind ? w.selected
    : [...w.furniture.children].reverse().find((o) => o.userData.kind === kind);
  if (m.proc && item) dress(item, m.proc, colourOf(colourText, args.hex));
  else if (m.catalog && colourText && item && tools().set_furniture_color) {
    const id = item.userData.fid;
    await tools().set_furniture_color({ target: id || 'it', color: colourText, hex: args.hex });
  }
  const spec = w.FURNITURE[kind];
  return { ...res, ok: true, described: desc, used: m.catalog ? `catalog ${spec.name.toLowerCase()} (real model)` : `a ${spec.name.toLowerCase()} stand-in`,
    size_m: `${spec.w} x ${spec.d} x ${spec.h} high`, stand_in: !!m.proc,
    say_hint: m.proc ? 'Say it is a simple real-size stand-in for the shape, then whether it fits.' : undefined };
}

// ------------------------------------------------------------------ undo
// Before each of John's changes, a snapshot of what he can change: pieces (position, turn, colour), wall finishes,
// pictures. One spoken request is one step, however many tools it ran. Hand drags are not recorded.
const MUTATING = ['paint_room', 'add_furniture', 'place_object', 'add_object', 'move_furniture', 'rotate_furniture', 'remove_furniture',
  'set_furniture_color', 'set_wall_material', 'hang_picture', 'decorate_room', 'renovate_house', 'remove_decor',
  'stage_room', 'stage_house'];
const stack = [];
const MAX_UNDO = 12;
let turn = 0, snapTurn = -1, lastToolAt = 0, depth = 0;

const pieces = () => W().furniture.children.filter((o) => o.userData && o.userData.kind);
const wallKey = (x) => `${x.wall.floor}|${x.wall.a}|${x.wall.b}`;

function snapshot(why) {
  const w = W();
  return {
    why,
    items: new Map(pieces().map((o) => [o, { x: o.position.x, y: o.position.y, z: o.position.z, rot: o.rotation.z,
      tint: o.userData.tint, on: o.userData.on, floor: o.userData.floor }])),
    walls: (w.wallMaterials ? w.wallMaterials() : []).map((x) => ({ wall: x.wall, url: x.url, tile: x.tileMetres })),
    pictures: w.decor ? [...w.decor.pictures] : [],
  };
}
function sameState(s) {
  const now = snapshot();
  if (now.items.size !== s.items.size || now.walls.length !== s.walls.length || now.pictures.length !== s.pictures.length) return false;
  for (const [o, a] of now.items) {
    const b = s.items.get(o);
    if (!b || Math.abs(a.x - b.x) > 1e-4 || Math.abs(a.y - b.y) > 1e-4 || Math.abs(a.rot - b.rot) > 1e-4 || a.tint !== b.tint) return false;
  }
  const urls = new Map(s.walls.map((x) => [wallKey(x), x.url]));
  return now.walls.every((x) => urls.get(wallKey(x)) === x.url) && now.pictures.every((p, i) => p === s.pictures[i]);
}

function untint(o) {
  delete o.userData.tint;
  o.traverse((m) => { if (m.isMesh && m.userData.tintOrig) { m.material = m.userData.tintOrig; delete m.userData.tintOrig; } });
}

async function restore(s) {
  const w = W(), done = { removed: [], restored: [], moved: [], recoloured: [], walls: 0, pictures: 0 };
  const name = (o) => lower((w.FURNITURE[o.userData.kind] || {}).name || o.userData.kind);
  for (const o of pieces()) {
    if (s.items.has(o)) continue;
    if (w.selected === o && w.select) w.select(null);
    o.parent.remove(o);
    done.removed.push(name(o));
  }
  for (const [o, st] of s.items) {
    if (!o.parent) { w.furniture.add(o); done.restored.push(name(o)); }
    else if (Math.abs(o.position.x - st.x) > 1e-4 || Math.abs(o.position.y - st.y) > 1e-4 || Math.abs(o.rotation.z - st.rot) > 1e-4) done.moved.push(name(o));
    o.position.set(st.x, st.y, st.z);
    o.rotation.z = st.rot;
    o.userData.on = st.on;
    o.userData.floor = st.floor;
    if (o.userData.tint !== st.tint) {
      if (st.tint) o.userData.tint = st.tint; else untint(o);   // furniture-tools re-applies a tint every 300 ms
      done.recoloured.push(name(o));
    }
  }
  if (w.wallMaterials && w.clearWallMaterial) {
    const before = new Map(s.walls.map((x) => [wallKey(x), x]));
    for (const x of w.wallMaterials()) {
      const b = before.get(wallKey(x));
      if (!b || b.url !== x.url) { w.clearWallMaterial(x.wall); done.walls++; }
    }
    const now = new Set(w.wallMaterials().map(wallKey));
    for (const b of s.walls) if (!now.has(wallKey(b))) { await w.setWallMaterial(b.wall, b.url, b.tile); done.walls++; }
  }
  if (w.decor) {
    const keep = new Set(s.pictures), list = w.decor.pictures;
    for (let i = list.length - 1; i >= 0; i--) {
      if (keep.has(list[i])) continue;
      const g = list.splice(i, 1)[0];
      if (g.parent) g.parent.remove(g);
      done.pictures++;
    }
  }
  if (w.checkFit) w.checkFit();
  return done;
}

async function undo() {
  while (stack.length && sameState(stack[stack.length - 1])) stack.pop();   // nothing changed since: skip it
  const s = stack.pop();
  if (!s) return { ok: false, reason: 'There is nothing of mine to undo yet.' };
  const d = await restore(s);
  snapTurn = -1;
  const parts = [];
  if (d.removed.length) parts.push(`took away the ${[...new Set(d.removed)].join(', ')}`);
  if (d.restored.length) parts.push(`brought back the ${[...new Set(d.restored)].join(', ')}`);
  if (d.moved.length) parts.push(`moved the ${[...new Set(d.moved)].join(', ')} back`);
  if (d.recoloured.length) parts.push(`put back the old colour on the ${[...new Set(d.recoloured)].join(', ')}`);
  if (d.walls) parts.push(`reverted ${d.walls} wall finish${d.walls === 1 ? '' : 'es'}`);
  if (d.pictures) parts.push(`took down ${d.pictures} picture${d.pictures === 1 ? '' : 's'}`);
  return { ok: true, undid: s.why, changes: parts, more_to_undo: stack.length,
    say: parts.length ? `Undone: I ${parts.join(', and ')}.` : 'Undone.' };
}

/** Wrap a tool so a snapshot is taken before it changes anything. Live voice calls the same RUN entries. */
function guard(name, fn) {
  if (fn.__johnUndo) return fn;
  const g = async function (args) {
    const busy = W().agent.isBusy && W().agent.isBusy();
    const fresh = snapTurn !== turn || (!busy && performance.now() - lastToolAt > 6000);
    if (depth === 0 && fresh) {
      stack.push(snapshot(name.replace(/_/g, ' ')));
      if (stack.length > MAX_UNDO) stack.shift();
      snapTurn = turn;
    }
    depth++;
    try { return await fn.apply(this, arguments); } finally { depth--; lastToolAt = performance.now(); }
  };
  g.__johnUndo = true;
  return g;
}
// add_furniture / place_object with a kind the catalog doesn't have ("fireplace", "sectional") would answer
// "Unknown kind" and the model often gives up: send those to add_object instead.
function orAddObject(name, fn) {
  if (fn.__johnAny) return fn;
  const g = async function (args = {}) {
    const res = await fn.apply(this, arguments);
    if (res && res.ok === false && /unknown kind|small objects in the catalog/i.test(res.reason || '')) {
      return addObject({ ...args, description: args.kind || args.description });
    }
    return res;
  };
  g.__johnAny = true;
  return g;
}

function guardAll() {
  const R = W() && W().agent && W().agent.tools;
  if (!R) return;
  for (const n of ['add_furniture', 'place_object']) if (typeof R[n] === 'function' && !R[n].__johnUndo) R[n] = orAddObject(n, R[n]);
  for (const n of MUTATING) if (typeof R[n] === 'function') R[n] = guard(n, R[n]);
}

// ------------------------------------------------------------------ rough cost of what is placed
// Catalog pieces use suggest.js's prices (the same numbers as the price tags); stand-ins use these mid-market guesses.
const STAND_IN_USD = { piano: 5000, grandpiano: 30000, fireplace: 4500, crib: 399, bunkbed: 699, dresser: 699, wardrobe: 799,
  sectional: 2499, christmastree: 149, cattree: 99, treadmill: 1299, floormirror: 199, tablelamp: 79 };
function estimateCost() {
  const w = W(), byName = new Map(), notPriced = [];
  let total = 0;
  for (const o of pieces()) {
    const spec = w.FURNITURE[o.userData.kind] || {}, n = lower(spec.name || o.userData.kind);
    const p = (w.suggest && w.suggest.priceOf(o.userData.kind)) || STAND_IN_USD[spec.proc];
    if (!p) { notPriced.push(n); continue; }
    total += p;
    byName.set(n, (byName.get(n) || 0) + 1);
  }
  const walls = w.wallMaterials ? w.wallMaterials().length : 0;
  const paint = walls * 350;                           // a pro painting one wall, roughly
  return { ok: true, pieces: Object.fromEntries(byName), furniture_usd: total, painted_walls: walls, paint_usd: paint,
    total_usd: total + paint, not_priced: notPriced,
    price_note: (w.suggest && w.suggest.PRICE_NOTE) || 'illustrative mid-market retail estimates, not quotes',
    house_price: 'the listing price is listing.price in describe_house, if the user meant the house' };
}

// ------------------------------------------------------------------ paint a whole room (or every room)
function findRoom(q) {
  const w = W(), rooms = w.house.rooms.filter((r) => r.poly && r.poly.length > 2);
  const c = w.current, here = c && c.pos ? w.roomAt(c.pos[0], c.pos[1], c.floor) : null;
  if (!q || /^(this|here|the room|this room|current)$/i.test(String(q).trim())) return here;
  const t = lower(q).trim();
  return rooms.find((r) => r.id === q) || rooms.find((r) => lower(r.label) === t)
    || rooms.find((r) => lower(r.label).includes(t) || t.includes(lower(r.label))) || null;
}
function roomWallFaces(room) {
  const w = W(), floor = (w.house.floors || []).find((f) => f.id === room.floor) || (w.house.floors || [])[0], out = [];
  if (!floor) return out;
  floor.walls.forEach((rec, index) => {
    if (rec.type && rec.type !== 'wall') return;
    const dx = rec.b[0] - rec.a[0], dy = rec.b[1] - rec.a[1], len = Math.hypot(dx, dy);
    if (len < 0.6) return;
    const mx = (rec.a[0] + rec.b[0]) / 2, my = (rec.a[1] + rec.b[1]) / 2;
    for (const s of [1, -1]) {
      const n = [(-dy / len) * s, (dx / len) * s];
      if (w.roomAt(mx + n[0] * 0.3, my + n[1] * 0.3, floor.id) === room) {
        out.push({ floor: floor.id, index, a: rec.a, b: rec.b, normal: n });
        break;
      }
    }
  });
  return out;
}
async function paintRoom({ description, room, colors } = {}) {
  const w = W();
  if (typeof w.setWallMaterial !== 'function' || !w.decor || !w.decor.patternTile) return { ok: false, reason: 'walls are not loaded yet' };
  const d = String(description || 'white paint');
  const tile = w.decor.patternTile(/paint|paper|stripe|check|dot|brick|tile|wood|damask|floral/i.test(d) ? d : `${d} paint`, { colors });
  if (!tile) return { ok: false, reason: `I don't know the finish "${d}". Name a colour, e.g. "warm white".` };
  const all = /^(all|every|everywhere|whole house|the house|house|all rooms|every room)$/i.test(String(room || '').trim());
  const floor = w.current && w.current.floor;
  const rooms = all ? w.house.rooms.filter((r) => r.poly && r.poly.length > 2 && (!floor || !r.floor || r.floor === floor)) : [findRoom(room)];
  if (!rooms[0]) return { ok: false, reason: `No room called "${room}". Rooms: ${w.house.rooms.map((r) => r.label).join(', ')}.` };
  let walls = 0, area = 0;
  const done = new Set();
  for (const r of rooms) {
    for (const face of roomWallFaces(r)) {
      const k = `${face.floor}|${face.index}|${face.normal.map((v) => v.toFixed(2))}`;
      if (done.has(k)) continue;
      done.add(k);
      try {
        const res = await w.setWallMaterial(face, tile.url, tile.tile);
        if (res && res.ok) { walls++; area += res.area || 0; }
      } catch (e) { console.warn('[john] wall failed', e); }
    }
  }
  return { ok: walls > 0, finish: d, rooms: rooms.map((r) => r.label), walls, area_m2: Math.round(area),
    reason: walls ? undefined : 'No walls could be covered there.' };
}

// ------------------------------------------------------------------ registration
const declarations = [
  { name: 'add_object',
    description: 'Add ANY object the user names, real size, even if it is not in the catalog: fireplace, piano, grand piano, crib, bunk bed, dresser, wardrobe, sectional, Christmas tree, cat tree, treadmill, floor mirror, table lamp, or anything else. Catalog things (sofa, bed, desk, TV, bookcase, lamp, rug, plants) use the real model; anything else becomes a simple, labelled stand-in at the real size you give. Use it whenever add_furniture has no matching kind, and for "X on the desk/table" (pass on).',
    parameters: { type: 'object', properties: {
      description: { type: 'string', description: 'The object in the user\'s words, e.g. "fireplace", "upright piano", "white crib", "treadmill", "aquarium".' },
      room: { type: 'string', description: 'Optional room label to put it in.' },
      against: { type: 'string', description: 'Optional: "window" or "wall".' },
      on: { type: 'string', description: 'Optional placed piece to stand it on, e.g. "the desk", "the nightstand".' },
      color: { type: 'string', description: 'Optional colour, e.g. white, walnut, black.' },
      width_m: { type: 'number', description: 'Real width in metres, for things not in the list above (your best real-world size).' },
      depth_m: { type: 'number', description: 'Real depth in metres.' },
      height_m: { type: 'number', description: 'Real height in metres.' } },
      required: ['description'] } },
  { name: 'paint_room',
    description: 'Paint or paper EVERY wall of a room at once (the room the user is in by default), or of every room with room="all". Use for "paint this room / everything / the whole bedroom white", "make all the walls lighter". For one wall use set_wall_material.',
    parameters: { type: 'object', properties: {
      description: { type: 'string', description: 'The finish in the user\'s words, e.g. "white paint", "warm white", "sage green", "navy stripes".' },
      room: { type: 'string', description: 'Optional room label; empty = the room the user is in; "all" = every room on this floor.' },
      colors: { type: 'array', items: { type: 'string' }, description: 'Optional colours as names or #hex.' } },
      required: ['description'] } },
  { name: 'undo',
    description: 'Undo John\'s last change (the last request: pieces added, moved, turned, recoloured or removed, wall paint, pictures, staging). Call again to go further back. Use for "undo", "undo that", "go back", "never mind", "put it back how it was", "I preferred it before".',
    parameters: { type: 'object', properties: {} } },
  { name: 'estimate_cost',
    description: 'A rough total (USD, mid-market retail estimates) for the furniture placed and the walls painted, for "how much would this cost / all this furniture". Not the house price: that is listing.price in describe_house.',
    parameters: { type: 'object', properties: {} } },
];

const rules = `- Anything not in the catalog (fireplace, piano, crib, bunk bed, dresser, wardrobe, sectional, Christmas tree, treadmill, mirror, table lamp, aquarium…) -> add_object with the user's words, never a refusal. Say it is a simple real-size stand-in. "X on the desk" -> add_object with on.
- Rooms the plan doesn't name ("nursery", "kids' room", "master", "guest room", "office") mean the matching room in describe_house: a bedroom (the biggest for master, a smaller one for nursery/kids/guest), never a made-up name.
- "Swap / replace the X with a Y": remove_furniture the X, then add_object (or add_furniture) the Y, in the same turn.
- "Paint everything / the whole room / all the walls X" -> paint_room (room "all" for the whole house). One wall -> set_wall_material.
- "Undo", "undo that", "go back", "never mind", "put it back" -> undo (not remove_decor). Say what it reverted from its result.
- "How much would this cost" (furniture, the makeover) -> estimate_cost and say "about" the total; "what's the price of the house" -> listing.price from describe_house.
- Things no tool can do (switch lights on/off, knock down or move walls, add windows or doors, build outside, change the floor plan): say so in one short sentence and offer the closest thing you CAN do (a floor lamp or somewhere dimmer for lights; an open-plan furniture layout or the room size for walls; a mirror or plants for brightness).
- Vague wishes are design requests, not questions: "make it feel bigger / brighter" = paint_room in a light warm white plus add_object "floor mirror" (and fewer, lower pieces if it is crowded); "make it romantic / like a hotel" = decorate_room with that theme; "set up an office in X" = stage_room with style "home office" in X. Act, then say what you did.`;

(window.walkinTools = window.walkinTools || []).push({
  declarations,
  run: { add_object: (a) => addObject(a || {}), paint_room: (a) => paintRoom(a || {}), undo: () => undo(), estimate_cost: () => estimateCost() },
  rules,
});

(function start(tries = 0) {
  const w = W();
  if (!w || !w.agent || !w.FURNITURE) { if (tries < 600) setTimeout(() => start(tries + 1), 200); return; }
  guardAll();
  setTimeout(guardAll, 3000);                          // tool modules that register late
  const ask = w.agent.ask;
  w.agent.ask = function (...a) { turn++; return ask.apply(this, a); };   // one typed or spoken request = one undo step
  addEventListener('walkin:live', (e) => { if (e.detail && e.detail.kind === 'turn') turn++; });
  w.john = { addObject, undo, estimateCost, matchObject, snapshot, stack };
})();
