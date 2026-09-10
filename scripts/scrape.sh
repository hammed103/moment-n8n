#!/usr/bin/env bash
# Run an Instagram followers/following scrape through the local classifier UI.
#
#   scripts/scrape.sh <username> [direction] [max-per-list]
#     direction: followers | following | both   (default: both)
#
# Boots ui/server.js on a scratch port, POSTs /api/scrape-followers, prints the
# summary, and shuts the server down again. Results are written to the Profiles
# tab of the Google Sheet by the server itself.
#
# APIFY_TOKEN is read from the environment, else from ui/.env (gitignored).
# Never commit the token — ui/.env is covered by the .env* rule in .gitignore.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USERNAME="${1:?usage: scripts/scrape.sh <username> [direction] [max-per-list]}"
DIRECTION="${2:-both}"
MAXCOUNT="${3:-50}"
PORT="${PORT:-39230}"

if [[ -z "${APIFY_TOKEN:-}" && -f "$ROOT/ui/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$ROOT/ui/.env"; set +a
fi
if [[ -z "${APIFY_TOKEN:-}" ]]; then
  echo "APIFY_TOKEN is not set. Put it in $ROOT/ui/.env as APIFY_TOKEN=... or export it." >&2
  exit 1
fi

# Refuse to reuse a port someone else is on: a stale server would answer the
# health check below and silently serve the request from older code.
if lsof -ti ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use (stale server?). Free it or re-run with PORT=<other>." >&2
  exit 1
fi

cd "$ROOT/ui"
APIFY_TOKEN="$APIFY_TOKEN" PORT="$PORT" node server.js >"${TMPDIR:-/tmp}/scrape-server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  # Confirm the listener is OURS, not something that grabbed the port meanwhile.
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "server exited:"; cat "${TMPDIR:-/tmp}/scrape-server.log" >&2; exit 1; }
  curl -sf -o /dev/null "http://localhost:$PORT/" && break
  sleep 1
done

echo "Scraping $DIRECTION of @$USERNAME ($MAXCOUNT per list) — this takes a few minutes..."
curl -s -m 580 -X POST "http://localhost:$PORT/api/scrape-followers" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USERNAME\",\"direction\":\"$DIRECTION\",\"maxFollowers\":$MAXCOUNT,\"filterReplicas\":true}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({k:v for k,v in d.items() if k!="followers"}, indent=2))'
