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
| `Sofa_01` | sofa | 0.6 MB |
| `ArmChair_01` | armchair | 0.6 MB |
| `GothicBed_01` | queen, king | 1.2 MB |
| `dining_table` | table | 2.3 MB |
| `metal_office_desk` | desk (and the office test fit) | 1.6 MB |
| `dining_chair_02` | chair (and the office test fit) | 0.9 MB |
| `ClassicNightstand_01` | nightstand | 0.4 MB |
| `side_table_01` | sidetable | 0.5 MB |
| `CoffeeTable_01` | coffeetable | 1.0 MB |
| `modern_wooden_cabinet` | tvstand | 2.9 MB |
| `wooden_display_shelves_01` | bookcase | 0.5 MB |
| `potted_plant_02` | plant | 2.6 MB |
| `potted_plant_04` | plantsmall | 2.1 MB |

All CC0 (<https://polyhaven.com/license>). A hero keeps its proportions (`fitToSpec` fits it inside
the catalog box uniformly, turning it 90° when its long side is on the other axis) and its own PBR
materials; the kit's style tints only multiply them.
