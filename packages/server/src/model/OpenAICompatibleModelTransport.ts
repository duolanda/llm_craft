import OpenAI from "openai";
import type { OpenAIProviderConfig } from "../LLMProvider";
import type {
  ModelCompletionRequest,
  ModelCompletionResult,
  ModelTransport,
  ModelTransportDescriptor,
} from "./ModelTransport";

const FORBIDDEN_EXTRA_REQUEST_PARAMS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "stream",
  "signal",
]);

export class OpenAICompatibleModelTransport implements ModelTransport {
  private client: OpenAI;
  private readonly descriptor: ModelTransportDescriptor;
  private readonly reasoningEffort?: OpenAIProviderConfig["reasoningEffort"];
  private readonly extraRequestParams?: Record<string, unknown> | null;

  constructor(config: OpenAIProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 0,
    });
    this.descriptor = {
      provider: "openai-compatible",
      model: config.model || "gpt-4o-mini",
      baseURL: config.baseURL,
    };
    this.reasoningEffort = config.reasoningEffort ?? null;
    this.extraRequestParams = config.extraRequestParams ?? null;
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResult> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const response = await this.client.chat.completions.create(
      {
        model: this.descriptor.model,
        messages: request.messages,
        ...(request.tools
          ? {
              tools: request.tools.map((tool) => ({
                type: "function" as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
              tool_choice: request.toolChoice ?? "auto",
            }
          : {}),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        ...this.buildOptionalRequestParams(),
      } as any,
      { signal: request.signal },
    );
    const choice = response.choices[0];
    const usage = response.usage;
    const promptDetails = usage && "prompt_tokens_details" in usage
      ? usage.prompt_tokens_details as { cached_tokens?: number | null } | undefined
      : undefined;
    const completionDetails = usage && "completion_tokens_details" in usage
      ? usage.completion_tokens_details as { reasoning_tokens?: number | null } | undefined
      : undefined;

    const completedAtMs = Date.now();
    return {
      message: choice?.message
        ? {
            role: choice.message.role,
            content: choice.message.content,
            tool_calls: choice.message.tool_calls?.map((toolCall) => ({
              id: toolCall.id,
              type: toolCall.type,
              function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments,
              },
            })),
          }
        : null,
      finishReason: choice?.finish_reason ? String(choice.finish_reason) : "model_stopped",
      requestId: response.id,
      responseModel: response.model,
      usage: {
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
        reasoningTokens: completionDetails?.reasoning_tokens ?? undefined,
        cachedInputTokens: promptDetails?.cached_tokens ?? undefined,
      },
      timing: {
        startedAt,
        completedAt: new Date(completedAtMs).toISOString(),
        latencyMs: completedAtMs - startedAtMs,
      },
    };
  }

  getDescriptor(): ModelTransportDescriptor {
    return { ...this.descriptor };
  }

  private buildOptionalRequestParams(): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    if (this.reasoningEffort) {
      params.reasoning_effort = this.reasoningEffort;
    }

    if (this.extraRequestParams) {
      for (const [key, value] of Object.entries(this.extraRequestParams)) {
        if (!FORBIDDEN_EXTRA_REQUEST_PARAMS.has(key)) {
          params[key] = value;
        }
      }
    }

    return params;
  }
}
