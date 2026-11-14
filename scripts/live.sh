#!/usr/bin/env bash
# Amit's laptop: serve the latest `main` at http://localhost:8000 (the cloudflared tunnel points here).
# Uses a separate worktree so the agent can keep working on the `amit` branch in this folder.
set -u
cd "$(dirname "$0")/.."
LIVE="../walkin-live"
git fetch -q origin
[ -d "$LIVE" ] || git worktree add --detach "$LIVE" origin/main
ln -sfn "$PWD/data" "$LIVE/data"
# Link the keys only if the served serve.py refuses dotfiles; otherwise /.env would be downloadable through the tunnel.
if [ -f .env ] && grep -q "refuse dotfiles" "$LIVE/serve.py"; then ln -sfn "$PWD/.env" "$LIVE/.env"; else rm -f "$LIVE/.env"; fi
(cd "$LIVE" && python3 serve.py 8000) &
SERVER=$!
trap 'kill $SERVER' EXIT
echo "serving main from $LIVE on :8000 — run: cloudflared tunnel --url http://localhost:8000"
while true; do
  git -C "$LIVE" fetch -q origin && git -C "$LIVE" checkout -q --detach origin/main
  sleep 180
done
