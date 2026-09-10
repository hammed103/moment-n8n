#!/usr/bin/env bash
# Run Stage 1 triage over a list of usernames via the local classifier UI.
#
#   scripts/classify.sh <usernames-file> <seed-account>
#
# One username per line. Each is POSTed to /api/stage1-classify, which fetches
# the profile + 10 recent posts from Apify, runs Gemini Flash over the images,
# and routes the row into Collector / Dealer / Watchless UHNWI / Low Rank.
#
# Sequential on purpose: Apify and Gemini both rate-limit, and the Sheets write
# is read-modify-write per row. Safe to re-run — writeRowByHeaders updates an
# existing row for the same username rather than appending a duplicate.
#
# APIFY_TOKEN and GEMINI_API_KEY come from the environment or ui/.env.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIST="${1:?usage: scripts/classify.sh <usernames-file> <seed-account>}"
SEED="${2:?usage: scripts/classify.sh <usernames-file> <seed-account>}"
PORT="${PORT:-39250}"

if [[ -f "$ROOT/ui/.env" ]]; then set -a; source "$ROOT/ui/.env"; set +a; fi
: "${APIFY_TOKEN:?APIFY_TOKEN not set (put it in ui/.env)}"
: "${GEMINI_API_KEY:?GEMINI_API_KEY not set (put it in ui/.env)}"

if lsof -ti ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT already in use (stale server?). Free it or re-run with PORT=<other>." >&2
  exit 1
fi

cd "$ROOT/ui"
APIFY_TOKEN="$APIFY_TOKEN" GEMINI_API_KEY="$GEMINI_API_KEY" PORT="$PORT" \
  node server.js >"${TMPDIR:-/tmp}/classify-server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "server exited:"; cat "${TMPDIR:-/tmp}/classify-server.log" >&2; exit 1; }
  curl -sf -o /dev/null "http://localhost:$PORT/" && break
  sleep 1
done

TOTAL=$(grep -c . "$LIST")
echo "Classifying $TOTAL profiles (seed=$SEED) on port $PORT"
i=0
while IFS= read -r u; do
  [[ -z "$u" ]] && continue
  i=$((i+1))
  out=$(curl -s -m 300 -X POST "http://localhost:$PORT/api/stage1-classify" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"$u\",\"seed_account\":\"$SEED\"}")
  echo "$out" | python3 -c "
import json,sys
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception: print('  [$i/$TOTAL] $u  UNPARSEABLE: '+raw[:120]); raise SystemExit
if d.get('skipped'): print('  [$i/$TOTAL] $u  SKIPPED ('+str(d.get('reason'))+')')
elif d.get('error'):  print('  [$i/$TOTAL] $u  ERROR: '+str(d['error'])[:110])
else:
    c=d.get('classification') or {}
    print('  [$i/$TOTAL] $u  -> '+str(c.get('classification'))+
          ' rank='+str(c.get('visible_watch_rank'))+
          ' wealth='+str(c.get('net_worth_tier'))+
          ' prio='+str(c.get('priority_score'))+
          ' sheet='+str(d.get('sheet') or d.get('routed_to') or '?'))
"
  sleep 1
done < "$LIST"
echo "done."
