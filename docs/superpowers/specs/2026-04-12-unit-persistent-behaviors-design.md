# Unit Persistent Behaviors Design

## Goal

Add two unit-level high-level AI APIs, `attackMoveTo` and `harvestLoop`, so units can keep executing intent inside the game tick loop without waiting for another LLM round trip.

## Scope

- Add `unit.attackMoveTo({ x, y }, targetPriority?)`
- Add `unit.harvestLoop(resourcePos?)`
- Keep implementation unit-level only
- Reuse existing move, attack, pathfinding, and worker economy systems

## Chosen Approach

Use persistent unit intents owned by the game runtime.

The sandbox/API layer only emits a command that writes a high-level intent onto the unit. `Game.tickUpdate()` then keeps resolving that intent every tick. This avoids building a second command queue inside the tick and keeps behavior stable under LLM latency.

## Behavior Model

### `attackMoveTo`

- Command stores an `attack_move` intent on the unit with destination and optional attack priority
- Every tick:
  - If an eligible enemy is in range, attack it immediately
  - Otherwise keep moving toward the destination
  - If already at destination and nothing is in range, stay idle but keep the intent
- If a target dies or leaves range, the unit resumes advancing automatically
- Any later unit command overrides this intent

### `harvestLoop`

- Command stores a `harvest_loop` intent on a worker, optionally with a preferred resource tile
- Every tick:
  - If the worker is not full, keep moving to a valid resource tile and let the existing economy loop gather
  - If the worker is full, keep moving back toward friendly HQ delivery range and let the existing economy loop deliver
- If the preferred resource tile is invalid, fall back to the nearest valid resource tile
- If no valid resource tile exists, stop movement and remain idle until replaced by a later command
- Any later unit command overrides this intent

## Data Changes

- Extend `Unit.intent` union in `packages/shared/src/types.ts` with:
  - `attack_move`
  - `harvest_loop`
- Reuse existing `targetX`, `targetY`, `targetPriority`
- Reuse `Command.position` for both new APIs

## Runtime Changes

- `APIBridge.ts` and `AISandboxWorker.cjs` expose the new methods
- `Game.processCommand()` accepts:
  - `attack_move`
  - `harvest_loop`
- `Game.tickUpdate()` adds two sustained processors:
  - `processHarvestLoopIntents()`
  - `processAttackMoveIntents()`

## Override Rules

- `move`, `attack`, `attack_in_range`, `hold`, `build`, `attack_move`, and `harvest_loop` all replace the unit's previous intent
- No intent stacking in phase 1

## Validation

- `attack_move` requires a friendly unit and an in-bounds destination
- `harvest_loop` requires a friendly worker
- If `harvest_loop(resourcePos)` points to a non-resource tile, the game falls back to nearest resource instead of hard failing

## Testing

- Sandbox/API tests for serializable command payloads
- Game tests for:
  - attack-move keeps advancing and attacks once in range
  - harvest loop gathers and delivers without another command
  - override behavior remains simple and last-write-wins

## Docs

Update:

- `docs/ai-api-contract.md`
- `docs/current-mvp-reality.md`
- `packages/server/src/SystemPrompt.ts`
