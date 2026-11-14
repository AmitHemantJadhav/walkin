#!/usr/bin/env bash
# One-time GitHub setup (Amit runs this once from the repo folder): labels, task issues, the "Agent status" issue,
# and collaborators.   scripts/bootstrap_github.sh <shruti-github-username>
set -u
cd "$(dirname "$0")/.."
SHRUTI="${1:-}"
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo "repo: $REPO"

for l in "owner:amit|1f6feb" "owner:shaurya|8250df" "owner:shruti|bf3989" "handoff|d93f0b" "taken-over|fbca04" \
         "needs-human|b60205" "blocked|5319e7"; do
  gh label create "${l%%|*}" --color "${l##*|}" --force >/dev/null && echo "label ${l%%|*}"
done

if ! gh issue list --state all --search 'in:title "Agent status"' --json number -q '.[0].number' | grep -q .; then
  n=$(gh issue create --title "Agent status" --body "Each agent posts 2–4 lines here every cycle: done / next / blocked. Hand-offs are announced here too." | grep -oE '[0-9]+$')
  gh issue pin "$n" >/dev/null 2>&1; echo "status issue #$n"
fi

tail -n +2 agents/tasks.tsv | while IFS=$'\t' read -r id owner title body; do
  [ -z "$id" ] && continue
  if gh issue list --state all --search "in:title \"$id \"" --json number -q '.[0].number' | grep -q .; then continue; fi
  gh issue create --title "$id $title" --body "$body"$'\n\nOwner: '"$owner"'. See MAIN.md §6 and agents/'"$owner"'.md.' \
    --label "owner:$owner" >/dev/null && echo "issue $id ($owner)"
done

gh api -X PUT "repos/$REPO/collaborators/Shaurya-b167" -f permission=push >/dev/null && echo "invited Shaurya-b167"
[ -n "$SHRUTI" ] && gh api -X PUT "repos/$REPO/collaborators/$SHRUTI" -f permission=push >/dev/null && echo "invited $SHRUTI"
echo "done"
