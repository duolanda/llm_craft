#!/usr/bin/env node
import { ControlClient } from "./client.js";
import { loadSession, saveSession, resolveServerUrl, resolveSessionId } from "./session.js";
import { ExitCode, exit } from "./io/errors.js";
import { printJson, printError } from "./io/json.js";
import { handleState, handleMap, handleMe, handleEvents, handlePlans } from "./commands/state.js";
import { handleUnits, handleBuildings, handleEnemies, handleResources } from "./commands/select.js";
import { handleMove, handleAttack, handleAttackMove, handleGather, handleBuild, handleTrain, handleHold } from "./commands/actions.js";
import { handleNearest, handleTarget } from "./commands/transform.js";
import { handlePlan, handleOrchestrate } from "./commands/plan.js";
import { handlePlay } from "./commands/play.js";

const VERSION = "0.1.0";

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
    "  --base-url <url>   Server base URL (env: LLMCRAFT_SERVER, default: http://localhost:3001)",
    "  --session <id>     Control session ID (env: LLMCRAFT_SESSION)",
    "  --player <id>      Player ID: player_1 or player_2 (env: LLMCRAFT_PLAYER)",
    "  --json             Force JSON output (default)",
    "  --help, -h         Show this help",
    "  --version, -V      Show version",
    "",
    "Commands:",
    "  session use        Create or bind a control session",
    "  session show       Display current session info",
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
    "  build              Build a structure (build barracks)",
    "  train              Train a unit (train worker/soldier)",
    "  hold               Hold position",
    "  nearest            Find nearest resource/enemy for each unit",
    "  target             Pair units with enemy-hq or weakest enemy",
    "  plan               Generate a plan (economy/defend/attack-hq/custom)",
    "  orchestrate        Execute a plan or batch of actions from stdin",
    "  play               Start a game against a CPU opponent (play --vs random)",
    "",
    "Plan flags:",
    "  --file <path>      Path to custom plan JSON (plan custom only)",
    "",
    "Orchestrate flags:",
    "  --dry-run          Validate only, do not submit",
    "  --max-actions <n>  Limit number of actions executed",
    "",
    "Action flags:",
    "  --unit <id>        Unit ID",
    "  --to <x,y>         Target coordinates",
    "  --target <id>      Target ID",
    "  --resource <x,y>   Resource coordinates",
    "  --at <x,y>         Build location",
    "  --building <id>    Building ID",
    "  --priority <list>  Target priority (soldier,worker)",
    "",
    "Selector flags (units, buildings, enemies, resources):",
    "  --type <t>         Filter by type (worker, soldier, hq, barracks)",
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
    "Examples:",
    "  llmcraft session use --player player_1 --base-url http://localhost:3001",
    "  llmcraft session show",
    "  llmcraft state --compact",
    "  llmcraft units --type worker --idle",
    "  llmcraft enemies --type hq",
    "  llmcraft resources --near 5,5 --limit 2",
    "  llmcraft move --unit worker_1 --to 5,8",
    "  llmcraft attack --unit soldier_1 --target enemy_hq",
    "  llmcraft units --idle --type worker | llmcraft gather",
    "  llmcraft buildings --type barracks --ready | llmcraft train soldier",
    "  llmcraft units --idle --type worker | llmcraft nearest resource | llmcraft gather",
    "  llmcraft units --type soldier | llmcraft target enemy-hq | llmcraft attack",
    "  llmcraft plan economy | llmcraft orchestrate",
    "  llmcraft plan attack-hq | llmcraft orchestrate",
    "  llmcraft orchestrate --dry-run < actions.json",
    "  while true; do llmcraft units --idle --type worker | llmcraft gather; sleep 1; done",
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
  printError(err instanceof Error ? err.message : String(err));
  process.exit(ExitCode.ArgError);
});
