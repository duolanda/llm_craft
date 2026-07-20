import {
  AgentRunInput,
  AgentModelRequestRecord,
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
import type { ModelTransport } from "./model/ModelTransport";
import { OpenAICompatibleModelTransport } from "./model/OpenAICompatibleModelTransport";
import { ContextWindowLimiter } from "./agent/ContextWindowLimiter";

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2048;
const CONNECTION_TEST_MAX_TOKENS = 8;
const MAX_CONSECUTIVE_READ_ONLY_TOOL_CALLS = 10;
const ABORT_STOP_REASON = "aborted";
const PROVIDER_SYNC_WARNING_MS = 100;
const PROVIDER_LARGE_PAYLOAD_WARNING_BYTES = 250_000;
const MODEL_REQUEST_MAX_ATTEMPTS = 3;
const REPLACEABLE_READ_TOOL_NAMES = new Set([
  "get_map_state",
  "get_my_state",
  "get_my_units",
  "get_active_plans",
  "get_recent_events",
]);

interface WarmedTurn {
  input: AgentRunInput;
  assistantMessage: any;
  assistantText: string;
  finishReason: string;
  modelRequestRecord: AgentModelRequestRecord;
}

export interface OpenAIAgentSessionOptions {
  systemPrompt?: string;
  contextWindowLimiter?: ContextWindowLimiter;
}

export class OpenAIAgentSession implements LLMProvider {
  private history: any[] = [];
  private warmedTurn: WarmedTurn | null = null;
  private readonly systemPrompt: string;
  private readonly contextWindowLimiter: ContextWindowLimiter;

  constructor(
    config: OpenAIProviderConfig,
    private readonly transport: ModelTransport = new OpenAICompatibleModelTransport(config),
    options: OpenAIAgentSessionOptions = {},
  ) {
    this.systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
    this.contextWindowLimiter = options.contextWindowLimiter ?? new ContextWindowLimiter();
  }

  async warmupAgent(input: AgentRunInput, options: RunAgentOptions): Promise<WarmupAgentResult> {
    if (options.signal?.aborted) {
      return this.createAbortedWarmupResult();
    }

    const messages: any[] = [
      { role: "system", content: this.systemPrompt },
      ...this.history,
      { role: "user", content: JSON.stringify(input, null, 2) },
    ];
    const persistentHistory = messages.slice(1);
    const modelRequestRecords: AgentModelRequestRecord[] = [];
    this.injectUrgentRuntimeAlert(messages, options.getRuntimeState(), null);

    try {
      const response = await this.createAgentCompletion(messages, options, modelRequestRecords, "warmup");
      const assistantMessage = response.message;
      if (!assistantMessage) {
        const contextWindow = this.limitContextWindow(persistentHistory);
        this.warmedTurn = null;
        return {
          assistantMessages: [],
          stopReason: "empty_response",
          hasPendingToolCalls: false,
          metrics: { modelRequests: 1, modelRequestRecords, contextWindow },
        };
      }

      messages.push(assistantMessage);
      persistentHistory.push(assistantMessage);
      const contextWindow = this.limitContextWindow(persistentHistory);
      const assistantText = typeof assistantMessage.content === "string" ? assistantMessage.content : "";
      if (assistantText) {
        options.onAssistantMessage?.(assistantText);
      }
      const finishReason = response.finishReason;
      this.warmedTurn = {
        input,
        assistantMessage,
        assistantText,
        finishReason,
        modelRequestRecord: modelRequestRecords[0]!,
      };

      return {
        assistantMessages: assistantText ? [assistantText] : [],
        stopReason: finishReason,
        hasPendingToolCalls: (assistantMessage.tool_calls ?? []).length > 0,
        metrics: { modelRequests: 1, modelRequestRecords, contextWindow },
      };
    } catch (error) {
      if (this.isAbortError(error, options.signal)) {
        return this.createAbortedWarmupResult();
      }
      throw error;
    }
  }

  async testConnection(signal?: AbortSignal): Promise<LLMConnectionTestResult> {
    const response = await this.transport.complete({
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      temperature: 0,
      maxTokens: CONNECTION_TEST_MAX_TOKENS,
      signal,
    });
    const text = typeof response.message?.content === "string"
      ? response.message.content.trim()
      : "";

    return {
      responseText: text,
    };
  }

  async runAgent(input: AgentRunInput, options: RunAgentOptions): Promise<RunAgentResult> {
    const warmedTurn = this.takeWarmedTurn(input);
    const inputStringifyStartedAt = Date.now();
    const inputContent = warmedTurn ? null : JSON.stringify(input);
    this.maybeEmitProviderWarning(options, "input_stringify", Date.now() - inputStringifyStartedAt, {
      bytes: inputContent ? Buffer.byteLength(inputContent, "utf8") : 0,
      details: {
        warmedTurn: Boolean(warmedTurn),
      },
    });
    const messages: any[] = warmedTurn
      ? [{ role: "system", content: this.systemPrompt }, ...this.history]
      : [
          { role: "system", content: this.systemPrompt },
          ...this.history,
          { role: "user", content: inputContent },
        ];
    const persistentHistory = messages.slice(1);
    const assistantMessages: string[] = warmedTurn?.assistantText ? [warmedTurn.assistantText] : [];
    const toolCalls: AgentToolCallRecord[] = [];
    const modelRequestRecords: AgentModelRequestRecord[] = warmedTurn
      ? [warmedTurn.modelRequestRecord]
      : [];
    let consecutiveReadOnlyToolCalls = 0;
    let stopReason = "model_stopped";
    let lastRuntimeAlertSignature: string | null = null;
    let latestObservationTick = input.tick;
    let pendingAssistantMessage = warmedTurn?.assistantMessage ?? null;
    let pendingFinishReason = warmedTurn?.finishReason ?? null;

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
        const runtimeStateStartedAt = Date.now();
        const runtimeState = options.getRuntimeState();
        this.maybeEmitProviderWarning(options, "get_runtime_state", Date.now() - runtimeStateStartedAt, {
          details: {
            messages: messages.length,
          },
        });
        const urgentAlertStartedAt = Date.now();
        lastRuntimeAlertSignature = this.injectUrgentRuntimeAlert(messages, runtimeState, lastRuntimeAlertSignature);
        this.maybeEmitProviderWarning(options, "inject_urgent_alert", Date.now() - urgentAlertStartedAt, {
          details: {
            messages: messages.length,
            hasAlert: Boolean(lastRuntimeAlertSignature),
          },
        });

        let response;
        try {
          const completionStartedAt = Date.now();
          response = await this.createAgentCompletion(messages, options, modelRequestRecords, "turn");
          this.maybeEmitProviderWarning(options, "create_completion", Date.now() - completionStartedAt, {
            details: {
              messages: messages.length,
              modelRequests: modelRequestRecords.length,
            },
          });
        } catch (error) {
          if (this.isAbortError(error, options.signal)) {
            stopReason = ABORT_STOP_REASON;
            break;
          }
          throw error;
        }
        assistantMessage = response.message;
        if (!assistantMessage) {
          stopReason = "empty_response";
          break;
        }
        finishReason = response.finishReason;

        messages.push(assistantMessage);
        persistentHistory.push(assistantMessage);
      }

      const assistantText = typeof assistantMessage.content === "string" ? assistantMessage.content : "";
      if (assistantText && shouldEmitAssistant) {
        assistantMessages.push(assistantText);
        const assistantCallbackStartedAt = Date.now();
        options.onAssistantMessage?.(assistantText);
        this.maybeEmitProviderWarning(options, "assistant_callback", Date.now() - assistantCallbackStartedAt, {
          bytes: Buffer.byteLength(assistantText, "utf8"),
        });
      }

      const requestedToolCalls = assistantMessage.tool_calls ?? [];
      if (requestedToolCalls.length === 0) {
        stopReason = finishReason ?? "model_stopped";
        break;
      }

      let shouldStopForStall = false;
      for (let toolCallIndex = 0; toolCallIndex < requestedToolCalls.length; toolCallIndex++) {
        const toolCall = requestedToolCalls[toolCallIndex];
        const toolStartedAtMs = Date.now();
        const toolStartedAt = new Date(toolStartedAtMs).toISOString();
        const parseArgsStartedAt = Date.now();
        const args = this.parseToolArgs(toolCall.function.arguments);
        this.maybeEmitProviderWarning(options, "parse_tool_args", Date.now() - parseArgsStartedAt, {
          bytes: Buffer.byteLength(String(toolCall.function.arguments ?? ""), "utf8"),
          details: {
            toolName: toolCall.function.name,
          },
        });
        let execution: AgentToolExecutionResult;
        if (toolCall.function.name === "spawn_agent") {
          if (options.spawnSubAgent) {
            const spawnRuntimeStateStartedAt = Date.now();
            const runtimeState = options.getRuntimeState();
            this.maybeEmitProviderWarning(options, "spawn_get_runtime_state", Date.now() - spawnRuntimeStateStartedAt, {
              details: {
                messages: messages.length,
                toolName: toolCall.function.name,
              },
            });
            const parentContext: SubAgentParentContext = {
              playerId: input.playerId,
              controllerId: options.runContext?.controllerId,
              turnId: options.runContext?.turnId,
              input,
              messages: [...messages],
              runtimeState,
              tools: options.tools,
              executeTool: options.executeTool,
            };
            const spawnStartedAt = Date.now();
            execution = options.spawnSubAgent(args, parentContext);
            this.maybeEmitProviderWarning(options, "spawn_agent", Date.now() - spawnStartedAt, {
              details: {
                messages: messages.length,
              },
            });
          } else {
            execution = {
              effect: "read",
              result: { ok: false, error: "spawn_agent_unavailable" },
            };
          }
        } else {
          try {
            const executeToolStartedAt = Date.now();
            execution = await options.executeTool(toolCall.function.name, args, {
              toolCallId: toolCall.id,
              controllerId: options.runContext?.controllerId,
              parentControllerId: options.runContext?.parentControllerId,
              turnId: options.runContext?.turnId,
              source: "macro_tool",
            });
            this.maybeEmitProviderWarning(options, "execute_tool", Date.now() - executeToolStartedAt, {
              details: {
                toolName: toolCall.function.name,
                effect: execution.effect,
              },
            });
          } catch (error) {
            execution = {
              effect: "read",
              result: { ok: false, error: error instanceof Error ? error.message : String(error) },
            };
          }
        }

        if (execution.effect === "read") {
          consecutiveReadOnlyToolCalls++;
          const expireStartedAt = Date.now();
          this.expireSupersededReadToolResults(messages, toolCall.id, toolCall.function.name, args);
          this.maybeEmitProviderWarning(options, "expire_read_results", Date.now() - expireStartedAt, {
            details: {
              toolName: toolCall.function.name,
              messages: messages.length,
            },
          });
        } else {
          consecutiveReadOnlyToolCalls = 0;
        }
        const resultTick = this.extractResultTick(execution.result);
        const observationTick = latestObservationTick;
        if (execution.effect === "read" && resultTick !== undefined) {
          latestObservationTick = resultTick;
        }
        const toolCompletedAtMs = Date.now();
        const resultBytes = Buffer.byteLength(JSON.stringify(execution.result) ?? "null", "utf8");
        const toolCallRecord = {
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          args,
          result: execution.result,
          isError: execution.result instanceof Object && "ok" in (execution.result as Record<string, unknown>)
            ? (execution.result as Record<string, unknown>).ok === false
            : false,
          turnId: options.runContext?.turnId,
          controllerId: options.runContext?.controllerId,
          modelRequestIndex: modelRequestRecords.length,
          startedAt: toolStartedAt,
          completedAt: new Date(toolCompletedAtMs).toISOString(),
          durationMs: toolCompletedAtMs - toolStartedAtMs,
          observationTick,
          resultTick,
          resultBytes,
          commandIds: this.extractCommandIds(execution.result),
        };
        toolCalls.push(toolCallRecord);
        const toolCallbackStartedAt = Date.now();
        options.onToolCall?.(toolCallRecord);
        this.maybeEmitProviderWarning(options, "tool_callback", Date.now() - toolCallbackStartedAt, {
          details: {
            toolName: toolCall.function.name,
          },
        });

        const toolResultStringifyStartedAt = Date.now();
        const toolResultContent = JSON.stringify(execution.result);
        this.maybeEmitProviderWarning(options, "tool_result_stringify", Date.now() - toolResultStringifyStartedAt, {
          bytes: Buffer.byteLength(toolResultContent, "utf8"),
          details: {
            toolName: toolCall.function.name,
            effect: execution.effect,
          },
        });
        const toolMessage = {
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResultContent,
          name: toolCall.function.name,
        };
        messages.push(toolMessage);
        persistentHistory.push(toolMessage);

        if (consecutiveReadOnlyToolCalls > MAX_CONSECUTIVE_READ_ONLY_TOOL_CALLS) {
          stopReason = "stall_detected";
          shouldStopForStall = true;
          for (const skippedToolCall of requestedToolCalls.slice(toolCallIndex + 1)) {
            const skippedToolMessage = {
              role: "tool",
              tool_call_id: skippedToolCall.id,
              content: JSON.stringify({
                ok: false,
                error: "stall_detected",
                hint: "This tool call was not executed because the read-only tool loop exceeded its safety limit.",
              }),
              name: skippedToolCall.function.name,
            };
            messages.push(skippedToolMessage);
            persistentHistory.push(skippedToolMessage);
          }
          break;
        }
      }

      if (shouldStopForStall) {
        break;
      }
    }

    const contextWindow = this.limitContextWindow(persistentHistory);
    return {
      assistantMessages,
      toolCalls,
      plans: [],
      stopReason,
      metrics: {
        modelRequests: modelRequestRecords.length,
        toolCalls: toolCalls.length,
        stallDetected: stopReason === "stall_detected",
        modelRequestRecords,
        contextWindow,
      },
    };
  }

  async runSubAgentTask(input: RunSubAgentTaskInput): Promise<string> {
    return await runSubAgentTask({
      ...input,
      systemPrompt: this.systemPrompt,
      createCompletion: async (request, signal) =>
        await this.transport.complete({
          messages: request.messages,
          tools: request.tools,
          toolChoice: "auto",
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          signal,
        }),
    });
  }

  getModel(): string {
    return this.transport.getDescriptor().model;
  }

  getBaseURL(): string | undefined {
    return this.transport.getDescriptor().baseURL;
  }

  private parseToolArgs(raw: string): unknown {
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  private extractResultTick(result: unknown): number | undefined {
    if (!result || typeof result !== "object") return undefined;
    const tick = (result as { tick?: unknown }).tick;
    return typeof tick === "number" && Number.isFinite(tick) ? tick : undefined;
  }

  private extractCommandIds(result: unknown): string[] {
    if (!result || typeof result !== "object") return [];
    const record = result as Record<string, unknown>;
    const ids = new Set<string>();
    if (typeof record.commandId === "string") ids.add(record.commandId);
    if (Array.isArray(record.commandIds)) {
      for (const id of record.commandIds) if (typeof id === "string") ids.add(id);
    }
    if (Array.isArray(record.results)) {
      for (const nested of record.results) {
        for (const id of this.extractCommandIds(nested)) ids.add(id);
      }
    }
    return [...ids];
  }

  private limitContextWindow(history: readonly unknown[]) {
    const result = this.contextWindowLimiter.limit(history);
    this.history = result.history;
    return result.record;
  }

  private async createAgentCompletion(
    messages: any[],
    options: RunAgentOptions,
    records: AgentModelRequestRecord[],
    phase: AgentModelRequestRecord["phase"],
  ) {
    const messagesSnapshot = structuredClone(messages) as unknown[];
    const firstRequestIndex = records.length + 1;
    for (let attempt = 1; attempt <= MODEL_REQUEST_MAX_ATTEMPTS; attempt++) {
      const startedAtMs = Date.now();
      try {
        const result = await this.transport.complete({
          messages,
          tools: options.tools,
          toolChoice: "auto",
          temperature: DEFAULT_TEMPERATURE,
          maxTokens: DEFAULT_MAX_TOKENS,
          signal: options.signal,
        });
        const record: AgentModelRequestRecord = {
          requestIndex: records.length + 1,
          phase,
          requestId: result.requestId,
          model: result.responseModel ?? this.transport.getDescriptor().model,
          finishReason: result.finishReason,
          latencyMs: result.timing?.latencyMs ?? Date.now() - startedAtMs,
          messageCount: messages.length,
          toolCount: options.tools.length,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          reasoningTokens: result.usage.reasoningTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          status: "success",
          attempt,
          ...(attempt > 1 ? { retryOfRequestIndex: firstRequestIndex } : {}),
          messages: messagesSnapshot,
        };
        records.push(record);
        options.onModelRequest?.(record);
        return result;
      } catch (error) {
        const record: AgentModelRequestRecord = {
          requestIndex: records.length + 1,
          phase,
          model: this.transport.getDescriptor().model,
          finishReason: "request_error",
          latencyMs: Date.now() - startedAtMs,
          messageCount: messages.length,
          toolCount: options.tools.length,
          status: "error",
          attempt,
          ...(attempt > 1 ? { retryOfRequestIndex: firstRequestIndex } : {}),
          error: error instanceof Error ? error.message : String(error),
          messages: messagesSnapshot,
        };
        records.push(record);
        options.onModelRequest?.(record);
        if (this.isAbortError(error, options.signal) || attempt === MODEL_REQUEST_MAX_ATTEMPTS || !this.isRetryableModelError(error)) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
    throw new Error("Model request retry loop exhausted unexpectedly.");
  }

  private isRetryableModelError(error: unknown): boolean {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
    return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
  }

  private maybeEmitProviderWarning(
    options: RunAgentOptions,
    phase: string,
    elapsedMs: number,
    input?: {
      bytes?: number;
      details?: Record<string, unknown>;
    }
  ): void {
    const bytes = input?.bytes;
    if (elapsedMs <= PROVIDER_SYNC_WARNING_MS && (bytes ?? 0) <= PROVIDER_LARGE_PAYLOAD_WARNING_BYTES) {
      return;
    }

    options.onPerformanceWarning?.({
      phase,
      elapsedMs,
      bytes,
      details: input?.details,
    });
  }

  private takeWarmedTurn(input: AgentRunInput): WarmedTurn | null {
    if (!this.warmedTurn || this.warmedTurn.input.playerId !== input.playerId) {
      return null;
    }

    const warmedTurn = this.warmedTurn;
    this.warmedTurn = null;
    return warmedTurn;
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
        modelRequestRecords: [],
      },
    };
  }
}

/** @deprecated Prefer OpenAIAgentSession; retained for external imports during migration. */
export class OpenAICompatibleProvider extends OpenAIAgentSession {}
