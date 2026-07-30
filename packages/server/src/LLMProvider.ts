import {
  AgentPlanRecord,
  AgentModelRequestRecord,
  ContextWindowLimitRecord,
  AgentRunInput,
  AgentRunMetrics,
  AgentToolCallRecord,
} from "@llmcraft/shared";
import { MatchPlayerLLMConfig, OpenAICompatibleRuntimeConfig } from "@llmcraft/shared";

export type LLMProviderConfig = MatchPlayerLLMConfig;
export type OpenAIProviderConfig = OpenAICompatibleRuntimeConfig;

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolExecutionResult {
  effect: "read" | "action" | "plan";
  result: unknown;
}

export interface AgentToolExecutionContext {
  toolCallId: string;
  controllerId?: string;
  parentControllerId?: string;
  turnId?: string;
  source?: "macro_tool" | "subagent";
}

export interface AgentRuntimeState {
  mapState: unknown;
  myState: unknown;
  myUnits: unknown;
  activePlans: unknown;
  recentEvents: unknown;
}

export interface SubAgentParentContext {
  playerId: string;
  controllerId?: string;
  turnId?: string;
  input: AgentRunInput;
  messages: unknown[];
  runtimeState: AgentRuntimeState;
  tools: AgentToolDefinition[];
  executeTool: (name: string, args: unknown, context?: AgentToolExecutionContext) => Promise<AgentToolExecutionResult> | AgentToolExecutionResult;
}

export interface RunAgentOptions {
  tools: AgentToolDefinition[];
  executeTool: (name: string, args: unknown, context?: AgentToolExecutionContext) => Promise<AgentToolExecutionResult> | AgentToolExecutionResult;
  runContext?: {
    turnId: string;
    controllerId: string;
    parentControllerId?: string;
  };
  getRuntimeState: () => AgentRuntimeState;
  onAssistantMessage?: (message: string) => void;
  onToolCall?: (record: AgentToolCallRecord) => void;
  onModelRequest?: (record: AgentModelRequestRecord) => void;
  onPerformanceWarning?: (warning: {
    phase: string;
    elapsedMs?: number;
    bytes?: number;
    details?: Record<string, unknown>;
  }) => void;
  signal?: AbortSignal;
  spawnSubAgent?: (args: unknown, context: SubAgentParentContext) => AgentToolExecutionResult;
  drainSubAgentNotifications?: () => string[];
}

export interface RunAgentResult {
  assistantMessages: string[];
  toolCalls: AgentToolCallRecord[];
  plans: AgentPlanRecord[];
  stopReason: string;
  metrics: AgentRunMetrics;
}

export interface RunSubAgentTaskInput {
  taskId: string;
  description: string;
  objective: string;
  assignedUnits?: string[];
  assignedBuildings?: string[];
  constraints?: string;
  successCriteria?: string;
  parentContext: SubAgentParentContext;
  signal: AbortSignal;
}

export interface WarmupAgentResult {
  assistantMessages: string[];
  stopReason: string;
  hasPendingToolCalls: boolean;
  metrics: {
    modelRequests: number;
    modelRequestRecords?: AgentModelRequestRecord[];
    contextWindow?: ContextWindowLimitRecord;
  };
}

export interface LLMConnectionTestResult {
  responseText: string;
}

/** Stateful provider conversation and tool-loop boundary owned by one controller. */
export interface AgentSession {
  runAgent(input: AgentRunInput, options: RunAgentOptions): Promise<RunAgentResult>;
  runSubAgentTask(input: RunSubAgentTaskInput): Promise<string>;
  warmupAgent(input: AgentRunInput, options: RunAgentOptions): Promise<WarmupAgentResult>;
  getModel(): string;
  getBaseURL(): string | undefined;
}

/** Agent session surface used by the preset connection-test endpoint. */
export interface LLMProvider extends AgentSession {
  testConnection(signal?: AbortSignal): Promise<LLMConnectionTestResult>;
}
