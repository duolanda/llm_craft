import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput, OpenAICompatibleRuntimeConfig } from "@llmcraft/shared";
import type { RunAgentOptions } from "../LLMProvider";
import { OpenAIAgentSession } from "../OpenAICompatibleProvider";
import { ContextWindowLimiter } from "../agent/ContextWindowLimiter";
import type { ModelCompletionRequest, ModelCompletionResult, ModelTransport } from "../model/ModelTransport";
import { describePromptReflectionError, normalizeReflectedPrompt } from "../PromptReflection";

const config: OpenAICompatibleRuntimeConfig = {
  providerType: "openai-compatible",
  apiKey: "test-key",
  baseURL: "https://example.test/v1",
  model: "test-model",
};
const input: AgentRunInput = { playerId: "player_1", tick: 0, tickIntervalMs: 500, summary: "test match" };
const reflectionInput = { playerId: "player_1", winner: "player_2", finalTick: 120 } as const;
const tools = [{ name: "build_structure", description: "Build", parameters: { type: "object" } }];
const getRuntimeState = () => ({ mapState: null, myState: null, myUnits: null, activePlans: null, recentEvents: null });

function reply(content: string): ModelCompletionResult {
  return { message: { role: "assistant", content }, finishReason: "stop", usage: {} };
}

function reflectionReply(content: string): ModelCompletionResult {
  return reply(`# 稳健推进\n\n${content}`);
}

function toolReply(count: number): ModelCompletionResult {
  return {
    message: {
      role: "assistant",
      content: "test decision before tools",
      tool_calls: Array.from({ length: count }, (_, index) => ({
        id: `call-${index}`,
        function: { name: "build_structure", arguments: JSON.stringify({ index }) },
      })),
    },
    finishReason: "tool_calls",
    usage: {},
  };
}

function createSession(complete: ModelTransport["complete"], limiter = new ContextWindowLimiter()) {
  return new OpenAIAgentSession(config, {
    complete,
    getDescriptor: () => ({ provider: config.providerType, model: config.model, baseURL: config.baseURL }),
  }, { contextWindowLimiter: limiter });
}

