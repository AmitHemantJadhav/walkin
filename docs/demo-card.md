# Demo card

One screen. The whole run is in `demo-runbook.md`; this is what you hold while you present.

```
…/?m=zvKHR9DHNjJ&layout=none             stand in a room, then:  await walkin.preflight()
…/?m=zvKHR9DHNjJ&layout=none&preflight   on a phone — same nine lines, on the screen
```

| | say | and then |
|---|---|---|
| **1** 20 s | *"This is a real house, and it's empty."* | walk two scan points. Matterport emptied it; it's a real listing |
| **2** 30 s | **"Hey John — stage this as a cosy living room."** | sofa, rug, coffee table, armchair, tv stand, television, plant. **Real metres, checked against the walls and the doorways.** The sofa is 2.1 m because sofas are |
| **3** 20 s | *"Now walk around it."* | another scan point. Still exactly where you left it. **This is the pitch** — an image edit can't survive a change of viewpoint; ours is in model space |
| **4** 30 s | **"Hey John — put red brick wallpaper on this wall."** | tile generated, laid at real scale, cut around the door and the window, shaded by the photo's own light |
| **5** 40 s | *"Will my sofa fit?"* | **the beat to land hardest.** See the box below |
| **6** 20 s | **"Hey John — what plant should go here?"** | he reads the light at that spot and places one. Fallback: `walkin.suggestPlant()` |
| **7** 10 s | **"Hey John — furnish the whole house."** | six rooms, 32 pieces. Fallback: `walkin.stageHouse('modern')` |

### Beat 5, in order

1. **Move the coffee table out of the way first** — one grab, it's light. A sofa can't pass through it.
2. Stand at **scan point 37**. The doorway you want is the **1.15 m** one, 0.47 m away.
3. Carry the sofa at it **broadside**. It stops dead, John says it, and the same sentence appears
   under the room card:
   > *"the sofa is 2.10 m across the way you're holding it and that door is 1.15 m — turn it and it goes through"*
   >
   > In the headset the card is hidden, so **his voice is the only version there** — if `/api/health`
   > says the voice is off, say the line yourself.
4. Turn it and walk it through **square on**. If it stops in the doorway, back off half a metre, square up, go again.
5. If anyone asks: a king bed gets *"it won't fit through at all"* at every angle, and never goes through.

### Six things that will bite you

- **Only one doorway works for beat 5.** 19 of La Mirada's 22 are too narrow for a sofa even turned.
- **Go in square.** About **10 cm** off the centre line still goes through — not symmetric, so don't lean
  on it. By 16 cm it squares up to the gap and **stops in it**: back off half a metre and go again.
- **Move the coffee table first.**
- **Don't stand at scan point 38 or 16** — the scan gives those rooms no outline, so staging refuses.
- **`&layout=none`** or last night's furniture comes back.
- **Paint walls in the Empty view**, not "As scanned".

### When something breaks

| | |
|---|---|
| John doesn't answer | run `await walkin.preflight()` — the John row makes a real call now, so it says *why* |
| furniture flies away from your hand | add `&dgain=0` |
| furniture won't move | `walkin.physics.enabled = false` |
| everything looks wrong | `walkin.clearLayout()` then **⋯ → ⌂ Stage room** |
| the house won't load | re-prep it and reload, or `?m=fixture` after `python3 tools/fake_house.py` — needs no keys, does the whole run |
| the walk between scan points looks wrong | `&a6=off` — plain cross-fade for every move. `&a6=round` is *not* a full rollback: it still blinks |
| you changed **or pulled** `serve.py` | restart it — it is read once at startup, so a `git pull` leaves the old one serving. If the John row says *"is serve.py the one you just pulled?"*, that is this |
