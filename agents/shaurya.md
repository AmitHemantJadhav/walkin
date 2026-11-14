# agents/shaurya.md — Shaurya's agent (furniture & restaging)

**Plan:** Claude Max. Loop every 12 min (`scripts/agent-loop.sh shaurya`). You can take over `handoff` issues.
**GitHub:** Shaurya-b167. **Branch:** `shaurya`. **Lane:** making the furnished house look real and fit.

## You own
`furniture.js` and new files you add for furniture (e.g. `models/`, `staging.js`, `layout.js`).
Do not edit `app.js` — request hooks from amit in an issue or PR comment.

## Your tasks (issues labelled `owner:shaurya`, in order)
- **S1** Real furniture: CC0 GLB models (Poly Haven, Kenney, Quaternius). Put them in `models/` (keep each < 3 MB;
  prefer < 1 MB). Load with GLTFLoader, scale to the catalog's real `w × d × h`, origin at footprint centre on the
  floor, front facing −y. Keep the box builders as a fallback if a model fails to load.
  Keep `buildFurniture(kind)` returning synchronously (return a group, fill it when the GLB arrives).
- **S2** Make it sit in the photo: ambient light tinted by the pano's average colour, soft contact shadow, slight
  roughness. No dynamic shadow maps on phones.
- **S3** `walkin.stageRoom(roomId, style)` in `staging.js`: for bedroom / living / dining / office, place a set that
  fits the room polygon (bed against the longest wall without a doorway, etc.). Return what was placed and
  whether it fits, so the agent can say it.
- **S4** Fit check v2 (`fit.js`, exported function the viewer can call): keep doorways clear (use wall `openings`),
  ≥0.6 m walkway, no overlap between pieces. Return reasons ("blocks the bedroom door").
- **S5** Plants: 5–8 CC0 plant GLBs + `walkin.placeObject(kind, x, y)` for small objects (plants, lamps, rug).
- **S6** Save/load layouts as JSON (`layout.js`): `walkin.saveLayout()`, `walkin.loadLayout(json)`, localStorage autosave.

## Notes
- Sizes are metres, Z up, front faces −y (see `furniture.js`).
- Exposing a function: `window.walkin.stageRoom = stageRoom` from your module, and add your `<script type="module">`
  line to `index.html` (small additive edit; mention it in the PR).

---

## State of this lane (updated Sat 08:50 ET by the overnight agent)

