# CLI Control Plane - AI Agent Guide

> Rule for agents: use the `llmcraft` CLI. Do not write WebSocket clients or raw HTTP control clients unless this guide explicitly says the CLI cannot do the required operation.

The CLI is the stable shell interface for external agents. It handles session creation, server URL resolution, stdin pipelines, JSON formatting, exit codes, and tool routing. Treat it as your action API.

This guide uses the agent-facing executable:

```bash
llmcraft <command> [flags]
```

In this repo, build the CLI first and call the workspace bin directly:

```bash
pnpm build:cli
./node_modules/.bin/llmcraft state --compact
```

`pnpm cli -- ...` is only a development convenience. Do not use it in pipelines that feed JSON to another CLI command; npm/pnpm script banners can pollute stdout.

## 0. Prerequisites

Build the CLI and run the server:

```bash
pnpm install
pnpm build:cli
pnpm dev:server
```

The default server is `http://localhost:3001`. Override it with either:

```bash
llmcraft state --base-url http://localhost:3001
```

or:

```bash
export LLMCRAFT_SERVER=http://localhost:3001
```

PowerShell:

```powershell
$env:LLMCRAFT_SERVER = "http://localhost:3001"
```

Sanity check:

```bash
llmcraft --help
```

## 1. Start A Match

There are two supported CLI start modes.

### Agent vs CPU

Use this when one shell agent should play `player_1` against a built-in CPU `player_2`.

```bash
llmcraft play --vs random
```

or:

```bash
llmcraft play --vs rush
```

This does three things:

- creates a new game on the server
- starts CPU control for `player_2`
- joins you as `player_1` and saves your session to `~/.llmcraft/session.json`

After this, commands like `llmcraft state` and `llmcraft units` use the saved session automatically.

### Two CLI Agents

Use this when two independent agents should play each other through the CLI.

Start a PVP game:

```bash
llmcraft play --mode pvp
```

Then each agent joins one side:

```bash
# Agent 1
llmcraft session use --player player_1

# Agent 2
llmcraft session use --player player_2
```

The game does not start ticking until both players have created a control session.

## 2. Session Rules

`session use` returns JSON like:

```json
{
  "ok": true,
  "sessionId": "cs_abc12345",
  "gameId": "default",
  "playerId": "player_1",
  "createdAt": "...",
  "serverUrl": "http://localhost:3001"
}
```

For a single local agent, using the saved session file is fine:

```bash
llmcraft session use --player player_1
llmcraft state
```

For two agents on the same machine, do not rely on the shared `~/.llmcraft/session.json`; the second `session use` will overwrite it. Use explicit sessions or per-agent environment variables.

Explicit sessions:

```bash
llmcraft state --session cs_player1
llmcraft units --idle --type worker --session cs_player1 | llmcraft gather --session cs_player1
```

Environment variables:

```bash
export LLMCRAFT_SESSION=cs_player1
export LLMCRAFT_SERVER=http://localhost:3001
```

PowerShell:

```powershell
$env:LLMCRAFT_SESSION = "cs_player1"
$env:LLMCRAFT_SERVER = "http://localhost:3001"
```

PowerShell treats commas in unquoted native-command arguments specially. Quote coordinates:

```powershell
llmcraft build barracks --at '5,10'
llmcraft attack-move --to '18,10'
```

Check your current saved session:

```bash
llmcraft session show
```

## 3. Read Before Acting

Every agent turn should begin with a read. Good reads:

```bash
llmcraft state --compact
llmcraft me
llmcraft units
llmcraft buildings
llmcraft enemies
llmcraft events --limit 5
```

Action results can include warnings:

- `no_recent_read`: this session has not read state before acting
- `state_stale`: the last read is too old for the current tick

If you see either warning, stop issuing actions and read again. When running through `pnpm cli`, process startup plus agent thinking can make the read stale before the action. Prefer short turns with explicit session flags, and issue only the actions justified by the latest read:

```bash
llmcraft state --compact
llmcraft units
```

