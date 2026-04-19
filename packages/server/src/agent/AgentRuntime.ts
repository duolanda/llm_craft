import {
  AgentPlanRecord,
  AgentRunInput,
  AgentRunMetrics,
  AgentToolCallRecord,
  Command,
} from "@llmcraft/shared";
import { GameAgentBridge } from "./GameAgentBridge";
import { AgentToolDefinition, executeAgentTool, getAgentToolDefinitions } from "./AgentTools";
import { LLMProvider } from "../LLMProvider";

export interface AgentRuntimeResult {
  assistantMessages: string[];
  toolCalls: AgentToolCallRecord[];
  plans: AgentPlanRecord[];
  commands: Command[];
  stopReason: string;
  metrics: AgentRunMetrics;
}

export interface AgentRuntimeCallbacks {
  onAssistantMessage?: (message: string) => void;
  onToolCall?: (record: AgentToolCallRecord) => void;
}

export class AgentRuntime {
  private readonly toolDefinitions: AgentToolDefinition[];

  constructor(private readonly provider: LLMProvider, private readonly bridge: GameAgentBridge) {
    this.toolDefinitions = getAgentToolDefinitions();
  }

  async run(input: AgentRunInput, callbacks?: AgentRuntimeCallbacks, signal?: AbortSignal): Promise<AgentRuntimeResult> {
    this.bridge.beginRun();
    const result = await this.provider.runAgent(input, {
      tools: this.toolDefinitions,
      executeTool: async (name, args) => executeAgentTool(this.bridge, name, args),
      getRuntimeState: () => ({
        mapState: this.bridge.getMapState().result,
        myState: this.bridge.getMyState().result,
        myUnits: this.bridge.getMyUnits().result,
        activePlans: this.bridge.getActivePlansTool().result,
        recentEvents: this.bridge.getRecentEvents().result,
      }),
      onAssistantMessage: callbacks?.onAssistantMessage,
      onToolCall: callbacks?.onToolCall,
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
