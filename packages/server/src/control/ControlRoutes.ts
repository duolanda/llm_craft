import http from "node:http";
import {
  ControlActionBatchRequest,
  ControlToolCallRequest,
  CreateControlSessionRequest,
  PLAYER_IDS,
} from "@llmcraft/shared";
import type { ServerState } from "../index";
import {
  buildControlResponse,
  executeControlActionBatch,
  executeControlTool,
} from "../ControlHandler";
import { getControlAgentToolNames, getControlReadToolNames } from "../agent/AgentTools";
import { ControlPlaneMatch } from "./ControlPlaneMatch";

const CONTROL_TOOL_NAMES = new Set(getControlAgentToolNames());
const CONTROL_READ_TOOL_NAMES = new Set(getControlReadToolNames());

interface ControlRouteHelpers {
  sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void;
  readJsonBody<T>(req: http.IncomingMessage): Promise<T>;
}

function getControlMatch(state: ServerState, matchId?: string): ControlPlaneMatch | null {
  const entry = matchId
    ? state.matchRegistry.get(matchId)
    : state.matchRegistry.getObserved();
  if (entry?.kind === "control" && entry.handle instanceof ControlPlaneMatch) {
    return entry.handle;
  }
  if (matchId) return null;
  for (const summary of state.matchRegistry.list()) {
    const candidate = state.matchRegistry.get(summary.matchId);
    if (candidate?.kind === "control" && candidate.handle instanceof ControlPlaneMatch) {
      return candidate.handle;
    }
  }
  return null;
}

function getActiveControlMatch(state: ServerState): ControlPlaneMatch | null {
  for (const summary of state.matchRegistry.list()) {
    if (summary.kind !== "control") continue;
    if (summary.status !== "waiting_for_players" && summary.status !== "running") continue;
    const entry = state.matchRegistry.get(summary.matchId);
    if (entry?.handle instanceof ControlPlaneMatch) return entry.handle;
  }
  return null;
}

export async function handleControlHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  state: ServerState,
  helpers: ControlRouteHelpers,
): Promise<boolean> {
  const { sendJson, readJsonBody } = helpers;

  if (req.method === "GET" && url.pathname === "/api/control/matches") {
    sendJson(res, 200, {
      matches: state.matchRegistry.list(),
      observedMatchId: state.matchRegistry.getObservedMatchId(),
    });
    return true;
  }

  const matchRoute = url.pathname.match(/^\/api\/control\/matches\/([^/]+)\/(observe|save-record|stop)$/);
  if (req.method === "POST" && matchRoute) {
    const matchId = decodeURIComponent(matchRoute[1]!);
    const action = matchRoute[2]!;
    const entry = state.matchRegistry.get(matchId);
    if (!entry) {
      sendJson(res, 404, { error: "指定对局不存在。" });
      return true;
    }
    if (action === "observe") {
      state.matchRegistry.observe(matchId);
      sendJson(res, 200, { ok: true, matchId });
      return true;
    }
    if (action === "save-record") {
      const filePath = await state.matchRegistry.save(matchId);
      sendJson(res, 200, { ok: true, matchId, filePath });
      return true;
    }
    const finalization = await state.matchRegistry.stopAndSave(matchId);
    sendJson(res, finalization.ok ? 200 : 500, finalization.ok
      ? { ok: true, matchId, filePath: finalization.filePath }
      : { ok: false, matchId, error: finalization.error });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/control/start-game") {
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

    const activeMatch = getActiveControlMatch(state);
    if (activeMatch) {
      state.matchRegistry.observe(activeMatch.getMatchId());
      const lobby = activeMatch.getLobbyStatus();
      sendJson(res, 200, {
        ok: true,
        tick: activeMatch.getGame().getTick(),
        kind: "state",
        data: {
          matchId: activeMatch.getMatchId(),
          status: lobby.status,
          reused: true,
          message: "An active control match already exists; no new match was created.",
        },
      });
      return true;
    }

    const controlMatch = new ControlPlaneMatch({ cpuStrategy: cpu });
    state.matchRegistry.register(controlMatch, { kind: "control", observe: true });
    sendJson(res, 201, {
      ok: true,
      tick: 0,
      kind: "state",
      data: {
        matchId: controlMatch.getMatchId(),
        status: "waiting_for_players",
        reused: false,
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

    const controlMatch = getControlMatch(state, body.gameId);
    if (!controlMatch) {
      sendJson(res, 503, { error: "没有活跃对局。请先 POST /api/control/start-game。" });
      return true;
    }

    const game = controlMatch.getGame();
    const session = state.controlSessions.create(
      controlMatch.getGameplayController(body.playerId),
      controlMatch.getMatchId(),
      body.playerId,
    );
    const serverTick = game.getState()?.tick ?? 0;
    controlMatch.join(body.playerId);

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
  const controlMatch = getControlMatch(state, session.gameId);
  if (!controlMatch) {
    sendJson(res, 410, { error: "控制会话所属对局已不存在。" });
    return true;
  }
  const game = controlMatch.getGame();

  if (req.method === "GET" && subPath === "/state") {
    const mapResult = session.gameplayController.getMapState({ includeCells: false, includeEmptyTiles: false });
    const myResult = session.gameplayController.getMyState();
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

  if (req.method === "POST" && subPath === "/save-record") {
    const filePath = await state.matchRegistry.save(session.gameId);
    sendJson(res, 200, {
      ok: true,
      tick: game.getState().tick,
      kind: "state",
      data: { matchId: session.gameId, filePath },
    });
    return true;
  }

  if (req.method === "POST" && subPath === "/actions") {
    const lobby = controlMatch.getLobbyStatus();
    if (lobby?.status === "waiting_for_players") {
      sendJson(res, 409, {
        ok: false,
        tick: game.getState().tick,
        kind: "batch_result",
        data: { status: lobby.status, ready: lobby.ready },
        error: {
          code: "game_not_started",
          message: "Game has not started. Wait until both players have created control sessions.",
        },
      });
      return true;
    }
    let body: ControlActionBatchRequest;
    try {
      body = await readJsonBody<ControlActionBatchRequest>(req);
    } catch {
      sendJson(res, 400, { error: "请求体 JSON 格式错误。" });
      return true;
    }
    if (
      typeof body.clientRequestId !== "string"
      || !body.clientRequestId.trim()
      || !Array.isArray(body.actions)
      || body.actions.length === 0
      || body.actions.some((action) => (
        !action
        || typeof action.tool !== "string"
        || !action.tool.trim()
        || (action.args !== undefined && (typeof action.args !== "object" || action.args === null || Array.isArray(action.args)))
      ))
    ) {
      sendJson(res, 400, {
        ok: false,
        tick: game.getState().tick,
        kind: "batch_result",
        data: {},
        error: {
          code: "invalid_action_batch",
          message: "clientRequestId and at least one well-formed action are required.",
        },
      });
      return true;
    }
    try {
      const response = executeControlActionBatch(session.controller, body, game.getState().tick);
      sendJson(res, 200, response);
    } catch (error) {
      sendJson(res, 409, {
        ok: false,
        tick: game.getState().tick,
        kind: "batch_result",
        data: { clientRequestId: body.clientRequestId },
        error: {
          code: "batch_submission_rejected",
          message: error instanceof Error ? error.message : "Batch submission failed.",
        },
      });
    }
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
      const result = executeControlTool(session.controller, toolName, args);
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
