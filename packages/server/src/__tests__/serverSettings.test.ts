import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameState } from "@llmcraft/shared";
import { OpenAICompatibleProvider } from "../OpenAICompatibleProvider";
import {
  buildStateMessagePayload,
  createServerState,
  handleClientMessage,
  handleHttpRequest,
} from "../index";

afterEach(() => {
  vi.restoreAllMocks();
});

function createRequest({
  method,
  url,
  body,
}: {
  method: string;
  url: string;
  body?: string;
}) {
  const req = Object.assign([], {
    method,
    url,
    [Symbol.asyncIterator]: async function* () {
      if (body) {
        yield Buffer.from(body);
      }
    },
  });

  return req as unknown as http.IncomingMessage;
}

function createResponseCapture() {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let payload = "";

  const res = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    writeHead(nextStatusCode: number, nextHeaders?: Record<string, string>) {
      statusCode = nextStatusCode;
      if (nextHeaders) {
        for (const [name, value] of Object.entries(nextHeaders)) {
          headers.set(name.toLowerCase(), value);
        }
      }
      return res;
    },
    end(chunk?: string) {
      payload = chunk ?? "";
      return res;
    },
  };

  return {
    res: res as unknown as http.ServerResponse,
    get statusCode() {
      return statusCode;
    },
    get payload() {
      return payload;
    },
    get headers() {
      return headers;
    },
  };
}

function createMockGameState(tick: number): GameState {
  return {
    tick,
    players: [],
    tiles: [],
    winner: null,
    logs: [],
  };
}

function makeLLMConfig(overrides?: Partial<{ apiKey: string; baseURL: string; model: string }>) {
  return {
    providerType: "openai-compatible" as const,
    apiKey: overrides?.apiKey ?? "token-one",
    baseURL: overrides?.baseURL ?? "https://api.one.test/v1",
    model: overrides?.model ?? "model-one",
    rpm: null,
    reasoningEffort: null,
    extraRequestParams: null,
  };
}

