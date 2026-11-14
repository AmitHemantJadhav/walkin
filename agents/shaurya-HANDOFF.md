# HANDOFF → Shaurya's agent

## ▶ Paste this into Claude Code first (one prompt: checks everything, then starts the overnight loop)
Open the cloned repo folder (Terminal: `cd walkin && claude`, or VS Code with Claude Code), then paste:
```
You're setting up Shaurya's Walk-In agent for the night. This folder should be a clone of AmitHemantJadhav/walkin.
THE GOAL is MAIN.md §0. The overnight loop keeps working toward it, cycle after cycle, until it's true.
Your job right now: check everything, fix what's missing, then start the loop. Never print the contents of any .env file.
If something fails and you can't fix it, stop and tell me.

CHECK AND FIX
1. Repo: `git remote -v` must point to AmitHemantJadhav/walkin. Run git fetch, git checkout shaurya, git pull.
   Make sure there are no stray uncommitted changes.
   git config user.name and user.email must be my name and my GitHub email. If they aren't set, ask me.
   `gh auth status` must show my GitHub account. Push access must be true:
   `gh api repos/AmitHemantJadhav/walkin --jq .permissions.push`
   If it isn't, tell me to accept Amit's invite at https://github.com/AmitHemantJadhav/walkin/invitations.
   `claude --version` must work, because the loop calls it.
2. Keys: if .env is missing, run cp .env.example .env. MATTERPORT_API_KEY and MATTERPORT_API_TOKEN must have values.
   If they're empty, stop and tell me to paste them from /costar-keys in the #costar-group Discord.
   Report yes/no per key name, never the values.
3. House data: data/zvKHR9DHNjJ/house.json must exist with 39 panos. If it doesn't, run python3 prep_house.py zvKHR9DHNjJ (~30 s).
4. scripts/smoke.sh must pass.
5. Quick serve test on a spare port: start python3 serve.py 8001 in the background. Check that
   curl -s -o /dev/null -w '%{http_code}' 'http://localhost:8001/?m=zvKHR9DHNjJ' gives 200 and data/zvKHR9DHNjJ/house.json loads. Then stop it.
6. GitHub: the task issues and the pinned "Agent status" issue must exist (gh issue list). If they don't, Amit hasn't
   run the bootstrap yet. Re-check every 2 minutes for up to 20 minutes, then tell me.
7. Read CLAUDE.md, MAIN.md (§0 THE GOAL and §7 the protocol), agents/shaurya.md and agents/shaurya-HANDOFF.md.

START
8. Overnight loop, detached so it keeps running after this chat:
   mkdir -p .agent && nohup scripts/agent-loop.sh shaurya > .agent/loop.out 2>&1 & disown
   Wait about 90 seconds. Then show me `pgrep -fl "agent-loop|caffeinate|claude -p"` and the last lines of .agent/loop.out.
9. Finish with a short checklist: what passed, what you fixed, what's running (with PIDs), anything I must do,
   and the command to stop it: pkill -f "agent-loop.sh shaurya"
   After that, don't edit files in this folder. The loop uses it now.
```
Keep the laptop plugged in with the lid open. The loop keeps the Mac awake (`caffeinate`) and runs one cycle every
12 min toward the goal. Log: `.agent/shaurya.log`. If the check in step 8 shows no loop running, run `scripts/agent-loop.sh shaurya`
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
