#!/usr/bin/env bash
# Called by agent-loop.sh (not by Claude) when a teammate's Claude hits its usage limit, and again when it's back.
#   scripts/handoff.sh shruti          -> posts the hand-off message, labels open issues `handoff`
#   scripts/handoff.sh shruti --back   -> removes `handoff` from issues nobody took over
set -u
WHO="$1"; MODE="${2:-}"
STATUS=$(gh issue list --state open --search 'in:title "Agent status"' --json number -q '.[0].number' 2>/dev/null)
OPEN=$(gh issue list --state open --label "owner:$WHO" --json number,labels \
  -q '.[] | select(([.labels[].name] | index("taken-over")) | not) | .number' 2>/dev/null)

if [ "$MODE" = "--back" ]; then
  for n in $OPEN; do gh issue edit "$n" --remove-label handoff >/dev/null 2>&1; done
  [ -n "$STATUS" ] && gh issue comment "$STATUS" --body "**$WHO** is back. Picking up my remaining issues (skipping the ones marked taken-over)." >/dev/null
  exit 0
fi

MSG="This is my last commit for the next 5 hours."
PR=$(gh pr list --head "$WHO" --state open --json number -q '.[0].number' 2>/dev/null)
[ -n "$PR" ] && gh pr comment "$PR" --body "$MSG Handing off my open issues (label \`handoff\`) to Amit's and Shaurya's agents." >/dev/null
for n in $OPEN; do gh issue edit "$n" --add-label handoff >/dev/null 2>&1; done
[ -n "$STATUS" ] && gh issue comment "$STATUS" --body "**$WHO:** $MSG Open issues: $(echo $OPEN | sed 's/[0-9]\+/#&/g'). Labelled \`handoff\`." >/dev/null
echo "hand-off posted for $WHO"
