# Furniture models

All models in this folder are from Kenney's **Furniture Kit** (<https://kenney.nl/assets/furniture-kit>),
released under **Creative Commons Zero (CC0)** — public domain, free for commercial use, credit appreciated
but not required. Credit: Kenney (www.kenney.nl).

Downloaded from the `shorepine/kenney` mirror of the kit at commit `3694c68`
(`3d/furniture/<name>.glb`), unmodified. Each file is self-contained glTF-binary
(no external textures, flat-shaded materials) and under 25 KB.

| File | Used for | Model size (glTF, Y-up, metres) |
|---|---|---|
| `loungeSofa.glb` | `sofa` | 0.980 w × 0.410 d × 0.460 h |
| `loungeChair.glb` | `armchair` | 0.490 w × 0.410 d × 0.460 h |
| `bedDouble.glb` | `queen`, `king` | 0.956 w × 1.125 d × 0.375 h |
| `table.glb` | `table` | 0.841 w × 0.447 d × 0.327 h |
| `desk.glb` | `desk` | 0.734 w × 0.392 d × 0.384 h |

The kit is modelled at roughly half real scale, so `furniture.js` rescales every model to the
catalog's real metres (see `fitToSpec`): footprint to `w × d` exactly, height to `h`. The catalog `h`
values were set from each model's natural proportions, so the vertical stretch stays under ~10%.

`preview.html` renders every catalog item inside its real-size wire box — open
`http://localhost:8000/models/preview.html` with `serve.py` running to check sizes and facing.

## Photoreal pieces (`hero/`)

The sofa and armchair are **CC0** models from **Poly Haven** (<https://polyhaven.com>), downloaded at
1k texture resolution (glTF + .bin + diffuse/normal/ARM jpg). Public domain; credit appreciated,
not required.

| Folder | Used for | Size | Source |
|---|---|---|---|
| `hero/Sofa_01/` | `sofa` | 0.51 MB | <https://polyhaven.com/a/Sofa_01> |
| `hero/ArmChair_01/` | `armchair` | 0.75 MB | <https://polyhaven.com/a/ArmChair_01> |

These load *after* the Kenney model for the same kind, so a piece appears instantly and sharpens a
moment later; if they fail to load, the Kenney model stays. They keep their own PBR materials — a
`stageRoom` style tints them rather than recolouring them, so the texture detail survives.

Two things worth knowing if you add more of these:
- Poly Haven models can carry a baked `COLOR_0` vertex-colour attribute that multiplies the texture
  (it rendered `CoffeeTable_01` solid black until `vertexColors` was turned off).
- Their packed ARM maps can drive metalness to 1, and a metal surface with no environment map renders
  black, so metalness is clamped to 0.12 until the scene has an environment map.

The full set, fetched by `tools/heroes.py` (Poly Haven asset id → catalog kind):

| Asset | Kind | Size (1k) |
|---|---|---|
| `sofa_02` | sofa | 0.4 MB |
| `modern_arm_chair_01` | armchair | 2.7 MB |
| `GothicBed_01` | queen, king | 1.2 MB |
| `dining_table` | table | 2.3 MB |
| `metal_office_desk` | desk (and the office test fit) | 1.6 MB |
| `dining_chair_02` | chair (and the office test fit) | 0.9 MB |
| `ClassicNightstand_01` | nightstand | 0.4 MB |
| `side_table_tall_01` | sidetable | 1.6 MB |
| `coffee_table_round_01` | coffeetable | 1.6 MB |
| `modern_wooden_cabinet` | tvstand | 2.9 MB |
| `wooden_display_shelves_01` | bookcase | 0.5 MB |
| `potted_plant_02` | plant | 2.6 MB |
| `potted_plant_04` | plantsmall | 2.1 MB |

All CC0 (<https://polyhaven.com/license>). A hero keeps its proportions (`fitToSpec` fits it inside
the catalog box uniformly, turning it 90° when its long side is on the other axis) and its own PBR
materials; the kit's style tints only multiply them.

## Sketchfab models via Objaverse (`hero/objaverse/`)

Modern pieces Poly Haven does not have, from the Objaverse mirror of Sketchfab's Creative Commons
models (Deitke et al., 2022; <https://objaverse.allenai.org>). Each is CC-BY 4.0: credit the author,
link the model. Textures resized to 1k with gltf-transform; geometry untouched. Fetched by hand with
`tools/heroes.py`'s Objaverse section (uids in the catalog).

| File | Kind | Model | Author | License | Source |
|---|---|---|---|---|---|
| `08f7f65e…` | bed | Bed | [Ambriel](https://sketchfab.com/Ambriel) | CC-BY | [08f7f65edfea…](https://sketchfab.com/3d-models/08f7f65edfea417b8ed9ca748381e507) |
| `2a014121…` | dresser | Y7VF00 | [Interiors3D](https://sketchfab.com/Interiors3D) | CC-BY | [2a0141217f9b…](https://sketchfab.com/3d-models/2a0141217f9b4ae99abaf1a1a01683f1) |
| `d7afff23…` | table | Kitchen Table | [CioJay](https://sketchfab.com/CioJay) | CC-BY | [d7afff23c741…](https://sketchfab.com/3d-models/d7afff23c741411c82a5994ae9940669) |
| `774971f6…` | diningset | set | [jeilocreativedesignworld](https://sketchfab.com/jeilocreativedesignworld) | CC-BY | [774971f63ea5…](https://sketchfab.com/3d-models/774971f63ea54cdba8119439f4ff09c5) |
| `75a7a3a8…` | fridge | Rr | [jjjjeongggg](https://sketchfab.com/jjjjeongggg) | CC-BY | [75a7a3a81468…](https://sketchfab.com/3d-models/75a7a3a8146849dea698cfd04f73482b) |
| `b10785bc…` | stove | Thor Kitchen 6 Burner Gas Range | [allenbranch](https://sketchfab.com/allenbranch) | CC-BY | [b10785bcfc6e…](https://sketchfab.com/3d-models/b10785bcfc6e46a080614293c3ff6e1c) |
| `8f4abf0c…` | tablelamp | Modern lamp | [starkerg](https://sketchfab.com/starkerg) | CC-BY | [8f4abf0c719d…](https://sketchfab.com/3d-models/8f4abf0c719d42109f316ecece72dd75) |
| `c277c4d1…` | floorlamp | Antique Lamp | [aya.albayati](https://sketchfab.com/aya.albayati) | CC-BY | [c277c4d1742b…](https://sketchfab.com/3d-models/c277c4d1742b4f118becbfefd325ce71) |
| `51cfe336…` | tv | Tv_Sks | [Skippysnk](https://sketchfab.com/Skippysnk) | CC-BY | [51cfe336d192…](https://sketchfab.com/3d-models/51cfe336d19243eba66c5fac64a81507) |
