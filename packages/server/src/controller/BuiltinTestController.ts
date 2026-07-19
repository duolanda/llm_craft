import type {
  AgentRunInput,
  AgentToolCallRecord,
  BuiltinCPURuntimeConfig,
  PlayerId,
} from "@llmcraft/shared";
import type { WarmupAgentResult } from "../LLMProvider";
import { executeAgentTool } from "../agent/AgentTools";
import type { AgentRuntimeCallbacks, AgentRuntimeResult } from "../agent/AgentRuntime";
import type { GameAgentBridge } from "../agent/GameAgentBridge";
import { runBuiltinCPUStrategy } from "../benchmark/BuiltinCPUStrategy";
import type { Controller, ControllerDescriptor } from "./Controller";

/** Deterministic rules smoke driver. This is intentionally not a model session. */
export class BuiltinTestController implements Controller {
  private readonly descriptor: ControllerDescriptor;

  constructor(
    playerId: PlayerId,
    private readonly config: BuiltinCPURuntimeConfig,
    private readonly bridge: GameAgentBridge,
  ) {
    this.descriptor = {
      controllerId: `test:${playerId}`,
      kind: "test",
      playerId,
      model: `test-${config.strategy}`,
    };
  }

  getDescriptor(): ControllerDescriptor {
    return { ...this.descriptor };
  }

  async warmup(_input: AgentRunInput, _callbacks?: AgentRuntimeCallbacks, signal?: AbortSignal): Promise<WarmupAgentResult> {
    return {
      assistantMessages: [],
      stopReason: signal?.aborted ? "aborted" : "test_driver_ready",
      hasPendingToolCalls: false,
      metrics: { modelRequests: 0 },
    };
  }

  async run(_input: AgentRunInput, callbacks?: AgentRuntimeCallbacks, signal?: AbortSignal): Promise<AgentRuntimeResult> {
    if (signal?.aborted) return this.emptyResult("aborted");
    this.bridge.beginRun({
      controllerId: this.descriptor.controllerId,
      source: "test",
      ...(callbacks?.traceContext?.turnId ? { turnId: callbacks.traceContext.turnId } : {}),
    });
    let toolCallIndex = 0;
    const toolCalls: AgentToolCallRecord[] = [];
    const callTool = async (toolName: string, args: Record<string, unknown>) => {
      const toolCallId = `test_tool_${++toolCallIndex}`;
      const startedAtMs = Date.now();
      this.bridge.setCommandProvenance({
        toolCallId,
        controllerId: this.descriptor.controllerId,
        turnId: callbacks?.traceContext?.turnId,
        source: "macro_tool",
      });
      const execution = await executeAgentTool(this.bridge, toolName, args);
      const result = execution.result;
      const completedAtMs = Date.now();
      const record: AgentToolCallRecord = {
        toolCallId,
        toolName,
        args,
        result,
        isError: Boolean(result && typeof result === "object" && "ok" in result && result.ok === false),
        turnId: callbacks?.traceContext?.turnId,
        controllerId: this.descriptor.controllerId,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
      };
      toolCalls.push(record);
      callbacks?.onToolCall?.(record);
      return result;
    };

    await runBuiltinCPUStrategy({
      strategy: this.config.strategy,
      runtime: {
        mapState: this.bridge.getMapState({ trackRead: false }).result,
        myState: this.bridge.getMyState({ trackRead: false }).result,
        myUnits: this.bridge.getMyUnits({ trackRead: false }).result,
      },
      callTool,
    });

    return {
      assistantMessages: [],
      toolCalls,
      plans: this.bridge.takeRunPlans(),
      commands: this.bridge.takeIssuedCommands(),
      stopReason: "test_driver_turn_complete",
      metrics: {
        modelRequests: 0,
        toolCalls: toolCalls.length,
        stallDetected: false,
      },
    };
  }

  advancePlans() {
    return this.bridge.advancePlans();
  }

  getActivePlans() {
    return this.bridge.getActivePlans();
  }

  private emptyResult(stopReason: string): AgentRuntimeResult {
    return {
      assistantMessages: [],
      toolCalls: [],
      plans: [],
      commands: [],
      stopReason,
      metrics: { modelRequests: 0, toolCalls: 0, stallDetected: false },
    };
  }
}
