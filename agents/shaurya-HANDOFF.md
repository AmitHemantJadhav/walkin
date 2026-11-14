# HANDOFF → Shaurya's agent

Written at 01:40 Sat Nov 14 by Amit (with Claude) after the first build session. Read this once, fully.

## The project in one breath
HackPrinceton Fall 2026, CoStar Group track ("Inside and Out: AI for the Built World"; $1,500 / $500 / $250 + interviews;
judges are CoStar/Matterport engineers). **Walk-In**: put your phone in a headset, walk a real home Matterport scanned and digitally
emptied, and change it by pointing and talking — real-size furniture grabbed with bare hands, wallpaper and plants by voice.
Homes.com (CoStar) already has an agent that finds homes and drops you into the tour; we start where that ends.

## Team
- Amit (AmitHemantJadhav) — XR & hands — Claude Max — branch `amit`
- Shaurya (Shaurya-b167) — furniture & restaging — Claude Max — branch `shaurya`
- Shruti — agent, voice & story — Claude **Pro** (runs out first; others take over) — branch `shruti`
Everyone's agent talks only through GitHub: PRs into `main`, reviews, the pinned "Agent status" issue, `handoff` labels.

## Your lane: Furniture & restaging (models, lighting, staging, fit)
## Where things stand
- Furniture today = box builders in `furniture.js` (sofa, armchair, queen, king, table, desk) at real sizes, front faces −y,
  origin at the footprint centre on the floor. They render after the occluder mesh, so real walls hide them correctly.
- Fit check = all four footprint corners inside the room polygon that contains the centre (`checkFit()` in `app.js`).
  It shows "fits in the living room" / "doesn't fit…" in the top-left panel.
- The judges' open problem #6 is "Furnish an empty room — in 3D and in photos, consistent". Your lane is the core of that story.

## Shared facts you must not break
- World = Matterport model frame, metres, Z up. Calibration `{qMode:1, yaw:90, mirror:1}` is verified. Every pano has its own rotation.
- `main` must stay demo-able. `demo` is frozen at tonight's working build — never push to it.
- `data/` and `.env` are never committed (licensed hackathon data, keys). No AI attribution in commits/PRs/comments.

## Your first moves (in order)
1. S1: real CC0 GLB furniture in `models/` (small files), loaded with GLTFLoader (import from `three/addons/loaders/GLTFLoader.js`),
   scaled to the catalog's real w×d×h. Keep `buildFurniture(kind)` synchronous: return the group, add the model when it loads; box fallback.
2. S2: lighting that matches the photo (ambient tinted by the pano's average colour, soft contact shadow).
3. S3 `stageRoom`, S4 fit v2 (doors + walkways), S5 plants + `placeObject` (Shruti's agent needs these), S6 layouts.

## Watch out
- Don't edit `app.js`; ask Amit's agent for hooks in an issue or PR comment, and expose your own functions on `window.walkin`
  from your module (add one `<script type="module">` line to `index.html`).
- Keep model files small (<3 MB, ideally <1 MB) — phones load them over the tunnel.
- You're on Max: take `handoff` issues when Shruti's limit hits.

## Timeline
- Phase 1 polish until Sat ~12:00 · Phase 2 agent features until Sat ~20:00 · then feature freeze: fixes, video, Devpost, pitch.
- Submission/judging is Sunday morning — confirm the exact deadline on Devpost/Discord and post it in the status issue if you find it.

## What the humans want to see at ~8 am
Merged PRs on `main` that work on the phone, a short honest summary in the "Agent status" issue, and a clear list of anything
that needs a human decision (`needs-human`). Prefer three solid merged features over ten half-done ones.
