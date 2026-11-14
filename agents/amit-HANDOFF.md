# HANDOFF → Amit's agent

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

## Your lane: XR & hands (headset, hands, pointing, wall materials)
## Where things stand
- You built (with Claude tonight) the whole working prototype on `main`. It runs on Amit's laptop and through the tunnel on his iPhone.
- **Verified:** calibration `{qMode:1, yaw:90, mirror:1}` (floor projections of 4 panos in 4 rooms match the wall graph);
  empty-house mesh occlusion; real-size furniture with fit check; navigation pucks hidden by furniture; furniture stays put across scan points.
- **Hands:** laptop webcam works (Amit tested: hands detected, pinch works). Two hands + 3D hand drawing + twist were added last and
  are only lightly tested. **iPhone hand tracking was weak**: with the back camera handheld it can't see your hand; we switched handheld
  to the front camera and show a preview (top right). Headset mode switches to the back camera — untested in a real viewer.
- **Not measured yet:** fps on iPhone in headset mode with hands on (that's A1, your first task).

## Shared facts you must not break
- World = Matterport model frame, metres, Z up. Calibration `{qMode:1, yaw:90, mirror:1}` is verified. Every pano has its own rotation.
- `main` must stay demo-able. `demo` is frozen at tonight's working build — never push to it.
- `data/` and `.env` are never committed (licensed hackathon data, keys). No AI attribution in commits/PRs/comments.

## Your first moves (in order)
1. A1: measure fps (add an fps readout to Debug), then make headset+hands ≥45 fps on iPhone (pixel ratio cap 1.5 on mobile,
   sphere 64×32, detect hands every other frame on mobile, hide hand meshes when no hand).
2. A3 `walkin.pointer` — Shruti's agent needs it for "this wall". Ship a first version early even if rough, announce it in your PR.
3. A2 gesture polish, then A4 `setWallMaterial`, A5 radial menu, A6 transitions.

## Watch out
- You are the only agent allowed to edit `app.js`. Review Shaurya's and Shruti's PRs for anything that would break the viewer.
- Teammates will ask for hooks (`stageRoom` placement helpers, `pointer`, `setWallMaterial`, `onTalk`) — add them quickly.
- You can't see a phone at night. Keep rendering changes conservative; keep a toggle to turn new effects off.

## Timeline
- Phase 1 polish until Sat ~12:00 · Phase 2 agent features until Sat ~20:00 · then feature freeze: fixes, video, Devpost, pitch.
- Submission/judging is Sunday morning — confirm the exact deadline on Devpost/Discord and post it in the status issue if you find it.

## What the humans want to see at ~8 am
Merged PRs on `main` that work on the phone, a short honest summary in the "Agent status" issue, and a clear list of anything
that needs a human decision (`needs-human`). Prefer three solid merged features over ten half-done ones.
