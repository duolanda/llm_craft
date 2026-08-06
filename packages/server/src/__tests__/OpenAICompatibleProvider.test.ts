import { describe, expect, it, vi } from "vitest";
import { AgentRunInput, DEFAULT_MAP_LAYOUT } from "@llmcraft/shared";
import { OpenAICompatibleProvider } from "../OpenAICompatibleProvider";
import { ContextWindowLimiter } from "../agent/ContextWindowLimiter";

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

  const create = vi.fn(async (_request?: unknown) => {
    const next = responses.shift();
    if (!next) {
      throw new Error("No more mocked responses");
    }
    return next;
  });

  (provider as any).transport.client = {
    chat: {
      completions: {
        create,
      },
    },
  };

  return { provider, create };
}

describe("OpenAICompatibleProvider", () => {
  it("persists completed tool results before a later request failure so the next turn has no orphan tool calls", async () => {
    const provider = new OpenAICompatibleProvider({
      providerType: "openai-compatible",
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      model: "test-model",
    });
    const connectionError = new Error("Connection error");
    const create = vi.fn()
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "read first",
            tool_calls: [{ id: "call-1", function: { name: "get_my_state", arguments: "{}" } }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      })
      .mockRejectedValueOnce(connectionError)
      .mockRejectedValueOnce(connectionError)
      .mockRejectedValueOnce(connectionError)
      .mockResolvedValueOnce({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "recovered", tool_calls: [] } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    (provider as any).transport.client = { chat: { completions: { create } } };
    const options = {
      tools: [{ name: "get_my_state", description: "read", parameters: { type: "object" } }],
      executeTool: async () => ({ effect: "read" as const, result: { ok: true, tick: 42 } }),
      getRuntimeState: () => ({ mapState: null, myState: null, myUnits: null, activePlans: null, recentEvents: null }),
    };

    await provider.warmupAgent(createInput(), options);
    await expect(provider.runAgent(createInput(), options)).rejects.toThrow("Connection error");
    await expect(provider.runAgent({ ...createInput(), tick: 43 }, options)).resolves.toMatchObject({
      stopReason: "stop",
    });

    const recoveryRequest = (create.mock.calls[4]?.[0] as { messages?: Array<Record<string, any>> } | undefined)?.messages ?? [];
    const assistantIndex = recoveryRequest.findIndex((message) => (
      message.role === "assistant"
      && Array.isArray(message.tool_calls)
      && message.tool_calls.some((call: { id?: string }) => call.id === "call-1")
    ));
    const matchingToolIndex = recoveryRequest.findIndex((message) => message.role === "tool" && message.tool_call_id === "call-1");
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(matchingToolIndex).toBeGreaterThan(assistantIndex);
  });

  it("records explicit retries and the exact message snapshot for each model attempt", async () => {
    const provider = new OpenAICompatibleProvider({
      providerType: "openai-compatible",
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      model: "test-model",
    });
    const transient = Object.assign(new Error("temporarily unavailable"), { status: 503 });
    const create = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({
        id: "response-2",
        model: "test-model",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done", tool_calls: [] } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    (provider as any).transport.client = { chat: { completions: { create } } };

    const result = await provider.runAgent(createInput(), {
      tools: [],
      executeTool: async () => ({ effect: "read" as const, result: {} }),
      getRuntimeState: () => ({ mapState: null, myState: null, myUnits: null, activePlans: null, recentEvents: null }),
      runContext: { turnId: "turn-1", controllerId: "llm:player_1" },
    });

    expect(result.metrics.modelRequests).toBe(2);
    expect(result.metrics.modelRequestRecords).toEqual([
      expect.objectContaining({ requestIndex: 1, status: "error", attempt: 1, error: "temporarily unavailable" }),
      expect.objectContaining({ requestIndex: 2, status: "success", attempt: 2, retryOfRequestIndex: 1 }),
    ]);
    expect(result.metrics.modelRequestRecords?.[0].messages).toEqual(result.metrics.modelRequestRecords?.[1].messages);
  });

  it("keeps provider history within its explicit context-window limit", async () => {
    const provider = new OpenAICompatibleProvider(
      {
        providerType: "openai-compatible",
        apiKey: "test-key",
        baseURL: "https://example.test/v1",
        model: "test-model",
      },
      undefined,
      {
        contextWindowLimiter: new ContextWindowLimiter({
          maxMessages: 5,
          maxBytes: 4096,
          maxMessageBytes: 512,
        }),
      },
    );
    const create = vi.fn(async () => ({
      choices: [{
        finish_reason: "stop",
        message: { content: "done", tool_calls: [] },
      }],
    }));
    (provider as any).transport.client = { chat: { completions: { create } } };
    const options = {
      tools: [],
      executeTool: async () => ({ effect: "read" as const, result: {} }),
      getRuntimeState: () => ({
        mapState: null,
        myState: null,
        myUnits: null,
        activePlans: null,
        recentEvents: null,
      }),
    };

    let finalResult: Awaited<ReturnType<OpenAICompatibleProvider["runAgent"]>> | undefined;
    for (let tick = 0; tick < 4; tick += 1) {
      finalResult = await provider.runAgent({ ...createInput(), tick }, options);
    }

    expect(finalResult?.metrics.contextWindow).toMatchObject({
      maxMessages: 5,
      messagesAfter: 5,
    });
    expect(finalResult?.metrics.contextWindow?.droppedMessages).toBeGreaterThan(0);
    expect((provider as any).history).toHaveLength(5);
  });

  it("warms up the first real turn and defers tool execution until runAgent continues it", async () => {
    const { provider, create } = createProviderWithResponses([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "thinking",
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
              content: "done",
              tool_calls: [],
            },
          },
        ],
      },
    ]);
    const warmupExecuteTool = vi.fn(async () => ({ effect: "read" as const, result: { ok: true } }));
    const runExecuteTool = vi.fn(async () => ({ effect: "read" as const, result: { tick: 0, ok: true } }));
    const warmupAssistant = vi.fn();
    const runAssistant = vi.fn();

    const options = {
      tools: [
        {
          name: "get_map_state",
          description: "Read map",
          parameters: {},
        },
      ],
      getRuntimeState: () => ({
        mapState: null,
        myState: null,
        myUnits: null,
        activePlans: null,
        recentEvents: null,
      }),
    };
    const warmupResult = await provider.warmupAgent(createInput(), {
      ...options,
      executeTool: warmupExecuteTool,
      onAssistantMessage: warmupAssistant,
    });
    const runResult = await provider.runAgent(createInput(), {
      ...options,
      executeTool: runExecuteTool,
      onAssistantMessage: runAssistant,
    });

    expect(warmupResult.assistantMessages).toEqual(["thinking"]);
    expect(warmupResult.hasPendingToolCalls).toBe(true);
    expect(warmupExecuteTool).not.toHaveBeenCalled();
    expect(runExecuteTool).toHaveBeenCalledTimes(1);
    expect(runResult.assistantMessages).toEqual(["thinking", "done"]);
    expect(runResult.metrics.modelRequests).toBe(2);
    expect(runResult.metrics.modelRequestRecords?.map((record) => record.phase)).toEqual([
      "warmup",
      "turn",
    ]);
    expect(warmupAssistant).toHaveBeenCalledWith("thinking");
    expect(runAssistant).toHaveBeenCalledWith("done");
    expect(runAssistant).not.toHaveBeenCalledWith("thinking");

    const createCalls = create.mock.calls as unknown as Array<Array<unknown>>;
    const warmupRequest = createCalls[0]?.[0] as Record<string, unknown>;
    expect(warmupRequest.tools).toBeInstanceOf(Array);
    expect(JSON.stringify(warmupRequest.messages)).toContain("provider stall test");
    const continuationRequest = createCalls[1]?.[0] as { messages: Array<{ role: string; content: string }> };
    expect(JSON.stringify(continuationRequest.messages)).toContain("thinking");
    expect(JSON.stringify(continuationRequest.messages)).toContain("\"role\":\"tool\"");
    expect(JSON.stringify(continuationRequest.messages).match(/provider stall test/g)).toHaveLength(1);
  });

  it("adds generic reasoning effort and merges allowed extra request params", async () => {
    const provider = new OpenAICompatibleProvider({
      providerType: "openai-compatible",
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      model: "test-model",
      reasoningEffort: "medium",
      extraRequestParams: {
        reasoning_effort: "high",
        thinking: { type: "enabled" },
        max_tokens: 512,
        temperature: 0,
        model: "do-not-override",
        messages: [],
        tool_choice: "none",
      },
    });

    const create = vi.fn(async (_request: unknown) => ({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "done",
            tool_calls: [],
          },
        },
      ],
    }));

    (provider as any).transport.client = {
      chat: {
        completions: {
          create,
        },
      },
    };

    await provider.runAgent(createInput(), {
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

    const request = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.model).toBe("test-model");
    expect(request.messages).toBeInstanceOf(Array);
    expect(request.tool_choice).toBe("auto");
    expect(request.reasoning_effort).toBe("high");
    expect(request.thinking).toEqual({ type: "enabled" });
    expect(request.max_tokens).toBe(512);
    expect(request.temperature).toBe(0);
  });

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

  it("closes every tool call in a stalled multi-call assistant message before persisting history", async () => {
    const responses = [
      ...Array.from({ length: 10 }, (_, index) => ({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [{
              id: `call_${index + 1}`,
              function: { name: "get_map_state", arguments: "{}" },
            }],
          },
        }],
      })),
      {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [
              { id: "call_11", function: { name: "get_map_state", arguments: "{}" } },
              { id: "call_12", function: { name: "get_my_state", arguments: "{}" } },
            ],
          },
        }],
      },
      {
        choices: [{
          finish_reason: "stop",
          message: { content: "recovered", tool_calls: [] },
        }],
      },
    ];
    const { provider, create } = createProviderWithResponses(responses);
    const options = {
      tools: [],
      executeTool: async () => ({ effect: "read" as const, result: { ok: true } }),
      getRuntimeState: () => ({
        mapState: null,
        myState: null,
        myUnits: null,
        activePlans: null,
        recentEvents: null,
      }),
    };

    const stalled = await provider.runAgent(createInput(), options);
    expect(stalled.stopReason).toBe("stall_detected");
    expect(stalled.toolCalls).toHaveLength(11);

    const recovered = await provider.runAgent({ ...createInput(), tick: 5 }, options);
    expect(recovered.stopReason).toBe("stop");
    const recoveryRequest = create.mock.calls[11]?.[0] as {
      messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
    };
    const trailingToolMessages = recoveryRequest.messages.filter(
      (message) => message.role === "tool" && ["call_11", "call_12"].includes(message.tool_call_id ?? ""),
    );
    expect(trailingToolMessages.map((message) => message.tool_call_id)).toEqual(["call_11", "call_12"]);
    expect(trailingToolMessages[1]?.content).toContain("stall_detected");
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
            myState: { hq: { id: "hq_1", ...DEFAULT_MAP_LAYOUT.player1Hq, hp: 1000, maxHp: 1000 } },
            myUnits: null,
            activePlans: null,
            recentEvents: null,
          };
        }

        return {
          mapState: {
            units: [
              { relation: "enemy", type: "soldier", x: DEFAULT_MAP_LAYOUT.player1Hq.x + 1, y: DEFAULT_MAP_LAYOUT.player1Hq.y, attackRange: 1 },
              { relation: "enemy", type: "soldier", x: DEFAULT_MAP_LAYOUT.player1Hq.x + 3, y: DEFAULT_MAP_LAYOUT.player1Hq.y, attackRange: 1 },
            ],
          },
          myState: { hq: { id: "hq_1", ...DEFAULT_MAP_LAYOUT.player1Hq, hp: 320, maxHp: 1000 } },
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
          { relation: "enemy", type: "soldier", x: DEFAULT_MAP_LAYOUT.player1Hq.x + 1, y: DEFAULT_MAP_LAYOUT.player1Hq.y, attackRange: 1 },
          { relation: "enemy", type: "soldier", x: DEFAULT_MAP_LAYOUT.player1Hq.x + 3, y: DEFAULT_MAP_LAYOUT.player1Hq.y, attackRange: 1 },
        ],
      },
      myState: { hq: { id: "hq_1", ...DEFAULT_MAP_LAYOUT.player1Hq, hp: 320, maxHp: 1000 } },
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
            { relation: "enemy", type: "soldier", x: DEFAULT_MAP_LAYOUT.player1Hq.x + 3, y: DEFAULT_MAP_LAYOUT.player1Hq.y, attackRange: 1 },
          ],
        },
        myState: { hq: { id: "hq_1", ...DEFAULT_MAP_LAYOUT.player1Hq, hp: 320, maxHp: 1000 } },
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

  it("injects and deduplicates compact EVA completion, ready, and loss notices", async () => {
    const stopResponse = () => ({
      choices: [{ finish_reason: "stop", message: { content: "acknowledged", tool_calls: [] } }],
    });
    const { provider, create } = createProviderWithResponses([stopResponse(), stopResponse()]);
    const runtimeState = {
      mapState: { units: [] },
      myState: { hq: { id: "hq_1", type: "hq", ...DEFAULT_MAP_LAYOUT.player1Hq } },
      myUnits: null,
      activePlans: null,
      recentEvents: {
        events: [
          { tick: 10, type: "building_completed", data: { buildingId: "building_5", buildingType: "barracks" } },
          { tick: 12, type: "unit_spawned", data: { unitId: "unit_20", unitType: "rifleman" } },
          { tick: 12, type: "unit_spawned", data: { unitId: "unit_21", unitType: "rifleman" } },
          { tick: 15, type: "unit_destroyed", data: { unitId: "unit_20", unitType: "rifleman" } },
        ],
      },
    };
    const options = {
      tools: [],
      executeTool: async () => ({ effect: "read" as const, result: { ok: true } }),
      getRuntimeState: () => runtimeState,
    };

    await provider.runAgent(createInput(), options);
    await provider.runAgent({ ...createInput(), tick: 16 }, options);

    const calls = create.mock.calls as unknown as Array<Array<{ messages: Array<{ role: string; content: string }> }>>;
    const latestMessages = calls[1]![0]!.messages;
    const evaMessages = latestMessages.filter((message) => message.role === "user" && message.content.includes("EVA:"));
    expect(evaMessages).toHaveLength(1);
    expect(evaMessages[0]!.content).toContain("Building complete: barracks building_5");
    expect(evaMessages[0]!.content).toContain("Unit ready: 2 rifleman");
    expect(evaMessages[0]!.content).toContain("Unit lost: 1 rifleman");
  });

  it("expires older read tool results when the same read tool and args are called again", async () => {
    const responses = [
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_old",
                  function: {
                    name: "get_map_state",
                    arguments: "{\"includeEmptyTiles\":false}",
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
              content: "refreshing map",
              tool_calls: [
                {
                  id: "call_new",
                  function: {
                    name: "get_map_state",
                    arguments: "{\"includeEmptyTiles\":false}",
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
              content: "done",
              tool_calls: [],
            },
          },
        ],
      },
    ];

    const { provider, create } = createProviderWithResponses(responses);
    let toolReadCount = 0;
    await provider.runAgent(createInput(), {
      tools: [],
      executeTool: async () => {
        toolReadCount++;
        return {
          effect: "read" as const,
          result: toolReadCount === 1
            ? { tick: 10, cells: [{ marker: "OLD_MAP_SHOULD_EXPIRE" }] }
            : { tick: 20, cells: [{ marker: "NEW_MAP_SHOULD_REMAIN" }] },
        };
      },
      getRuntimeState: () => ({
        mapState: null,
        myState: null,
        myUnits: null,
        activePlans: null,
        recentEvents: null,
      }),
    });

    const createCalls = create.mock.calls as unknown as Array<Array<{ messages: Array<{ role: string; content: string; name?: string }> }>>;
    const thirdCall = createCalls[2];
    if (!thirdCall?.[0]) {
      throw new Error("expected third OpenAI request");
    }

    const serializedMessages = JSON.stringify(thirdCall[0].messages);
    expect(serializedMessages).not.toContain("OLD_MAP_SHOULD_EXPIRE");
    expect(serializedMessages).toContain("NEW_MAP_SHOULD_REMAIN");
    expect(serializedMessages).toContain("superseded_by_new_read");
    const oldToolMessage = thirdCall[0].messages.find((message) => message.role === "tool" && message.name === "get_map_state");
    expect(oldToolMessage).toBeDefined();
    expect(JSON.parse(String(oldToolMessage?.content))).toMatchObject({
      expired: true,
      reason: "superseded_by_new_read",
      observedTick: 10,
    });
  });

  it("keeps older read tool results when the same read tool is called with different args", async () => {
    const responses = [
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_full",
                  function: {
                    name: "get_map_state",
                    arguments: "{\"includeEmptyTiles\":true}",
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
              content: "checking slim map",
              tool_calls: [
                {
                  id: "call_slim",
                  function: {
                    name: "get_map_state",
                    arguments: "{\"includeEmptyTiles\":false}",
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
              content: "done",
              tool_calls: [],
            },
          },
        ],
      },
    ];

    const { provider, create } = createProviderWithResponses(responses);
    let toolReadCount = 0;
    await provider.runAgent(createInput(), {
      tools: [],
      executeTool: async () => {
        toolReadCount++;
        return {
          effect: "read" as const,
          result: toolReadCount === 1
            ? { tick: 10, cells: [{ marker: "FULL_MAP_SHOULD_REMAIN" }] }
            : { tick: 20, cells: [{ marker: "SLIM_MAP_SHOULD_REMAIN" }] },
        };
      },
      getRuntimeState: () => ({
        mapState: null,
        myState: null,
        myUnits: null,
        activePlans: null,
        recentEvents: null,
      }),
    });

    const createCalls = create.mock.calls as unknown as Array<Array<{ messages: Array<{ role: string; content: string; name?: string }> }>>;
    const thirdCall = createCalls[2];
    if (!thirdCall?.[0]) {
      throw new Error("expected third OpenAI request");
    }

    const serializedMessages = JSON.stringify(thirdCall[0].messages);
    expect(serializedMessages).toContain("FULL_MAP_SHOULD_REMAIN");
    expect(serializedMessages).toContain("SLIM_MAP_SHOULD_REMAIN");
    expect(serializedMessages).not.toContain("superseded_by_new_read");
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

    const create = vi.fn((_request: unknown, requestOptions?: { signal?: AbortSignal }) => {
      receivedSignal = requestOptions?.signal;
      return new Promise((_, reject) => {
        requestOptions?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });

    (provider as any).transport.client = {
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
    expect(result.metrics.modelRequests).toBe(1);
    expect(result.metrics.modelRequestRecords?.[0]).toEqual(
      expect.objectContaining({ status: "error", finishReason: "request_error" }),
    );
  });
});
