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

The default server is `http://localhost:3101`. Override it with either:

```bash
llmcraft state --base-url http://localhost:3101
```

or:

```bash
export LLMCRAFT_SERVER=http://localhost:3101
```

PowerShell:

```powershell
$env:LLMCRAFT_SERVER = "http://localhost:3101"
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

Before both players have joined, read commands are available but selectors, transformers, actions, `plan`, and `orchestrate` return `game_not_started`. This prevents the first agent to join from pre-queuing actions before the other agent is ready.

### Host A Match Between Two External Agents

Use this flow when a human host wants any two external coding agents to play each other:

1. In one terminal, start the server:

```bash
pnpm dev:server
```

2. In another terminal, create the PVP lobby:

```bash
llmcraft play --mode pvp
```

3. Give the first agent this instruction:

```text
You are player_1 in a LLMCraft CLI match.
First read docs/cli-agent-guide.md.
Join with: llmcraft session use --player player_1 --base-url http://localhost:3101
After joining, copy your sessionId and pass --session <sessionId> on every command.
Use only llmcraft. Do not write WebSocket or raw HTTP clients.
```

4. Give the second agent the same instruction with `player_2`.

5. After both agents have created control sessions, the game starts ticking automatically. Each agent should then read `state --compact` and continue with normal CLI turns.

## 2. Session Rules

`session use` returns JSON like:

```json
{
  "ok": true,
  "sessionId": "cs_abc12345",
  "gameId": "match_abc123",
  "playerId": "player_1",
  "createdAt": "...",
  "serverUrl": "http://localhost:3101"
}
```

`gameId` is the stable match identity. When more than one control match exists, bind explicitly so another newly created or observed match cannot change your target:

```bash
llmcraft session use --player player_1 --game match_abc123
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
export LLMCRAFT_SERVER=http://localhost:3101
```

PowerShell:

```powershell
$env:LLMCRAFT_SESSION = "cs_player1"
$env:LLMCRAFT_SERVER = "http://localhost:3101"
```

PowerShell treats commas in unquoted native-command arguments specially. Quote coordinates:

```powershell
llmcraft build barracks --at '6,12'
llmcraft attack-move --to '32,12'
```

Check your current saved session:

```bash
llmcraft session show
```

## 3. Match Selection And Records

The server can retain multiple live, control, and benchmark matches at the same time. List them before operating on a match you did not create yourself:

```bash
llmcraft matches list
```

Select which match the Web UI observes without stopping the others:

```bash
llmcraft matches observe --game match_abc123
```

Save a Match Record. With no `--game`, the command uses the match bound to the saved local session:

```bash
llmcraft record save
llmcraft record save --game match_abc123
```

Quiesce, stop, and save exactly one match:

```bash
llmcraft matches stop --game match_abc123
```

Observation selection and session binding are deliberately separate: `matches observe` changes the Web UI projection; it does not retarget existing CLI sessions.

The current CLI does not expose journal recovery or retention commands. A Match Record is written once after the match has stopped; transcript data is an optional part of an evaluation record rather than a separate storage lifecycle.

## 4. Read Before Acting

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

If you see this warning, read before making further decisions. Once the session has read state, elapsed ticks alone do not produce a stale-state warning: actions validate targets and rules against live state when called.

```bash
llmcraft state --compact
llmcraft units
```

## 5. Selectors

Selectors read state and output `kind: "selection"` JSON for piping into actions.

```bash
# My idle workers
llmcraft units --type worker --idle

# My riflemen that are not assigned to an active plan
llmcraft units --type rifleman --unplanned

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
| `--type <entity-type>` | Filter by any unit or building type in the standard ruleset |
| `--idle` | Only idle units |
| `--planned` | Only units with active plans |
| `--unplanned` | Only units without active plans |
| `--ready` | Only buildings with empty production queue |
| `--near x,y` | Sort by Chebyshev distance |
| `--limit n` | Return at most `n` items |

## 6. Actions

Actions can take explicit IDs:

