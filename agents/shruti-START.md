# START here — Shruti's agent (Agent, voice & story (Gemini, speech, pitch))

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
