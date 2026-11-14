# HANDOFF → Amit's agent

## ▶ Paste this into Claude Code first (one prompt: checks everything, sets up GitHub and the live demo, starts the loop)
```
You're setting up my (Amit's) Walk-In agent for the night. This folder should be a clone of AmitHemantJadhav/walkin.
THE GOAL is MAIN.md §0. The overnight loop keeps working toward it, cycle after cycle, until it's true.
Check everything, fix what's missing, then start. Never print the contents of any .env file. If something fails and you can't fix it, stop and tell me.

CHECK AND FIX
1. Repo: `git remote -v` must point to AmitHemantJadhav/walkin. Run git fetch, git checkout amit, git pull. Make sure there are no stray uncommitted changes.
   git config user.name "Amit Jadhav" && git config user.email "AmitHemantJadhav@users.noreply.github.com"
   `gh auth status` must show AmitHemantJadhav. `claude --version` must work, because the loop calls it.
2. Keys: if .env is missing, run cp ~/Devlopment/costar/.env .env. Confirm MATTERPORT_API_KEY and MATTERPORT_API_TOKEN have values (yes/no only).
3. House data: data/zvKHR9DHNjJ/house.json (39 panos) must exist. If it doesn't, cp -R ~/Devlopment/costar/walkin/data ./data.
   Only if that's missing too, run python3 prep_house.py zvKHR9DHNjJ.
4. scripts/smoke.sh must pass.
5. What's running: lsof -nP -iTCP:8000 -sTCP:LISTEN and pgrep -fl "serve.py|http.server|cloudflared|agent-loop|live.sh".
6. Read CLAUDE.md, MAIN.md (§0 THE GOAL, §7), agents/amit.md, agents/amit-HANDOFF.md.

GITHUB (once)
7. Run scripts/bootstrap_github.sh with no argument (Shruti's username isn't known yet).
   Confirm the labels, the task issues and the pinned "Agent status" issue exist.
8. CI: the "smoke" workflow shows startup_failure on every push, and the merge rule needs green checks. Find the cause
   (gh run list, gh run view, the Actions settings). If it's a quick fix, commit it to amit. If Actions can't run on this
   account, run `gh workflow disable smoke`. Tell me which one you did.

START
9. Live demo: kill only the old server on :8000 (lsof -ti tcp:8000 -sTCP:LISTEN | xargs kill). Do NOT touch cloudflared.
   mkdir -p .agent && nohup scripts/live.sh > .agent/live.log 2>&1 & disown
   Check that http://localhost:8000/?m=zvKHR9DHNjJ returns 200 from ../walkin-live.
   Comment on "Agent status": "Live build (main): https://default-confidence-holdings-muslim.trycloudflare.com/?m=zvKHR9DHNjJ"
10. Overnight loop: nohup scripts/agent-loop.sh amit > .agent/loop.out 2>&1 & disown
    Wait about 90 seconds. Then show me pgrep -fl "agent-loop|live.sh|caffeinate|claude -p" and the last lines of .agent/loop.out.
11. Finish with a checklist: what passed, what you fixed, what's running (with PIDs), anything I must do, and how to stop it.
    After that, don't edit files in this folder. The loop uses it now.
```


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
