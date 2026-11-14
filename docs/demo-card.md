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
| **4** 30 s | **"Hey John — put red brick wallpaper on this wall."** | tile generated, laid at real scale, cut around the door and the window, shaded by the photo's own light. **Stay at scan point 37 and point at wall #19 or #31** — 1% and 0% lost to the scan mesh. #61 is fixed, so nothing is catastrophic now (worst nearby is #1 at 10%); `walkin.wallFit()` tells you if a wall looks bare |
| **5** 40 s | *"Will my sofa fit?"* | **the beat to land hardest.** See the box below |
| **6** 20 s | **"Hey John — what plant should go here?"** | he reads the light at that spot and places one. Fallback: `walkin.suggestPlant()` |
| **7** 10 s | **"Hey John — furnish the whole house."** | six rooms, 32 pieces. Fallback: `walkin.stageHouse('modern')` |

### Beat 5, in order

1. **Run beat 5 before beat 2** and skip the problem. Scan point 37 is the **front porch**, so
   **⋯ → + Add → Sofa** drops it 1.5 m from the **front door** with nothing in the way — and *"will it fit
   through the front door"* is the better line anyway. After beat 2 it takes three drags (coffee table,
   armchair, tv stand) or the sofa travels 24 cm and stops.
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
- **Go in square — and it is forgiving now.** Since #97 the sofa goes through from **±50 cm** off the
  centre line (it was 10 cm this morning). If it does stop it is beside the door, not wedged in it:
  back off half a metre, aim at the doorway, go again. `&doorrail=off` restores the old behaviour.
- **Clear three pieces first, not one** — coffee table, armchair *and* tv stand. With all seven staged the
  sofa travels 24 cm and stops. Simplest: **do beat 5 before beat 2**, in the empty room.
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
| John's voice is odd or the conversation stalls | `&live=off` — back to the old speak-and-reply path |
| the walk between scan points looks wrong | `&a6=off` — plain cross-fade for every move. `&a6=round` is *not* a full rollback: it still blinks |
| you changed **or pulled** `serve.py` | restart it — it is read once at startup, so a `git pull` leaves the old one serving. If the John row says *"is serve.py the one you just pulled?"*, that is this |
