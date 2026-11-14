# START here — Amit's agent (XR & hands (headset, hands, pointing, wall materials))

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


Plan: Claude **Max** · loop every 12 min · branch `amit` · GitHub AmitHemantJadhav

## Tonight, before bed (≈10 minutes)
1. Clone and switch to your branch:
   ```bash
   gh auth login                      # if you haven't
   git clone https://github.com/AmitHemantJadhav/walkin && cd walkin
   git checkout amit
   git config user.name "<your name>" && git config user.email "<your GitHub email>"
   ```
2. Keys and data:
   ```bash
   cp .env.example .env               # fill in YOUR keys from /costar-keys (#costar-group Discord)
   python prep_house.py zvKHR9DHNjJ   # ~30 s; or copy an existing data/ folder
   python serve.py                    # check http://localhost:8000/?m=zvKHR9DHNjJ loads, then Ctrl+C
   ```
3. **Once, before anyone's kick-off:** `scripts/bootstrap_github.sh <shruti-github-username>` — creates the task
   issues, labels, the pinned "Agent status" issue, and invites Shaurya and Shruti.
4. **Live demo for the night:** stop the old `serve.py` / `http.server` (Ctrl+C) but keep the cloudflared tab (same URL).
   In a new tab: `scripts/live.sh` (serves the latest `main` on :8000). Paste the tunnel URL into the "Agent status" issue.
   Leave Chrome open — the overnight email updates screenshot the live build.
5. Kick-off: run `claude` in the repo folder, accept "trust this folder", and paste the **kick-off prompt** below.
   Wait for it to finish (it does one full cycle and checks your setup), then type `/exit`.
6. Start the overnight loop and go to bed (plugged in, lid open, Terminal open):
   ```bash
   scripts/agent-loop.sh amit
   ```
   It keeps the Mac awake by itself (`caffeinate`). Ctrl+C stops it. Log: `.agent/amit.log`.

## Kick-off prompt (paste into Claude Code once)
```
You are Amit's Walk-In agent on branch amit. Read CLAUDE.md, MAIN.md, agents/amit.md and agents/amit-HANDOFF.md.
Check my setup without printing secrets: gh auth status, git user.name/email, .env exists with the key names filled,
data/zvKHR9DHNjJ/house.json exists, scripts/smoke.sh passes. Tell me anything I must fix before bed.
Then do one full cycle exactly as agents/cycle.md says (sync, handoffs, review, respond, build, merge, status).
Finish by telling me in 3 lines what you did and what you'll do next. I'll then start scripts/agent-loop.sh amit.
```

## If the loop script won't run (fallback: one long session)
Run `claude --permission-mode acceptEdits` and paste:
```
You are Amit's Walk-In agent on branch amit. Read CLAUDE.md, MAIN.md, agents/amit.md, agents/amit-HANDOFF.md.
Then repeat forever: do one cycle exactly as agents/cycle.md says (replace {{WHO}} with amit), then run `sleep 720`,
then start the next cycle. Never stop on your own. If you hit a usage limit, run scripts/handoff.sh amit first.
```

## In the morning
Read the pinned **Agent status** issue, then anything labelled `needs-human`. Main is served live by Amit's `scripts/live.sh`.
