import {
  AgentPlanRecord,
  AgentRunInput,
  AgentRunMetrics,
  AgentToolCallRecord,
  Command,
} from "@llmcraft/shared";
import { GameAgentBridge } from "./GameAgentBridge";
import { AgentToolDefinition, executeAgentTool, getAgentToolDefinitions } from "./AgentTools";
import { AgentSession, RunAgentOptions, WarmupAgentResult } from "../LLMProvider";

export interface AgentRuntimeResult {
  assistantMessages: string[];
  toolCalls: AgentToolCallRecord[];
  plans: AgentPlanRecord[];
  commands: Command[];
  stopReason: string;
  metrics: AgentRunMetrics;
}

export interface AgentRuntimeCallbacks {
  traceContext?: RunAgentOptions["traceContext"];
  onAssistantMessage?: (message: string) => void;
  onToolCall?: (record: AgentToolCallRecord) => void;
  onModelRequest?: RunAgentOptions["onModelRequest"];
  onPerformanceWarning?: RunAgentOptions["onPerformanceWarning"];
  spawnSubAgent?: RunAgentOptions["spawnSubAgent"];
  drainSubAgentNotifications?: RunAgentOptions["drainSubAgentNotifications"];
}

export class AgentRuntime {
  private readonly toolDefinitions: AgentToolDefinition[];

  constructor(private readonly session: AgentSession, private readonly bridge: GameAgentBridge) {
    this.toolDefinitions = getAgentToolDefinitions();
  }

  async warmup(input: AgentRunInput, callbacks?: AgentRuntimeCallbacks, signal?: AbortSignal): Promise<WarmupAgentResult> {
    return await this.session.warmupAgent(input, {
      tools: this.toolDefinitions,
      executeTool: () => {
        throw new Error("Warmup must not execute tools before the game starts.");
      },
      getRuntimeState: () => ({
        mapState: this.bridge.getMapState({ trackRead: false }).result,
        myState: this.bridge.getMyState({ trackRead: false }).result,
        myUnits: this.bridge.getMyUnits({ trackRead: false }).result,
        activePlans: this.bridge.getActivePlansTool({ trackRead: false }).result,
        recentEvents: this.bridge.getRecentEvents({ trackRead: false }).result,
      }),
      onAssistantMessage: callbacks?.onAssistantMessage,
      onToolCall: callbacks?.onToolCall,
      onModelRequest: callbacks?.onModelRequest,
      onPerformanceWarning: callbacks?.onPerformanceWarning,
      traceContext: callbacks?.traceContext,
      signal,
    });
  }

  async run(input: AgentRunInput, callbacks?: AgentRuntimeCallbacks, signal?: AbortSignal): Promise<AgentRuntimeResult> {
    this.bridge.beginRun(callbacks?.traceContext ? {
      controllerId: callbacks.traceContext.controllerId,
      source: "macro_tool",
      turnId: callbacks.traceContext.turnId,
      ...(callbacks.traceContext.parentControllerId
        ? { parentControllerId: callbacks.traceContext.parentControllerId }
        : {}),
    } : undefined);
    const result = await this.session.runAgent(input, {
      tools: this.toolDefinitions,
      executeTool: async (name, args, context) => {
        if (context) this.bridge.setCommandProvenance(context);
        return executeAgentTool(this.bridge, name, args);
      },
      getRuntimeState: () => ({
        mapState: this.bridge.getMapState({ trackRead: false }).result,
        myState: this.bridge.getMyState({ trackRead: false }).result,
        myUnits: this.bridge.getMyUnits({ trackRead: false }).result,
        activePlans: this.bridge.getActivePlansTool({ trackRead: false }).result,
        recentEvents: this.bridge.getRecentEvents({ trackRead: false }).result,
      }),
      onAssistantMessage: callbacks?.onAssistantMessage,
      onToolCall: callbacks?.onToolCall,
      onModelRequest: callbacks?.onModelRequest,
      onPerformanceWarning: callbacks?.onPerformanceWarning,
      spawnSubAgent: callbacks?.spawnSubAgent,
      drainSubAgentNotifications: callbacks?.drainSubAgentNotifications,
      traceContext: callbacks?.traceContext,
      signal,
    });

    return {
      ...result,
      plans: this.bridge.takeRunPlans(),
      commands: this.bridge.takeIssuedCommands(),
    };
  }

  advancePlans(): Command[] {
    return this.bridge.advancePlans();
  }

  getActivePlans(): AgentPlanRecord[] {
    return this.bridge.getActivePlans();
  }
}
