# Demo runbook

Rehearsed against `main` on the real La Mirada house. Every line below was run and timed; where
something doesn't work yet it says so.

Three minutes, in this order. The point of the order is that each beat answers a question the
previous one raises.

---

## Before you start

```bash
python3 serve.py                 # or scripts/live.sh on the demo laptop
cloudflared tunnel --url http://localhost:8000
```

Open `…/?m=zvKHR9DHNjJ`. Check in this order, it takes 30 seconds:

| check | what you should see |
|---|---|
| `…/api/health` | `{"gemini": true}` or `{"provider": "mock"}` — **if both are false, John is deaf** |
| the house loads | room card top left, dock at the bottom, nav rings on the floor |
| ✋ Hands | your hand appears cut out of the camera within a couple of seconds |
| `?fps` | 45 or better in headset mode with hands on |

**If there is no Gemini key**, start the server with `GEMINI_MOCK=1 python3 serve.py`. Every line
below still works: the mock picks the right tool from your words and even generates a brick tile.
It is not as smooth as the real thing but nothing dies on stage.

**Start from a clean house:** `…/?m=zvKHR9DHNjJ&layout=none` — otherwise last night's furniture
is still there, because layouts persist on purpose.

---

## The run

### 1. "This is a real house, and it's empty." (20 s)

Walk two or three scan points. Point out that the house has been **digitally emptied** by
Matterport — this is a real listing, not a model.

### 2. "Furnish it." (30 s)

> **"Hey John — stage this as a cosy living room."**

A sofa, rug, coffee table, armchair and a plant appear, and John says what he did:

> *"I put sofa, rug, coffee table, armchair and plant in the living room. Everything fits, doors clear."*

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

Grab the sofa and carry it at the doorway **broadside**. It stops dead, and the app says:

> *"the sofa is 2.10 m across the way you're holding it and that door is 1.15 m — turn it and it goes through"*

Turn it. It goes through — and you don't have to be precise about it: a piece that *would* fit is
slid onto the doorway's centre line for you, because hands can't hold ±10 cm. A piece that genuinely
doesn't fit, like a king bed at a 1.15 m door, is never helped and says *"it won't fit through at
all"* instead.

This is the beat to land hardest. Nobody buying a house asks whether a render looks nice; they ask
whether the sofa gets through the door.

### 6. "And the plant?" (20 s)

> **"Hey John — what plant should go here?"**

He reads the light at that spot from the photo and the window positions, and places one:

> *"A fern — that spot is low light, 4.2 m from the nearest window, and it is happy out of the sun."*

If the model doesn't chain the two steps, `walkin.suggestPlant()` does the whole thing in one call
and always lands.

### 7. Close (10 s)

> **"Hey John — furnish the whole house."**

Six rooms, 28 pieces, about a fifth of a second. Then walk through it.

---

## What to avoid on stage

- **Don't reload** without `&layout=none` unless you want last night's furniture back.
- **Don't drag a piece into a corner it can't leave.** Physics is honest: if it won't fit, it won't
  go. `walkin.physics.enabled = false` in the console turns it off if it ever gets in the way.
- **Don't demo on a room with no polygon.** Three rooms in La Mirada have none from the API
  (`Room`, 0.1 m²); staging politely refuses them rather than guessing.
- **Paint walls in the Empty view, not "As scanned".** The quad sits 8 cm into the room, so over the
  as-scanned photo it covers whatever was standing against that wall — the owner's sofa back, a
  lamp. It still works and still re-shades, it just looks like wallpaper over furniture. Empty is
  the default, so this only bites if you've toggled.
- **A wall painted with a *generated* tile does not survive a reload.** The tile is a `data:` URL
  and we deliberately don't put megabytes of base64 in localStorage. A tile from
  `models/textures/` does survive.

## If something breaks

| symptom | do this |
|---|---|
| John doesn't answer | check `/api/health`; restart with `GEMINI_MOCK=1` |
| no hands | reload, allow the camera, check it's the right camera with 📷 |
| furniture won't move | `walkin.physics.enabled = false` |
| everything looks wrong | `walkin.clearLayout()` then `⌂ Stage room` |
| the house won't load | `python3 prep_house.py zvKHR9DHNjJ` again; or `?m=fixture` after `python3 tools/fake_house.py`, which needs no keys at all |

## Console equivalents for every beat

Useful for rehearsing without a microphone, and for anyone testing a change:

```js
walkin.stageRoom(walkin.roomAt(walkin.current.pos[0], walkin.current.pos[1], walkin.current.floor), 'cozy')
walkin.setWallMaterial(walkin.pointer.wall, 'models/textures/brick_red.jpg', 0.9)
walkin.placeObject('plant')
walkin.suggestPlant()                       // reads the light here, picks a plant, places it
walkin.stageHouse('modern')                 // the whole house: 6 rooms, 28 pieces, ~0.2 s
walkin.setStyle('cozy')                     // restyle everything already placed
walkin.clearLayout()
```