## 4. Selectors

Selectors read state and output `kind: "selection"` JSON for piping into actions.

```bash
# My idle workers
llmcraft units --type worker --idle

# My soldiers that are not assigned to an active plan
llmcraft units --type soldier --unplanned

# My ready HQ or barracks, meaning empty production queue
llmcraft buildings --type hq --ready
llmcraft buildings --type barracks --ready

# Enemy HQ
llmcraft enemies --type hq

# Resource tiles near a point
llmcraft resources --near 10,10 --limit 3
```

Common selector flags:

| Flag | Meaning |
|------|---------|
| `--type worker|soldier|hq|barracks` | Filter by entity type |
| `--idle` | Only idle units |
| `--planned` | Only units with active plans |
| `--unplanned` | Only units without active plans |
| `--ready` | Only buildings with empty production queue |
| `--near x,y` | Sort by Chebyshev distance |
| `--limit n` | Return at most `n` items |

## 5. Actions

Actions can take explicit IDs:

```bash
llmcraft move --unit unit_1 --to 5,8
llmcraft gather --unit unit_1
llmcraft build barracks --unit unit_1 --at 5,10
llmcraft train worker --building building_1
llmcraft train soldier --building building_3
llmcraft attack --unit unit_7 --target building_2
llmcraft attack-move --unit unit_7 --to 18,10
llmcraft hold --unit unit_7
```

Actions also accept selector stdin:

```bash
llmcraft units --idle --type worker | llmcraft gather
llmcraft buildings --type hq --ready | llmcraft train worker
llmcraft buildings --type barracks --ready | llmcraft train soldier
```

When piped, each selected item becomes one action. The output is `kind: "batch_result"`.

## 6. Transformers

Transformers sit between selectors and actions.

```bash
# Pair each idle worker with a nearby resource, then gather
llmcraft units --idle --type worker | llmcraft nearest resource | llmcraft gather

# Pair each soldier with enemy HQ, then issue target attack
llmcraft units --type soldier | llmcraft target enemy-hq | llmcraft attack

# Pair each soldier with weakest visible enemy
llmcraft units --type soldier | llmcraft target weakest | llmcraft attack
```

`target weakest` is a global visible-target helper. Do not use it as a defense heuristic when enemies are already near your HQ; read `enemies --near <hq x,y>` or use an explicit `--target` for the immediate threat.

Available transformers:

| Command | Purpose |
|---------|---------|
| `nearest resource` | Pair selected units with nearest resource tile |
| `nearest enemy` | Pair selected units with nearest enemy |
| `target enemy-hq` | Pair selected units with enemy HQ |
| `target weakest` | Pair selected units with lowest-HP enemy |

## 7. Attack Semantics

Use `attack` when you know the target ID. This is the correct way to destroy HQ and barracks:

```bash
llmcraft units --type soldier | llmcraft target enemy-hq | llmcraft attack
```

Use `attack-move` when you only want to move toward coordinates and fight enemy units encountered on the way:

```bash
llmcraft units --type soldier | llmcraft attack-move --to 18,10
```

Do not use `attack-move` as a substitute for attacking HQ. It is intentionally an area advance command, not a building-demolition command.

At long range, `attack` may first appear as movement toward the target. Re-read state/events after the unit arrives; if the target still exists and the unit is idle, issue `attack` again.

## 8. Build Positions

Current map starts with:

- `player_1` HQ near `(2,10)`
- `player_2` HQ near `(18,10)`

Barracks cannot be adjacent to your HQ. Practical first barracks positions:

```bash
# player_1
llmcraft units --idle --type worker --limit 1 | llmcraft build barracks --at 5,10

# player_2
llmcraft units --idle --type worker --limit 1 | llmcraft build barracks --at 15,10
```

If a build fails, read `events` or the action error `hint`, then choose another empty tile.

## 9. Minimal Agent Turn

This is the basic turn shape every agent should understand. A turn starts with a read, then issues only the actions justified by the current state:

