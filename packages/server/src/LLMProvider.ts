import {
  AgentPlanRecord,
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

export interface AgentRuntimeState {
  mapState: unknown;
  myState: unknown;
  myUnits: unknown;
  activePlans: unknown;
  recentEvents: unknown;
}

export interface SubAgentParentContext {
  playerId: string;
  input: AgentRunInput;
  messages: unknown[];
  runtimeState: AgentRuntimeState;
  tools: AgentToolDefinition[];
  executeTool: (name: string, args: unknown) => Promise<AgentToolExecutionResult> | AgentToolExecutionResult;
}

export interface RunAgentOptions {
  tools: AgentToolDefinition[];
  executeTool: (name: string, args: unknown) => Promise<AgentToolExecutionResult> | AgentToolExecutionResult;
  getRuntimeState: () => AgentRuntimeState;
  onAssistantMessage?: (message: string) => void;
  onToolCall?: (record: AgentToolCallRecord) => void;
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
  };
}

export interface LLMConnectionTestResult {
  responseText: string;
}

export interface LLMProvider {
  runAgent(input: AgentRunInput, options: RunAgentOptions): Promise<RunAgentResult>;
  runSubAgentTask(input: RunSubAgentTaskInput): Promise<string>;
  warmupAgent(input: AgentRunInput, options: RunAgentOptions): Promise<WarmupAgentResult>;
  testConnection(signal?: AbortSignal): Promise<LLMConnectionTestResult>;
  getModel(): string;
  getBaseURL(): string | undefined;
}
