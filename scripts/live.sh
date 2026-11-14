#!/usr/bin/env bash
# Amit's laptop: serve the latest `main` at http://localhost:8000 (the cloudflared tunnel points here).
# Uses a separate worktree so the agent can keep working on the `amit` branch in this folder.
# Every 3 min it pulls `main`; when serve.py changed (e.g. new /api relays) it restarts the server.
set -u
cd "$(dirname "$0")/.."
LIVE="${LIVE:-../walkin-live}"
PORT="${PORT:-8000}"
BRANCH="${BRANCH:-origin/main}"   # override only to test another branch on a spare PORT and LIVE
git fetch -q origin
[ -d "$LIVE" ] || git worktree add --detach "$LIVE" "$BRANCH"
git -C "$LIVE" checkout -q --detach "$BRANCH"
ln -sfn "$PWD/data" "$LIVE/data"

# Does the served serve.py refuse dotfiles? Checked for real, before any key is linked: run it on a spare port
# and ask for a canary dotfile. Only a 404 counts. Otherwise /.env would be downloadable through the tunnel.
refuses_dotfiles() {
  local code=000 pid
  rm -f "$LIVE/.env"
  echo canary > "$LIVE/.live-canary"
  (cd "$LIVE" && exec python3 serve.py 8099 >/dev/null 2>&1) &
  pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.3
    code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' http://localhost:8099/.live-canary) && [ "$code" != 000 ] && break
  done
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  rm -f "$LIVE/.live-canary"
  [ "$code" = 404 ]
}

SERVER=""
start() {
  local keys="not linked"
  if [ -f .env ] && refuses_dotfiles; then ln -sfn "$PWD/.env" "$LIVE/.env"; keys="linked"; else rm -f "$LIVE/.env"; fi
  (cd "$LIVE" && exec python3 serve.py "$PORT") &
  SERVER=$!
  echo "$(date +%H:%M) serving $BRANCH $(git -C "$LIVE" rev-parse --short HEAD) on :$PORT (.env $keys)"
}
stop() { if [ -n "$SERVER" ]; then kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null; SERVER=""; fi; }
trap stop EXIT

start
echo "run: cloudflared tunnel --url http://localhost:$PORT"
while true; do
  sleep "${INTERVAL:-180}"
  before=$(git -C "$LIVE" rev-parse HEAD:serve.py 2>/dev/null)
  git -C "$LIVE" fetch -q origin && git -C "$LIVE" checkout -q --detach "$BRANCH"
  if [ "$(git -C "$LIVE" rev-parse HEAD:serve.py 2>/dev/null)" != "$before" ]; then
    echo "$(date +%H:%M) serve.py changed, restarting"
    stop; start
  elif ! kill -0 "$SERVER" 2>/dev/null; then
    echo "$(date +%H:%M) server died, restarting"
    start
  fi
done
