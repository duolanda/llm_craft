#!/usr/bin/env node
import { ControlClient } from "./client.js";
import { loadSession, saveSession, resolveServerUrl, resolveSessionId } from "./session.js";
import { ExitCode, exit } from "./io/errors.js";
import { printJson, printError } from "./io/json.js";
import { handleState, handleMap, handleMe, handleEvents, handlePlans } from "./commands/state.js";
import { handleUnits, handleBuildings, handleEnemies, handleResources } from "./commands/select.js";
import { handleMove, handleAttack, handleAttackMove, handleGather, handleBuild, handleTrain, handleStop, handleHold, handleRally, handleProductionQueue, handleCancelProduction } from "./commands/actions.js";
import { handleNearest, handleTarget } from "./commands/transform.js";
import { handlePlan, handleOrchestrate } from "./commands/plan.js";
import { handlePlay } from "./commands/play.js";

const VERSION = "0.1.0";
type CommandKind = "selection" | "action_result" | "plan_result";

interface ParsedArgs {
  baseUrl?: string;
  sessionId?: string;
  playerId?: string;
  command: string;
  subcommand: string;
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      flags.set("help", "true");
      i++;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      flags.set("version", "true");
      i++;
      continue;
    }
    if (arg === "--json") {
      flags.set("json", "true");
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex >= 0) {
        const key = arg.slice(2, eqIndex);
        const value = arg.slice(eqIndex + 1);
        flags.set(key, value);
        i++;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        flags.set(arg.slice(2), argv[i + 1]);
        i += 2;
      } else {
        flags.set(arg.slice(2), "true");
        i++;
      }
      continue;
    }
    positional.push(arg);
    i++;
  }

  const command = positional[0] ?? "";
  const subcommand = positional[1] ?? "";

  return { command, subcommand, flags };
}

