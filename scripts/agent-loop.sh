#!/usr/bin/env bash
# Run one teammate's Claude Code agent in a loop, all night.
#   scripts/agent-loop.sh amit      (or shaurya / shruti)
# Keep this Terminal window open, the laptop plugged in and the lid open. Ctrl+C stops it.
set -u
WHO="${1:?usage: scripts/agent-loop.sh <amit|shaurya|shruti>}"
case "$WHO" in amit|shaurya) INTERVAL="${INTERVAL:-720}"; TURNS="${TURNS:-80}" ;;   # Max plan: every 12 min
               shruti)       INTERVAL="${INTERVAL:-900}"; TURNS="${TURNS:-40}" ;;   # Pro plan: every 15 min, shorter cycles
               *) echo "unknown teammate: $WHO"; exit 1 ;; esac
cd "$(dirname "$0")/.."
command -v claude >/dev/null || { echo "Claude Code (claude) is not installed"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login"; exit 1; }
mkdir -p .agent
LOG=".agent/$WHO.log"
caffeinate -dimsu -w $$ 2>/dev/null &          # macOS: don't sleep while this script runs

LIMITED=0
echo "agent loop for $WHO: every $((INTERVAL / 60)) min, log in $LOG"
while true; do
  git fetch origin -q
  git checkout -q "$WHO" 2>/dev/null || git checkout -q -b "$WHO" "origin/$WHO"
  git pull -q --no-rebase origin "$WHO" || true

  PROMPT="$(sed "s/{{WHO}}/$WHO/g" agents/cycle.md)"
  START=$(date '+%F %T')
  # --settings: headless runs ignore .claude/settings.json in a folder never opened interactively ("not trusted"),
  # so every git/gh call would wait for an approval nobody gives. Passing it explicitly applies its allow and deny lists.
  OUT="$(claude -p "$PROMPT" --settings .claude/settings.json --permission-mode acceptEdits --max-turns "$TURNS" 2>&1)"
  CODE=$?
  printf '\n===== %s (exit %s) =====\n%s\n' "$START" "$CODE" "$OUT" | tail -c 30000 >> "$LOG"
  echo "[$START] $(echo "$OUT" | tail -n 1 | cut -c1-160)"

  # Only the CLI's own limit notice counts. It is the whole (short) reply, so check the last line only (a normal cycle ends with its GOAL line):
  # grepping the full reply fired a false 5-hour hand-off whenever an agent merely wrote about API "rate limits".
  if echo "$OUT" | tail -n 1 | grep -qiE "usage limit|limit reached|hit your (usage )?limit|limit will reset|resets (at|in) |out of (extra )?usage"; then
    if [ "$LIMITED" = 0 ]; then scripts/handoff.sh "$WHO"; LIMITED=1; fi
    sleep 1800                                   # check again every 30 min until the limit resets
    continue
  fi
  if [ "$LIMITED" = 1 ]; then scripts/handoff.sh "$WHO" --back; LIMITED=0; fi
  sleep "$INTERVAL"
done
