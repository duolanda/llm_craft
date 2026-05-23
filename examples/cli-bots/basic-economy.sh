#!/usr/bin/env bash
# basic-economy.sh — LLMCraft CLI bot: economy automation
#
# This script runs a simple economy loop:
# 1. Assign idle workers to gather resources
# 2. Train workers when HQ is idle
# 3. Sleep briefly so the game can progress
#
# Usage:
#   llmcraft session use --player player_1
#   ./examples/cli-bots/basic-economy.sh
#
# Or set env vars:
#   LLMCRAFT_SESSION=<id> LLMCRAFT_SERVER=http://localhost:3001 LLMCRAFT_BUILD_AT=5,10 ./examples/cli-bots/basic-economy.sh

set -euo pipefail

MAX_TURNS="${MAX_TURNS:-50}"
SESSION="${LLMCRAFT_SESSION:-}"
BUILD_AT="${LLMCRAFT_BUILD_AT:-5,10}"

if [ -z "$SESSION" ]; then
  echo "Error: No session. Run 'llmcraft session use --player player_1' first." >&2
  exit 1
fi

echo "=== LLMCraft Economy Bot ==="
echo "Session: $SESSION"
echo "Max turns: $MAX_TURNS"
echo "Barracks position: $BUILD_AT"
echo ""

for ((turn=1; turn<=MAX_TURNS; turn++)); do
  echo "--- Turn $turn ---"

  # Read current state
  echo "State:"
  llmcraft me || true

  # Assign idle workers to gathering
  echo "Assigning idle workers..."
  llmcraft units --idle --type worker | llmcraft gather || true

  # Train new workers if HQ is ready
  echo "Training workers..."
  llmcraft buildings --type hq --ready | llmcraft train worker || true

  # Build barracks if we have idle workers and credits
  echo "Checking for barracks build..."
  llmcraft units --idle --type worker --limit 1 | \
    llmcraft build barracks --at "$BUILD_AT" 2>/dev/null || true

  # Train soldiers from ready barracks
  echo "Training soldiers..."
  llmcraft buildings --type barracks --ready | llmcraft train soldier || true

  # Let the game progress
  echo "Sleeping for 2s..."
  sleep 2

  echo ""
done

echo "=== Economy bot finished ==="
