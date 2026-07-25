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