```bash
llmcraft state --compact
llmcraft units --idle --type worker | llmcraft nearest resource | llmcraft gather
llmcraft buildings --type hq --ready | llmcraft train worker
llmcraft units --idle --type worker --limit 1 | llmcraft build barracks --at 5,10
llmcraft buildings --type barracks --ready | llmcraft train soldier
llmcraft units --type soldier | llmcraft target enemy-hq | llmcraft attack
```

For `player_2`, use a right-side barracks coordinate such as `15,10`.

The CLI does not require or insert a sleep between turns. If an external harness runs continuously, pacing belongs to that harness. LLM/tool-calling agents can simply make the next read/action decision when control returns to them.

`state --compact` includes `winner` for end-of-game checks. Full `state` is still the best final read when you need HQ, economy, production, and complete unit/building details.

After a winner exists, read commands (`state`, `map`, `me`, `events`, `plans`) remain available. Selectors, transformers, actions, `plan`, and `orchestrate` return `game_over` with the winner instead of continuing the pipeline.

Plans are asynchronous intentions. `hasActivePlan: true` does not guarantee the unit will immediately leave `idle`; the plan may be waiting for credits, production queue availability, a target condition, or the next plan tick. If a plan appears stuck, read `plans` and `events` before assuming the plan failed.

## 10. External Scheduler Shape

The CLI process is intentionally one command at a time. A long-running agent, benchmark runner, or shell wrapper owns the outer scheduling loop:

```text
read state/events/plans
decide whether any action is needed
issue zero or more CLI actions
return control to the caller's scheduler
```

Do not treat the fixed command sequence above as a recommended strategy. It is only a compact example of the command surface.

## 11. Two-Agent Local Test

Terminal 1:

```bash
pnpm dev:server
```

Terminal 2:

```bash
llmcraft play --mode pvp
llmcraft session use --player player_1
```

Copy the `sessionId` as `P1_SESSION`.

Terminal 3:

```bash
llmcraft session use --player player_2
```

Copy the `sessionId` as `P2_SESSION`.

If you run commands manually, always pass the matching `--session` flag for that agent.

## 12. Common Failures

| Symptom | Meaning | Fix |
|---------|---------|-----|
| `No session found` | You did not join a game or did not set `LLMCRAFT_SESSION` | Run `session use` or pass `--session` |
| `没有活跃对局` | Server has no control-plane game | Run `llmcraft play --vs random` or `llmcraft play --mode pvp` |
| `已有活跃对局` | A match is already running | Stop/reset the server or finish the current match |
| `stdin selection has no units` | Selector returned an empty list | Read state and try a different selector |
| `insufficient_credits` | Not enough credits | Gather, wait, or train less |
| `invalid_build_position` | Tile blocked or too close to HQ | Pick another empty tile |
| `state_stale` / `no_recent_read` | You acted without a recent read | Run `state`, `me`, or `units` before acting |
| `game_over` | The match already has a winner | Stop issuing actions; read `state` for final details |

## 13. Command Reference

| Category | Commands |
|----------|----------|
| Match | `play --vs random`, `play --vs rush`, `play --mode pvp` |
| Session | `session use`, `session show` |
| State | `state`, `map`, `me`, `events`, `plans` |
| Selectors | `units`, `buildings`, `enemies`, `resources` |
| Actions | `move`, `attack`, `attack-move`, `gather`, `build`, `train`, `hold` |
| Transformers | `nearest`, `target` |
| Plans | `plan`, `orchestrate` |

Global flags:

| Flag | Meaning |
|------|---------|
| `--base-url <url>` | Server URL, defaults to `LLMCRAFT_SERVER` or `http://localhost:3001` |
| `--session <id>` | Control session ID, defaults to `LLMCRAFT_SESSION` or saved session |
| `--player <id>` | `player_1` or `player_2` |
| `--json` | JSON output, currently the default |

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Argument error |
| 2 | Backend action or plan failure |
| 3 | Connection failure |
| 4 | Stdin parse error |