```bash
llmcraft move --unit unit_1 --to 5,8
llmcraft gather --unit unit_1
llmcraft gather --units unit_1,unit_2,unit_3
llmcraft build barracks --unit unit_1 --at 6,12
llmcraft train worker --building building_1
llmcraft train rifleman --building building_3
llmcraft rally --building building_3 --to 32,12 --mode attack-move
llmcraft attack --unit unit_7 --target building_2
llmcraft attack-move --unit unit_7 --to 32,12
llmcraft hold --unit unit_7
```

Actions also accept selector stdin:

```bash
llmcraft units --idle --type worker | llmcraft gather
llmcraft buildings --type hq --ready | llmcraft train worker
llmcraft buildings --type barracks --ready | llmcraft train rifleman
```

The standard ruleset no longer produces `soldier`; barracks production starts with `rifleman` and also supports `rocket_soldier`. A completed war factory unlocks the T2 `light_tank` and short-range anti-infantry/structure `flame_tank`; a completed tech center unlocks the T3 `heavy_tank` in war factories and one player-wide `commando` in barracks. The commando one-shots infantry at long range and buildings with adjacent C4, but cannot damage vehicles. The `soldier` type remains readable and targetable so older Match Records can still be replayed and inspected.

When piped, the CLI groups compatible selections into array-shaped actions and sends the complete expansion through one HTTP request and one `CommandEnvelope`. Each action is applied independently at the same tick boundary; one failed action does not roll back successful siblings. The output is `kind: "batch_result"`.

For a retryable automation step, supply a stable idempotency key:

```bash
llmcraft units --idle --type worker | llmcraft gather --request-id opening-workers-v1
llmcraft orchestrate --request-id assault-wave-3 < actions.json
```

Reusing the same ID with identical actions returns `duplicate: true` without executing again. Reusing it with different actions is an explicit conflict.

Pathfinding has a deliberate fair tick budget. If a large move/gather/attack-move envelope returns `path_budget_exceeded`, no unit in that envelope was changed and nothing was deferred; split the selection into smaller explicit groups and retry with new request IDs. When both players submit path commands in the same tick, each receives a reserved share before unused capacity is lent.

## 7. Transformers

Transformers sit between selectors and actions.

```bash
# Pair each idle worker with a nearby resource, then gather
llmcraft units --idle --type worker | llmcraft nearest resource | llmcraft gather

# Pair each rifleman with enemy HQ, then issue target attack
llmcraft units --type rifleman | llmcraft target enemy-hq | llmcraft attack

# Pair each rifleman with weakest known enemy
llmcraft units --type rifleman | llmcraft target weakest | llmcraft attack
```

`target weakest` is a global target helper. Do not use it as a defense heuristic when enemies are already near your HQ; read `enemies --near <hq x,y>` or use an explicit `--target` for the immediate threat.

Available transformers:

| Command | Purpose |
|---------|---------|
| `nearest resource` | Pair selected units with nearest resource tile |
| `nearest enemy` | Pair selected units with nearest enemy |
| `target enemy-hq` | Pair selected units with enemy HQ |
| `target weakest` | Pair selected units with lowest-HP enemy |

## 8. Attack Semantics

Use `attack` when you know the target ID. This is the correct way to destroy HQ and barracks:

```bash
llmcraft units --type rifleman | llmcraft target enemy-hq | llmcraft attack
```

Use `attack-move` when you only want to move toward coordinates and fight enemy units encountered on the way:

```bash
llmcraft units --type rifleman | llmcraft attack-move --to 32,12
```

Do not use `attack-move` as a substitute for attacking HQ. It is intentionally an area advance command, not a building-demolition command.

Production rallies have the same two travel modes. `rally --mode move` is the default; `rally --mode attack-move` is available for barracks and war factories. HQ worker rallies only support `move`.

At long range, `attack` may first appear as movement toward the target. Re-read state/events after the unit arrives; if the target still exists and the unit is idle, issue `attack` again.

## 9. Build Positions

Current map starts with:

- `player_1` HQ near `(4,12)`
- `player_2` HQ near `(32,12)`

