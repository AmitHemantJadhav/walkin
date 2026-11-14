# Demo card

One screen. The whole run is in `demo-runbook.md`; this is what you hold while you present.

```
…/?m=zvKHR9DHNjJ&layout=none        stand in a room, then:  await walkin.preflight()
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
3. Carry the sofa at it **broadside**. It stops dead, and John says:
   > *"the sofa is 2.10 m across the way you're holding it and that door is 1.15 m — turn it and it goes through"*
   >
   > **Only if #54 is merged.** It is the only thing that listens for the sentence. Without it the sofa
   > stops at the door in silence and you have to say the line yourself — check before you go on.
4. Turn it and walk it through **square on**. If it stops in the doorway, back off half a metre, square up, go again.
5. If anyone asks: a king bed gets *"it won't fit through at all"* at every angle, and never goes through.

### Six things that will bite you

- **Only one doorway works for beat 5.** 19 of La Mirada's 22 are too narrow for a sofa even turned.
- **Go in square.** ±8 cm is the real clearance; past that it lines up and stops in the gap.
- **Move the coffee table first.**
- **Don't stand at scan point 38 or 16** — the scan gives those rooms no outline, so staging refuses.
- **`&layout=none`** or last night's furniture comes back.
- **Paint walls in the Empty view**, not "As scanned".

### When something breaks

| | |
|---|---|
| John doesn't answer | `/api/health`; restart with `GEMINI_MOCK=1 python3 serve.py` |
| furniture flies away from your hand | add `&dgain=0` |
| furniture won't move | `walkin.physics.enabled = false` |
| everything looks wrong | `walkin.clearLayout()` then **⋯ → ⌂ Stage room** |
| the house won't load | `?m=fixture` after `python3 tools/fake_house.py` — needs no keys, does the whole run |
| you changed `serve.py` | restart it. It is read once at startup |