function printHelp(): void {
  const text = [
    "llmcraft - CLI action control plane for LLMCraft RTS matches",
    "",
    "Usage: llmcraft [global-flags] <command> [subcommand] [flags]",
    "",
    "Global flags:",
    "  --base-url <url>   Server base URL (env: LLMCRAFT_SERVER, default: http://localhost:3101)",
    "  --session <id>     Control session ID (env: LLMCRAFT_SESSION)",
    "  --player <id>      Player ID: player_1 or player_2 (env: LLMCRAFT_PLAYER)",
    "  --json             Force JSON output (default)",
    "  --help, -h         Show this help",
    "  --version, -V      Show version",
    "",
    "Commands:",
    "  session use        Create or bind a control session",
    "  session show       Display current session info",
    "  matches list       List registered live/control/benchmark matches",
    "  matches observe    Select the match shown by Web UI (--game <matchId>)",
    "  matches stop       Quiesce, stop, and save one match without affecting others",
    "  record save        Save a Match Record (--game <matchId>)",
    "  state              Read full game state (map + player)",
    "  map                Show ASCII battlefield map",
    "  me                 Show my economy, HQ, and production",
    "  events             Show recent AI-facing events",
    "  plans              Show active orchestration plans",
    "  units              List my units with filtering",
    "  buildings          List my buildings with filtering",
    "  enemies            List visible enemy units and buildings",
    "  resources          List visible resource tiles",
    "  move               Move a unit to coordinates",
    "  attack             Attack a target with a unit",
    "  attack-move        Combat move toward coordinates",
    "  gather             Assign worker to harvest loop",
    "  build              Build a structure (build barracks/war_factory)",
    "  train              Train a unit (worker/rifleman/rocket_soldier/commando/light_tank/flame_tank/heavy_tank)",
    "  production-queue   Inspect finite production queues and progress",
    "  cancel-production  Cancel batches by order ID or clear building queues",
    "  rally              Set or clear move/attack-move production rally points",
    "  stop               Cancel orders and return units to normal idle behavior",
    "  hold               Hold position",
    "  nearest            Find nearest resource/enemy for each unit",
    "  target             Pair units with enemy-hq or weakest enemy",
    "  plan               Generate a plan (economy/tech/defend/attack-hq/custom)",
    "  orchestrate        Execute a batch of tool-shaped actions from stdin",
    "  play               Start a CPU or PVP control-plane game",
    "",
    "Plan flags:",
    "  --file <path>      Path to custom plan JSON (plan custom only)",
    "",
    "Orchestrate flags:",
    "  --dry-run          Validate only, do not submit",
    "  --max-actions <n>  Limit number of actions executed",
    "  --request-id <id>  Stable idempotency key for a batched action submission",
    "",
    "Action flags:",
    "  --unit <id>        Unit ID",
    "  --units <list>     Comma-separated unit IDs for move/attack/attack-move/stop/hold",
    "  --to <x,y>         Target coordinates",
    "  --target <id>      Target ID",
    "  --resource <x,y>   Resource coordinates",
    "  --at <x,y>         Build location",
    "  --building <id>    Building ID",
    "  --buildings <list> Comma-separated production building IDs for rally",
    "  --count <n>        Units to append with train (1-100)",
    "  --order <id>       Production order ID to cancel",
    "  --orders <list>    Comma-separated production order IDs to cancel",
    "  --mode <mode>      Rally travel mode: move or attack-move",
    "  --priority <list>  Target priority (worker/infantry/vehicles/buildings)",
    "  --request-id <id>  Stable idempotency key when stdin expands to multiple actions",
    "",
    "Selector flags (units, buildings, enemies, resources):",
    "  --type <t>         Filter by any unit or building type",
    "  --idle             Only idle units",
    "  --planned          Only units with an active plan",
    "  --unplanned        Only units without an active plan",
    "  --ready            Only buildings with an empty production queue",
    "  --near <x,y>       Sort by Chebyshev distance from (x,y)",
    "  --limit <n>        Return at most n results",
    "",
    "State flags:",
    "  --compact          Compact output (ASCII map only)",
    "  --cells            Include cell grid",
    "  --empty-tiles      Include empty tiles in cells",
    "",
    "Play flags:",
    "  --vs random|rush   Start player_1 vs CPU player_2 and join as player_1",
    "  --mode pvp         Start a two-player control-plane game and wait for both sessions",
    "",
    "Examples:",
    "  llmcraft play --vs random",
    "  llmcraft play --mode pvp",
    "  llmcraft session use --player player_1 --base-url http://localhost:3101",
    "  llmcraft session show",
    "  llmcraft matches list",
    "  llmcraft matches observe --game match_xxx",
    "  llmcraft record save --game match_xxx",
    "  llmcraft state --compact",
    "  llmcraft units --type worker --idle",
    "  llmcraft enemies --type hq",
    "  llmcraft resources --near 5,5 --limit 2",
    "  llmcraft move --unit worker_1 --to 5,8",
    "  llmcraft attack --unit rifleman_1 --target enemy_hq",
    "  llmcraft stop --unit rifleman_1",
    "  llmcraft hold --unit rifleman_1",
    "  llmcraft units --idle --type worker | llmcraft gather",
    "  llmcraft buildings --type barracks --ready | llmcraft train rifleman",
    "  llmcraft rally --building building_4 --to 40,30 --mode attack-move  # omit --to to clear",
    "  llmcraft units --idle --type worker | llmcraft nearest resource | llmcraft gather",
    "  llmcraft units --type rifleman | llmcraft target enemy-hq | llmcraft attack",
    "  llmcraft plan economy | llmcraft orchestrate",
    "  llmcraft plan tech | llmcraft orchestrate",
    "  llmcraft plan attack-hq | llmcraft orchestrate",
    "  llmcraft orchestrate --dry-run < actions.json  # accepts { actions: [...] }",
    "  llmcraft units --idle --type worker | llmcraft gather",
    "",
    "PowerShell: quote comma-separated values, e.g. --at '5,10' or --units 'unit_1,unit_2'.",
    "",
    "Exit codes:",
    "  0  Success",
    "  1  Argument error",
    "  2  Backend action/plan failure",
    "  3  Connection failure",
    "  4  Stdin parse error",
  ].join("\n");
  process.stdout.write(text + "\n");
  process.exit(0);
}

function printVersion(): void {
  process.stdout.write(`llmcraft ${VERSION}\n`);
  process.exit(0);
}

function gameOverKindForCommand(command: string): CommandKind | null {
  if (["units", "buildings", "enemies", "resources", "nearest", "target"].includes(command)) {
    return "selection";
  }
  if (["move", "attack", "attack-move", "gather", "build", "train", "production-queue", "cancel-production", "rally", "stop", "hold"].includes(command)) {
    return "action_result";
  }
  if (["plan", "orchestrate"].includes(command)) {
    return "plan_result";
  }
  return null;
}

