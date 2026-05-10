# CLI Action Control Plane — Progress Log

## 2026-05-10: Phase 3 — Read State & Selectors ✅

### What was built

Implemented all Phase 3 commands: the CLI can now read game state and select/filter units, buildings, enemies, and resources. This is the foundation that all pipe workflows (Phase 4+) will depend on.

### New files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/cli/src/commands/state.ts` | 109 | Handlers for `state`, `map`, `me`, `events`, `plans` |
| `packages/cli/src/commands/select.ts` | 211 | Handlers for `units`, `buildings`, `enemies`, `resources` with local filtering |

### Modified files

| File | Change |
|------|--------|
| `packages/cli/src/index.ts` | Added imports + 9 command routing cases + updated help text with all new commands and selector flags |

### Commands implemented

**Read state:**
- `llmcraft state [--compact] [--cells] [--empty-tiles]` — full map + player state (uses combined `/state` endpoint)
- `llmcraft map [--ascii] [--cells]` — ASCII battlefield map (alias for `state --compact`)
- `llmcraft me` — my economy, HQ, buildings, production queues
- `llmcraft events [--limit n]` — recent AI-facing events
- `llmcraft plans` — active orchestration plans

**Selectors:**
- `llmcraft units [--type w|s] [--idle] [--planned] [--unplanned] [--near x,y] [--limit n]` — filters `get_my_units` locally
- `llmcraft buildings [--type hq|barracks] [--ready] [--near x,y] [--limit n]` — filters `get_my_state` buildings + production queue check
- `llmcraft enemies [--type w|s|hq|barracks] [--near x,y] [--limit n]` — filters `get_map_state` for enemy units + buildings
- `llmcraft resources [--near x,y] [--limit n]` — filters `get_map_state` cells for resource tiles

### Design decisions

- **Local filtering**: All `--near`, `--type`, `--idle`, etc. filters run in the CLI, not the server. This keeps the backend simple and follows the plan's "first version filter locally" guidance. Chebyshev distance is used for `--near`.
- **`buildings --ready`**: Checks production queue emptiness via `get_my_state` (which includes `productionQueues`).
- **`enemies`**: Combines both units and buildings with `relation === "enemy"` from `get_map_state` into a single list.
- **Output format**: All selectors output `kind: "selection"` with a data key matching the command name (`units`, `buildings`, `enemies`, `resources`).

### Verification

- `tsc --noEmit` passes (typecheck clean)
- `tsc --build` succeeds
- CLI smoke tests pass: help text, version, session-required errors, argument parsing, exit codes
- Commands correctly gate on session existence before making HTTP calls

### What's next

Phase 4 (action commands): `move`, `attack`, `attack-move`, `gather`, `build`, `train`, `hold` — both parameter input and stdin selection input.

---

## 2026-05-10: Phase 4 — Action Commands ✅

### What was built

Implemented all Phase 4 atomic action commands. Each command supports both parameter input (e.g., `--unit <id>`) and stdin selection input (from pipe with `units`/`buildings` selectors). Stdin input with multiple items produces `kind: "batch_result"` with individual results.

### New files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/cli/src/commands/actions.ts` | 305 | Handlers for `move`, `attack`, `attack-move`, `gather`, `build`, `train`, `hold` |

### Modified files

| File | Change |
|------|--------|
| `packages/cli/src/index.ts` | Added imports, 7 command routing cases, help text for action flags and examples |

### Commands implemented

- `move --unit <id> --to x,y` → `move_unit`
- `attack --unit <id> --target <id>` → `attack`
- `attack-move --unit <id> --to x,y [--priority s,w]` → `attack_move_unit`
- `gather --unit <id> [--resource x,y]` → `start_harvest_loop`
- `build barracks --unit <id> --at x,y` → `build_structure`
- `train worker|soldier --building <id>` → `spawn_unit`
- `hold --unit <id>` → `hold_unit`

### Stdin pipeline support

All commands accept selection input from stdin (piped from `units`, `buildings`, etc.). Stdin with multiple items iterates and calls the backend tool for each item, outputting `kind: "batch_result"`. `gather` additionally accepts `kind: "pairing"` from transformers.

### Design decisions

- Parameter input takes priority over stdin — if `--unit` is present, stdin is ignored
- Stdin selection extracts items from the appropriate data key (`units`, `buildings`)
- `build` and `train` use subcommand for building type / unit type respectively
- `gather` supports both `kind: "selection"` and `kind: "pairing"` for transformer compatibility

---

## 2026-05-10: Phase 5 — Pipeline Transformers ✅

