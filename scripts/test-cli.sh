#!/bin/bash
# CLI Control Plane — Automated Integration Test
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "=== Building CLI ==="
pnpm build:cli 2>&1 | tail -2

echo "=== Starting Server ==="
pnpm dev:server &
SERVER_PID=$!
sleep 3

# Check server is running
if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "❌ Server failed to start"
  exit 1
fi
echo "✅ Server running (PID: $SERVER_PID)"

# Create a dummy preset via HTTP
echo "=== Creating Preset ==="
PRESET_RESP=$(curl -s -X POST http://localhost:3001/api/settings/presets \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-preset",
    "providerType": "openai-compatible",
    "baseURL": "http://localhost:9999",
    "model": "test-model",
    "apiKey": "test-key-123"
  }')
PRESET_ID=$(echo "$PRESET_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('preset',{}).get('id',''))" 2>/dev/null || echo "")
if [ -z "$PRESET_ID" ]; then
  echo "⚠️ Could not create preset, trying alternate approach..."
  # List existing presets
  EXISTING=$(curl -s http://localhost:3001/api/settings/presets)
  PRESET_ID=$(echo "$EXISTING" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['presets'][0]['id'] if d.get('presets') else '')" 2>/dev/null || echo "")
  if [ -z "$PRESET_ID" ]; then
    echo "❌ No preset available"
    kill $SERVER_PID 2>/dev/null
    exit 1
  fi
fi
echo "✅ Preset: $PRESET_ID"

# Start a match via WebSocket
echo "=== Starting Match ==="
python3 -c "
import asyncio, json, websockets

async def start_match():
    async with websockets.connect('ws://localhost:3001') as ws:
        # Prepare
        await ws.send(json.dumps({
            'type': 'prepare',
            'player1PresetId': '$PRESET_ID',
            'player2PresetId': '$PRESET_ID',
            'warmup': {'player_1': False, 'player_2': False}
        }))
        resp = await asyncio.wait_for(ws.recv(), timeout=10)
        print(f'Prepare: {resp[:100]}')

        # Start
        await ws.send(json.dumps({
            'type': 'start',
            'player1PresetId': '$PRESET_ID',
            'player2PresetId': '$PRESET_ID'
        }))
        print('Match started')

asyncio.run(start_match())
" 2>&1 || echo "⚠️ WebSocket match start had an issue (may still work)"

# Wait for match to initialize
sleep 3

echo ""
echo "========== CLI TESTS =========="
CLI="./node_modules/.bin/llmcraft"
PASS=0
FAIL=0

check() {
  local name="$1"
  local cmd="$2"
  local expect_ok="$3"
  echo -n "  TEST: $name ... "
  output=$(eval "$cmd" 2>&1) && rc=$? || rc=$?
  if echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('ok') == $expect_ok, f'Expected ok=$expect_ok, got {d}'" 2>/dev/null; then
    echo "✅"
    PASS=$((PASS+1))
  else
    echo "❌ (rc=$rc)"
    echo "    $output" | head -5
    FAIL=$((FAIL+1))
  fi
}

# Test 1: Create session
check "session use" "$CLI session use --player player_1 --base-url http://localhost:3001 2>&1" true

# Test 2: Show session
check "session show" "$CLI session show --base-url http://localhost:3001 2>&1" true

# Test 3: State
check "state" "$CLI state --base-url http://localhost:3001 2>&1" true

# Test 4: Map
check "map --ascii" "$CLI map --ascii --base-url http://localhost:3001 2>&1" true

# Test 5: Me
check "me" "$CLI me --base-url http://localhost:3001 2>&1" true

# Test 6: Units
check "units" "$CLI units --base-url http://localhost:3001 2>&1" true

# Test 7: Units with filter
check "units --type worker" "$CLI units --type worker --base-url http://localhost:3001 2>&1" true

# Test 8: Buildings
check "buildings" "$CLI buildings --base-url http://localhost:3001 2>&1" true

# Test 9: Enemies
check "enemies" "$CLI enemies --base-url http://localhost:3001 2>&1" true

# Test 10: Resources
check "resources" "$CLI resources --base-url http://localhost:3001 2>&1" true

# Test 11: Wait
check "wait --ticks 1" "$CLI wait --ticks 1 --base-url http://localhost:3001 2>&1" true

# Test 12: Move (will fail gracefully without valid unit, but should return proper JSON)
check "move (arg error)" "$CLI move --unit invalid --to 5,8 --base-url http://localhost:3001 2>&1" true

# Test 13: Unknown command
check "unknown command" "$CLI nonexistent --base-url http://localhost:3001 2>&1" false

# Test 14: Plans
check "plans" "$CLI plans --base-url http://localhost:3001 2>&1" true

# Test 15: Events
check "events" "$CLI events --base-url http://localhost:3001 2>&1" true

echo ""
echo "========== SUMMARY =========="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo ""

# Cleanup
kill $SERVER_PID 2>/dev/null || true

if [ $FAIL -gt 0 ]; then
  echo "❌ Some tests failed"
  exit 1
else
  echo "✅ All tests passed"
fi
