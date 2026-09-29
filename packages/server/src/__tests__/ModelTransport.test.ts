import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelCompletionRequest,
  ModelCompletionResult,
  ModelTransport,
} from "../model/ModelTransport";
import { OpenAICompatibleModelTransport } from "../model/OpenAICompatibleModelTransport";
import { RateLimitedModelTransport } from "../model/RateLimitedModelTransport";

function createResult(content = "ok"): ModelCompletionResult {
  return {
    message: { role: "assistant", content, tool_calls: [] },
    finishReason: "stop",
    usage: {},
  };
}

function createRequest(signal?: AbortSignal): ModelCompletionRequest {
  return {
    messages: [{ role: "user", content: "hello" }],
    temperature: 0,
    maxTokens: 32,
    signal,
  };
}

describe("ModelTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes OpenAI-compatible responses and keeps provider parameters in transport", async () => {
    const transport = new OpenAICompatibleModelTransport({
      providerType: "openai-compatible",
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      model: "test-model",
      reasoningEffort: "medium",
      extraRequestParams: { thinking: { type: "enabled" } },
    });
    const create = vi.fn(async () => ({
      id: "request-1",
      model: "test-model-2026",
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "OK", tool_calls: [] },
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
        prompt_tokens_details: { cached_tokens: 7 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    }));
    (transport as any).client = { chat: { completions: { create } } };

    const result = await transport.complete(createRequest());

    expect(transport.getDescriptor()).toEqual({
      provider: "openai-compatible",
      model: "test-model",
      baseURL: "https://example.test/v1",
    });
    const createCalls = create.mock.calls as unknown as Array<Array<unknown>>;
    expect(createCalls[0]?.[0]).toMatchObject({
      model: "test-model",
      reasoning_effort: "medium",
      thinking: { type: "enabled" },
      max_tokens: 32,
    });
    expect(result).toMatchObject({
      requestId: "request-1",
      responseModel: "test-model-2026",
      finishReason: "stop",
      message: { content: "OK" },
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
        cachedInputTokens: 7,
        reasoningTokens: 3,
      },
    });
  });

  it("applies RPM to each completion inside the same session", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(async () => createResult());
    const inner: ModelTransport = {
      complete,
      getDescriptor: () => ({ provider: "fake", model: "fake-model" }),
    };
    const transport = new RateLimitedModelTransport(inner, 60);

    await transport.complete(createRequest());
    const second = transport.complete(createRequest());

    await vi.advanceTimersByTimeAsync(999);
    expect(complete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each([
    { baseURL: "https://opencode.ai/zen/go/v1/", field: "reasoning", replayField: "reasoning_content" },
    { baseURL: "https://example.test/v1", field: "reasoning", replayField: "reasoning" },
    { baseURL: "https://example.test/v1", field: "reasoning_content", replayField: "reasoning_content" },
    { baseURL: "https://example.test/v1", field: "reasoning_text", replayField: "reasoning_text" },
    { baseURL: "https://opencode.ai.example.test/zen/go/v1", field: "reasoning", replayField: "reasoning" },
  ])("round-trips $field at $baseURL without changing the session history", async ({ baseURL, field, replayField }) => {
    const transport = new OpenAICompatibleModelTransport({ providerType: "openai-compatible", apiKey: "test-key", model: "test-model", baseURL });
    const details = [{ type: "reasoning.encrypted", data: "opaque-test-data", signature: "opaque-signature" }];
    const message = {
      role: "assistant", content: null, [field]: "test reasoning", reasoning_details: details,
      tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
    };
    const create = vi.fn(async (_request: unknown) => ({
      choices: [{ finish_reason: "tool_calls", message }],
    }));
    Object.defineProperty(transport, "client", { value: { chat: { completions: { create } } } });

    const response = await transport.complete(createRequest());
    expect(response.message).toEqual(message);
    const messages = [response.message, { role: "tool", tool_call_id: "call-1", content: "result" }];
    const original = structuredClone(messages);
    await transport.complete({ ...createRequest(), messages });

    const sent = create.mock.calls[1]![0] as { messages: Array<Record<string, unknown>> };
    expect(sent.messages[0]).toMatchObject({ [replayField]: "test reasoning", reasoning_details: details });
    if (replayField !== field) expect(sent.messages[0]).not.toHaveProperty(field);
    expect(messages).toEqual(original);
  });

  it("filters empty assistant history at the request boundary without breaking tool pairs", async () => {
    const transport = new OpenAICompatibleModelTransport({ providerType: "openai-compatible", apiKey: "test-key", model: "test-model", baseURL: "https://example.test/v1" });
    const create = vi.fn(async (_request: unknown) => ({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
    }));
    Object.defineProperty(transport, "client", { value: { chat: { completions: { create } } } });
    const user = { role: "user", content: "test" };
    const declaration = {
      role: "assistant", content: null, reasoning_content: "test reasoning",
      tool_calls: [{ id: "call-1", function: { name: "read", arguments: "{}" } }],
    };
    const result = { role: "tool", tool_call_id: "call-1", content: "result" };
    const messages = [user, declaration, result,
      { role: "assistant", content: null },
      { role: "assistant", content: " \n ", tool_calls: [] },
      { role: "assistant", content: [], reasoning: "unfinished reasoning only" },
      { role: "assistant", content: [{ type: "text", text: "" }] },
      user,
    ];
    const original = structuredClone(messages);

    await transport.complete({ ...createRequest(), messages });

    expect((create.mock.calls[0]![0] as { messages: unknown[] }).messages).toEqual([user, declaration, result, user]);
    expect(messages).toEqual(original);
  });

  it("does not start a queued request after its signal is aborted", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(async () => createResult());
    const inner: ModelTransport = {
      complete,
      getDescriptor: () => ({ provider: "fake", model: "fake-model" }),
    };
    const transport = new RateLimitedModelTransport(inner, 60);
    await transport.complete(createRequest());

    const controller = new AbortController();
    const second = transport.complete(createRequest(controller.signal));
    controller.abort();

    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