### What was built

Implemented pipeline transformers that consume stdin selection and output pairings for downstream action commands. This enables natural pipe chains without external `jq`.

### New files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/cli/src/commands/transform.ts` | 184 | Handlers for `nearest resource`, `nearest enemy`, `target enemy-hq`, `target weakest` |

### Modified files

| File | Change |
|------|--------|
| `packages/cli/src/index.ts` | Added imports, 2 command routing cases, help text for transformers and examples |

### Commands implemented

- `nearest resource` — pairs each unit with its nearest resource tile (fetches map state to get cells)
- `nearest enemy` — pairs each unit with its nearest enemy (units + buildings)
- `target enemy-hq` — pairs each unit with the enemy HQ
- `target weakest` — pairs each unit with the lowest-HP enemy

### Output format

All transformers output `kind: "pairing"` with `data.pairs` containing `{ unitId, resource: {x,y} }` or `{ unitId, enemy: {id,type,x,y,hp} }`.

### Verification

Example pipes that should work end-to-end:
```bash
llmcraft units --idle --type worker | llmcraft nearest resource | llmcraft gather
llmcraft units --type soldier | llmcraft target enemy-hq | llmcraft attack
```

---

## 2026-05-10: Phase 6 — Plan & Orchestrate ✅

### What was built

Implemented plan generation and orchestration commands. Plans are generated client-side based on current state and output as JSON. `orchestrate` consumes plans or action batches from stdin.

### New files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/cli/src/commands/plan.ts` | 193 | Handlers for `plan` (economy/defend/attack-hq/custom) and `orchestrate` |

### Modified files

| File | Change |
|------|--------|
| `packages/cli/src/index.ts` | Added imports, 2 command routing cases, plan/orchestrate flags and examples in help |

### Commands implemented

- `plan economy` — generates infinite-loop mining + worker production + barracks build plan
- `plan defend` — generates HQ defense plan (attack-move to HQ + hold)
- `plan attack-hq` — generates enemy HQ assault plan (attack-move near + attack)
- `plan custom --file <path>` — reads arbitrary plan JSON from file
- `orchestrate` — consumes `kind: "plan"` or `kind: "actions"` from stdin
- `orchestrate --dry-run` — validates without submitting
- `orchestrate --max-actions n` — limits batch size

### Design decisions

- `plan economy/defend/attack-hq` fetch current state (`get_my_state` + `get_map_state`) to build context-aware plans
- Plans use schema-compatible steps: `$unitId` and `$hq`/`$barracks` placeholders
- `orchestrate` for plan input calls `orchestrate_plan` backend; for actions input sequentially calls each tool
- Error handling propagates backend failures with exit code 2

---

## 2026-05-10: Phase 7 — Wait, Scripts & Docs ✅

### What was built

Implemented the `wait` command, created example shell script bots, and updated project documentation to reflect CLI capabilities.

### New files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/cli/src/commands/wait.ts` | 23 | Handler for `wait --ticks n` |
| `examples/cli-bots/basic-economy.sh` | 56 | Economy automation shell script |
| `examples/cli-bots/rush.sh` | 70 | Aggressive rush strategy shell script |

### Modified files

| File | Change |
|------|--------|
| `packages/cli/src/index.ts` | Added wait import/routing, help text for wait flags and piped-loop example |
| `docs/current-mvp-reality.md` | Added section 6: CLI Control Plane — architecture overview, all commands, pipe examples, script references |
| `docs/ai-api-contract.md` | Added section 3: Control Plane HTTP API — all 4 endpoints with request/response schemas |

### Example scripts

Both scripts are executable and use `set -euo pipefail`:
- `basic-economy.sh` — 50-turn loop: gather idle workers, train workers, build barracks, train soldiers
- `rush.sh` — 3-phase strategy: early economy (turns 1-10), military buildup (11-20), attack (21+)

### Verification

- `tsc --noEmit` passes cleanly
- `tsc --build` succeeds (full build)
- All 18 commands route correctly in index.ts
- Help text covers all commands, flags, and examples

### Final CLI command inventory

| Category | Commands |
|----------|----------|
| Session | `session use`, `session show` |
| State | `state`, `map`, `me`, `events`, `plans` |
| Selectors | `units`, `buildings`, `enemies`, `resources` |
| Actions | `move`, `attack`, `attack-move`, `gather`, `build`, `train`, `hold` |
| Transformers | `nearest`, `target` |
| Plan | `plan`, `orchestrate` |
| Wait | `wait` |
