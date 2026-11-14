# Facts for the pitch

Numbers someone can say out loud without having to qualify them. Every one was measured on this
code, on these houses, and says how. Nothing here is rounded in our favour; where something only
works under a condition, the condition is part of the fact.

Measured against `main` on Sat 14 Nov, La Mirada (`zvKHR9DHNjJ`) unless another house is named.

## What it is

- A real Matterport scan of a real listing, **digitally emptied** by Matterport's own defurnished
  view, walked on a phone or in a headset, changed by pointing and talking.
- **5836 La Mirada Ave**: 39 scan points, 17 rooms. Also prepped: **10319 Dunvegan Way** (51 panos,
  12 rooms) and **314 Gale St, Houston** (55 panos, 10 rooms). All 211 residential splat houses in
  the hackathon set have a defurnished view.

## The claim that matters: it is in the house's coordinates, not in the picture

- Furniture is placed in the **model frame, in metres, Z up** — so walking to a different scan point
  shows the same furniture from the new angle. Measured: stage a room, move scan point, **0 of 7
  pieces moved**, to 1 mm.
- CoStar's own open problem #6 is furnishing a room *consistently*. An image-only edit cannot survive
  a change of viewpoint; this does, by construction rather than by effort.
- Same for the walls: a generated tile is laid on **one real wall** at real scale, cut around that
  wall's doorways and windows, and shaded by a light map sampled from the photo. Walk away and back:
  still the same wall.

## Real sizes, checked against the real room

- **22 catalogue items**, each at its real size. Measured by bounding box against the catalogue in
  all three dimensions: **22 of 22 within 6 cm**, 0 fell back to a box. The sofa is 2.10 × 0.95 m
  because sofas are.
- Every placement is checked against the room's own polygon, the other furniture, the doorway zones
  from the API's `openings`, and a 0.6 m walkway by raster and flood fill.
- **La Mirada: 32 pieces across 6 rooms in about a fifth of a second**, everything fitting, no
  doorway blocked. Dunvegan 19 across 4; 314 Gale St 26 across 4; the synthetic fixture 12 across 2.
- Rooms with nothing sensible to put in them are left alone on purpose — bathrooms, halls, closets,
  and never a garage or a basement, however big.

## The question people actually ask

> *"Will my sofa fit through that door?"*

- The answer is computed from the piece's footprint at the angle you are holding it and the doorway's
  real width: *"the sofa is 2.10 m across the way you're holding it and that door is 1.15 m — turn it
  and it goes through."* Turn it and it does.
- It refuses honestly: a king bed (1.95 × 2.15 m) at the same door gets *"it won't fit through at
  all"* **at every angle**, and never goes through.
- The houses make the point better than we could: of La Mirada's **22 doorways, 19 are too narrow for
  a sofa even turned**. One is 2.50 m and it just walks through. **Exactly one** is in the interesting
  middle. That is what buying a house is actually like.

## What it costs

- **61 fps with 32 pieces**, the same in side-by-side headset mode, on a laptop.
- The physics costs **0.0096 ms per piece per frame** — 0.31 ms for all 32.
- The fit check while you drag is **0.015 ms**; the full one with the walkway raster is 1.6 ms and
  only runs 300 ms after you stop moving.
- Twenty full-house stagings in three palettes leave the scene census **identical** — 429 objects,
  196 geometries, 61 materials, 7 textures, before and after. Nothing leaks: a piece is a clone of one
  cached glTF and the style materials are cached per (style, source material).

## Things to say carefully

- **Every number above is a laptop at 60 Hz.** As of this writing nobody has run it on a phone or in
  a headset, and nobody has run the hands with a real camera.
- The doorway assist helps a piece that *would* fit onto the centre line, but only within about
  **8 cm**, which is the real clearance anyway. Hands cannot hold ±8 cm. See #55.
- Everything verified without a Gemini key, on the mock. It demos well; it is not the real thing.
