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
