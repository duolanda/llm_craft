import { describe, expect, it, vi, afterEach } from "vitest";
import { AIPromptPayload } from "@llmcraft/shared";
import { GenerateCodeResult, LLMProvider } from "../LLMProvider";
import { RateLimitedLLMProvider } from "../RateLimitedLLMProvider";

function createPayload(): AIPromptPayload {
  return {
    mode: "full",
    tick: 0,
    tickIntervalMs: 500,
    summary: "",
    state: null,
    delta: null,
  };
}

function createResult(): GenerateCodeResult {
  return {
    code: "return [];",
    requestMessages: [],
  };
}

function createProvider(generateCode: LLMProvider["generateCode"]): LLMProvider {
  return {
    shouldForceFullState: () => false,
    generateCode,
    getModel: () => "test-model",
    getBaseURL: () => "http://test.local",
  };
}

describe("RateLimitedLLMProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not delay requests when rpm is not configured", async () => {
    const provider = createProvider(vi.fn(async () => createResult()));
    const wrapped = new RateLimitedLLMProvider(provider, null);

    await wrapped.generateCode(createPayload());
    await wrapped.generateCode(createPayload());

    expect(provider.generateCode).toHaveBeenCalledTimes(2);
  });

  it("enforces a minimum spacing between requests", async () => {
    vi.useFakeTimers();

    const provider = createProvider(vi.fn(async () => createResult()));
    const wrapped = new RateLimitedLLMProvider(provider, 60);

    await wrapped.generateCode(createPayload());

    const secondRequest = wrapped.generateCode(createPayload());
    await vi.advanceTimersByTimeAsync(999);
    expect(provider.generateCode).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await secondRequest;

    expect(provider.generateCode).toHaveBeenCalledTimes(2);
  });
});