describe("same-session prompt reflection", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("awaits an opt-in detached capture before sending the unchanged reflection request", async () => {
    const requests: ModelCompletionRequest[] = [];
    let captureFinished = false;
    let captured: Omit<ModelCompletionRequest, "signal"> | undefined;
    const session = createSession(async request => {
      if (requests.length > 0) expect(captureFinished).toBe(true);
      requests.push(structuredClone({ ...request, signal: undefined }));
      return requests.length === 1 ? reply("played") : reflectionReply("captured result");
    });
    await session.runAgent(input, { tools, getRuntimeState, executeTool: () => ({ effect: "read", result: {} }) });
    await session.reflectPrompt(reflectionInput, {
      signal: new AbortController().signal,
      onRequest: async request => {
        expect(request).not.toHaveProperty("signal");
        captured = structuredClone(request);
        request.messages.length = 0;
        request.tools![0]!.description = "capture consumer mutation";
        await Promise.resolve();
        captureFinished = true;
      },
    });
    expect(captured).toBeDefined();
    expect(requests[1]).toEqual({ ...captured, signal: undefined });
    expect(requests[1]?.tools).toEqual(tools);
  });

  it("leaves the session retryable without calling the model if capture fails", async () => {
    const requests: ModelCompletionRequest[] = [];
    const session = createSession(async request => {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      return requests.length === 1 ? reply("played") : reflectionReply("retry result");
    });
    await session.runAgent(input, { tools, getRuntimeState, executeTool: () => ({ effect: "read", result: {} }) });
    let captured: Omit<ModelCompletionRequest, "signal"> | undefined;
    await expect(session.reflectPrompt(reflectionInput, {
      onRequest: request => { captured = request; throw new Error("capture write failed"); },
    })).rejects.toThrow("capture write failed");
    expect(requests).toHaveLength(1);
    await session.reflectPrompt(reflectionInput);
    expect(requests[1]).toEqual({ ...captured, signal: undefined });
  });

  it("automatically retries a connection reset using the identical session prefix without repeating tools", async () => {
    vi.useFakeTimers();
    const requests: ModelCompletionRequest[] = [];
    const failure = new OpenAI.APIConnectionError({ cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    const complete = vi.fn(async (request: ModelCompletionRequest) => {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      if (requests.length === 1) return toolReply(1);
      if (requests.length === 2) return reply("played");
      if (requests.length === 3) throw failure;
      return reflectionReply("策略正文");
    });
    const session = createSession(complete);
    const executeTool = vi.fn(() => ({ effect: "action" as const, result: { ok: true, tick: 22 } }));
    await session.runAgent(input, { tools, getRuntimeState, executeTool });
    const onRetry = vi.fn();
    const onRequest = vi.fn();
    const reflection = session.reflectPrompt(reflectionInput, { onRetry, onRequest });
    await vi.runAllTimersAsync();
    await expect(reflection).resolves.toMatchObject({ content: "策略正文" });
    expect(requests[3]).toEqual(requests[2]);
    expect(requests[3]?.toolChoice).toBe("none");
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["backoff", "inflight"])("cancels reflection during %s without checkpointing a failed or late response", async (phase) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const requests: ModelCompletionRequest[] = [];
    let resolveLate!: (response: ModelCompletionResult) => void;
    const late = new Promise<ModelCompletionResult>((resolve) => { resolveLate = resolve; });
    const session = createSession(async (request) => {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      if (requests.length === 1) return reply("played");
      if (requests.length === 2) {
        if (phase === "backoff") throw new OpenAI.APIConnectionError({});
        return late; // Simulate a transport that ignores abort and eventually responds.
      }
      return reflectionReply("重试成功");
    });
    await session.runAgent(input, { tools, getRuntimeState, executeTool: () => ({ effect: "read", result: {} }) });
    const cancelled = expect(session.reflectPrompt(reflectionInput, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    resolveLate(reflectionReply("不应保存的迟到结果"));
    await cancelled;
    await vi.runAllTimersAsync();
    expect(requests).toHaveLength(2);
    await expect(session.reflectPrompt(reflectionInput)).resolves.toMatchObject({ content: "重试成功" });
    expect(requests[2]?.messages).toEqual(requests[1]?.messages);
    expect(requests[1]?.signal).toBe(controller.signal);
    expect(requests[2]?.signal).toBeUndefined();
  });

  it("keeps the playing prefix, tool schemas and early results beyond the old 12-call cutoff", async () => {
    const responses = [toolReply(14), reply("test final game response"), reflectionReply("本局经验")];
    const requests: ModelCompletionRequest[] = [];
    const complete = vi.fn(async (request: ModelCompletionRequest) => {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      return responses.shift()!;
    });
    const limiter = new ContextWindowLimiter();
    const limit = vi.spyOn(limiter, "limit");
    const session = createSession(complete, limiter);
    const earlyFailure = { ok: false, tick: 10, error: "invalid_build_position", hint: "occupied footprint" };
    const executeTool = vi.fn<Parameters<RunAgentOptions["executeTool"]>, ReturnType<RunAgentOptions["executeTool"]>>()
      .mockImplementation((_name, args) => ({
        effect: "action",
        result: (args as { index: number }).index === 0 ? earlyFailure : { ok: true, tick: 11 },
      }));
    await session.runAgent(input, { tools, getRuntimeState, executeTool });
    const limitCount = limit.mock.calls.length;

    await expect(session.reflectPrompt(reflectionInput)).resolves.toEqual({ title: "稳健推进", content: "本局经验", model: "test-model" });

    const gameRequest = requests[1]!;
    const reflectionRequest = requests[2]!;
    expect(reflectionRequest.messages.slice(0, gameRequest.messages.length)).toEqual(gameRequest.messages);
    expect(reflectionRequest.messages.at(-2)).toEqual(reply("test final game response").message);
    expect(reflectionRequest.messages.at(-1)).toMatchObject({ role: "user" });
    expect(reflectionRequest.messages).toContainEqual({
      role: "tool", name: "build_structure", tool_call_id: "call-0", content: JSON.stringify(earlyFailure),
    });
    expect(reflectionRequest.tools).toEqual(gameRequest.tools);
    expect(reflectionRequest.toolChoice).toBe("none");
    expect(executeTool).toHaveBeenCalledTimes(14);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(limit).toHaveBeenCalledTimes(limitCount);
  });

  it("continues after the final in-flight game request is aborted without reusing its aborted signal", async () => {
    const controller = new AbortController();
    const requests: ModelCompletionRequest[] = [];
    let notifyWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { notifyWaiting = resolve; });
    const complete = vi.fn(async (request: ModelCompletionRequest) => {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      if (requests.length === 1) return toolReply(1);
      if (requests.length === 2) {
        notifyWaiting();
        return await new Promise<ModelCompletionResult>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")), { once: true });
        });
      }
      return reflectionReply("复盘结果");
    });
    const session = createSession(complete);
    const run = session.runAgent(input, {
      tools, getRuntimeState, signal: controller.signal,
      executeTool: () => ({ effect: "action", result: { ok: true, tick: 115 } }),
    });
    await waiting;
    controller.abort();
    await expect(run).resolves.toMatchObject({ stopReason: "aborted" });

    await expect(session.reflectPrompt(reflectionInput)).resolves.toMatchObject({ content: "复盘结果" });

    expect(requests[2]?.signal).toBeUndefined();
    expect(requests[2]?.messages.slice(0, -1)).toEqual(requests[1]?.messages);
    expect(requests[2]?.messages).toContainEqual({
      role: "tool", name: "build_structure", tool_call_id: "call-0", content: JSON.stringify({ ok: true, tick: 115 }),
    });
  });

  it.each([
    { result: reply(""), error: "PROMPT_REFLECTION_EMPTY" },
    { result: toolReply(1), error: "PROMPT_REFLECTION_UNEXPECTED_TOOL_CALL" },
    { result: { ...reply("incomplete"), finishReason: "length" }, error: "PROMPT_REFLECTION_INCOMPLETE" },
    { result: reply("missing title"), error: "PROMPT_REFLECTION_INVALID_FORMAT" },
  ])("rejects $error without changing history or executing tools", async ({ result, error }) => {
    const responses = [reply("game response"), result, reflectionReply("重试结果")];
    const requests: ModelCompletionRequest[] = [];
    const session = createSession(async (request) => {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      return responses.shift()!;
    });
    const executeTool = vi.fn(() => ({ effect: "action" as const, result: { ok: true } }));
    await session.runAgent(input, { tools, getRuntimeState, executeTool });

    await expect(session.reflectPrompt(reflectionInput)).rejects.toThrow(error);
    await expect(session.reflectPrompt(reflectionInput)).resolves.toMatchObject({ content: "重试结果" });

    expect(requests[2]?.messages).toEqual(requests[1]?.messages);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("does not make a fresh model request when no playing session history exists", async () => {
    const complete = vi.fn(async () => reply("must not be used"));
    const session = createSession(complete);

    await expect(session.reflectPrompt(reflectionInput)).rejects.toThrow("PROMPT_REFLECTION_SESSION_UNAVAILABLE");
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    { result: { message: { role: "assistant", content: null }, finishReason: "length", usage: {} }, error: "MODEL_RESPONSE_TRUNCATED" },
    { result: reply(" \n "), error: "MODEL_RESPONSE_EMPTY" },
    { result: { ...reply("partial"), finishReason: "error" }, error: "MODEL_RESPONSE_FAILED" },
  ])("keeps the last valid tool checkpoint after $error and can still reflect", async ({ result, error }) => {
    const responses = [toolReply(1), result, reflectionReply("复盘结果")];
    const requests: ModelCompletionRequest[] = [];
    const session = createSession(async (request) => {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      return responses.shift()!;
    });
    await expect(session.runAgent(input, {
      tools, getRuntimeState, executeTool: () => ({ effect: "action", result: { ok: true } }),
    })).rejects.toThrow(error);

    await expect(session.reflectPrompt(reflectionInput)).resolves.toMatchObject({ content: "复盘结果" });

    expect(requests[2]?.messages.slice(0, -1)).toEqual(requests[1]?.messages);
  });

  it.each([false, true])("does not execute any truncated tool call (warmed=%s), but returns paired errors and continues", async (warmed) => {
    const truncated = toolReply(2);
    truncated.finishReason = "length";
    truncated.message!.tool_calls![1]!.function = { name: "spawn_agent", arguments: '{"objective":' };
    const responses = [truncated, reply("recovered"), reflectionReply("复盘结果")];
    const requests: ModelCompletionRequest[] = [];
    const session = createSession(async (request) => {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      return responses.shift()!;
    });
    const executeTool = vi.fn(() => ({ effect: "action" as const, result: { ok: true } }));
    const spawnSubAgent = vi.fn(() => ({ effect: "action" as const, result: { ok: true } }));
    const options = { tools, getRuntimeState, executeTool, spawnSubAgent };
    if (warmed) await session.warmupAgent(input, options);

    const result = await session.runAgent(input, options);

    expect(executeTool).not.toHaveBeenCalled();
    expect(spawnSubAgent).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("stop");
    expect(result.toolCalls).toHaveLength(2);
    for (const call of result.toolCalls) {
      expect(call).toMatchObject({ isError: true, result: { ok: false, error: "model_output_truncated" } });
      expect(requests[1]?.messages).toContainEqual({
        role: "tool", name: call.toolName, tool_call_id: call.toolCallId, content: JSON.stringify(call.result),
      });
    }
    await expect(session.reflectPrompt(reflectionInput)).resolves.toMatchObject({ content: "复盘结果" });
    expect(requests[2]?.messages.slice(0, -2)).toEqual(requests[1]?.messages);
  });

  it("rejects an empty warmup without poisoning the next decision", async () => {
    const requests: ModelCompletionRequest[] = [];
    const session = createSession(async (request) => {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      return requests.length === 1 ? reply("") : reply("recovered");
    });
    const options = { tools, getRuntimeState, executeTool: () => ({ effect: "action" as const, result: {} }) };
    await expect(session.warmupAgent(input, options)).rejects.toThrow("MODEL_RESPONSE_EMPTY");
    await expect(session.runAgent(input, options)).resolves.toMatchObject({ stopReason: "stop" });
    expect(requests[1]?.messages).toHaveLength(2);
  });

  it("returns a malformed-argument error without executing it or blocking a valid sibling call", async () => {
    const malformed = toolReply(2);
    malformed.message!.tool_calls![0]!.function.arguments = '{"index":';
    const responses = [malformed, reply("recovered")];
    const session = createSession(async () => responses.shift()!);
    const executeTool = vi.fn(() => ({ effect: "action" as const, result: { ok: true } }));

    const result = await session.runAgent(input, { tools, getRuntimeState, executeTool });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.toolCalls[0]).toMatchObject({ isError: true, result: { error: "invalid_tool_arguments" } });
    expect(result.toolCalls[1]).toMatchObject({ isError: false, args: { index: 1 } });
  });

  it("does not checkpoint or execute an assistant returned with an aborted finish reason", async () => {
    const aborted = { ...toolReply(1), finishReason: "aborted" };
    const responses = [aborted, reflectionReply("复盘结果")];
    const requests: ModelCompletionRequest[] = [];
    const session = createSession(async (request) => {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      return responses.shift()!;
    });
    const executeTool = vi.fn(() => ({ effect: "action" as const, result: {} }));
    await expect(session.runAgent(input, { tools, getRuntimeState, executeTool })).resolves.toMatchObject({ stopReason: "aborted" });
    await session.reflectPrompt(reflectionInput);
    expect(executeTool).not.toHaveBeenCalled();
    expect(requests[1]?.messages.slice(0, -1)).toEqual(requests[0]?.messages);
  });

  it("describes known reflection failures without exposing raw provider secrets", () => {
    const error = Object.assign(new Error("provider echoed secret-test-key"), {
      status: 400,
      param: "messages[5] assistant must provide content, reasoning_content or tool_calls",
      headers: { authorization: "Bearer secret-test-key" },
    });
    expect(describePromptReflectionError(error)).toContain("第 6 条空会话消息");
    expect(describePromptReflectionError(error)).toContain("HTTP 400");
    expect(describePromptReflectionError(error)).not.toContain("secret-test-key");
    error.param = "invalid secret-test-key";
    expect(describePromptReflectionError(error)).not.toContain("secret-test-key");
    expect(describePromptReflectionError(new Error("PROMPT_REFLECTION_INCOMPLETE"))).toContain("token 上限");
    expect(describePromptReflectionError(Object.assign(new Error("rate limit"), { status: 429 }))).toContain("429");
  });

  it("parses a short title separately from the complete strategy body", () => {
    expect(normalizeReflectedPrompt("```markdown\n# 稳健推进\n\n第一段\n\n## 后续计划\n第二段\n```"))
      .toEqual({ title: "稳健推进", content: "第一段\n\n## 后续计划\n第二段" });
    for (const invalid of ["只有正文", "# 只有标题", `# ${"长".repeat(25)}\n\n正文`, "#\n\n标题\n\n正文"]) {
      expect(() => normalizeReflectedPrompt(invalid)).toThrow("PROMPT_REFLECTION_INVALID_FORMAT");
    }
  });

  it("records the actual response model alongside the title, without another request", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(reply("played"))
      .mockResolvedValueOnce({ ...reflectionReply("策略正文"), responseModel: "actual-provider-model" });
    const session = createSession(complete);
    await session.runAgent(input, { tools, getRuntimeState, executeTool: () => ({ effect: "read", result: {} }) });
    await expect(session.reflectPrompt(reflectionInput)).resolves.toEqual({ title: "稳健推进", content: "策略正文", model: "actual-provider-model" });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
