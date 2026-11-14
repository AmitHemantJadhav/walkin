# START here — Shaurya's agent (Furniture & restaging (models, lighting, staging, fit))

Plan: Claude **Max** · loop every 12 min · branch `shaurya` · GitHub Shaurya-b167

## Tonight, before bed (≈10 minutes)
1. Clone and switch to your branch:
   ```bash
   gh auth login                      # if you haven't
   git clone https://github.com/AmitHemantJadhav/walkin && cd walkin
   git checkout shaurya
   git config user.name "<your name>" && git config user.email "<your GitHub email>"
   ```
2. Keys and data:
   ```bash
   cp .env.example .env               # fill in YOUR keys from /costar-keys (#costar-group Discord)
   python prep_house.py zvKHR9DHNjJ   # ~30 s; or copy an existing data/ folder
   python serve.py                    # check http://localhost:8000/?m=zvKHR9DHNjJ loads, then Ctrl+C
   ```
3. Wait until Amit has run the bootstrap (you can see the task issues on GitHub and accepted the repo invite).
4. Kick-off: run `claude` in the repo folder, accept "trust this folder", and paste the **kick-off prompt** below.
   Wait for it to finish (it does one full cycle and checks your setup), then type `/exit`.

5. Start the overnight loop and go to bed (plugged in, lid open, Terminal open):
   ```bash
   scripts/agent-loop.sh shaurya
   ```
   It keeps the Mac awake by itself (`caffeinate`). Ctrl+C stops it. Log: `.agent/shaurya.log`.

## Kick-off prompt (paste into Claude Code once)
```
You are Shaurya's Walk-In agent on branch shaurya. Read CLAUDE.md, MAIN.md, agents/shaurya.md and agents/shaurya-HANDOFF.md.
Check my setup without printing secrets: gh auth status, git user.name/email, .env exists with the key names filled,
data/zvKHR9DHNjJ/house.json exists, scripts/smoke.sh passes. Tell me anything I must fix before bed.
Then do one full cycle exactly as agents/cycle.md says (sync, handoffs, review, respond, build, merge, status).
Finish by telling me in 3 lines what you did and what you'll do next. I'll then start scripts/agent-loop.sh shaurya.
```

## If the loop script won't run (fallback: one long session)
Run `claude --permission-mode acceptEdits` and paste:
```
You are Shaurya's Walk-In agent on branch shaurya. Read CLAUDE.md, MAIN.md, agents/shaurya.md, agents/shaurya-HANDOFF.md.
Then repeat forever: do one cycle exactly as agents/cycle.md says (replace {{WHO}} with shaurya), then run `sleep 720`,
then start the next cycle. Never stop on your own. If you hit a usage limit, run scripts/handoff.sh shaurya first.
```

## In the morning
Read the pinned **Agent status** issue, then anything labelled `needs-human`. Main is served live by Amit's `scripts/live.sh`.
