#!/usr/bin/env bash
# rush.sh — LLMCraft CLI bot: aggressive rush strategy
#
# This script executes an early-game rush:
# 1. Build up economy (workers gathering)
# 2. Build barracks near enemy
# 3. Produce soldiers and attack-move toward enemy HQ
# 4. Target enemy HQ with all soldiers
#
# Usage:
#   llmcraft session use --player player_1
#   ./examples/cli-bots/rush.sh

set -euo pipefail

MAX_TURNS="${MAX_TURNS:-60}"
SESSION="${LLMCRAFT_SESSION:-}"

if [ -z "$SESSION" ]; then
  echo "Error: No session. Run 'llmcraft session use --player player_1' first." >&2
  exit 1
fi

echo "=== LLMCraft Rush Bot ==="
echo "Session: $SESSION"

# Phase 1: Early economy (turns 1-10)
echo "=== Phase 1: Economy setup ==="
for ((turn=1; turn<=10; turn++)); do
  echo "Turn $turn — gathering + producing workers"
  llmcraft units --idle --type worker | llmcraft gather 2>/dev/null || true
  llmcraft buildings --type hq --ready | llmcraft train worker 2>/dev/null || true
  sleep 2
done

# Phase 2: Build barracks + first soldiers (turns 11-20)
echo "=== Phase 2: Military buildup ==="
for ((turn=11; turn<=20; turn++)); do
  echo "Turn $turn"
  llmcraft units --idle --type worker | llmcraft gather 2>/dev/null || true
  llmcraft buildings --type hq --ready | llmcraft train worker 2>/dev/null || true

  # Build barracks
  llmcraft units --idle --type worker --limit 1 | \
    llmcraft build barracks --at 8,8 2>/dev/null || true

  # Train soldiers
  llmcraft buildings --type barracks --ready | llmcraft train soldier 2>/dev/null || true
  sleep 2
done

# Phase 3: Attack! (turns 21+)
echo "=== Phase 3: ATTACK ==="
for ((turn=21; turn<=MAX_TURNS; turn++)); do
  echo "Turn $turn — attacking enemy HQ"

  # Keep economy running
  llmcraft units --idle --type worker | llmcraft gather 2>/dev/null || true
  llmcraft buildings --type barracks --ready | llmcraft train soldier 2>/dev/null || true

  # Send soldiers toward enemy HQ
  llmcraft units --type soldier --unplanned | \
    llmcraft target enemy-hq | \
    llmcraft attack 2>/dev/null || true

  # Check if game is over
  STATE=$(llmcraft me 2>/dev/null || echo '{"ok":true}')
  WINNER=$(echo "$STATE" | grep -o '"winner":"[^"]*"' 2>/dev/null || true)
  if [ -n "$WINNER" ]; then
    echo "Game over! Winner: $WINNER"
    break
  fi

  sleep 2
done

echo "=== Rush bot finished ==="
