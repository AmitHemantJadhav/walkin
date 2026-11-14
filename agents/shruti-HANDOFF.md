# HANDOFF → Shruti's agent

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

## Your lane: Agent, voice & story (Gemini, speech, pitch)
## Where things stand
- Nothing in your lane exists yet: no `agent.js`, no relays in `serve.py`. The viewer exposes `window.walkin` hooks
  (`house, goTo, addFurniture, furniture, camera, view, current, selected, roomAt, select, checkFit, FURNITURE`).
  `pointer`, `setWallMaterial` (Amit) and `stageRoom`, `placeObject` (Shaurya) are coming — stub them until they land.
- Product vision for the agent: point and talk in the headset. "Put red-brick wallpaper on this wall" → generated seamless tile on the
  wall you point at. "What plant should go here?" → reasoned from window positions and wall orientation, preview image, placed in 3D.
  Spoken replies (ElevenLabs, or Vapi if HackPrinceton has a Vapi prize).
- Pitch line: Homes.com gets you into the house; Walk-In lets you live in it. Geometry-anchored edits are consistent from every
  scan point; pure image edits are not (CoStar's own open problem).

## Shared facts you must not break
- World = Matterport model frame, metres, Z up. Calibration `{qMode:1, yaw:90, mirror:1}` is verified. Every pano has its own rotation.
- `main` must stay demo-able. `demo` is frozen at tonight's working build — never push to it.
- `data/` and `.env` are never committed (licensed hackathon data, keys). No AI attribution in commits/PRs/comments.

## Your first moves (in order)
1. R1 relays in `serve.py` (`/api/gemini`, `/api/tts`), keys from `.env`, never sent to the browser. Small and finished — commit it.
2. R2 `agent.js` skeleton with function calling and stubs; a text box first, voice next (R3).
3. R7 early drafts of `docs/devpost.md` and `docs/pitch.md` (cheap in tokens, high value) — then R4, R5, R6.

## Watch out
- You're on **Pro**: small finished commits, push after every working step. When the limit hits, the loop posts
  "This is my last commit for the next 5 hours." and Amit's/Shaurya's agents take your open issues. When you're back, skip `taken-over` issues.
- Check current Gemini model names and API docs before coding (they change). Keep replies to 1–2 spoken sentences.
- Don't edit `app.js`; ask for hooks.

## Timeline
- Phase 1 polish until Sat ~12:00 · Phase 2 agent features until Sat ~20:00 · then feature freeze: fixes, video, Devpost, pitch.
- Submission/judging is Sunday morning — confirm the exact deadline on Devpost/Discord and post it in the status issue if you find it.

## What the humans want to see at ~8 am
Merged PRs on `main` that work on the phone, a short honest summary in the "Agent status" issue, and a clear list of anything
that needs a human decision (`needs-human`). Prefer three solid merged features over ten half-done ones.
