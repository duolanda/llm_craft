import OpenAI from "openai";
import {
  AgentRunInput,
  AgentToolCallRecord,
} from "@llmcraft/shared";
import {
  AgentToolExecutionResult,
  LLMConnectionTestResult,
  LLMProvider,
  OpenAIProviderConfig,
  RunAgentOptions,
  RunAgentResult,
  RunSubAgentTaskInput,
  SubAgentParentContext,
  WarmupAgentResult,
} from "./LLMProvider";
import { SYSTEM_PROMPT } from "./SystemPrompt";
import { getHQUnderAttackAlertFromRuntimeState } from "./HQAlert";
import { runSubAgentTask } from "./agent/SubAgentRunner";

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2048;
const CONNECTION_TEST_MAX_TOKENS = 8;
const MAX_CONSECUTIVE_READ_ONLY_TOOL_CALLS = 10;
const ABORT_STOP_REASON = "aborted";
const FORBIDDEN_EXTRA_REQUEST_PARAMS = new Set(["model", "messages", "tools", "tool_choice", "stream", "signal"]);
const REPLACEABLE_READ_TOOL_NAMES = new Set([
  "get_map_state",
  "get_my_state",
  "get_my_units",
  "get_active_plans",
  "get_recent_events",
]);

interface PreparedTurn {
  input: AgentRunInput;
  assistantMessage: any;
  assistantText: string;
  finishReason: string;
}

