# HANDOFF → Shruti's agent

## ▶ Paste this into Claude Code first (one prompt: checks everything, then starts the overnight loop)
Open the cloned repo folder (Terminal: `cd walkin && claude`, or VS Code with Claude Code), then paste:
```
You're setting up Shruti's Walk-In agent for the night. This folder should be a clone of AmitHemantJadhav/walkin.
THE GOAL is MAIN.md §0. The overnight loop keeps working toward it, cycle after cycle, until it's true.
Your job right now: check everything, fix what's missing, then start the loop. Never print the contents of any .env file.
If something fails and you can't fix it, stop and tell me.

CHECK AND FIX
1. Repo: `git remote -v` must point to AmitHemantJadhav/walkin. Run git fetch, git checkout shruti, git pull.
   Make sure there are no stray uncommitted changes.
   git config user.name and user.email must be my name and my GitHub email. If they aren't set, ask me.
   `gh auth status` must show my GitHub account. Push access must be true:
   `gh api repos/AmitHemantJadhav/walkin --jq .permissions.push`
   If it isn't, tell me to accept Amit's invite at https://github.com/AmitHemantJadhav/walkin/invitations.
   `claude --version` must work, because the loop calls it.
2. Keys: if .env is missing, run cp .env.example .env. MATTERPORT_API_KEY and MATTERPORT_API_TOKEN must have values.
   If they're empty, stop and tell me to paste them from /costar-keys in the #costar-group Discord.
   Also check GEMINI_API_KEY and ELEVENLABS_API_KEY, which R1–R3 need. If they're missing, tell me but continue:
   the agent builds with stubs and labels the issue needs-human.
   Report yes/no per key name, never the values.
3. House data: data/zvKHR9DHNjJ/house.json must exist with 39 panos. If it doesn't, run python3 prep_house.py zvKHR9DHNjJ (~30 s).
4. scripts/smoke.sh must pass.
5. Quick serve test on a spare port: start python3 serve.py 8001 in the background. Check that
   curl -s -o /dev/null -w '%{http_code}' 'http://localhost:8001/?m=zvKHR9DHNjJ' gives 200 and data/zvKHR9DHNjJ/house.json loads. Then stop it.
6. GitHub: the task issues and the pinned "Agent status" issue must exist (gh issue list). If they don't, Amit hasn't
   run the bootstrap yet. Re-check every 2 minutes for up to 20 minutes, then tell me.
7. Read CLAUDE.md, MAIN.md (§0 THE GOAL and §7 the protocol), agents/shruti.md and agents/shruti-HANDOFF.md.
   You're on the Pro plan, so keep this setup short. When my limit hits, the loop runs scripts/handoff.sh and Amit's and
   Shaurya's agents take over my open issues.

START
8. Overnight loop, detached so it keeps running after this chat:
   mkdir -p .agent && nohup scripts/agent-loop.sh shruti > .agent/loop.out 2>&1 & disown
   Wait about 90 seconds. Then show me `pgrep -fl "agent-loop|caffeinate|claude -p"` and the last lines of .agent/loop.out.
9. Finish with a short checklist: what passed, what you fixed, what's running (with PIDs), anything I must do,
   and the command to stop it: pkill -f "agent-loop.sh shruti"
   After that, don't edit files in this folder. The loop uses it now.
```
Keep the laptop plugged in with the lid open. The loop keeps the Mac awake (`caffeinate`) and runs one cycle every
15 min toward the goal. Log: `.agent/shruti.log`. If the check in step 8 shows no loop running, run `scripts/agent-loop.sh shruti`
yourself in a terminal in this folder.


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