async function exitIfGameOver(
  client: ControlClient,
  sessionId: string,
  kind: CommandKind,
): Promise<void> {
  const stateResp = await client.getState(sessionId);
  if (!stateResp.ok) {
    exit(ExitCode.BackendFailure, stateResp.error?.message ?? "Failed to get state");
  }

  const stateData = stateResp.data as Record<string, unknown>;
  const winner = stateData.winner;
  if (winner === null || winner === undefined) {
    return;
  }

  printJson({
    ok: false,
    tick: stateResp.tick,
    kind,
    data: {
      gameOver: true,
      winner,
    },
    error: {
      code: "game_over",
      message: `Game is over. Winner: ${String(winner)}`,
    },
  });
  process.exit(ExitCode.BackendFailure);
}

async function exitIfGameNotStarted(
  client: ControlClient,
  sessionId: string,
  kind: CommandKind,
): Promise<void> {
  const stateResp = await client.getState(sessionId);
  if (!stateResp.ok) {
    exit(ExitCode.BackendFailure, stateResp.error?.message ?? "Failed to get state");
  }

  const stateData = stateResp.data as Record<string, unknown>;
  if (stateData.status !== "waiting_for_players") {
    return;
  }

  printJson({
    ok: false,
    tick: stateResp.tick,
    kind,
    data: {
      status: stateData.status,
      ready: stateData.ready,
    },
    error: {
      code: "game_not_started",
      message: "Game has not started. Wait until both players have created control sessions.",
    },
  });
  process.exit(ExitCode.BackendFailure);
}

