import {
  AgentPlanRecord,
  AgentModelRequestRecord,
  AgentMemoryPolicyRecord,
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
  traceContext?: {
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
    memory?: AgentMemoryPolicyRecord;
  };
}

export interface LLMConnectionTestResult {
  responseText: string;
}

/** Stateful conversation, memory and tool-loop boundary owned by one controller. */
export interface AgentSession {
  runAgent(input: AgentRunInput, options: RunAgentOptions): Promise<RunAgentResult>;
  runSubAgentTask(input: RunSubAgentTaskInput): Promise<string>;
  warmupAgent(input: AgentRunInput, options: RunAgentOptions): Promise<WarmupAgentResult>;
  getModel(): string;
  getBaseURL(): string | undefined;
}

/** Legacy compatibility surface for connection-test callers during P3A migration. */
export interface LLMProvider extends AgentSession {
  testConnection(signal?: AbortSignal): Promise<LLMConnectionTestResult>;
}
