import type {
  AgentRunInput,
  AgentToolCallRecord,
  BuiltinCPURuntimeConfig,
  PlayerId,
} from "@llmcraft/shared";
import type { WarmupAgentResult } from "../LLMProvider";
import { executeAgentTool } from "../agent/AgentTools";
import type { AgentRuntimeCallbacks, AgentRuntimeResult } from "../agent/AgentRuntime";
import type { GameplayController } from "./GameplayController";
import { runBuiltinCPUStrategy } from "../benchmark/BuiltinCPUStrategy";
import type { DecisionController, DecisionControllerDescriptor } from "./DecisionController";

/** Built-in CPU opponent used as a benchmark baseline. It is not a model session. */
export class BuiltinCPUController implements DecisionController {
  private readonly descriptor: DecisionControllerDescriptor;

  constructor(
    playerId: PlayerId,
    private readonly config: BuiltinCPURuntimeConfig,
    private readonly gameplayController: GameplayController,
  ) {
    this.descriptor = {
      controllerId: `cpu:${playerId}`,
      kind: "cpu",
      playerId,
      model: `builtin-cpu-${config.strategy}`,
    };
  }

  getDescriptor(): DecisionControllerDescriptor {
    return { ...this.descriptor };
  }

  async warmup(_input: AgentRunInput, _callbacks?: AgentRuntimeCallbacks, signal?: AbortSignal): Promise<WarmupAgentResult> {
    return {
      assistantMessages: [],
      stopReason: signal?.aborted ? "aborted" : "cpu_ready",
      hasPendingToolCalls: false,
      metrics: { modelRequests: 0 },
    };
  }

  async run(
    _input: AgentRunInput,
    callbacks?: AgentRuntimeCallbacks,
    signal?: AbortSignal,
  ): Promise<AgentRuntimeResult> {
    if (signal?.aborted) return this.emptyResult("aborted");
    this.gameplayController.beginRun({
      controllerId: this.descriptor.controllerId,
      source: "cpu",
      ...(callbacks?.runContext?.turnId ? { turnId: callbacks.runContext.turnId } : {}),
    });
    let toolCallIndex = 0;
    const toolCalls: AgentToolCallRecord[] = [];
    const callTool = async (toolName: string, args: Record<string, unknown>) => {
      const toolCallId = `cpu_tool_${++toolCallIndex}`;
      const startedAtMs = Date.now();
      this.gameplayController.setCommandProvenance({
        toolCallId,
        controllerId: this.descriptor.controllerId,
        turnId: callbacks?.runContext?.turnId,
        source: "macro_tool",
      });
      const execution = await executeAgentTool(this.gameplayController, toolName, args);
      const result = execution.result;
      const completedAtMs = Date.now();
      const record: AgentToolCallRecord = {
        toolCallId,
        toolName,
        args,
        result,
        isError: Boolean(result && typeof result === "object" && "ok" in result && result.ok === false),
        turnId: callbacks?.runContext?.turnId,
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
        mapState: this.gameplayController.getMapState({ trackRead: false }).result,
        myState: this.gameplayController.getMyState({ trackRead: false }).result,
        myUnits: this.gameplayController.getMyUnits({ trackRead: false }).result,
      },
      callTool,
    });

    return {
      assistantMessages: [],
      toolCalls,
      plans: this.gameplayController.takeRunPlans(),
      commands: this.gameplayController.takeIssuedCommands(),
      stopReason: "cpu_turn_complete",
      metrics: {
        modelRequests: 0,
        toolCalls: toolCalls.length,
        stallDetected: false,
      },
    };
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