async function handleSessionUse(
  client: ControlClient,
  flags: Map<string, string>,
): Promise<void> {
  const playerId = flags.get("player") || process.env.LLMCRAFT_PLAYER || flags.get("player-id");
  if (!playerId) {
    exit(ExitCode.ArgError, "session use requires --player (player_1 or player_2)");
  }
  if (playerId !== "player_1" && playerId !== "player_2") {
    exit(ExitCode.ArgError, "--player must be player_1 or player_2");
  }

  const gameId = flags.get("game") || flags.get("game-id") || undefined;

  let response;
  try {
    response = await client.createSession(playerId, gameId);
  } catch (err) {
    exit(
      ExitCode.ConnectionFailure,
      `Failed to connect to server: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    exit(ExitCode.BackendFailure, response.error?.message ?? "Failed to create session");
  }

  const data = response.data as {
    sessionId: string;
    gameId: string;
    playerId: string;
    createdAt: string;
  };

  saveSession({
    sessionId: data.sessionId,
    gameId: data.gameId,
    playerId: data.playerId,
    serverUrl: client.getBaseUrl(),
  });

  printJson({
    ok: true,
    sessionId: data.sessionId,
    gameId: data.gameId,
    playerId: data.playerId,
    createdAt: data.createdAt,
    serverUrl: client.getBaseUrl(),
  });
}

async function handleSessionShow(): Promise<void> {
  const session = loadSession();
  if (!session) {
    exit(ExitCode.ArgError, "No session found. Run 'llmcraft session use --player <id>' first.");
  }

  printJson({
    ok: true,
    sessionId: session.sessionId,
    gameId: session.gameId,
    playerId: session.playerId,
    serverUrl: session.serverUrl,
  });
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    printHelp();
  }

  const parsed = parseArgs(rawArgs);

  if (parsed.flags.has("help")) {
    printHelp();
  }
  if (parsed.flags.has("version")) {
    printVersion();
  }

  const globalBaseUrl = resolveServerUrl(parsed.flags.get("base-url"));

  if (!parsed.command) {
    printHelp();
  }

  if (parsed.command === "session") {
    if (parsed.subcommand === "use") {
      const client = new ControlClient(globalBaseUrl);
      await handleSessionUse(client, parsed.flags);
      return;
    }
    if (parsed.subcommand === "show") {
      await handleSessionShow();
      return;
    }
    exit(ExitCode.ArgError, `Unknown session subcommand: ${parsed.subcommand || "(none)"}`);
  }

  if (parsed.command === "matches") {
    const client = new ControlClient(globalBaseUrl);
    try {
      if (parsed.subcommand === "list") {
        printJson(await client.listMatches());
        return;
      }
      const matchId = parsed.flags.get("game") || parsed.flags.get("game-id");
      if (!matchId) exit(ExitCode.ArgError, `${parsed.subcommand} requires --game <matchId>`);
      if (parsed.subcommand === "observe") {
        printJson(await client.observeMatch(matchId));
        return;
      }
      if (parsed.subcommand === "stop") {
        printJson(await client.stopMatch(matchId));
        return;
      }
      exit(ExitCode.ArgError, `Unknown matches subcommand: ${parsed.subcommand || "(none)"}`);
    } catch (error) {
      exit(ExitCode.ConnectionFailure, error instanceof Error ? error.message : String(error));
    }
  }

  if (parsed.command === "record") {
    if (parsed.subcommand !== "save") {
      exit(ExitCode.ArgError, `Unknown record subcommand: ${parsed.subcommand || "(none)"}`);
    }
    const savedSession = loadSession();
    const matchId = parsed.flags.get("game") || parsed.flags.get("game-id") || savedSession?.gameId;
    if (!matchId) exit(ExitCode.ArgError, "record save requires --game <matchId> or a saved session");
    try {
      printJson(await new ControlClient(globalBaseUrl).saveMatchRecord(matchId));
      return;
    } catch (error) {
      exit(ExitCode.ConnectionFailure, error instanceof Error ? error.message : String(error));
    }
  }

  // Play command: start a game vs CPU
  if (parsed.command === "play") {
    const client = new ControlClient(globalBaseUrl);
    await handlePlay(client, parsed.flags);
    return;
  }

  // Phase 3: Read state and selectors
  const sessionId = resolveSessionId(parsed.flags.get("session"));
  if (!sessionId) {
    exit(ExitCode.ArgError, "No session found. Run 'llmcraft session use --player <id>' first.");
  }
  const client = new ControlClient(globalBaseUrl);

  if (parsed.command === "state") {
    await handleState(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "map") {
    await handleMap(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "me") {
    await handleMe(client, sessionId);
    return;
  }
  if (parsed.command === "events") {
    await handleEvents(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "plans") {
    await handlePlans(client, sessionId);
    return;
  }

  const gameOverKind = gameOverKindForCommand(parsed.command);
  if (gameOverKind) {
    await exitIfGameOver(client, sessionId, gameOverKind);
    await exitIfGameNotStarted(client, sessionId, gameOverKind);
  }

  if (parsed.command === "units") {
    await handleUnits(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "buildings") {
    await handleBuildings(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "enemies") {
    await handleEnemies(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "resources") {
    await handleResources(client, sessionId, parsed.flags);
    return;
  }

  // Phase 4: Action commands
  if (parsed.command === "move") {
    await handleMove(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "attack") {
    await handleAttack(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "attack-move") {
    await handleAttackMove(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "gather") {
    await handleGather(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "build") {
    await handleBuild(client, sessionId, parsed.subcommand, parsed.flags);
    return;
  }
  if (parsed.command === "train") {
    await handleTrain(client, sessionId, parsed.subcommand, parsed.flags);
    return;
  }
  if (parsed.command === "production-queue") {
    await handleProductionQueue(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "cancel-production") {
    await handleCancelProduction(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "rally") {
    await handleRally(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "stop") {
    await handleStop(client, sessionId, parsed.flags);
    return;
  }
  if (parsed.command === "hold") {
    await handleHold(client, sessionId, parsed.flags);
    return;
  }

  // Phase 5: Pipeline transformers
  if (parsed.command === "nearest") {
    await handleNearest(client, sessionId, parsed.subcommand);
    return;
  }
  if (parsed.command === "target") {
    await handleTarget(client, sessionId, parsed.subcommand);
    return;
  }

  // Phase 6: Plan and orchestrate
  if (parsed.command === "plan") {
    await handlePlan(client, sessionId, parsed.subcommand, parsed.flags);
    return;
  }
  if (parsed.command === "orchestrate") {
    await handleOrchestrate(client, sessionId, parsed.flags);
    return;
  }

  exit(ExitCode.ArgError, `Unknown command: ${parsed.command}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err.cause as { code?: string } | undefined : undefined;
  const connectionFailure = message.includes("fetch failed") || cause?.code === "ECONNREFUSED";
  printError(connectionFailure ? `Failed to connect to server: ${message}` : message);
  process.exit(connectionFailure ? ExitCode.ConnectionFailure : ExitCode.ArgError);
});
