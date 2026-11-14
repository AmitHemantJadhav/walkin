# START here — Shruti's agent (Agent, voice & story (Gemini, speech, pitch))

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
   If they're empty, DON'T stop: tell me to paste them later from /costar-keys in the #costar-group Discord,
   skip steps 3 and 5 (house data and serve test need them), and continue with the rest.
   Also check GEMINI_API_KEY and ELEVENLABS_API_KEY, which R1–R3 need. If they're missing, tell me but continue:
   the agent builds with stubs and labels the issue needs-human.
   Report yes/no per key name, never the values.
3. House data: data/zvKHR9DHNjJ/house.json must exist with 39 panos. If it doesn't, run python3 prep_house.py zvKHR9DHNjJ (~30 s). Skip if the Matterport keys are missing.
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


Plan: Claude **Pro** · loop every 15 min · branch `shruti` · GitHub (add yours)

## Tonight, before bed (≈10 minutes)
1. Clone and switch to your branch:
   ```bash
   gh auth login                      # if you haven't
   git clone https://github.com/AmitHemantJadhav/walkin && cd walkin
   git checkout shruti
   git config user.name "<your name>" && git config user.email "<your GitHub email>"
   ```
2. Keys and data:
   ```bash
   cp .env.example .env               # fill in YOUR keys from /costar-keys (#costar-group Discord)
   python prep_house.py zvKHR9DHNjJ   # ~30 s; or copy an existing data/ folder
   python serve.py                    # check http://localhost:8000/?m=zvKHR9DHNjJ loads, then Ctrl+C
   ```
3. Add `GEMINI_API_KEY` and `ELEVENLABS_API_KEY` to `.env` (Google AI Studio / ElevenLabs). Without them the agent builds
   with stubs and labels the issue `needs-human`. Wait until Amit has run the bootstrap (you can see the issues on GitHub).
4. Kick-off: run `claude` in the repo folder, accept "trust this folder", and paste the **kick-off prompt** below.
   Wait for it to finish (it does one full cycle and checks your setup), then type `/exit`.
5. Start the overnight loop and go to bed (plugged in, lid open, Terminal open):
   ```bash
   scripts/agent-loop.sh shruti
   ```
   It keeps the Mac awake by itself (`caffeinate`). Ctrl+C stops it. Log: `.agent/shruti.log`.

## Kick-off prompt (paste into Claude Code once)
```
You are Shruti's Walk-In agent on branch shruti. Read CLAUDE.md, MAIN.md, agents/shruti.md and agents/shruti-HANDOFF.md.
Check my setup without printing secrets: gh auth status, git user.name/email, .env exists with the key names filled,
data/zvKHR9DHNjJ/house.json exists, scripts/smoke.sh passes. Tell me anything I must fix before bed.
Then do one full cycle exactly as agents/cycle.md says (sync, handoffs, review, respond, build, merge, status).
Finish by telling me in 3 lines what you did and what you'll do next. I'll then start scripts/agent-loop.sh shruti.
```

## If the loop script won't run (fallback: one long session)
Run `claude --permission-mode acceptEdits` and paste:
```
You are Shruti's Walk-In agent on branch shruti. Read CLAUDE.md, MAIN.md, agents/shruti.md, agents/shruti-HANDOFF.md.
Then repeat forever: do one cycle exactly as agents/cycle.md says (replace {{WHO}} with shruti), then run `sleep 900`,
then start the next cycle. Never stop on your own. If you hit a usage limit, run scripts/handoff.sh shruti first.
```

## In the morning
Read the pinned **Agent status** issue, then anything labelled `needs-human`. Main is served live by Amit's `scripts/live.sh`.
