import { describe, expect, it, vi } from "vitest";
import { AgentRunInput } from "@llmcraft/shared";
import { OpenAICompatibleProvider } from "../OpenAICompatibleProvider";

function createInput(): AgentRunInput {
  return {
    playerId: "player_1",
    tick: 0,
    tickIntervalMs: 500,
    summary: "provider stall test",
  };
}

function createProviderWithResponses(responses: unknown[]) {
  const provider = new OpenAICompatibleProvider({
    providerType: "openai-compatible",
    apiKey: "test-key",
    baseURL: "https://example.test/v1",
    model: "test-model",
  });

  const create = vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("No more mocked responses");
    }
    return next;
  });

  (provider as any).client = {
    chat: {
      completions: {
        create,
      },
    },
  };

  return { provider, create };
}

describe("OpenAICompatibleProvider", () => {
  it("does not mark exactly ten consecutive read-only tool calls as stalled", async () => {
    const responses = Array.from({ length: 10 }, (_, index) => ({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [
              {
                id: `call_${index + 1}`,
                function: {
                  name: "get_map_state",
                  arguments: "{}",
                },
              },
            ],
          },
        },
      ],
    }));
    responses.push({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "done",
            tool_calls: [],
          },
        },
      ],
    });

    const { provider, create } = createProviderWithResponses(responses);
    const result = await provider.runAgent(createInput(), {
      tools: [],
      executeTool: async () => ({ effect: "read" as const, result: { ok: true } }),
      getRuntimeState: () => ({
        mapState: null,
        myState: null,
        myUnits: null,
        activePlans: null,
        recentEvents: null,
      }),
    });

    expect(result.stopReason).toBe("stop");
    expect(result.metrics.stallDetected).toBe(false);
    expect(result.toolCalls).toHaveLength(10);
    expect(create).toHaveBeenCalledTimes(11);
  });

  it("stops after more than ten consecutive read-only tool calls", async () => {
    const responses = Array.from({ length: 11 }, (_, index) => ({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [
              {
                id: `call_${index + 1}`,
                function: {
                  name: "get_map_state",
                  arguments: "{}",
                },
              },
            ],
          },
        },
      ],
    }));

    const { provider, create } = createProviderWithResponses(responses);
    const result = await provider.runAgent(createInput(), {
      tools: [],
      executeTool: async () => ({ effect: "read" as const, result: { ok: true } }),
      getRuntimeState: () => ({
        mapState: null,
        myState: null,
        myUnits: null,
        activePlans: null,
        recentEvents: null,
      }),
    });

    expect(result.stopReason).toBe("stall_detected");
    expect(result.metrics.stallDetected).toBe(true);
    expect(result.toolCalls).toHaveLength(11);
    expect(create).toHaveBeenCalledTimes(11);
  });

  it("injects an urgent HQ warning into the same long-running turn when danger appears", async () => {
    const responses = [
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  function: {
                    name: "get_map_state",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "switching to defense",
              tool_calls: [],
            },
          },
        ],
      },
    ];

    const { provider, create } = createProviderWithResponses(responses);
    let runtimeStateCall = 0;
    await provider.runAgent(createInput(), {
      tools: [],
      executeTool: async () => ({ effect: "read" as const, result: { ok: true } }),
      getRuntimeState: () => {
        runtimeStateCall++;
        if (runtimeStateCall === 1) {
          return {
            mapState: { units: [] },
            myState: { hq: { id: "hq_1", x: 2, y: 10, hp: 1000, maxHp: 1000 } },
            myUnits: null,
            activePlans: null,
            recentEvents: null,
          };
        }

        return {
          mapState: {
            units: [
              { relation: "enemy", type: "soldier", x: 3, y: 10, attackRange: 1 },
              { relation: "enemy", type: "soldier", x: 5, y: 10, attackRange: 1 },
            ],
          },
          myState: { hq: { id: "hq_1", x: 2, y: 10, hp: 320, maxHp: 1000 } },
          myUnits: null,
          activePlans: null,
          recentEvents: null,
        };
      },
    });

    expect(create).toHaveBeenCalledTimes(2);
    const createCalls = create.mock.calls as unknown as Array<Array<{ messages: Array<{ role: string; content: string }> }>>;
    const secondCall = createCalls[1];
    if (!secondCall?.[0]) {
      throw new Error("expected second OpenAI request");
    }
    const secondCallMessages = secondCall[0].messages;
    const injectedAlert = secondCallMessages.find((message: { role: string; content: string }) =>
      message.role === "user" && typeof message.content === "string" && message.content.includes("Alert: our HQ is under attack.")
    );

    expect(injectedAlert?.content).toBe("Alert: our HQ is under attack.");
  });

  it("does not inject the same urgent HQ warning repeatedly when the danger snapshot is unchanged", async () => {
    const responses = [
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  function: {
                    name: "get_map_state",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_2",
                  function: {
                    name: "get_my_state",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "defense acknowledged",
              tool_calls: [],
            },
          },
        ],
      },
    ];

    const { provider, create } = createProviderWithResponses(responses);
    const threatenedRuntimeState = {
      mapState: {
        units: [
          { relation: "enemy", type: "soldier", x: 3, y: 10, attackRange: 1 },
          { relation: "enemy", type: "soldier", x: 5, y: 10, attackRange: 1 },
        ],
      },
      myState: { hq: { id: "hq_1", x: 2, y: 10, hp: 320, maxHp: 1000 } },
      myUnits: null,
      activePlans: null,
      recentEvents: null,
    };

    await provider.runAgent(createInput(), {
      tools: [],
      executeTool: async () => ({ effect: "read" as const, result: { ok: true } }),
      getRuntimeState: () => threatenedRuntimeState,
    });

    expect(create).toHaveBeenCalledTimes(3);
    const createCalls = create.mock.calls as unknown as Array<Array<{ messages: Array<{ role: string; content: string }> }>>;
    const thirdCall = createCalls[2];
    if (!thirdCall?.[0]) {
      throw new Error("expected third OpenAI request");
    }
    const thirdCallMessages = thirdCall[0].messages;
    const alertCount = thirdCallMessages.filter((message: { role: string; content: string }) =>
      message.role === "user" && typeof message.content === "string" && message.content.includes("Alert: our HQ is under attack.")
    ).length;

    expect(alertCount).toBe(1);
  });

  it("does not inject the HQ alert when the HQ is only damaged but not currently being attacked", async () => {
    const responses = [
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "continue economy",
              tool_calls: [],
            },
          },
        ],
      },
    ];

    const { provider, create } = createProviderWithResponses(responses);
    await provider.runAgent(createInput(), {
      tools: [],
      executeTool: async () => ({ effect: "read" as const, result: { ok: true } }),
      getRuntimeState: () => ({
        mapState: {
          units: [
            { relation: "enemy", type: "soldier", x: 5, y: 10, attackRange: 1 },
          ],
        },
        myState: { hq: { id: "hq_1", x: 2, y: 10, hp: 320, maxHp: 1000 } },
        myUnits: null,
        activePlans: null,
        recentEvents: null,
      }),
    });

    const createCalls = create.mock.calls as unknown as Array<Array<{ messages: Array<{ role: string; content: string }> }>>;
    const firstCall = createCalls[0];
    if (!firstCall?.[0]) {
      throw new Error("expected first OpenAI request");
    }
    const alertCount = firstCall[0].messages.filter((message: { role: string; content: string }) =>
      message.role === "user" && typeof message.content === "string" && message.content.includes("Alert: our HQ is under attack.")
    ).length;

    expect(alertCount).toBe(0);
  });

  it("aborts the in-flight OpenAI request when the signal is cancelled", async () => {
    const provider = new OpenAICompatibleProvider({
      providerType: "openai-compatible",
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      model: "test-model",
    });
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const create = vi.fn((request: { signal?: AbortSignal }) => {
      receivedSignal = request.signal;
      return new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });

    (provider as any).client = {
      chat: {
        completions: {
          create,
        },
      },
    };

    const runPromise = provider.runAgent(createInput(), {
      tools: [],
      executeTool: async () => ({ effect: "read" as const, result: { ok: true } }),
      getRuntimeState: () => ({
        mapState: null,
        myState: null,
        myUnits: null,
        activePlans: null,
        recentEvents: null,
      }),
      signal: controller.signal,
    });

    controller.abort();
    const result = await runPromise;

    expect(create).toHaveBeenCalledTimes(1);
    expect(receivedSignal).toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(result.stopReason).toBe("aborted");
    expect(result.metrics.modelRequests).toBe(0);
  });
});
