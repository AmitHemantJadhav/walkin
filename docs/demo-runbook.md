# Demo runbook

Rehearsed against `main` on the real La Mirada house. Every line below was run and timed; where
something doesn't work yet it says so.

Three minutes, in this order. The point of the order is that each beat answers a question the
previous one raises.

**[`demo-card.md`](demo-card.md) is the one-screen version** — the seven beats, the lines to say, and
this list. Hold that; this is the document you read beforehand.

## The six things that will bite you

Each one is explained where it belongs below; this is the list to read on the walk to the stage.

1. **Beat 5 only works at one doorway** — the 1.15 m one off the living room, **scan point 37**. At
   nineteen of La Mirada's twenty-two the sofa doesn't fit turned either, and John says so.
2. **Go in square.** ±8 cm of the centre line goes through; past that the sofa lines up with the
   doorway and stops in it. Back off half a metre, square up, go again.
3. **Move the coffee table first.** Beat 2 puts one right in front of the sofa, and a sofa can't pass
   through a coffee table: dragged straight at the door it travels 24 cm and stops.
4. **Beat 5 is silent unless #54 is merged.** `physics.js` computes the sentence; the only thing that
   speaks it is eleven lines in `agent.js` on that PR.
5. **Beat 7 needs #60 merged** to be a real tool call; without it there is a safety net that works
   in mock mode. `walkin.stageHouse('modern')` always does the house.
6. **Don't stand at scan point 38 or 16.** They are inside rooms the scan gives no outline, so
   staging refuses — and 38 is 0.63 m from the doorway beat 5 needs.

If the hands make furniture fly away from you, add **`&dgain=0`** to the URL.

---

## Before you start

```bash
python3 serve.py                 # or scripts/live.sh on the demo laptop
cloudflared tunnel --url http://localhost:8000
```

Open `…/?m=zvKHR9DHNjJ`, **stand inside a room**, and run one line in the console:

```js
await walkin.preflight()
```

Nine ✓ or ✗ with the number behind each: the house, whether John answers, staging, whether this
house even has a door the sofa beat works at, physics, the wallpaper fallback tiles, whether a layout
from an earlier session is waiting to come back, the hand hooks and the frame rate. It saves whatever is in the room first and puts it back, so it costs you nothing
to run it twice. On La Mirada, standing in the living room with `&layout=none`, all nine are green.

Two it cannot check for you: **the camera** (press ✋ and look at your own hand) and **the headset**.

The same checks by hand, if you'd rather:

| check | what you should see |
|---|---|
| `…/api/health` | `{"gemini": true}` or `{"provider": "mock"}` — **if both are false, John is deaf** |
| the house loads | room card top left, dock at the bottom, nav rings on the floor |
| ✋ Hands | your hand appears cut out of the camera within a couple of seconds |
| `?fps` | 45 or better in headset mode with hands on |

**If there is no Gemini key**, start the server with `GEMINI_MOCK=1 python3 serve.py`. The mock picks
a tool from your words and even generates a brick tile, so nothing dies on stage — but it is not as
good as the real thing and two beats need help. Run end to end against the mock this morning:

| beat | spoken | what actually happens |
|---|---|---|
| 2 furnish | *"stage this as a cosy living room"* | **works** — 7 pieces, television included, and John reads the sentence back |
| 4 wallpaper | *"put red brick wallpaper on this wall"* | **works** — tile generated and laid at real scale, 3.9 s end to end |
| 6 the plant | *"what plant should go here?"* | stops after reading the light: *"Mock reply: done (light_here)"*. Use `walkin.suggestPlant()` |
| 7 the close | *"furnish the whole house"* | **works** — 6 rooms, 32 pieces, and he reads back what he did |

**Start from a clean house:** `…/?m=zvKHR9DHNjJ&layout=none` — otherwise last night's furniture
is still there, because layouts persist on purpose.

---

## The run

### 1. "This is a real house, and it's empty." (20 s)

Walk two or three scan points. Point out that the house has been **digitally emptied** by
Matterport — this is a real listing, not a model.

### 2. "Furnish it." (30 s)

> **"Hey John — stage this as a cosy living room."**

A sofa, rug, coffee table, armchair, tv stand, television and a plant appear, and John says what he did:

> *"I put sofa, rug, coffee table, armchair, tv stand, television and plant in the living room.
> Everything fits, doors clear."*

**Say the thing that matters:** every piece is in the house's own coordinates, at its real size in
metres, checked against the room's walls and doorways. The sofa is 2.1 m because sofas are.

Fallback if the voice path misbehaves: **⋯ → ⌂ Stage room**. Each press cycles modern → cozy →
scandi. Nobody can tell it wasn't the plan.

### 3. "Now walk around it." (20 s)

Move to another scan point. The furniture is still exactly where you left it, from a completely
different photo.

