import {
  AgentPlanRecord,
  AgentRunInput,
  AgentRunMetrics,
  AgentToolCallRecord,
  Command,
} from "@llmcraft/shared";
import { GameplayController } from "../controller/GameplayController";
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
  runContext?: RunAgentOptions["runContext"];
  onAssistantMessage?: (message: string) => void;
  onToolCall?: (record: AgentToolCallRecord) => void;
  onModelRequest?: RunAgentOptions["onModelRequest"];
  onPerformanceWarning?: RunAgentOptions["onPerformanceWarning"];
  spawnSubAgent?: RunAgentOptions["spawnSubAgent"];
  drainSubAgentNotifications?: RunAgentOptions["drainSubAgentNotifications"];
}

export class AgentRuntime {
  private readonly toolDefinitions: AgentToolDefinition[];

  constructor(private readonly session: AgentSession, private readonly gameplayController: GameplayController) {
    this.toolDefinitions = getAgentToolDefinitions();
  }

  async warmup(input: AgentRunInput, callbacks?: AgentRuntimeCallbacks, signal?: AbortSignal): Promise<WarmupAgentResult> {
    return await this.session.warmupAgent(input, {
      tools: this.toolDefinitions,
      executeTool: () => {
        throw new Error("Warmup must not execute tools before the game starts.");
      },
      getRuntimeState: () => ({
        mapState: this.gameplayController.getMapState({ trackRead: false }).result,
        myState: this.gameplayController.getMyState({ trackRead: false }).result,
        myUnits: this.gameplayController.getMyUnits({ trackRead: false }).result,
        activePlans: this.gameplayController.getActivePlansTool({ trackRead: false }).result,
        recentEvents: this.gameplayController.getRecentEvents({ trackRead: false }).result,
      }),
      onAssistantMessage: callbacks?.onAssistantMessage,
      onToolCall: callbacks?.onToolCall,
      onModelRequest: callbacks?.onModelRequest,
      onPerformanceWarning: callbacks?.onPerformanceWarning,
      runContext: callbacks?.runContext,
      signal,
    });
  }

  async run(input: AgentRunInput, callbacks?: AgentRuntimeCallbacks, signal?: AbortSignal): Promise<AgentRuntimeResult> {
    this.gameplayController.beginRun(callbacks?.runContext ? {
      controllerId: callbacks.runContext.controllerId,
      source: "macro_tool",
      turnId: callbacks.runContext.turnId,
      ...(callbacks.runContext.parentControllerId
        ? { parentControllerId: callbacks.runContext.parentControllerId }
        : {}),
    } : undefined);
    const result = await this.session.runAgent(input, {
      tools: this.toolDefinitions,
      executeTool: async (name, args, context) => {
        if (context) this.gameplayController.setCommandProvenance(context);
        return executeAgentTool(this.gameplayController, name, args);
      },
      getRuntimeState: () => ({
        mapState: this.gameplayController.getMapState({ trackRead: false }).result,
        myState: this.gameplayController.getMyState({ trackRead: false }).result,
        myUnits: this.gameplayController.getMyUnits({ trackRead: false }).result,
        activePlans: this.gameplayController.getActivePlansTool({ trackRead: false }).result,
        recentEvents: this.gameplayController.getRecentEvents({ trackRead: false }).result,
      }),
      onAssistantMessage: callbacks?.onAssistantMessage,
      onToolCall: callbacks?.onToolCall,
      onModelRequest: callbacks?.onModelRequest,
      onPerformanceWarning: callbacks?.onPerformanceWarning,
      spawnSubAgent: callbacks?.spawnSubAgent,
      drainSubAgentNotifications: callbacks?.drainSubAgentNotifications,
      runContext: callbacks?.runContext,
      signal,
    });

    return {
      ...result,
      plans: this.gameplayController.takeRunPlans(),
      commands: this.gameplayController.takeIssuedCommands(),
    };
  }

}