export class OpenAICompatibleProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;
  private baseURL?: string;
  private reasoningEffort?: OpenAIProviderConfig["reasoningEffort"];
  private extraRequestParams?: Record<string, unknown> | null;
  private history: any[] = [];
  private preparedTurn: PreparedTurn | null = null;

  constructor(config: OpenAIProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model || "gpt-4o-mini";
    this.baseURL = config.baseURL;
    this.reasoningEffort = config.reasoningEffort ?? null;
    this.extraRequestParams = config.extraRequestParams ?? null;
  }

  async warmupAgent(input: AgentRunInput, options: RunAgentOptions): Promise<WarmupAgentResult> {
    if (options.signal?.aborted) {
      return this.createAbortedWarmupResult();
    }

    const messages: any[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...this.history,
      { role: "user", content: JSON.stringify(input, null, 2) },
    ];
    const persistentHistory = messages.slice(1);
    this.injectUrgentRuntimeAlert(messages, options.getRuntimeState(), null);

    try {
      const response = await this.createAgentCompletion(messages, options);
      const choice = response.choices[0];
      const assistantMessage = choice?.message;
      if (!assistantMessage) {
        this.history = persistentHistory;
        this.preparedTurn = null;
        return {
          assistantMessages: [],
          stopReason: "empty_response",
          hasPendingToolCalls: false,
          metrics: { modelRequests: 1 },
        };
      }

      messages.push(assistantMessage);
      persistentHistory.push(assistantMessage);
      this.history = persistentHistory;
      const assistantText = typeof assistantMessage.content === "string" ? assistantMessage.content : "";
      if (assistantText) {
        options.onAssistantMessage?.(assistantText);
      }
      const finishReason = choice?.finish_reason ? String(choice.finish_reason) : "model_stopped";
      this.preparedTurn = {
        input,
        assistantMessage,
        assistantText,
        finishReason,
      };

      return {
        assistantMessages: assistantText ? [assistantText] : [],
        stopReason: finishReason,
        hasPendingToolCalls: (assistantMessage.tool_calls ?? []).length > 0,
        metrics: { modelRequests: 1 },
      };
    } catch (error) {
      if (this.isAbortError(error, options.signal)) {
        return this.createAbortedWarmupResult();
      }
      throw error;
    }
  }

  async testConnection(signal?: AbortSignal): Promise<LLMConnectionTestResult> {
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [
          {
            role: "user",
            content: "Reply with exactly: OK",
          },
        ],
        temperature: 0,
        max_tokens: CONNECTION_TEST_MAX_TOKENS,
        ...this.buildOptionalRequestParams(),
      } as any,
      { signal },
    );
    const text = response.choices
      .map((choice) => typeof choice.message?.content === "string" ? choice.message.content : "")
      .join("\n")
      .trim();

    return {
      responseText: text,
    };
  }

  async runAgent(input: AgentRunInput, options: RunAgentOptions): Promise<RunAgentResult> {
    const preparedTurn = this.takePreparedTurn(input);
    const messages: any[] = preparedTurn
      ? [{ role: "system", content: SYSTEM_PROMPT }, ...this.history]
      : [
          { role: "system", content: SYSTEM_PROMPT },
          ...this.history,
          { role: "user", content: JSON.stringify(input, null, 2) },
        ];
    const persistentHistory = messages.slice(1);
    const assistantMessages: string[] = preparedTurn?.assistantText ? [preparedTurn.assistantText] : [];
    const toolCalls: AgentToolCallRecord[] = [];
    let modelRequests = 0;
    let consecutiveReadOnlyToolCalls = 0;
    let stopReason = "model_stopped";
    let lastRuntimeAlertSignature: string | null = null;
    let pendingAssistantMessage = preparedTurn?.assistantMessage ?? null;
    let pendingFinishReason = preparedTurn?.finishReason ?? null;

    while (true) {
      if (options.signal?.aborted) {
        stopReason = ABORT_STOP_REASON;
        break;
      }

      let assistantMessage: any;
      let finishReason: string | null;
      const shouldEmitAssistant = !pendingAssistantMessage;

      if (pendingAssistantMessage) {
        assistantMessage = pendingAssistantMessage;
        finishReason = pendingFinishReason;
        pendingAssistantMessage = null;
        pendingFinishReason = null;
      } else {
        this.injectSubAgentNotifications(messages, persistentHistory, options);
        lastRuntimeAlertSignature = this.injectUrgentRuntimeAlert(messages, options.getRuntimeState(), lastRuntimeAlertSignature);

        let response;
        try {
          response = await this.createAgentCompletion(messages, options);
        } catch (error) {
          if (this.isAbortError(error, options.signal)) {
            stopReason = ABORT_STOP_REASON;
            break;
          }
          throw error;
        }
        modelRequests++;

        const choice = response.choices[0];
        assistantMessage = choice?.message;
        if (!assistantMessage) {
          stopReason = "empty_response";
          break;
        }
        finishReason = choice?.finish_reason ? String(choice.finish_reason) : "model_stopped";

        messages.push(assistantMessage);
        persistentHistory.push(assistantMessage);
      }

      const assistantText = typeof assistantMessage.content === "string" ? assistantMessage.content : "";
      if (assistantText && shouldEmitAssistant) {
        assistantMessages.push(assistantText);
        options.onAssistantMessage?.(assistantText);
      }

      const requestedToolCalls = assistantMessage.tool_calls ?? [];
      if (requestedToolCalls.length === 0) {
        stopReason = finishReason ?? "model_stopped";
        break;
      }

      let shouldStopForStall = false;
      for (const toolCall of requestedToolCalls) {
        const args = this.parseToolArgs(toolCall.function.arguments);
        let execution: AgentToolExecutionResult;
        if (toolCall.function.name === "spawn_agent") {
          if (options.spawnSubAgent) {
            const parentContext: SubAgentParentContext = {
              playerId: input.playerId,
              input,
              messages: [...messages],
              runtimeState: options.getRuntimeState(),
              tools: options.tools,
              executeTool: options.executeTool,
            };
            execution = options.spawnSubAgent(args, parentContext);
          } else {
            execution = {
              effect: "read",
              result: { ok: false, error: "spawn_agent_unavailable" },
            };
          }
        } else {
          try {
            execution = await options.executeTool(toolCall.function.name, args);
          } catch (error) {
            execution = {
              effect: "read",
              result: { ok: false, error: error instanceof Error ? error.message : String(error) },
            };
          }
        }

        if (execution.effect === "read") {
          consecutiveReadOnlyToolCalls++;
          this.expireSupersededReadToolResults(messages, toolCall.id, toolCall.function.name, args);
        } else {
          consecutiveReadOnlyToolCalls = 0;
        }
        const toolCallRecord = {
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          args,
          result: execution.result,
          isError: execution.result instanceof Object && "ok" in (execution.result as Record<string, unknown>)
            ? (execution.result as Record<string, unknown>).ok === false
            : false,
        };
        toolCalls.push(toolCallRecord);
        options.onToolCall?.(toolCallRecord);

        const toolMessage = {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(execution.result),
          name: toolCall.function.name,
        };
        messages.push(toolMessage);
        persistentHistory.push(toolMessage);

        if (consecutiveReadOnlyToolCalls > MAX_CONSECUTIVE_READ_ONLY_TOOL_CALLS) {
          stopReason = "stall_detected";
          shouldStopForStall = true;
          break;
        }
      }

      if (shouldStopForStall) {
        break;
      }
    }

    this.history = persistentHistory;
    return {
      assistantMessages,
      toolCalls,
      plans: [],
      stopReason,
      metrics: {
        modelRequests,
        toolCalls: toolCalls.length,
        stallDetected: stopReason === "stall_detected",
      },
    };
  }

  async runSubAgentTask(input: RunSubAgentTaskInput): Promise<string> {
    return await runSubAgentTask({
      ...input,
      createCompletion: async (request, signal) =>
        await this.client.chat.completions.create(
          {
            model: this.model,
            messages: request.messages,
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: "auto",
            temperature: request.temperature,
            max_tokens: request.maxTokens,
            ...this.buildOptionalRequestParams(),
          } as any,
          { signal },
        ),
    });
  }

  getModel(): string {
    return this.model;
  }

  getBaseURL(): string | undefined {
    return this.baseURL;
  }

  private parseToolArgs(raw: string): unknown {
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
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

  private async createAgentCompletion(messages: any[], options: RunAgentOptions) {
    return await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        tools: options.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        tool_choice: "auto",
        temperature: DEFAULT_TEMPERATURE,
        max_tokens: DEFAULT_MAX_TOKENS,
        ...this.buildOptionalRequestParams(),
      } as any,
      { signal: options.signal },
    );
  }

  private takePreparedTurn(input: AgentRunInput): PreparedTurn | null {
    if (!this.preparedTurn || this.preparedTurn.input.playerId !== input.playerId) {
      return null;
    }

    const preparedTurn = this.preparedTurn;
    this.preparedTurn = null;
    return preparedTurn;
  }

  private injectSubAgentNotifications(messages: any[], persistentHistory: any[], options: RunAgentOptions): void {
    if (!options.drainSubAgentNotifications) {
      return;
    }
    const notifications = options.drainSubAgentNotifications();
    for (const notification of notifications) {
      const userMessage = { role: "user", content: notification };
      messages.push(userMessage);
      persistentHistory.push(userMessage);
    }
  }

  private injectUrgentRuntimeAlert(messages: any[], runtimeState: ReturnType<RunAgentOptions["getRuntimeState"]>, previousSignature: string | null): string | null {
    const alert = getHQUnderAttackAlertFromRuntimeState(runtimeState);
    if (!alert) {
      return null;
    }

    if (alert !== previousSignature) {
      messages.push({
        role: "user",
        content: alert,
      });
    }

    return alert;
  }

  private expireSupersededReadToolResults(messages: any[], currentToolCallId: string, toolName: string, args: unknown): void {
    if (!REPLACEABLE_READ_TOOL_NAMES.has(toolName)) {
      return;
    }

    const currentArgsKey = this.normalizeToolArgs(args);
    for (const message of messages) {
      if (
        message?.role !== "tool" ||
        message.tool_call_id === currentToolCallId ||
        message.name !== toolName ||
        this.isExpiredObservation(message)
      ) {
        continue;
      }

      const previousCall = this.findToolCall(messages, message.tool_call_id);
      if (!previousCall || previousCall.toolName !== toolName || previousCall.argsKey !== currentArgsKey) {
        continue;
      }

      const observedTick = this.getToolResultTick(message);
      message.content = JSON.stringify({
        expired: true,
        reason: "superseded_by_new_read",
        toolName,
        args: this.normalizeToolArgsForDisplay(args),
        observedTick,
        message: "This older read result was replaced by a newer read of the same tool and args. Do not rely on old positions, HP, resources, or unit states from it.",
      });
    }
  }

  private findToolCall(messages: any[], toolCallId: string | undefined): { toolName: string; argsKey: string } | null {
    if (!toolCallId) {
      return null;
    }

    for (const message of messages) {
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      for (const toolCall of toolCalls) {
        if (toolCall?.id !== toolCallId) {
          continue;
        }

        return {
          toolName: String(toolCall.function?.name ?? ""),
          argsKey: this.normalizeToolArgs(this.parseToolArgs(String(toolCall.function?.arguments ?? ""))),
        };
      }
    }

    return null;
  }

  private isExpiredObservation(message: any): boolean {
    if (typeof message?.content !== "string") {
      return false;
    }

    try {
      const parsed = JSON.parse(message.content);
      return parsed?.expired === true;
    } catch {
      return false;
    }
  }

  private getToolResultTick(message: any): number | null {
    if (typeof message?.content !== "string") {
      return null;
    }

    try {
      const parsed = JSON.parse(message.content);
      return typeof parsed?.tick === "number" ? parsed.tick : null;
    } catch {
      return null;
    }
  }

  private normalizeToolArgs(args: unknown): string {
    return JSON.stringify(this.normalizeValue(args ?? {}));
  }

  private normalizeToolArgsForDisplay(args: unknown): unknown {
    return this.normalizeValue(args ?? {});
  }

  private normalizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeValue(item));
    }

    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .reduce<Record<string, unknown>>((normalized, key) => {
          normalized[key] = this.normalizeValue(record[key]);
          return normalized;
        }, {});
    }

    return value;
  }

  private isAbortError(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) {
      return true;
    }
    if (error instanceof Error && error.name === "AbortError") {
      return true;
    }
    return Boolean(
      error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError"
    );
  }

  private createAbortedWarmupResult(): WarmupAgentResult {
    return {
      assistantMessages: [],
      stopReason: ABORT_STOP_REASON,
      hasPendingToolCalls: false,
      metrics: {
        modelRequests: 0,
      },
    };
  }
}