**This is the whole pitch.** CoStar's own open problem #6 is furnishing a room *consistently* —
an image-only edit cannot survive a change of viewpoint. Ours is in model space, so it does by
construction.

### 4. "Change the wall." (30 s)

Look at a wall and say:

> **"Hey John — put red brick wallpaper on this wall."**

The tile is generated, then laid on that wall at real scale, **cut around the door and the
window**, and shaded by the photo's own light, so the corner stays dark and the patch beside the
window stays bright. Walk to another scan point: still the same wall.

### 5. "Will my sofa fit?" (40 s) — the one people actually ask

**Move the coffee table first.** Beat 2 just put one directly in front of the sofa, because that is
what a living room looks like, and a sofa cannot pass through a coffee table: dragged straight at the
door it travels **24 cm** and stops. Grab the coffee table and pull it aside — one grab, it is light
and it moves easily — or run this beat on a room you haven't staged. (Why the sofa doesn't just shove
it out of the way: #57.)

**Use the right door.** The beat only works at a door the sofa *could* pass if it were turned, and
La Mirada has three out of twenty-two: the 2.50 m opening into the dining room (too wide, nothing to
prove), one at 0.98 m into the dining room, and **the 1.15 m doorway off the living room — the one
the sentence below quotes**. It is at model `(2.81, 0.02)`; stand at **scan point 37**, 0.47 m away,
and you are looking straight through it. At the other nineteen the sofa doesn't fit turned either, so
John correctly says *"it won't fit through at all"* and the beat goes nowhere.

Grab the sofa and carry it at the doorway **broadside**. It stops dead, and John says:

> *"the sofa is 2.10 m across the way you're holding it and that door is 1.15 m — turn it and it goes through"*

**Check #54 is merged before you rely on that.** `physics.js` computes the sentence and fires it as a
`walkin:blocked` event; the only thing that listens is eleven lines at the end of `agent.js` in #54.
Without them the sofa stops at the door **in silence** and the beat is half of what it should be. One
line in the console tells you:

```js
addEventListener('walkin:blocked', e => console.log(e.detail.reason))   // then push the sofa at the door
```

