#!/usr/bin/env bash
# Smoke test for issue #51 — run AFTER you start the bot from temp/preview-merge
# (or from main once both PRs are merged).
#
# Usage: ./scripts/smoke_issue51.sh [HOST]
# Default HOST is http://127.0.0.1:3000

set -e
HOST="${1:-http://127.0.0.1:3000}"
PASS=0
FAIL=0
note() { echo -e "\n=== $* ==="; }
ok()   { echo "  [PASS] $*"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }

# ---- Album search ----------------------------------------------------------
note "1. /api/music/search/all returns {songs,albums,playlists}"

RES=$(curl.exe -s "$HOST/api/music/search/all?q=%E5%91%A8%E6%9D%B0%E4%BC%A6") # 周杰伦
KEYS=$(echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);print(','.join(sorted(d.keys())))")
if [ "$KEYS" = "albums,playlists,songs" ]; then ok "keys = $KEYS"; else bad "keys = $KEYS (expected albums,playlists,songs)"; fi

NA=$(echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d.get('albums',[])))")
NS=$(echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d.get('songs',[])))")
NP=$(echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d.get('playlists',[])))")
echo "  songs=$NS, albums=$NA, playlists=$NP"
if [ "$NA" -gt 0 ]; then ok "albums populated"; else bad "albums empty (expected >0 for 周杰伦)"; fi
if [ "$NS" -gt 0 ]; then ok "songs populated"; fi

# ---- Album detail playback path -------------------------------------------
note "2. /api/music/album/:id returns songs"

if [ "$NA" -gt 0 ]; then
  ALBUM_ID=$(echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);a=d['albums'][0];print(a['id'])")
  PLATFORM=$(echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);a=d['albums'][0];print(a['platform'])")
  echo "  testing album id=$ALBUM_ID platform=$PLATFORM"
  ASONGS=$(curl.exe -s "$HOST/api/music/album/$ALBUM_ID?platform=$PLATFORM" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d.get('songs',[])))" 2>/dev/null || echo 0)
  if [ "$ASONGS" -gt 0 ]; then ok "album returned $ASONGS songs"; else bad "album endpoint returned 0 songs"; fi
else
  echo "  (skipped — no albums to test)"
fi

# ---- Avatar API ------------------------------------------------------------
note "3. avatar GET 404 on bot with no avatar"

BOT_ID=$(curl.exe -s "$HOST/api/bot" | python3 -c "import json,sys;d=json.load(sys.stdin);bots=d.get('bots',[]);print(bots[0]['id'] if bots else '')")
if [ -z "$BOT_ID" ]; then bad "no bot found — create a bot first"; exit 1; fi
echo "  using bot $BOT_ID"

curl.exe -s -o /dev/null -w "%{http_code}" "$HOST/api/bot/$BOT_ID/avatar" > /tmp/code
CODE=$(cat /tmp/code)
if [ "$CODE" = "404" ] || [ "$CODE" = "200" ]; then ok "GET initial state = $CODE"; else bad "unexpected GET status $CODE"; fi

note "4. avatar PUT 200 + GET 200 round-trip"
# 1×1 transparent PNG (67 bytes)
TINY_PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
PUT_RES=$(curl.exe -s -X PUT "$HOST/api/bot/$BOT_ID/avatar" -H "Content-Type: application/json" \
  -d "{\"dataUrl\":\"data:image/png;base64,$TINY_PNG_B64\"}")
echo "  PUT response: $PUT_RES"
GOT_PATH=$(echo "$PUT_RES" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('path',''))" 2>/dev/null || echo "")
if [ "$GOT_PATH" = "$BOT_ID.png" ]; then ok "PUT returned path=$GOT_PATH"; else bad "PUT path = $GOT_PATH (expected $BOT_ID.png)"; fi

curl.exe -s -o /tmp/avatar_check.png -w "%{http_code}" "$HOST/api/bot/$BOT_ID/avatar" > /tmp/code
CODE=$(cat /tmp/code)
SIZE=$(wc -c < /tmp/avatar_check.png)
if [ "$CODE" = "200" ] && [ "$SIZE" -gt 60 ]; then ok "GET returned 200, $SIZE bytes"; else bad "GET status=$CODE size=$SIZE"; fi

note "5. avatar DELETE 204 + GET 404"
curl.exe -s -X DELETE "$HOST/api/bot/$BOT_ID/avatar" -o /dev/null -w "%{http_code}" > /tmp/code
CODE=$(cat /tmp/code)
if [ "$CODE" = "204" ]; then ok "DELETE returned 204"; else bad "DELETE status = $CODE"; fi

curl.exe -s -o /dev/null -w "%{http_code}" "$HOST/api/bot/$BOT_ID/avatar" > /tmp/code
CODE=$(cat /tmp/code)
if [ "$CODE" = "404" ]; then ok "GET after DELETE returned 404"; else bad "GET after DELETE = $CODE"; fi

note "6. avatar PUT rejects oversize (>200KB)"
BIG_B64=$(node -e "console.log(Buffer.alloc(210*1024,7).toString('base64'))")
curl.exe -s -o /dev/null -w "%{http_code}" -X PUT "$HOST/api/bot/$BOT_ID/avatar" \
  -H "Content-Type: application/json" -d "{\"dataUrl\":\"data:image/png;base64,$BIG_B64\"}" > /tmp/code
CODE=$(cat /tmp/code)
if [ "$CODE" = "413" ]; then ok "oversize rejected with 413"; else bad "oversize status = $CODE (expected 413)"; fi

note "7. avatar PUT rejects bad MIME (image/gif)"
GIF_B64="R0lGODlhAQABAAAAACw="  # tiny gif
curl.exe -s -o /dev/null -w "%{http_code}" -X PUT "$HOST/api/bot/$BOT_ID/avatar" \
  -H "Content-Type: application/json" -d "{\"dataUrl\":\"data:image/gif;base64,$GIF_B64\"}" > /tmp/code
CODE=$(cat /tmp/code)
if [ "$CODE" = "400" ]; then ok "bad MIME rejected with 400"; else bad "bad MIME status = $CODE (expected 400)"; fi

# ---------------------------------------------------------------------------
echo ""
echo "============================================="
echo "SMOKE RESULT: $PASS passed, $FAIL failed"
echo "============================================="
[ "$FAIL" -eq 0 ]
