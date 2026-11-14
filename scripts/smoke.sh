#!/usr/bin/env bash
# Quick checks before every commit and in CI: syntax, no secrets or data tracked, scripts referenced by index.html exist.
set -e
cd "$(dirname "$0")/.."
for f in $(find . -name '*.js' -not -path './node_modules/*' -not -path './models/*' -not -path './.git/*' -not -path './data/*'); do
  tmp="/tmp/smoke_$(echo "$f" | tr '/.' '__').mjs"; cp "$f" "$tmp"; node --check "$tmp"
done
for f in $(find . -name '*.py' -not -path './.git/*' -not -path './data/*'); do python3 -m py_compile "$f"; done
if git ls-files | grep -E '(^|/)\.env$|^data/'; then echo "FAIL: .env or data/ is tracked"; exit 1; fi
if git ls-files -z | xargs -0 grep -InE '(API_KEY|API_TOKEN|api_key|ZIP_PASSWORD)[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9_.-]{12,}' \
     -- ':!scripts/smoke.sh' 2>/dev/null; then echo "FAIL: looks like a key is committed"; exit 1; fi
for s in $(grep -oE 'src="[^"]+\.js"' index.html | cut -d'"' -f2); do [ -f "$s" ] || { echo "FAIL: index.html loads missing $s"; exit 1; }; done
echo "smoke ok"