Turn it and walk it through — **square on**. Measured at that doorway: up to about **8 cm off the
centre line it goes straight through**, which is the real clearance a 0.95 m sofa has in a 1.15 m
door. Past that the assist does slide it towards the centre, but the hand is still pulling off to one
side, so the sofa lines itself up with the doorway and stops in it rather than passing. It looks
deliberate rather than broken — but if it stops, back off half a metre, square up and go again, and
don't let anyone think it is meant to be forgiving. Fixing that properly needs the doorway to act as
a rail for the whole traverse; four attempts at it this morning each made something else worse (#55),
so it is written down rather than half-done.

A piece that genuinely doesn't fit, like a king bed at a 1.15 m door, is never helped and says *"it
won't fit through at all"* instead.

Both halves were run against `main` at that doorway, and the two sentences above are verbatim what
came back: the sofa (2.10 × 0.95 m) stops 0.56 m short held broadside and crosses to the other side
once turned; the king bed (1.95 × 2.15 m) gets the same answer at every angle and never goes through.

This is the beat to land hardest. Nobody buying a house asks whether a render looks nice; they ask
whether the sofa gets through the door.

### 6. "And the plant?" (20 s)

> **"Hey John — what plant should go here?"**

He reads the light at that spot from the photo and the window positions, and places one:

> *"A fern — that spot is low light, 4.2 m from the nearest window, and it is happy out of the sun."*

The plant depends on the reading: a fern out of the sun, a plant in indirect light, a tall cactus in
a bright window. Standing in the living room this morning it answered *"A plant — that spot is medium
light, 3.3 m from the nearest window, and it does well in indirect light."* — so don't promise a fern
before you've heard it.

If the model doesn't chain the two steps, `walkin.suggestPlant()` does the whole thing in one call
and always lands.

### 7. Close (10 s)

> **"Hey John — furnish the whole house."**

Six rooms, 32 pieces, and John reads it back:

> *"I furnished 6 rooms with 32 pieces — 2 dining rooms, 2 living rooms and 2 bedrooms."*

Then walk through it.

**Check #60 is merged.** It gives John a real `stage_house` tool, which is the version of this beat
that doesn't depend on the model's mood. With it, *"furnish the whole house"* is one tool call.

Without it there is still a safety net in `staging.js`: `stage_room` is then John's only staging
tool, so the sentence arrives as the *style*, and staging honours what was asked — *whole house*,
*entire home*, *every room*, *all the rooms* — instead of furnishing whichever room you happen to be
standing in. ("Stage this room like the rest of the house" is not that, and stages one room.) That
works in mock mode, verified at 6 rooms and 32 pieces, but **with a real key it depends on the model
passing your words through**: tidy the style down to `"modern"` and the words are gone.

Either way, **`walkin.stageHouse('modern')`** always does the house, and is the thing to press if the
spoken line gives you one room.

Rooms it leaves alone are left alone on purpose, so don't apologise for them on stage: bathrooms,
halls and closets have no set, and a garage or a basement is never furnished by the whole-house pass
even when it is big enough — a sofa in the garage is worse than an empty garage. Ask for one by
name — *"stage this as a living room"* — and it will try anyway.

Both La Mirada living rooms have a television, each one squarely facing its sofa.

Other houses, measured the same way — and the numbers depend on whether **#51** is merged, because
that is what lets a big open-plan kitchen take the living set:

| | with #51 | without |
|---|---|---|
| 10319 Dunvegan Way | 19 pieces, 4 rooms (its 31 m² kitchen gets the living set, television and all) | 12 pieces, 3 rooms |
| 314 Gale St | 26 pieces, 4 rooms | 19 pieces, 4 rooms |

La Mirada is 32 either way. If the counts come out low on the day, that is the reason — check
whether #51 landed before assuming something is broken.

---

## What to avoid on stage

- **Don't reload** without `&layout=none` unless you want last night's furniture back.
- **Don't drag a piece into a corner it can't leave.** Physics is honest: if it won't fit, it won't
  go. `walkin.physics.enabled = false` in the console turns it off if it ever gets in the way.
- **Two scan points in La Mirada are in no room at all: 38 and 16.** Three of its seventeen rooms come
  back from the API with a label of `Room` and no boundary — 12.9 m², 8.6 m² and 0.1 m² — so standing
  in one, *"stage this"* answers *"not in a room"* and the button flashes `⌂ not in a room`. It is
  refusing rather than guessing, which is right, but it looks broken from the audience.

  **38 is the one to watch**: it is 0.63 m from the 1.15 m doorway beat 5 uses, so it is easy to land
  on by accident. Stand at **37** instead — it is 0.47 m from the same door and is in the living room.
  The other thirty-seven scan points are all inside a room.
- **Paint walls in the Empty view, not "As scanned".** The quad sits 8 cm into the room, so over the
  as-scanned photo it covers whatever was standing against that wall — the owner's sofa back, a
  lamp. It still works and still re-shades, it just looks like wallpaper over furniture. Empty is
  the default, so this only bites if you've toggled.
- **Put small things down by asking, not by dragging.** `walkin.placeObject('plantsmall', x, y)` and
  *"put a plant on the coffee table"* both land it on the table, linked, at the right height. Carry
  the same plant there by hand and it stops 0.69 m short, on the floor beside it: the frame loop
  treats the table as something to bump into, not something to stand on (#58).
- **The reload is safe, so don't panic-clear.** Furniture, what each piece is standing on, and wall
  materials all come back. Only a *generated* tile doesn't — see the next line.
- **A wall painted with a *generated* tile does not survive a reload.** The tile is a `data:` URL
  and we deliberately don't put megabytes of base64 in localStorage. A tile from
  `models/textures/` does survive.

## If something breaks

| symptom | do this |
|---|---|
| John doesn't answer | check `/api/health`; restart with `GEMINI_MOCK=1` |
| no hands | reload, allow the camera, check it's the right camera with 📷 |
| furniture won't move | `walkin.physics.enabled = false` |
| furniture flies away when you carry it with your hands | add `&dgain=0` to the URL — that turns off hand-depth push/pull (#50) |
| everything looks wrong | `walkin.clearLayout()` then `⌂ Stage room` |
| the house won't load | `python3 prep_house.py zvKHR9DHNjJ` again **then hard-reload** (⌘⇧R) — `/data/` is cached for a day, so without that you keep seeing the old file (#59); or `?m=fixture` after `python3 tools/fake_house.py`, which needs no keys at all — the whole run works there now, beat 5 included, because its doorway is 1.15 m like the real one. If you have opened that fixture before, write it somewhere new (`python3 tools/fake_house.py data/fixture2`, then `?m=fixture2`) rather than fighting the cache |

## Console equivalents for every beat

Useful for rehearsing without a microphone, and for anyone testing a change:

```js
walkin.stageRoom(walkin.roomAt(walkin.current.pos[0], walkin.current.pos[1], walkin.current.floor), 'cozy')
walkin.setWallMaterial(walkin.pointer.wall, 'models/textures/brick_red.jpg', 0.9)
walkin.placeObject('plant')
walkin.suggestPlant()                       // reads the light here, picks a plant, places it
walkin.stageHouse('modern')                 // the whole house: 6 rooms, 32 pieces, ~0.2 s
walkin.setStyle('cozy')                     // restyle everything already placed
walkin.clearLayout()
walkin.doorsFor('sofa')                     // every doorway, and whether a sofa gets through it
await walkin.preflight()                    // all of the above as nine pass/fail lines
```

`doorsFor` is how the door above was found, and it is the first thing to run on a house you have not
rehearsed on. 314 Gale St, for instance, has exactly one: the 1.50 m living/dining doorway, 0.31 m
from scan point 5.
