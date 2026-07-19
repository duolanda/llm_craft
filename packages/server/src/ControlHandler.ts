import { randomUUID } from "node:crypto";
import {
  ControlActionBatchRequest,
  ControlResponse,
  ControlError,
  PlayerId,
} from "@llmcraft/shared";
import { GameAgentBridge } from "./agent/GameAgentBridge";
import { CLIControllerAdapter, ManualControllerAdapter } from "./controller/ManualControllerAdapter";
import {
  executeAgentTool,
  getControlActionToolNames,
  type AgentToolExecution,
} from "./agent/AgentTools";

const CONTROL_ACTION_TOOL_NAMES = new Set(getControlActionToolNames());

export interface ControlSessionState {
  id: string;
  gameId: string;
  playerId: PlayerId;
  bridge: GameAgentBridge;
  controller: CLIControllerAdapter;
  createdAt: string;
  lastUsedAt: string;
}

export class ControlSessionManager {
  private sessions = new Map<string, ControlSessionState>();

  create(bridge: GameAgentBridge, gameId: string, playerId: PlayerId): ControlSessionState {
    const id = `cs_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const session: ControlSessionState = {
      id,
      gameId,
      playerId,
      bridge,
      controller: new CLIControllerAdapter(playerId, bridge, id),
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

  clear(): void {
    this.sessions.clear();
  }
}

export function executeControlTool(
  target: GameAgentBridge | ManualControllerAdapter,
  toolName: string,
  args: Record<string, unknown>
): AgentToolExecution {
  const bridge = target instanceof ManualControllerAdapter ? target.bridge : target;
  if (target instanceof ManualControllerAdapter) target.beginExternalCall();
  else bridge.beginToolCall({ controllerId: "external:control", source: "external" });
  try {
    return executeAgentTool(bridge, toolName, args);
  } catch (error) {
    return {
      effect: "read",
      result: {
        ok: false,
        error: "tool_execution_error",
        message: error instanceof Error ? error.message : "Tool execution failed",
      },
    };
  }
}

export function executeControlActionBatch(
  target: GameAgentBridge | ManualControllerAdapter,
  request: ControlActionBatchRequest,
  tick: number,
): ControlResponse {
  const bridge = target instanceof ManualControllerAdapter ? target.bridge : target;
  if (target instanceof ManualControllerAdapter) target.beginExternalCall(request.clientRequestId);
  else bridge.beginToolCall({ controllerId: "external:control", source: "external", turnId: request.clientRequestId });
  const transaction = bridge.runCommandBatch({
    clientRequestId: request.clientRequestId,
    fingerprint: canonicalizeBatchActions(request.actions),
  }, () => {
    const results: ControlResponse[] = [];
    for (const action of request.actions) {
      if (!CONTROL_ACTION_TOOL_NAMES.has(action.tool)) {
        results.push({
          ok: false,
          tick,
          kind: "action_result",
          data: {},
          error: {
            code: "invalid_batch_tool",
            message: `Batch actions only support action tools; received ${action.tool}.`,
          },
        });
        return { commit: false, value: results };
      }
      let execution: AgentToolExecution;
      try {
        execution = executeAgentTool(bridge, action.tool, action.args ?? {});
      } catch (error) {
        results.push({
          ok: false,
          tick,
          kind: "action_result",
          data: {},
          error: {
            code: "tool_execution_error",
            message: error instanceof Error ? error.message : "Tool execution failed",
          },
        });
        return { commit: false, value: results };
      }
      const response = buildControlResponse(execution, "action_result");
      results.push(response);
      if (!response.ok) return { commit: false, value: results };
    }
    return { commit: true, value: results };
  });

  const failed = transaction.value.find((result) => !result.ok);
  return {
    ok: !failed,
    tick,
    kind: "batch_result",
    data: {
      clientRequestId: request.clientRequestId,
      duplicate: transaction.duplicate,
      results: transaction.value,
    },
    ...(failed ? { error: failed.error } : {}),
  };
}

function canonicalizeBatchActions(actions: ControlActionBatchRequest["actions"]): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  };
  return JSON.stringify(canonicalize(actions));
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
