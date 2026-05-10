import { randomUUID } from "node:crypto";
import {
  ControlSession as ControlSessionInfo,
  ControlResponse,
  ControlError,
  CreateControlSessionRequest,
  PlayerId,
} from "@llmcraft/shared";
import { GameAgentBridge, ExecutedToolResult } from "./agent/GameAgentBridge";
import { executeAgentTool, AgentToolExecution } from "./agent/AgentTools";
import { Game } from "./Game";

export interface ControlSessionState {
  id: string;
  gameId: string;
  playerId: PlayerId;
  bridge: GameAgentBridge;
  createdAt: string;
  lastUsedAt: string;
}

export class ControlSessionManager {
  private sessions = new Map<string, ControlSessionState>();

  create(game: Game, gameId: string, playerId: PlayerId): ControlSessionState {
    const id = `cs_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const bridge = new GameAgentBridge(game, playerId);
    bridge.beginRun();
    const session: ControlSessionState = {
      id,
      gameId,
      playerId,
      bridge,
      createdAt: now,
      lastUsedAt: now,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(sessionId: string): ControlSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastUsedAt = new Date().toISOString();
    }
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export function executeControlTool(
  bridge: GameAgentBridge,
  toolName: string,
  args: Record<string, unknown>
): AgentToolExecution {
  bridge.beginRun();
  return executeAgentTool(bridge, toolName, args);
}

export function buildControlResponse(
  result: AgentToolExecution,
  overrideKind?: ControlResponse["kind"]
): ControlResponse {
  const data = result.result as Record<string, unknown>;
  const tick = (data.tick as number) ?? 0;

  if (data.ok === false) {
    const error: ControlError = {
      code: (data.error as string) ?? "unknown",
      message: (data.message as string) ?? "Unknown error",
      hint: data.hint as string | undefined,
    };
    return {
      ok: false,
      tick,
      kind: overrideKind ?? kindFromEffect(result.effect),
      data: {},
      error,
    };
  }

  const warnings = data.warning
    ? [
        {
          type: (data.warning as Record<string, unknown>).type as string ?? "unknown",
          message: (data.warning as Record<string, unknown>).message as string ?? "",
        },
      ]
    : undefined;

  return {
    ok: true,
    tick,
    kind: overrideKind ?? kindFromEffect(result.effect),
    data,
    ...(warnings ? { warnings } : {}),
  };
}

function kindFromEffect(effect: "read" | "action" | "plan"): ControlResponse["kind"] {
  switch (effect) {
    case "read":
      return "state";
    case "action":
      return "action_result";
    case "plan":
      return "plan_result";
  }
}