Barracks cannot be adjacent to your HQ. Practical first barracks positions:

```bash
# player_1
llmcraft units --idle --type worker --limit 1 | llmcraft build barracks --at 6,12

# player_2
llmcraft units --idle --type worker --limit 1 | llmcraft build barracks --at 30,12
```

If a build fails, read `events` or the action error `hint`, then choose another empty tile.

## 10. Minimal Agent Turn

This is the basic turn shape every agent should understand. A turn starts with a read, then issues only the actions justified by the current state:

```bash
llmcraft state --compact
llmcraft units --idle --type worker | llmcraft nearest resource | llmcraft gather
llmcraft buildings --type hq --ready | llmcraft train worker
llmcraft units --idle --type worker --limit 1 | llmcraft build barracks --at 5,10
llmcraft buildings --type barracks --ready | llmcraft train rifleman
llmcraft units --type rifleman | llmcraft target enemy-hq | llmcraft attack
```

For `player_2`, use a right-side barracks coordinate such as `15,10`.

The CLI does not require or insert a sleep between turns. If an external harness runs continuously, pacing belongs to that harness. LLM/tool-calling agents can simply make the next read/action decision when control returns to them.

`state --compact` includes `winner` for end-of-game checks. Full `state` is still the best final read when you need HQ, economy, production, and complete unit/building details.

After a winner exists, read commands (`state`, `map`, `me`, `events`, `plans`) remain available. Selectors, transformers, actions, `plan`, and `orchestrate` return `game_over` with the winner instead of continuing the pipeline.

Plans are asynchronous intentions. `hasActivePlan: true` does not guarantee the unit will immediately leave `idle`; the plan may be waiting for credits, production queue availability, a target condition, or the next plan tick. If a plan appears stuck, read `plans` and `events` before assuming the plan failed.

## 11. External Scheduler Shape

The CLI process is intentionally one command at a time. A long-running agent, benchmark runner, or shell wrapper owns the outer scheduling loop:

```text
read state/events/plans
decide whether any action is needed
issue zero or more CLI actions
return control to the caller's scheduler
```

Do not treat the fixed command sequence above as a recommended strategy. It is only a compact example of the command surface.

## 12. Two-Agent Local Test

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

## 13. Common Failures

| Symptom | Meaning | Fix |
|---------|---------|-----|
| `No session found` | You did not join a game or did not set `LLMCRAFT_SESSION` | Run `session use` or pass `--session` |
| `没有活跃对局` | Server has no control-plane game | Run `llmcraft play --vs random` or `llmcraft play --mode pvp` |
| `指定对局不存在` | The supplied `--game` does not identify a registered match | Run `matches list` and retry with a current `matchId` |
| `stdin selection has no units` | Selector returned an empty list | Read state and try a different selector |
| `insufficient_credits` | Not enough credits | Gather, wait, or train less |
| `invalid_build_position` | Tile blocked or too close to HQ | Pick another empty tile |
| `no_recent_read` | This session has not read state yet | Run `state`, `me`, or `units` before acting |
| `game_not_started` | PVP lobby is waiting for both players | Wait for the other agent to run `session use`, then read `state` |
| `game_over` | The match already has a winner | Stop issuing actions; read `state` for final details |

## 14. Command Reference

| Category | Commands |
|----------|----------|
| Match | `play --vs random`, `play --vs rush`, `play --mode pvp`, `matches list`, `matches observe`, `matches stop` |
| Session | `session use`, `session show` |
| Record | `record save` |
| State | `state`, `map`, `me`, `events`, `plans` |
| Selectors | `units`, `buildings`, `enemies`, `resources` |
| Actions | `move`, `attack`, `attack-move`, `gather`, `build`, `train`, `rally`, `hold` |
| Transformers | `nearest`, `target` |
| Plans | `plan`, `orchestrate` |

Global flags:

| Flag | Meaning |
|------|---------|
| `--base-url <url>` | Server URL, defaults to `LLMCRAFT_SERVER` or `http://localhost:3101` |
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
