# Walk-In — MAIN.md (the whole project)

Team: **Amit** (AmitHemantJadhav), **Shaurya** (Shaurya-b167), **Shruti**.
HackPrinceton Fall 2026 · CoStar Group track "Inside and Out: AI for the Built World".
Prizes $1,500 / $500 / $250 + fast-track interviews. Judges are CoStar / Matterport engineers.

## 0. THE GOAL — every agent works toward this, every cycle, until it is true
Pick work that moves the **first unchecked item you own** (or, if yours are done, one a teammate handed off or
that unblocks them). An item is done only when it is **merged on `main`** and you wrote *how you tested it* in the PR.
Tick items in your "Agent status" comment ("Goal 1: A3 ✅ #12, S1 ✅ #9 …").

**Goal 1 — by Sat 12:00 ET, on `main`, working through the tunnel on an iPhone:**
- [ ] A7 `scripts/live.sh` serves `main` through the tunnel (the link in the "Agent status" issue works)
- [ ] A1 Headset mode with hands on runs ≥45 fps (show an fps readout in Debug)
- [ ] A2 Pinch-grab, carry, two-hand twist and pinch-to-teleport work reliably (smoothing, forgiving radius)
- [ ] A3 `walkin.pointer` returns `{type: wall|floor|furniture, wall, point, room}`
- [ ] S1 Real GLB furniture for all 6 catalog items at their real sizes
- [ ] S2 Lighting and contact shadows that match the photo
- [ ] R1 `/api/gemini` and `/api/tts` relays in `serve.py` (keys stay on the server)
- [ ] R6 House picker + 2 more prepped demo houses

**Goal 2 — by Sat 20:00 ET (then freeze):** in the headset, by voice, end to end:
- [ ] "Put red-brick wallpaper on this wall" → generated tile on the wall the user points at, consistent from every scan point (A4, R2, R4)
- [ ] "Stage this as a modern bedroom" → a full set that fits, doorways clear (S3, S4)
- [ ] "What plant should go here?" → spoken answer + the plant placed (S5, R3, R5)
- [ ] Radial menu in the headset (A5); layouts survive a reload (S6)
- [ ] A full 3-minute demo run from `main` without a crash; R7 Devpost/pitch draft by 18:00

**After Goal 2:** no new features. Fix bugs, harden, make the demo smooth. Never break `main`.

## 1. What we are building
**Homes.com gets you into the house. Walk-In lets you live in it.**
Put your phone in a headset, walk a real home that Matterport scanned and digitally emptied, and change it by
pointing and talking: grab real-size furniture with your bare hands, ask *"put red-brick wallpaper on this wall"*,
ask *"what plant should go here?"*, and hear the answer. Every change is anchored to the house's real geometry,
so it stays put and looks right from every scan point.

