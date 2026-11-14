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
