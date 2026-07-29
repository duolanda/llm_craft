import { ControlClient } from "../client.js";
import { ExitCode, exit } from "../io/errors.js";
import { printJson } from "../io/json.js";

const VALID_STRATEGIES = ["random", "rush"];
const PVP_MODES = ["pvp", "agent", "agents", "human", "manual"];

export async function handlePlay(
  client: ControlClient,
  flags: Map<string, string>,
): Promise<void> {
  const mode = (flags.get("mode") || flags.get("type"))?.toLowerCase();
  const requestedOpponent = (flags.get("vs") || flags.get("cpu") || flags.get("strategy"))?.toLowerCase();
  const startPvp = (mode && PVP_MODES.includes(mode)) || requestedOpponent === "pvp";

  if (startPvp) {
    await startPvpGame(client);
    return;
  }

  const strategy = requestedOpponent || "random";

  if (!VALID_STRATEGIES.includes(strategy)) {
    exit(
      ExitCode.ArgError,
      `Unknown opponent: "${strategy}". Valid CPU strategies: ${VALID_STRATEGIES.join(", ")}. Use --mode pvp for two CLI agents.`,
    );
  }

  let startResult;
  try {
    startResult = await client.startGame(strategy);
  } catch (err) {
    exit(
      ExitCode.ConnectionFailure,
      `Failed to connect to server: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!startResult.ok) {
    exit(ExitCode.BackendFailure, getErrorMessage(startResult, "Failed to start game"));
  }
  const startData = startResult.data as {
    matchId?: string;
    reused?: boolean;
    status?: string;
    decisionIntervalTicks?: number;
  };
  if (startData.reused) {
    printJson({
      ok: true,
      reused: true,
      message: "已有 control 对局正在进行；未创建新对局或 control session。",
      matchId: startData.matchId,
      status: startData.status,
      decisionIntervalTicks: startData.decisionIntervalTicks,
      serverUrl: client.getBaseUrl(),
    });
    return;
  }

  let sessionResponse;
  try {
    sessionResponse = await client.createSession("player_1", startData.matchId);
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
    decisionIntervalTicks: startData.decisionIntervalTicks,
    sessionId: data.sessionId,
    serverUrl: client.getBaseUrl(),
    instructions: [
      "查看局势:   llmcraft state / units / enemies",
      "经济循环:   llmcraft units --type worker --idle | llmcraft nearest resource | llmcraft gather",
      "建造兵营:   llmcraft build barracks --unit worker_1 --at 6,8",
      "训练步兵:   llmcraft train rifleman --building barracks_1",
      "攻击:       llmcraft units --type rifleman | llmcraft target enemy-hq | llmcraft attack",
      "下一轮:     由外部 agent 或调度器决定何时重新读取 state",
    ],
  });
}

async function startPvpGame(client: ControlClient): Promise<void> {
  let startResult;
  try {
    startResult = await client.startGame();
  } catch (err) {
    exit(
      ExitCode.ConnectionFailure,
      `Failed to connect to server: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!startResult.ok) {
    exit(ExitCode.BackendFailure, getErrorMessage(startResult, "Failed to start game"));
  }
  const startData = startResult.data as { matchId?: string; reused?: boolean; status?: string };
  if (startData.reused) {
    printJson({
      ok: true,
      reused: true,
      message: "已有 control 对局正在进行；未创建新对局。",
      matchId: startData.matchId,
      status: startData.status,
      serverUrl: client.getBaseUrl(),
    });
    return;
  }

  printJson({
    ok: true,
    message: "PVP 对局已创建，等待 player_1 和 player_2 创建 control session。",
    mode: "pvp",
    serverUrl: client.getBaseUrl(),
    status: startData.status ?? "waiting_for_players",
    instructions: [
      "Agent 1: llmcraft session use --player player_1 --base-url " + client.getBaseUrl(),
      "Agent 2: llmcraft session use --player player_2 --base-url " + client.getBaseUrl(),
      "两个 agent 都加入后，游戏 tick 才会开始。",
      "双 agent 同机运行时，不要共享默认 session 文件；后续命令请显式传 --session <id> 或分别设置 LLMCRAFT_SESSION。",
    ],
  });
}

function getErrorMessage(response: unknown, fallback: string): string {
  const data = response as { error?: string | { message?: string } };
  if (typeof data.error === "string") {
    return data.error;
  }
  return data.error?.message ?? fallback;
}
