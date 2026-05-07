import { describe, expect, it, vi, afterEach } from "vitest";
import { AgentRunInput } from "@llmcraft/shared";
import { LLMProvider, RunAgentResult } from "../LLMProvider";
import { RateLimitedLLMProvider } from "../RateLimitedLLMProvider";

function createInput(): AgentRunInput {
  return {
    playerId: "player_1",
    tick: 0,
    tickIntervalMs: 500,
    summary: "",
  };
}

function createResult(): RunAgentResult {
  return {
    assistantMessages: [],
    toolCalls: [],
    plans: [],
    stopReason: "done",
    metrics: {
      modelRequests: 1,
      toolCalls: 0,
      stallDetected: false,
    },
  };
}

function createProvider(runAgent: LLMProvider["runAgent"]): LLMProvider {
  return {
    runAgent,
    testConnection: vi.fn(async () => ({ responseText: "OK" })),
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

    await wrapped.runAgent(createInput(), { tools: [], executeTool: async () => ({ effect: "read", result: {} }), getRuntimeState: () => ({ mapState: null, myState: null, myUnits: null, activePlans: null, recentEvents: null }) });
    await wrapped.runAgent(createInput(), { tools: [], executeTool: async () => ({ effect: "read", result: {} }), getRuntimeState: () => ({ mapState: null, myState: null, myUnits: null, activePlans: null, recentEvents: null }) });

    expect(provider.runAgent).toHaveBeenCalledTimes(2);
  });

  it("enforces a minimum spacing between requests", async () => {
    vi.useFakeTimers();

    const provider = createProvider(vi.fn(async () => createResult()));
    const wrapped = new RateLimitedLLMProvider(provider, 60);
    const options = { tools: [], executeTool: async () => ({ effect: "read" as const, result: {} }), getRuntimeState: () => ({ mapState: null, myState: null, myUnits: null, activePlans: null, recentEvents: null }) };

    await wrapped.runAgent(createInput(), options);

    const secondRequest = wrapped.runAgent(createInput(), options);
    await vi.advanceTimersByTimeAsync(999);
    expect(provider.runAgent).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await secondRequest;

    expect(provider.runAgent).toHaveBeenCalledTimes(2);
  });

  it("returns early without calling the inner provider when aborted during rate-limit wait", async () => {
    vi.useFakeTimers();

    const provider = createProvider(vi.fn(async () => createResult()));
    const wrapped = new RateLimitedLLMProvider(provider, 60);
    const options = { tools: [], executeTool: async () => ({ effect: "read" as const, result: {} }), getRuntimeState: () => ({ mapState: null, myState: null, myUnits: null, activePlans: null, recentEvents: null }) };

    await wrapped.runAgent(createInput(), options);

    const controller = new AbortController();
    const secondRequest = wrapped.runAgent(createInput(), {
      ...options,
      signal: controller.signal,
    });

    controller.abort();
    await vi.runOnlyPendingTimersAsync();
    const result = await secondRequest;

    expect(provider.runAgent).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("aborted");
  });
});
