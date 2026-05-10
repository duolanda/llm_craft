import { ControlClient } from "../client.js";
import { ExitCode, exit } from "../io/errors.js";
import { printJson } from "../io/json.js";

const VALID_STRATEGIES = ["random", "rush"];

export async function handlePlay(
  client: ControlClient,
  flags: Map<string, string>,
): Promise<void> {
  const strategy = flags.get("vs") || flags.get("cpu") || flags.get("strategy") || "random";

  if (!VALID_STRATEGIES.includes(strategy)) {
    exit(
      ExitCode.ArgError,
      `Unknown CPU strategy: "${strategy}". Valid: ${VALID_STRATEGIES.join(", ")}`,
    );
  }

  // 1. POST start-game with cpu parameter
  let startResult;
  try {
    const res = await fetch(`${client.getBaseUrl()}/api/control/start-game`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cpu: strategy }),
    });
    startResult = await res.json();
  } catch (err) {
    exit(
      ExitCode.ConnectionFailure,
      `Failed to connect to server: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!startResult.ok) {
    const msg = startResult.error?.message ?? "Failed to start game";
    exit(ExitCode.BackendFailure, msg);
  }

  // 2. Join as player_1 using session use logic
  let sessionResponse;
  try {
    sessionResponse = await client.createSession("player_1");
  } catch (err) {
    exit(
      ExitCode.ConnectionFailure,
      `Failed to join game: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!sessionResponse.ok) {
    exit(
      ExitCode.BackendFailure,
      sessionResponse.error?.message ?? "Failed to join game",
    );
  }

  const data = sessionResponse.data as {
    sessionId: string;
    gameId: string;
    playerId: string;
    createdAt: string;
  };

  // 3. Save session
  // (Can't use saveSession + handleSessionShow here directly since it's a different module,
  //  but the user can also run `session show` after)
  const { saveSession } = await import("../session.js");
  saveSession({
    sessionId: data.sessionId,
    gameId: data.gameId,
    playerId: data.playerId,
    serverUrl: client.getBaseUrl(),
  });

  printJson({
    ok: true,
    message: `对战已开始！你作为玩家 (player_1) VS CPU (${strategy})`,
    strategy,
    playerId: "player_1",
    cpuPlayer: "player_2",
    cpuStrategy: strategy,
    sessionId: data.sessionId,
    serverUrl: client.getBaseUrl(),
    instructions: [
      "查看局势:   llmcraft state / units / enemies",
      "经济循环:   llmcraft units --type worker --idle | llmcraft nearest resource | llmcraft gather",
      "建造兵营:   llmcraft build barracks --unit worker_1 --at 6,8",
      "训练士兵:   llmcraft train soldier --building barracks_1",
      "攻击:       llmcraft units --type soldier | llmcraft target enemy-hq | llmcraft attack",
      "等待:       llmcraft wait --ticks 10",
    ],
  });
}