Why judges care: it attacks CoStar's own open problems (quickstart §9, workshop slide):
- **Furnish an empty room, consistently** (#6): edits live in model space (metres), so they are consistent across
  views by construction. Image-only edits are not. Say this in the pitch.
- **Understand spaces / search inside panoramas** (#1, #4): the agent reasons over rooms, walls, doorways, windows.
- Uses all three data layers: Matterport (panos, defurnished view, walls, mesh); CoStar listing (price, beds, baths, Homes.com highlights from the kit); Vexcel (orthophoto, parcel and building footprint from `property/extract`). The last two come from `tools/prep_outside.py` and are shown by `outside.js`.

## 2. Status (Sat Nov 14, 01:30)
Working on `main` and frozen on `demo`:
- 360 viewer in model coordinates, calibration verified on 4 rooms, navigation pucks with neighbor graph.
- Empty / as-scanned toggle (defurnished view), empty-house OBJ mesh as occluder (walls hide furniture).
- 6 real-size furniture types, drag, rotate, live "fits / doesn't fit" against the room outline.
- Gyro look-around, side-by-side headset mode, iPhone via cloudflared HTTPS tunnel.
- MediaPipe two-hand tracking, 3D hands drawn in the world, pinch-grab, two-hand twist, pinch puck to teleport,
  front camera handheld / back camera in the headset.

## 3. Architecture
```
prep_house.py  → data/<model>/house.json + panos/*.jpg (+_empty) + mesh/*.obj + plan_*.jpg   (API, run once per house)
serve.py       → static no-cache server (+ /api/* relay for Gemini & TTS keys — task R1)
index.html     → UI shell, importmap (three@0.170)
app.js         → viewer core: pano sphere shader, calibration, pucks, occluders, pointer, gyro, headset, hands interaction
hands.js       → MediaPipe HandLandmarker (2 hands)
furniture.js   → catalog + builders (→ GLB models, task S1)
agent.js       → Gemini agent + voice (task R2/R3), talks to the viewer only through window.walkin
```
**Module rule:** new features go in new files and talk to the viewer through `window.walkin`.
Current hooks: `house, cal, goTo(panoId), addFurniture(kind), furniture, camera, scene, view, current, selected,
roomAt(x,y,floor), select(item), checkFit(), FURNITURE`. Hooks to add: `pointer` (A3), `setWallMaterial` (A4),
`stageRoom` (S3), `placeObject` (S5), `say(text)` (R3).

## 4. Data and coordinate facts (verified — read before changing anything)
See `CLAUDE.md` §Facts. Short version: world = Matterport model frame, metres, Z up. Each pano has its own rotation.
Calibration `{qMode:1, yaw:90, mirror:1}` verified by projecting panos onto the floor against the wall graph.

## 5. Roadmap
- **Phase 1 — Polish the core (until Sat ~12:00):** A1–A3, S1–S2, R1, R6.
- **Phase 2 — Agent (Sat 12:00–20:00):** A4–A5, S3–S5, R2–R5.
- **Phase 3 — Freeze (Sat 20:00):** no new features. Bug fixes, demo video, Devpost, pitch rehearsal on the headset.
- Judging Sunday morning: demo runs from `demo` (humans move `demo` forward only from a tested `main`).

## 6. Tasks (bootstrapped into GitHub issues by `scripts/bootstrap_github.sh`)
The source of truth after bootstrap is GitHub Issues (labels `owner:<name>`). The list is in `agents/tasks.tsv`.

**Amit — XR & hands**
- A1 Headset performance on iPhone: ≥45 fps in headset mode with hands on (adaptive pixel ratio, lighter sphere, fewer draws).
- A2 Hand gesture polish: smoothing, forgiving grab radius, reliable pinch-to-teleport, two-hand twist and carry.
- A3 `walkin.pointer`: what the user points at (hand ray or gaze centre): `{type: wall|floor|furniture, wall, point, room}`.
- A4 `walkin.setWallMaterial(wall, textureUrl, tileMetres)`: textured quad on a wall, cut around doorways, shaded by the photo's luminance; consistent from every scan point.
- A5 In-headset radial menu (pinch-and-hold) to add furniture / toggle empty / start voice.
- A6 Better pano-to-pano transition.
- A7 Live demo host: `scripts/live.sh` serving `main` from Amit's laptop through the tunnel.

**Shaurya — furniture & restaging**
- S1 Real GLB furniture (CC0, e.g. Poly Haven / Kenney / Quaternius), normalised to the catalog's real sizes.
- S2 Lighting and contact shadows that match the photo (ambient tint from the pano, soft shadow).
- S3 `walkin.stageRoom(roomId, style)`: place a full set that fits ("modern bedroom").
- S4 Fit check v2: keep doorways clear (use `openings`), 0.6 m walkways, no overlap between pieces.
- S5 Plant library (5–8 CC0 plants) + `walkin.placeObject(kind, x, y)`.
- S6 Save / load layouts (JSON) so the demo layout survives a reload.

**Shruti — agent, voice & story**
- R1 `/api/gemini` and `/api/tts` relays in `serve.py` (keys from `.env`, never sent to the browser).
- R2 `agent.js`: Gemini with function calling → addFurniture, stageRoom, setWallMaterial, placeObject, goTo; answers from rooms, dimensions, CoStar listing.
- R3 Voice: push-to-talk (button / pinch-hold) → speech-to-text → agent → spoken reply (ElevenLabs or Vapi; check for a Vapi prize).
- R4 "Red-brick wallpaper on this wall": generate a seamless tile with Gemini's image model → `setWallMaterial(pointer.wall, …)`.
- R5 Plant advice: use window positions + wall orientation (house lat/lon) for light → suggestion, generated preview image, `placeObject`.
- R6 House picker + prep 2 more demo houses from `docs/walkin_candidates.csv`.
- R7 Devpost write-up, 2-minute demo video script, 3-minute pitch (draft by Sat 18:00).

## 7. How the three agents work together (the protocol)
Each teammate runs one Claude Code agent on their own laptop, logged into their own GitHub account, in a loop
(`scripts/agent-loop.sh <name>`, every ~12 min; Shruti's every 15). Your identity is your branch: `amit`, `shaurya`, `shruti`.

**Every cycle, in this order:**
1. **Sync.** `git fetch`; merge `origin/main` into your branch. Resolve conflicts in files you don't own by taking `main`.
2. **Handoffs.** `gh issue list --label handoff --state open`. Max-plan agents (Amit, Shaurya) take the oldest one not
   labelled `taken-over`: comment "Taking over", add `taken-over`, assign yourself, work on branch `takeover/<issue#>`
   from `main`, PR into `main` referencing the issue. Then continue your own tasks.
3. **Review.** For every open PR you didn't author with commits you haven't reviewed: read the diff, run
   `scripts/smoke.sh`, then `gh pr review --approve` or `--request-changes` with short, concrete comments
   (file:line, what is wrong, what to do). Review within the cycle; never leave a teammate blocked.
4. **Respond.** On your own open PRs: address every new review comment, push, and reply to each one
   ("Fixed in <sha>" or why not).
5. **Build.** Take your next open issue (`owner:<you>`, lowest number, not `blocked`). Small steps: one focused
   change per cycle. Run `scripts/smoke.sh`. Commit, push, and make sure an open PR `<you> → main` exists
   (`gh pr create --base main --head <you>`), body = what changed, how to test, `Closes #n` when done.
6. **Merge.** If your PR has ≥1 approval from another teammate, no open change requests and CI is green:
   `gh pr merge --squash` (keep your branch), then merge `main` back into your branch.
7. **Status.** Post 2–4 lines on the pinned **"Agent status"** issue: done / next / blocked.

**Hand-off (Shruti's Pro plan, or anyone):** when Claude Code reports a usage limit, `scripts/handoff.sh` (run by the
loop, not by Claude) posts **"This is my last commit for the next 5 hours."** on your open PR and the status issue,
and labels your open issues `handoff`. When you are back, check which of your issues were taken over and skip them.

**Hard rules**
- Never push to `main` or `demo` directly. Never force-push. Never rewrite history.
- Never commit `.env`, keys, or `data/`. Never print keys in logs, PRs or comments.
- No AI attribution anywhere: no "Co-Authored-By: Claude", no "Generated with Claude Code" in commits, PRs, or comments.
  Write as the teammate whose account you run under.
- Don't delete or rewrite a teammate's work; propose changes in review instead.
- Keep `main` demo-able: if a merge breaks the demo, revert it first (`git revert`), then fix.
- Stuck, or a decision that changes the product? Label the issue `needs-human`, explain in one comment, move on.

## 8. Deploy
`main` is served live from Amit's laptop (`scripts/live.sh`, a `main` worktree pulled every few minutes) through
the cloudflared tunnel. No public hosting: the Matterport / CoStar data is licensed for the event only.