**All of S1–S8 plus A4 are built and on `main`** (A4 was handed to me from Amit on #5). What exists now:

| file | what it does | hooks |
|---|---|---|
| `furniture.js` | 22-kind catalog at real metres, CC0 glTF models, three style palettes applied part by part, contact shadows | `FURNITURE`, `PLANTS`, `buildFurniture`, `setStyle`, `applyStyle`, `STYLES` |
| `models/` | Kenney Furniture Kit (CC0) + two photoreal Poly Haven pieces in `hero/`, loaded after the kit model so nothing waits. `models/CREDITS.md` has provenance and two traps. `models/preview.html` renders every item in its real-size box | |
| `lighting.js` | ambient tint, key-light direction and contact-shadow strength read off the current pano | `walkin.relight()` |
| `fit.js` | room outline, piece overlaps, doorway zones from the API's `openings`, 0.6 m walkways by raster + flood fill. `{quick: true}` skips the raster (162× cheaper) for use while dragging | `fitReport`, `fitLine`, `checkRoom`, `doorsFor` |
| `staging.js` | `stageRoom` / `stageHouse` / `placeObject`, every placement validated, clear of wall faces | `stageRoom`, `stageHouse`, `placeObject`, `describeRoom`, `plants`, `styles`, `setStyle` |
| `walls.js` + `shade.js` | A4: a material on one real wall, split around doorways and windows, at real scale, multiplied by a light map sampled from the photo | `setWallMaterial`, `clearWallMaterial`, `wallMaterials` |
| `physics.js` | a constraint layer, not an engine: walls with doorways open, swept sub-steps, mass lag, friction slide | `walkin.physics.{grab,moveTarget,release,shove,probe,enabled}`, `walkin:blocked` event |
| `layout.js` | save / load / clear, localStorage autosave per house, `?layout=none`, and what each piece stands on | `saveLayout`, `loadLayout`, `clearLayout` |
| `tools/fake_house.py` | a synthetic house into the git-ignored `data/fixture` so the viewer runs with **no Matterport keys** | `?m=fixture` |
| `tools/make_tiles.py` | four seamless 1 m wall tiles so the wallpaper beat survives a missing Gemini key | |
| `preflight.js` | `await walkin.preflight()` — nine pass/fail lines before you present, saves the room and puts it back | `preflight` |
| `docs/demo-runbook.md` | the 3-minute run, rehearsed against `main`, opening with the six things that will bite you | |

### Things worth knowing before you change any of this

- **Room polygons from the API follow wall CENTRE LINES.** A piece placed against the polygon edge is half inside
  the wall. `alongWall` clears `thickness / 2` and `clearOfWalls` rejects anything overlapping a wall band.
- **A wall midpoint belongs to no room**: `roomAt` on it returns null. Look a step inside along the normal.
- **Model geometry and materials are shared.** A piece is `clone(true)` of one cached glTF; style materials are
  cached per (style, source material); every contact shadow uses one `CanvasTexture`. **Never dispose any of it
  when removing a piece** — it blanks the next one of that kind. `walls.js` is the exception: each wall owns its
  material and light map, and those are disposed.
- **Telling "carrying" from "placing" by distance alone is wrong** and bit three times: being stuck is exactly when
  the distance grows. `physics.js` uses time, contact and whether a hand holds it.
- The empty-house mesh sits a few centimetres into the room from the idealised wall graph, so `walls.js` offsets
  **8 cm**, not the 1 cm the issue suggested. Less and the wallpaper is buried.
- **An opening is `{type, width, height, bottom, at}`** after `prep_house.py` normalises it — *not* the API's
  `lowerElevation` / `relativeCenter`. Use `at` (0–1 along the wall). I spent twenty minutes this morning chasing a
  critical bug that was my own test reading `relativeCenter`, getting `undefined`, and falling back to the wall
  midpoint, which is nowhere near the door.
- **`tryPlace` puts everything on the floor.** Anything that goes on top of something else has to go through
  `placeObject`, which knows about surfaces. A floor-level television inside a floor-level stand fails its own
  overlap check, which is why no staged room had a television until this morning.
- **A piece standing on another records `userData.on = <uuid>`, and uuids are new every reload.** `layout.js`
  stores the link as an index into the saved list and puts it back; `walkin.supportUnder(item)` works it out from
  the geometry for anything saved before that. Without it a restored television and its stand each read the other
  as a collision and neither can be picked up.
- **`userData.on` is written when a piece is placed and almost nothing else looks at it.** That one fact
  produced three separate bugs in one morning: a restored television and its stand reading each other as a
  collision, a television left hanging in the air when its stand was deleted, and a television left behind
  when its stand was dragged. If you add anything that moves, removes or reloads a piece, ask what happens
  to whatever is standing on it. `carry()` and the dangling-support drop in `physics.js` cover the loop;
  `layout.js` covers save and load.
- **The previous position of a piece has to come from `st`, not from the item.** A mouse drag and the ⟳
  button write `item.position` / `item.rotation` themselves, so inside the frame loop those already hold
  the new value and any difference you compute against them is zero. `st.x`, `st.y`, `st.rot` still hold
  last frame's. This cost twenty minutes: riders followed a hand drag perfectly and ignored the ⟳ button.
- **"The nearest door" is not "the door you are pushing at".** La Mirada's 1.15 m doorway has a 0.77 m one
  a metre and a half away, and `doorReason` quoting the nearest produced a confident, specific, wrong
  sentence a second before the sofa went through the other door. Choose by direction, as `doorAhead` does.
- **Big and unlabelled is not the same as living space.** `PLANS.living` refuses garages, basements, laundries and
  the rest unless the style string asks for a living room by name. A sofa in the garage is worse than an empty
  garage, because John says it out loud.

### `stageRoom` answers "the whole house" with the whole house

John has a `stage_house` tool as of #60, and this stays as the net under it. It was written when
`stage_room` was his only staging tool, so beat 7 arrived here
with the whole sentence as the style. `WHOLE_HOUSE` catches *whole house / entire home / every room /
all the rooms* and delegates to `stageHouse`, returning a `stageRoom`-shaped result so `agent.js` and the
mock need no change. **Strip the phrase before delegating** — `stageHouse` calls `stageRoom` for every
room, and leaving it in made each of those ask for the whole house again: the recursion came back with
nothing placed and no error anyone could see. Take this out the day a real tool lands.

### Beat 5 only works at one door, and this is the thing most likely to flatten the demo

For a 2.10 × 0.95 m sofa, La Mirada's 22 doorways are: **19 too narrow at any angle** ("it won't fit through at
all"), one 2.50 m opening it just walks through, and **exactly one** — 1.15 m, off the living room, model
`(2.81, 0.02)`, 0.47 m from **scan point 37** — where the answer is "turn it and it goes through". Both halves
verified at that door against `main`, king bed included. `walkin.doorsFor('sofa')` answers this for any house;
314 Gale St has one usable door, the 1.50 m living/dining one at scan point 5. Run it before rehearsing anywhere
new.

### Run `await walkin.preflight()` before anything else

Eight checks with the number behind each — the house, John, staging, whether this house even has a door the
sofa beat works at, physics, the wallpaper tiles, the hand hooks, the frame rate. It saves the room first and
puts it back. It is also the fastest way to find out whether a change broke something: 8/8 on La Mirada
standing in the living room.

### Measured, so nobody has to guess

61 fps with 28 pieces, the same in headset (side-by-side) mode, **on a laptop**. Twenty full-house stagings in
three palettes leave the scene census identical — 401 objects, 189 geometries, 54 materials, 7 textures — so
nothing leaks. La Mirada stages 32 pieces across 6 rooms, Dunvegan 19 across 4 (with #51), 314 Gale St 26 across 4.

### Open, with the measurements, deliberately not fixed

Five things I found today and chose to write up rather than land unreviewed on demo morning. Each has
the numbers and the dead ends on the issue, so picking one up is an hour rather than a morning.

| | |
|---|---|
| **#55** | the doorway assist lines a piece up but doesn't carry it through — four attempts, four reverts. Not an angle problem: the sofa comes out 0.00° square and 11.3 cm off centre against 10.0 cm of clearance |
| **#57** | a sofa pushed into a coffee table stops dead; `MASS` has never been used for contact. Built it, tripled the travel, and it left two pieces overlapping, so it is on the issue |
| **#58** | you can put a plant on a table by asking but not by dragging — the frame loop knows nothing about surfaces |
| **#61** | wallpaper clips against the scan mesh on one 314 Gale St wall. It is the mesh, not the quad; raising the 8 cm offset makes the paper stand proud |
| **#63** | dragging *and* rotating together can leave two pieces overlapping. Drag-only is clean, rotate-only is clean. Probably the sequencing: two pieces moving in one frame are each checked against the other's old position |

### If there is time after the demo

`scripts/smoke.sh` checks syntax, that no key or `data/` is tracked, and that `index.html` doesn't
load a file that isn't there. **It would have caught none of the eight bugs found this morning** —
the television never being placed, the rotate button doing nothing since S8, a deleted stand leaving
its television in the air, the wrong door being quoted. All behaviour, none of it syntax.

`walkin.preflight()` is the browser-side version of the same idea and it already catches most of
that class: staging placing nothing, a piece stuck in something, no wall segments, the wallpaper
tiles missing. @sshruti115 has a headless Chrome setup (she tested #60 with it) — **running
`preflight()` headlessly in `smoke.sh` and failing on a red row** is the cheapest real test suite
this repo could have. `scripts/` is the humans' to change, so this is a note, not a commit.

### Don't measure physics by teleporting a piece and turning it

Checking how far off square the sofa can enter a doorway, I set each run up by teleporting it a
stride from the door, grabbing it, calling `moveTarget(hand, point, yaw)` with the yaw I wanted and
letting it settle. **Turning a 2.1 m sofa in place that close to a door makes the solver shove it**,
so every run past about 5° had already been pushed through the doorway before the walk started. The
end states looked plausible and I nearly shipped "±7° goes through, ±8° stops a metre short" as a
measurement (#84).

What gave it away was a result that was too good rather than obviously broken: the **0.98 m** bathroom
door looked *more* forgiving than the **1.15 m** demo door, which cannot be true. Both were the same
artefact.

So, for anything physics:
- **Assert where the run started**, not just where it ended — `roomAt(x, y)` at the first frame, plus a
  plausible travel distance. A run that travelled 0.20 m did not traverse anything.
- **Don't teleport into a tight spot.** Grab the piece and walk it to the start gradually so the
  solver tracks it, and turn it in open floor away from the obstacle.
- **Say which direction you drove.** Through the *same* door, 12 cm off centre goes through one way
  and stops the other, and the whole envelope differs by direction. Worth knowing before retrying #55.
- `-0/1` is `0` and `op.at` is not `op.relativeCenter`. Same family of mistake: the number came back
  looking usable.

The lateral figure that survived all this was **about 10 cm**, not symmetric, which is what
`physics.js:342` documented at the time. **Superseded:** @AmitHemantJadhav fixed #55 in #97 (slide
along the jamb, then commit to the door as a rail) and it is now **±50 cm** on the same door. The
lesson about controls stands; the number doesn't.

### Delete the thing you are blaming before you blame it

On #89 I reported a "thin white wedge" in the wallpaper on La Mirada wall #1 and guessed it was the
paper quad overhanging a corner. @AmitHemantJadhav filed **#91** on that report and built returns at
every opening edge to fix it.

**There was nothing to fix.** The control took one call: `clearWallMaterial` on that wall and look at
the same spot from the same viewpoint. The white shapes are **still there** with no wallpaper in the
scene at all — they are the photographed door jamb and its trim, seen through the hole the paper is
correctly cut around.

| | the bright shapes |
|---|---|
| paper + returns | present |
| paper, `&wallreturn=off` | present, identical |
| **no paper at all** | **present, identical** |

Anything that survives deleting the thing you draw is not a bug in the thing you draw. When something
looks wrong *on* a surface we render, remove the surface first; it is cheaper than any amount of
reasoning about quads and z-fighting, and it is the test I skipped.

This is the same shape of mistake as [[#84]]: both times the missing step was a control, and both
times I had a plausible mechanism in hand that made me feel finished before I had checked anything.
A plausible mechanism is the *reason* to run the control, not a substitute for it. Also: pixel → ray
arithmetic across a scaled screenshot is not good enough to identify geometry — I tried that first on
#93 and it put a pixel I could plainly see as brick inside a doorway.

### Still untested by anyone, as of this writing

- **Hands with a real camera** (#41, #50) — no webcam on this machine.
- **Anything on a phone or in the headset**, including fps with hands on. Everything above is a laptop at 60 Hz.
- **The agent against a real Gemini key** — there is none in `.env` here; everything was verified with
  `GEMINI_MOCK=1`, which works well enough to demo on.