describe("server settings", () => {
  it("rejects start when player config is missing", async () => {
    const state = createServerState();
    const ws = { send: vi.fn() };

    await handleClientMessage({
      data: JSON.stringify({ type: "start", player1: null, player2: null }),
      ws: ws as any,
      state,
    });

    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining("必须提供红蓝双方的 LLM 配置"));
  });

  it("creates a fresh orchestrator from the provided player configs", async () => {
    const player1 = makeLLMConfig({ model: "model-one" });
    const player2 = makeLLMConfig({ apiKey: "token-two", baseURL: "https://api.two.test/v1", model: "model-two" });

    const start = vi.fn<[], Promise<void>>(async () => undefined);
    const stop = vi.fn<[], void>(() => undefined);
    const saveRecord = vi.fn<[], Promise<string>>(async () => "logs/records/mock.json");
    const getGame = vi.fn(() => ({
      getState: () => null,
      getSnapshots: () => [],
    }));
    const createOrchestrator = vi.fn((config) => ({
      start,
      stop,
      saveRecord,
      getGame,
      config,
    }));
    const state = createServerState(createOrchestrator);

    await handleClientMessage({
      data: JSON.stringify({
        type: "start",
        player1,
        player2,
      }),
      ws: { send: vi.fn() } as any,
      state,
    });

    expect(createOrchestrator).toHaveBeenCalledTimes(1);
    expect(createOrchestrator).toHaveBeenCalledWith({
      player1: expect.objectContaining({
        providerType: "openai-compatible",
        apiKey: "token-one",
        baseURL: "https://api.one.test/v1",
        model: "model-one",
      }),
      player2: expect.objectContaining({
        providerType: "openai-compatible",
        apiKey: "token-two",
        baseURL: "https://api.two.test/v1",
        model: "model-two",
      }),
      debug: undefined,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(state.orchestrator).not.toBeNull();
  });

  it("keeps the previous orchestrator if starting the next one fails", async () => {
    const player1 = makeLLMConfig();
    const player2 = makeLLMConfig({ model: "model-two" });

    const previousOrchestrator = {
      start: vi.fn<[], Promise<void>>(async () => undefined),
      stop: vi.fn<[], void>(() => undefined),
      saveRecord: vi.fn<[], Promise<string>>(async () => "logs/records/old.json"),
      getGame: vi.fn(() => ({
        getState: () => createMockGameState(1),
        getSnapshots: () => [],
      })),
    };
    const failedOrchestrator = {
      start: vi.fn<[], Promise<void>>(async () => {
        throw new Error("start failed");
      }),
      stop: vi.fn<[], void>(() => undefined),
      saveRecord: vi.fn<[], Promise<string>>(async () => "logs/records/new.json"),
      getGame: vi.fn(() => ({
        getState: () => null,
        getSnapshots: () => [],
      })),
    };
    const state = createServerState(vi.fn(() => failedOrchestrator as any));
    state.orchestrator = previousOrchestrator;
    const ws = { send: vi.fn() };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleClientMessage({
      data: JSON.stringify({
        type: "start",
        player1,
        player2,
      }),
      ws: ws as any,
      state,
    });

    expect(failedOrchestrator.start).toHaveBeenCalledTimes(1);
    expect(failedOrchestrator.stop).toHaveBeenCalledTimes(1);
    expect(previousOrchestrator.stop).not.toHaveBeenCalled();
    expect(state.orchestrator).toBe(previousOrchestrator);
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining("处理客户端消息失败"));
  });

  it("passes per-match debug flags through start message orchestration config", async () => {
    const player1 = makeLLMConfig();
    const player2 = makeLLMConfig({ model: "model-two" });
    const createOrchestrator = vi.fn(() => ({
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => undefined),
      saveRecord: vi.fn(async () => "logs/records/mock.json"),
      getGame: vi.fn(() => ({
        getState: () => null,
        getSnapshots: () => [],
      })),
    }));
    const state = createServerState(createOrchestrator);

    await handleClientMessage({
      data: JSON.stringify({
        type: "start",
        player1,
        player2,
        debug: { recordLLMTranscript: true },
      }),
      ws: { send: vi.fn() } as any,
      state,
    });

    expect(createOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        debug: { recordLLMTranscript: true },
      })
    );
  });

  it("prepares selected players before start and reports status", async () => {
    const player1 = makeLLMConfig({ model: "model-one" });
    const player2 = makeLLMConfig({ model: "model-two" });
    const prepare = vi.fn(async () => undefined);
    const createOrchestrator = vi.fn(() => ({
      prepare,
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => undefined),
      saveRecord: vi.fn(async () => "logs/records/mock.json"),
      getGame: vi.fn(() => ({
        getState: () => null,
        getSnapshots: () => [],
      })),
    }));
    const state = createServerState(createOrchestrator);
    const ws = { send: vi.fn() };

    await handleClientMessage({
      data: JSON.stringify({
        type: "prepare",
        player1,
        player2,
        warmup: { player_1: true, player_2: false },
      }),
      ws: ws as any,
      state,
    });

    expect(createOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        player1: expect.objectContaining({ model: "model-one" }),
        player2: expect.objectContaining({ model: "model-two" }),
      })
    );
    expect(prepare).toHaveBeenCalledWith({ player_1: true, player_2: false });
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"prepare_status"'));
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"player_1":"ready"'));
  });

  it("tests a preset API connection with the provided config", async () => {
    const state = createServerState();
    const response = createResponseCapture();
    const testSpy = vi
      .spyOn(OpenAICompatibleProvider.prototype, "testConnection")
      .mockResolvedValue({ responseText: "OK" });

    await handleHttpRequest(
      createRequest({
        method: "POST",
        url: "/api/settings/presets/test",
        body: JSON.stringify({
          providerType: "openai-compatible",
          baseURL: "https://api.example.com/v1",
          model: "gpt-4o-mini",
          apiKey: "secret-token",
        }),
      }),
      response.res,
      state
    );

    expect(response.statusCode).toBe(200);
    expect(testSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(response.payload) as { ok: boolean; responseText: string; model: string };
    expect(body).toMatchObject({ ok: true, responseText: "OK", model: "gpt-4o-mini" });
    expect(response.payload).not.toContain("secret-token");
  });

  it("starts benchmark orchestration with the provided config and cpu strategy", async () => {
    const player = makeLLMConfig({ model: "model-one" });

    const previousOrchestrator = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => undefined),
      saveRecord: vi.fn(async () => "logs/records/live.json"),
      getGame: vi.fn(() => ({
        getState: () => createMockGameState(3),
        getSnapshots: () => [],
      })),
    };
    const benchmarkOrchestrator = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => undefined),
      saveRecord: vi.fn(async () => "logs/records/benchmark.json"),
      getGame: vi.fn(() => ({
        getState: () => createMockGameState(0),
        getSnapshots: () => [],
      })),
    };
    const createBenchmarkOrchestrator = vi.fn(() => benchmarkOrchestrator as any);
    const state = createServerState(undefined, createBenchmarkOrchestrator);
    state.orchestrator = previousOrchestrator as any;

    await handleClientMessage({
      data: JSON.stringify({
        type: "start_benchmark",
        player,
        cpuStrategy: "random",
        rounds: 12,
        recordReplay: true,
        decisionIntervalTicks: 7,
        debug: { recordLLMTranscript: true },
      }),
      ws: { send: vi.fn() } as any,
      state,
    });

    expect(previousOrchestrator.stop).toHaveBeenCalledTimes(1);
    expect(createBenchmarkOrchestrator).toHaveBeenCalledWith(
      {
        llmConfig: expect.objectContaining({
          providerType: "openai-compatible",
          apiKey: "token-one",
          baseURL: "https://api.one.test/v1",
          model: "model-one",
        }),
        cpuStrategy: "random",
        rounds: 12,
        recordReplay: true,
        decisionIntervalTicks: 7,
        debug: { recordLLMTranscript: true },
      },
      expect.any(Object)
    );
    expect(benchmarkOrchestrator.start).toHaveBeenCalledTimes(1);
    expect(state.orchestrator).toBe(benchmarkOrchestrator);
  });

  it("builds live state payloads with always-enabled live flag", async () => {
    const latestSnapshot = {
      tick: 24,
      state: createMockGameState(24),
      aiOutputs: { player_1: "p1-24", player_2: "p2-24" },
    };

    const state = createServerState(
      vi.fn(() => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(() => undefined),
        saveRecord: vi.fn(async () => "logs/records/mock.json"),
        getGame: vi.fn(() => ({
          getState: () => createMockGameState(24),
          getSnapshots: () => [],
          getLatestSnapshot: () => latestSnapshot,
        })),
      }))
    );
    state.orchestrator = state.createOrchestrator({
      player1: makeLLMConfig(),
      player2: makeLLMConfig({ model: "model-two" }),
    }) as any;

    const payload = buildStateMessagePayload(state);

    expect(payload.liveEnabled).toBe(true);
    expect(payload.snapshots).toHaveLength(1);
    expect(payload.snapshots[0]?.tick).toBe(24);
  });
});
