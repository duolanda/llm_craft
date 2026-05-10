# CLI Control Plane — AI Agent Guide

This document tells an external AI agent how to join an LLMCraft game and play using the `llmcraft` CLI.

---

## 1. Join a Game

First, create a control session. This binds you to a side.

```bash
llmcraft session use --player player_1
```

Output:
```json
{"ok":true,"tick":0,"kind":"state","data":{"sessionId":"cs_abc12345","gameId":"default","playerId":"player_1","createdAt":"..."}}
```

Keep the `sessionId` — you'll need it if you switch terminals. Or just check it later:

```bash
llmcraft session show
```

> **Note:** A match must be running on the server before you can create a session. Start one from the web UI first.

---

## 2. Read the Battlefield

### Full state

```bash
llmcraft state
```

Returns the combined map + player state: ASCII map, units, buildings, economy, production queues.

### Just the ASCII map

```bash
llmcraft map --ascii
```

### My economy and buildings

```bash
llmcraft me
```

Shows: credits, HQ HP, buildings, production queues, worker count.

### Recent events

```bash
llmcraft events --limit 5
```

### Active plans

```bash
llmcraft plans
```

---

## 3. Filter and Select Targets

These commands filter the battlefield and output structured JSON for piping.

| Command | What it returns |
|---------|----------------|
| `units` | My units |
| `buildings` | My buildings |
| `enemies` | Enemy units + buildings |
| `resources` | Resource tiles on the map |

### Common filters

```bash
# Idle workers
llmcraft units --type worker --idle

# Soldiers without a plan
llmcraft units --type soldier --unplanned

# Ready barracks (empty production queue)
llmcraft buildings --type barracks --ready

# Enemy HQ
llmcraft enemies --type hq

# Resources near a location
llmcraft resources --near 10,10 --limit 3
```

All selectors output `kind: "selection"` with the data keyed by command name.

---

## 4. Issue Commands

### Direct (parameter input)

```bash
# Move a unit
llmcraft move --unit worker_1 --to 5,8

# Attack a target
llmcraft attack --unit soldier_1 --target building_2

# Attack-move (advance toward coordinates, engage enemies on the way)
llmcraft attack-move --unit soldier_1 --to 18,10

# Gather resources
llmcraft gather --unit worker_1

# Build a structure
llmcraft build barracks --unit worker_1 --at 8,8

# Train a unit
llmcraft train soldier --building barracks_1

# Hold position
llmcraft hold --unit soldier_1
```

### Pipe input (from selectors)

```bash
# Gather all idle workers
llmcraft units --idle --type worker | llmcraft gather

# Train soldiers in all ready barracks
llmcraft buildings --type barracks --ready | llmcraft train soldier

# Attack enemy HQ with all soldiers
llmcraft units --type soldier | llmcraft attack --target building_2
```

When piped, each item becomes a separate action. Output is `kind: "batch_result"`.

---

## 5. Pipeline Transformers

These sit between a selector and an action command, converting selections into pairings.

| Transformer | What it does | Output kind |
|-------------|-------------|-------------|
| `nearest resource` | Pair each unit with nearest resource tile | `pairing` |
| `nearest enemy` | Pair each unit with nearest enemy | `pairing` |
| `target enemy-hq` | Pair each unit with enemy HQ | `pairing` |
| `target weakest` | Pair each unit with lowest-HP enemy | `pairing` |

### Full pipe examples

```bash
# Idle workers → nearest resource → gather
llmcraft units --idle --type worker | llmcraft nearest resource | llmcraft gather

# Soldiers → enemy HQ → attack
llmcraft units --type soldier | llmcraft target enemy-hq | llmcraft attack
```

---

## 6. Plans and Orchestration

Plans are multi-step, multi-tick strategies. Generate one or write your own.

### Generate a plan

```bash
# Economy plan: mine + build + train
llmcraft plan economy

# Defense plan: protect HQ
llmcraft plan defend

# Attack plan: assault enemy HQ
llmcraft plan attack-hq
```

Each outputs `kind: "plan"`. Pipe it to `orchestrate` to execute:

```bash
llmcraft plan economy | llmcraft orchestrate
llmcraft plan attack-hq | llmcraft orchestrate
```

### Custom plan from file

```bash
llmcraft plan custom --file my-plan.json | llmcraft orchestrate
```

### Orchestrate options

```bash
# Dry run (validate without executing)
llmcraft plan economy | llmcraft orchestrate --dry-run

# Limit actions per tick
llmcraft plan attack-hq | llmcraft orchestrate --max-actions 5
```

---

## 7. Wait

Advance time. The game ticks every 500ms.

```bash
llmcraft wait --ticks 10
```

Blocks until the specified number of game ticks have elapsed, then returns the current tick.

---

## 8. Full Gameplay Loop

A complete bot using the CLI looks like this:

```bash
#!/bin/bash
set -euo pipefail

# Join the game
llmcraft session use --player player_1

# Main loop
for i in $(seq 1 50); do
  echo "=== Turn $i ==="

  # Economy: idle workers gather
  llmcraft units --idle --type worker | llmcraft nearest resource | llmcraft gather

  # Production: train workers if low
  llmcraft me | llmcraft orchestrate --dry-run  # check eco
  llmcraft buildings --ready | llmcraft train worker

  # Military: build barracks, then train soldiers
  if [ $i -gt 5 ]; then
    llmcraft buildings --ready | llmcraft train soldier
  fi

  # Attack with soldiers
  llmcraft units --type soldier --unplanned | llmcraft target enemy-hq | llmcraft attack

  # Wait for next tick window
  llmcraft wait --ticks 5
done
```

Two complete example scripts are in `examples/cli-bots/`:
- `basic-economy.sh` — 50-turn economy loop
- `rush.sh` — 3-phase rush strategy

---

## 9. Quick Reference

| Category | Commands |
|----------|----------|
| Session | `session use`, `session show` |
| State | `state`, `map`, `me`, `events`, `plans` |
| Selectors | `units`, `buildings`, `enemies`, `resources` |
| Actions | `move`, `attack`, `attack-move`, `gather`, `build`, `train`, `hold` |
| Transformers | `nearest`, `target` |
| Plan | `plan`, `orchestrate` |
| Wait | `wait` |

| Global flags | |
|--------------|---|
| `--base-url <url>` | Server URL (default: http://localhost:3001) |
| `--session <id>` | Session ID (default: saved from `session use`) |
| `--player <id>` | Player ID: player_1 or player_2 |
| `--json` | Force JSON output |

| Exit codes | |
|------------|---|
| 0 | Success |
| 1 | Argument error |
| 2 | Backend failure |
| 3 | Connection failure |
| 4 | Stdin parse error |
