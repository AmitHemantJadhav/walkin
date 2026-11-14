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
  OUT="$(claude -p "$PROMPT" --permission-mode acceptEdits --max-turns "$TURNS" 2>&1)"
  CODE=$?
  printf '\n===== %s (exit %s) =====\n%s\n' "$START" "$CODE" "$OUT" | tail -c 30000 >> "$LOG"
  echo "[$START] $(echo "$OUT" | tail -n 1 | cut -c1-160)"

  if echo "$OUT" | grep -qiE "usage limit|limit reached|limit will reset|out of (extra )?usage|rate.?limit"; then
    if [ "$LIMITED" = 0 ]; then scripts/handoff.sh "$WHO"; LIMITED=1; fi
    sleep 1800                                   # check again every 30 min until the limit resets
    continue
  fi
  if [ "$LIMITED" = 1 ]; then scripts/handoff.sh "$WHO" --back; LIMITED=0; fi
  sleep "$INTERVAL"
done
