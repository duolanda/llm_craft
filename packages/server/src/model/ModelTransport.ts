export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelAssistantMessage {
  role?: string;
  content?: unknown;
  tool_calls?: ModelToolCall[];
  reasoning_content?: string | null;
  reasoning?: string | null;
  reasoning_text?: string | null;
  /** Provider-owned replay data; encrypted entries/signatures must remain opaque. */
  reasoning_details?: unknown[];
  refusal?: string | null;
}

export interface ModelCompletionRequest {
  messages: unknown[];
  tools?: ModelToolDefinition[];
  toolChoice?: "auto" | "none";
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ModelTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface ModelCompletionResult {
  message: ModelAssistantMessage | null;
  finishReason: string;
  requestId?: string;
  responseModel?: string;
  usage: ModelTokenUsage;
  timing?: {
    startedAt: string;
    completedAt: string;
    latencyMs: number;
  };
}

export interface ModelTransportDescriptor {
  provider: string;
  model: string;
  baseURL?: string;
}

/** Stateless model API boundary. Conversation history and tool loops live in AgentSession. */
export interface ModelTransport {
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResult>;
  getDescriptor(): ModelTransportDescriptor;
}
