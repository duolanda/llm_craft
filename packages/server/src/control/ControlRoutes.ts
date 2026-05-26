import http from "node:http";
import {
  ControlToolCallRequest,
  CreateControlSessionRequest,
  PLAYER_IDS,
} from "@llmcraft/shared";
import type { ServerState } from "../index";
import { buildControlResponse, executeControlTool } from "../ControlHandler";
import { getControlAgentToolNames, getControlReadToolNames } from "../agent/AgentTools";
import { ControlPlaneMatch } from "./ControlPlaneMatch";

const CONTROL_TOOL_NAMES = new Set(getControlAgentToolNames());
const CONTROL_READ_TOOL_NAMES = new Set(getControlReadToolNames());

interface ControlRouteHelpers {
  sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void;
  readJsonBody<T>(req: http.IncomingMessage): Promise<T>;
}

function releaseFinishedOrchestrator(state: ServerState): boolean {
  const currentOrchestrator = state.orchestrator;
  if (!currentOrchestrator) {
    return false;
  }

  const winner = currentOrchestrator.getGame().getState()?.winner;
  if (!winner) {
    return false;
  }

  currentOrchestrator.stop();
  state.orchestrator = null;
  state.pendingMatch = null;
  state.controlSessions.clear();
  return true;
}

function releaseFinishedControlMatch(state: ServerState): boolean {
  const currentMatch = state.controlMatch;
  if (!currentMatch || !currentMatch.isFinished()) {
    return false;
  }

  currentMatch.stop();
  state.controlMatch = null;
  state.controlSessions.clear();
  return true;
}

export async function handleControlHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  state: ServerState,
  helpers: ControlRouteHelpers,
): Promise<boolean> {
  const { sendJson, readJsonBody } = helpers;

  if (req.method === "POST" && url.pathname === "/api/control/start-game") {
    if (state.orchestrator && !releaseFinishedOrchestrator(state)) {
      sendJson(res, 409, { error: "已有活跃对局。请先结束当前对局。" });
      return true;
    }
    if (state.controlMatch && !releaseFinishedControlMatch(state)) {
      sendJson(res, 409, { error: "已有活跃对局。请先结束当前对局。" });
      return true;
    }

    let cpu: string | undefined;
    try {
      const body = await readJsonBody<{ cpu?: string }>(req);
      cpu = body.cpu;
    } catch {
      // no body / non-JSON body is fine
    }

    if (cpu !== undefined && cpu !== "random" && cpu !== "rush") {
      sendJson(res, 400, {
        ok: false,
        tick: 0,
        kind: "state",
        data: {},
        error: {
          code: "invalid_cpu_strategy",
          message: "cpu must be random or rush.",
        },
      });
      return true;
    }

    const controlMatch = new ControlPlaneMatch({ cpuStrategy: cpu });
    state.controlMatch = controlMatch;
    sendJson(res, 201, {
      ok: true,
      tick: 0,
      kind: "state",
      data: {
        status: "waiting_for_players",
        ...(cpu ? { cpu, cpuPlayer: "player_2" } : {}),
      },
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/control/sessions") {
    let body: CreateControlSessionRequest;
    try {
      body = await readJsonBody<CreateControlSessionRequest>(req);
    } catch {
      sendJson(res, 400, { error: "请求体 JSON 格式错误。" });
      return true;
    }
    if (!body.playerId || (body.playerId !== PLAYER_IDS.PLAYER_1 && body.playerId !== PLAYER_IDS.PLAYER_2)) {
      sendJson(res, 400, { error: "playerId 必须是 player_1 或 player_2。" });
      return true;
    }

    if (!state.controlMatch) {
      sendJson(res, 503, { error: "没有活跃对局。请先 POST /api/control/start-game。" });
      return true;
    }

    const game = state.controlMatch.getGame();
    const session = state.controlSessions.create(
      state.controlMatch.getBridge(body.playerId),
      body.gameId || "default",
      body.playerId,
    );
    const serverTick = game.getState()?.tick ?? 0;
    state.controlMatch.join(body.playerId);

    sendJson(res, 201, {
      ok: true,
      tick: serverTick,
      kind: "state",
      data: {
        sessionId: session.id,
        gameId: session.gameId,
        playerId: session.playerId,
        createdAt: session.createdAt,
      },
    });
    return true;
  }

  const controlSessionPrefix = "/api/control/sessions/";
  if (!url.pathname.startsWith(controlSessionPrefix)) {
    return false;
  }

  const sessionPath = url.pathname.slice(controlSessionPrefix.length);
  const sessionIdEnd = sessionPath.indexOf("/");
  const sessionId = sessionIdEnd >= 0 ? sessionPath.slice(0, sessionIdEnd) : sessionPath;
  const subPath = sessionIdEnd >= 0 ? sessionPath.slice(sessionIdEnd) : "";

  if (!sessionId) {
    sendJson(res, 400, { error: "缺少 session ID。" });
    return true;
  }

  const session = state.controlSessions.get(sessionId);
  if (!session) {
    sendJson(res, 404, { error: "控制会话不存在。" });
    return true;
  }

  state.controlSessions.touch(sessionId);
  if (!state.controlMatch) {
    sendJson(res, 503, { error: "没有活跃对局。请先 POST /api/control/start-game。" });
    return true;
  }
  const controlMatch = state.controlMatch;
  const game = controlMatch.getGame();

  if (req.method === "GET" && subPath === "/state") {
    const mapResult = session.bridge.getMapState({ includeCells: false, includeEmptyTiles: false });
    const myResult = session.bridge.getMyState();
    const gameState = game.getState();
    const lobby = controlMatch.getLobbyStatus();
    const response = buildControlResponse(mapResult, "state");
    response.data = {
      ...(response.data as Record<string, unknown>),
      player: (myResult.result as Record<string, unknown>),
      winner: gameState.winner,
      ...(lobby ? { status: lobby.status, ready: lobby.ready } : {}),
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && subPath.startsWith("/tools/")) {
    const toolName = subPath.slice("/tools/".length);
    if (!toolName) {
      sendJson(res, 400, { error: "缺少 tool name。" });
      return true;
    }

    if (!CONTROL_TOOL_NAMES.has(toolName)) {
      sendJson(res, 400, {
        ok: false,
        tick: game.getState().tick,
        kind: "action_result",
        data: {},
        error: { code: "unknown_tool", message: `Unknown tool: ${toolName}` },
      });
      return true;
    }

    const lobby = controlMatch.getLobbyStatus();
    if (lobby?.status === "waiting_for_players" && !CONTROL_READ_TOOL_NAMES.has(toolName)) {
      sendJson(res, 409, {
        ok: false,
        tick: game.getState().tick,
        kind: toolName === "orchestrate_plan" ? "plan_result" : "action_result",
        data: {
          status: lobby.status,
          ready: lobby.ready,
        },
        error: {
          code: "game_not_started",
          message: "Game has not started. Wait until both players have created control sessions.",
        },
      });
      return true;
    }

    try {
      const body = await readJsonBody<ControlToolCallRequest>(req);
      const args = body.args ?? {};
      const result = executeControlTool(session.bridge, toolName, args);
      const response = buildControlResponse(result);
      sendJson(res, 200, response);
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        tick: game.getState().tick,
        error: {
          code: "tool_execution_error",
          message: error instanceof Error ? error.message : "Tool execution failed",
        },
      });
    }
    return true;
  }

  sendJson(res, 404, { error: "未知的控制端点。" });
  return true;
}
