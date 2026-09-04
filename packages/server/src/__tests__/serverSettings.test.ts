import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameState } from "@llmcraft/shared";
import { PresetStore } from "../PresetStore";
import { OpenAICompatibleProvider } from "../OpenAICompatibleProvider";
import {
  buildStateMessagePayload,
  createPresetStore,
  createServerState,
  getDefaultPresetPaths,
  handleClientMessage,
  handleHttpRequest,
} from "../index";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-server-settings-"));
  tempDirs.push(dir);
  return new PresetStore({
    filePath: path.join(dir, "llm-presets.json"),
    encryptionSecret: "0123456789abcdef0123456789abcdef",
  });
}

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

describe("server settings", () => {
  it("uses the built-in preset secret without creating a separate secret file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-secret-bootstrap-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "llm-presets.json");
    const secretFilePath = path.join(dir, "llm-presets.secret");

    const store = createPresetStore({
      filePath,
    });

    await store.create({
      name: "Preset A",
      providerType: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKey: "secret-token",
    });

    await expect(fs.access(secretFilePath)).rejects.toMatchObject({ code: "ENOENT" });

    const reloadedStore = createPresetStore({
      filePath,
    });
    const runtime = await reloadedStore.getRuntimeConfig((await reloadedStore.list())[0]!.id);
    expect(runtime.apiKey).toBe("secret-token");
  });

  it("resolves default preset paths independent of process cwd", () => {
    const cwdSpy = vi.spyOn(process, "cwd");
    cwdSpy.mockReturnValueOnce("E:/Projects/llm_craft");
    const rootPaths = getDefaultPresetPaths();

    cwdSpy.mockReturnValueOnce("E:/Projects/llm_craft/packages/server");
    const nestedPaths = getDefaultPresetPaths();

    expect(nestedPaths).toEqual(rootPaths);
    expect(rootPaths.filePath).toContain(path.join("packages", "server", "data", "llm-presets.json"));
    expect(rootPaths.filePath).not.toContain(path.join("packages", "server", "packages", "server"));
  });

  it("returns preset summaries from GET /api/settings/presets without exposing plaintext tokens", async () => {
    const presetStore = await createStore();
    await presetStore.create({
      name: "Preset A",
      providerType: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKey: "secret-token",
    });

    const state = createServerState(presetStore);
    const response = createResponseCapture();

    await handleHttpRequest(
      createRequest({ method: "GET", url: "/api/settings/presets" }),
      response.res,
      state
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = JSON.parse(response.payload) as {
      presets: Array<{ name: string; hasApiKey: boolean; apiKey?: string }>;
    };
    expect(body.presets).toHaveLength(1);
    expect(body.presets[0]?.name).toBe("Preset A");
    expect(body.presets[0]?.hasApiKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret-token");
    expect(body.presets[0]).not.toHaveProperty("apiKey");
  });

  it("supports HTTP preset CRUD and preserves apiKey when update omits it", async () => {
    const presetStore = await createStore();
    const state = createServerState(presetStore);

    const createResponse = createResponseCapture();
    await handleHttpRequest(
      createRequest({
        method: "POST",
        url: "/api/settings/presets",
        body: JSON.stringify({
          name: "Preset A",
          providerType: "openai-compatible",
          baseURL: "https://api.example.com/v1",
          model: "gpt-4o-mini",
          apiKey: "secret-token",
          reasoningEffort: "medium",
          extraRequestParams: {
            thinking: { type: "disabled" },
            max_tokens: 512,
          },
        }),
      }),
      createResponse.res,
      state
    );

    expect(createResponse.statusCode).toBe(201);
    const createdBody = JSON.parse(createResponse.payload) as { preset: { id: string } };
    const presetId = createdBody.preset.id;

    const updateResponse = createResponseCapture();
    await handleHttpRequest(
      createRequest({
        method: "PUT",
        url: `/api/settings/presets/${presetId}`,
        body: JSON.stringify({
          name: "Preset B",
          providerType: "openai-compatible",
          baseURL: "https://api.example.com/v2",
          model: "gpt-4.1-mini",
        }),
      }),
      updateResponse.res,
      state
    );

    expect(updateResponse.statusCode).toBe(200);
    const runtime = await presetStore.getRuntimeConfig(presetId);
    expect(runtime.apiKey).toBe("secret-token");
    expect(runtime.model).toBe("gpt-4.1-mini");
    expect(runtime.reasoningEffort).toBeNull();
    expect(runtime.extraRequestParams).toBeNull();

    const deleteResponse = createResponseCapture();
    await handleHttpRequest(
      createRequest({
        method: "DELETE",
        url: `/api/settings/presets/${presetId}`,
      }),
      deleteResponse.res,
      state
    );

    expect(deleteResponse.statusCode).toBe(200);
    await expect(presetStore.getRuntimeConfig(presetId)).rejects.toThrow("PRESET_NOT_FOUND");
  });

  it("returns readable errors for invalid JSON and missing presets", async () => {
    const presetStore = await createStore();
    const state = createServerState(presetStore);

    const invalidJsonResponse = createResponseCapture();
    await handleHttpRequest(
      createRequest({
        method: "POST",
        url: "/api/settings/presets",
        body: "{bad json",
      }),
      invalidJsonResponse.res,
      state
    );

    expect(invalidJsonResponse.statusCode).toBe(400);
    expect(invalidJsonResponse.payload).toContain("请求体不是有效的 JSON");

    const missingPresetResponse = createResponseCapture();
    await handleHttpRequest(
      createRequest({
        method: "DELETE",
        url: "/api/settings/presets/missing-id",
      }),
      missingPresetResponse.res,
      state
    );

    expect(missingPresetResponse.statusCode).toBe(404);
    expect(missingPresetResponse.payload).toContain("指定的预设不存在");
  });

  it("rejects extra request params that override core request fields", async () => {
    const presetStore = await createStore();
    const state = createServerState(presetStore);

    const response = createResponseCapture();
    await handleHttpRequest(
      createRequest({
        method: "POST",
        url: "/api/settings/presets",
        body: JSON.stringify({
          name: "Preset A",
          providerType: "openai-compatible",
          baseURL: "https://api.example.com/v1",
          model: "gpt-4o-mini",
          apiKey: "secret-token",
          extraRequestParams: {
            model: "other-model",
          },
        }),
      }),
      response.res,
      state
    );

    expect(response.statusCode).toBe(400);
    expect(response.payload).toContain("高级请求参数不能覆盖 model");
  });

  it("rejects start when a preset id is missing", async () => {
    const presetStore = await createStore();
    const state = createServerState(presetStore);
    const ws = { send: vi.fn() };

    await handleClientMessage({
      data: JSON.stringify({ type: "start", player1PresetId: "", player2PresetId: "" }),
      ws: ws as any,
      state,
    });

    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining("必须为红蓝双方选择预设"));
  });

  it("creates one live orchestrator and rejects a duplicate start", async () => {
    const presetStore = await createStore();
    const player1Preset = await presetStore.create({
      name: "Red",
      providerType: "openai-compatible",
      baseURL: "https://api.one.test/v1",
      model: "model-one",
      apiKey: "token-one",
    });
    const player2Preset = await presetStore.create({
      name: "Blue",
      providerType: "openai-compatible",
      baseURL: "https://api.two.test/v1",
      model: "model-two",
      apiKey: "token-two",
    });

    const start = vi.fn<[], Promise<void>>(async () => undefined);
    const stop = vi.fn<[], void>(() => undefined);
    const saveRecord = vi.fn<[], Promise<string>>(async () => "logs/records/mock.json");
    const getGame = vi.fn(() => ({
      getState: () => null,
      getSnapshots: () => [],
    }));
    const createOrchestrator = vi.fn((config) => ({
      getMatchId: () => "match_started",
      getMatchStatus: () => start.mock.calls.length > 0 ? "running" as const : "waiting_for_players" as const,
      start,
      stop,
      saveRecord,
      getGame,
      config,
    }));
    const state = createServerState(presetStore, createOrchestrator);

    const ws = { send: vi.fn() };
    await handleClientMessage({
      data: JSON.stringify({
        type: "start",
        player1PresetId: player1Preset.id,
        player2PresetId: player2Preset.id,
      }),
      ws: ws as any,
      state,
    });
    await handleClientMessage({
      data: JSON.stringify({
        type: "start",
        player1PresetId: player1Preset.id,
        player2PresetId: player2Preset.id,
      }),
      ws: ws as any,
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
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining("不会重复启动"));
    expect(state.matchRegistry.getObservedMatchId()).toBe("match_started");
    expect(state.matchRegistry.getObserved()?.liveSetup).toEqual({
      player1PresetId: player1Preset.id,
      player2PresetId: player2Preset.id,
      recordingProfile: "evaluation",
      includeTranscript: false,
    });
  });

  it("keeps the previous orchestrator if starting the next one fails", async () => {
    const presetStore = await createStore();
    const player1Preset = await presetStore.create({
      name: "Red",
      providerType: "openai-compatible",
      baseURL: "https://api.one.test/v1",
      model: "model-one",
      apiKey: "token-one",
    });
    const player2Preset = await presetStore.create({
      name: "Blue",
      providerType: "openai-compatible",
      baseURL: "https://api.two.test/v1",
      model: "model-two",
      apiKey: "token-two",
    });

    const previousOrchestrator = {
      getMatchId: () => "match_previous",
      start: vi.fn<[], Promise<void>>(async () => undefined),
      stop: vi.fn<[], void>(() => undefined),
      saveRecord: vi.fn<[], Promise<string>>(async () => "logs/records/old.json"),
      getGame: vi.fn(() => ({
        getState: () => createMockGameState(1),
        getSnapshots: () => [],
      })),
    };
    const failedOrchestrator = {
      getMatchId: () => "match_failed",
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
    const state = createServerState(presetStore, vi.fn(() => failedOrchestrator as any));
    state.matchRegistry.register(previousOrchestrator as any, { kind: "live", observe: true });
    const ws = { send: vi.fn() };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleClientMessage({
      data: JSON.stringify({
        type: "start",
        player1PresetId: player1Preset.id,
        player2PresetId: player2Preset.id,
      }),
      ws: ws as any,
      state,
    });

    expect(failedOrchestrator.start).toHaveBeenCalledTimes(1);
    expect(failedOrchestrator.stop).toHaveBeenCalledTimes(1);
    expect(previousOrchestrator.stop).not.toHaveBeenCalled();
    expect(state.matchRegistry.getObserved()?.handle).toBe(previousOrchestrator);
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining("处理客户端消息失败"));
  });

  it("resets only the explicitly identified live match and leaves the replacement waiting", async () => {
    const presetStore = await createStore();
    const player1Preset = await presetStore.create({
      name: "Red",
      providerType: "openai-compatible",
      baseURL: "https://api.one.test/v1",
      model: "model-one",
      apiKey: "token-one",
    });
    const player2Preset = await presetStore.create({
      name: "Blue",
      providerType: "openai-compatible",
      baseURL: "https://api.two.test/v1",
      model: "model-two",
      apiKey: "token-two",
    });
    const targetStop = vi.fn();
    const unrelatedStop = vi.fn();
    const replacementStart = vi.fn(async () => undefined);
    const state = createServerState(presetStore, vi.fn(() => ({
      getMatchId: () => "match_replacement",
      getMatchStatus: () => "waiting_for_players" as const,
      getGame: () => ({ getState: () => createMockGameState(0) }),
      start: replacementStart,
      stop: vi.fn(),
      saveRecord: vi.fn(async () => "logs/records/replacement.match.json"),
    })));
    state.matchRegistry.register({
      getMatchId: () => "match_target",
      getMatchStatus: () => "stopped",
      getGame: () => ({ getState: () => createMockGameState(20) }),
      stop: targetStop,
      saveRecord: vi.fn(async () => "logs/records/target.match.json"),
    }, { kind: "live" });
    state.matchRegistry.register({
      getMatchId: () => "match_unrelated",
      getMatchStatus: () => "stopped",
      getGame: () => ({ getState: () => createMockGameState(10) }),
      stop: unrelatedStop,
      saveRecord: vi.fn(async () => "logs/records/unrelated.match.json"),
    }, { kind: "control", observe: true });

    await handleClientMessage({
      data: JSON.stringify({
        type: "reset",
        matchId: "match_target",
        player1PresetId: player1Preset.id,
        player2PresetId: player2Preset.id,
      }),
      ws: { send: vi.fn() } as any,
      state,
    });

    expect(targetStop).toHaveBeenCalledTimes(1);
    expect(unrelatedStop).not.toHaveBeenCalled();
    expect(replacementStart).not.toHaveBeenCalled();
    expect(state.matchRegistry.get("match_target")).toBeUndefined();
    expect(state.matchRegistry.getObserved()?.matchId).toBe("match_replacement");
    expect(state.matchRegistry.getObserved()?.handle.getMatchStatus?.()).toBe("waiting_for_players");
  });

  it("returns a readable error when a preset can no longer be decrypted", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-corrupt-preset-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "llm-presets.json");
    const presetId = "broken-preset";

    await fs.writeFile(
      filePath,
      JSON.stringify([
        {
          id: presetId,
          name: "Broken",
          providerType: "openai-compatible",
          baseURL: "https://api.example.com/v1",
          model: "gpt-4.1-mini",
          apiKeyEncrypted: "invalid-payload",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
      "utf8"
    );

    const presetStore = new PresetStore({
      filePath,
      encryptionSecret: "0123456789abcdef0123456789abcdef",
    });
    const state = createServerState(presetStore);
    const ws = { send: vi.fn() };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleClientMessage({
      data: JSON.stringify({
        type: "start",
        player1PresetId: presetId,
        player2PresetId: presetId,
      }),
      ws: ws as any,
      state,
    });

    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining("预设中的 API Key 无法解密"));
  });

  it("passes per-match debug flags through start message orchestration config", async () => {
    const presetStore = await createStore();
    const player1Preset = await presetStore.create({
      name: "Red",
      providerType: "openai-compatible",
      baseURL: "https://api.one.test/v1",
      model: "model-one",
      apiKey: "token-one",
    });
    const player2Preset = await presetStore.create({
      name: "Blue",
      providerType: "openai-compatible",
      baseURL: "https://api.two.test/v1",
      model: "model-two",
      apiKey: "token-two",
    });
    const createOrchestrator = vi.fn(() => ({
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => undefined),
      saveRecord: vi.fn(async () => "logs/records/mock.json"),
      getGame: vi.fn(() => ({
        getState: () => null,
        getSnapshots: () => [],
      })),
    }));
    const state = createServerState(presetStore, createOrchestrator);

    await handleClientMessage({
      data: JSON.stringify({
        type: "start",
        player1PresetId: player1Preset.id,
        player2PresetId: player2Preset.id,
        debug: { recordingProfile: "evaluation", includeTranscript: true },
      }),
      ws: { send: vi.fn() } as any,
      state,
    });

    expect(createOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        debug: { recordingProfile: "evaluation", includeTranscript: true },
      })
    );
  });

  it("warms up selected players before start and reports status", async () => {
    const presetStore = await createStore();
    const player1Preset = await presetStore.create({
      name: "Red",
      providerType: "openai-compatible",
      baseURL: "https://api.one.test/v1",
      model: "model-one",
      apiKey: "token-one",
    });
    const player2Preset = await presetStore.create({
      name: "Blue",
      providerType: "openai-compatible",
      baseURL: "https://api.two.test/v1",
      model: "model-two",
      apiKey: "token-two",
    });
    const warmupHandler = vi.fn(async () => undefined);
    const createOrchestrator = vi.fn(() => ({
      warmup: warmupHandler,
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => undefined),
      saveRecord: vi.fn(async () => "logs/records/mock.json"),
      getGame: vi.fn(() => ({
        getState: () => null,
        getSnapshots: () => [],
      })),
    }));
    const state = createServerState(presetStore, createOrchestrator);
    const ws = { send: vi.fn() };

    await handleClientMessage({
      data: JSON.stringify({
        type: "warmup",
        player1PresetId: player1Preset.id,
        player2PresetId: player2Preset.id,
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
    expect(warmupHandler).toHaveBeenCalledWith({ player_1: true, player_2: false });
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"warmup_status"'));
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"player_1":"ready"'));
  });

  it("tests a preset API connection without exposing the saved api key", async () => {
    const presetStore = await createStore();
    const preset = await presetStore.create({
      name: "Preset A",
      providerType: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKey: "secret-token",
    });
    const state = createServerState(presetStore);
    const response = createResponseCapture();
    const testSpy = vi
      .spyOn(OpenAICompatibleProvider.prototype, "testConnection")
      .mockResolvedValue({ responseText: "OK" });

    await handleHttpRequest(
      createRequest({
        method: "POST",
        url: "/api/settings/presets/test",
        body: JSON.stringify({
          presetId: preset.id,
          providerType: "openai-compatible",
          baseURL: "https://api.example.com/v1",
          model: "gpt-4o-mini",
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

  it("starts benchmark orchestration with the selected preset and cpu strategy", async () => {
    const presetStore = await createStore();
    const preset = await presetStore.create({
      name: "Benchmark LLM",
      providerType: "openai-compatible",
      baseURL: "https://api.one.test/v1",
      model: "model-one",
      apiKey: "token-one",
    });

    const previousOrchestrator = {
      getMatchId: () => "match_live",
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
    const state = createServerState(presetStore, undefined, createBenchmarkOrchestrator);
    state.matchRegistry.register(previousOrchestrator as any, { kind: "live", observe: true });

    await handleClientMessage({
      data: JSON.stringify({
        type: "start_benchmark",
        presetId: preset.id,
        cpuStrategy: "random",
        rounds: 12,
        recordReplay: true,
        debug: { recordingProfile: "evaluation", includeTranscript: true },
      }),
      ws: { send: vi.fn() } as any,
      state,
    });

    expect(previousOrchestrator.stop).not.toHaveBeenCalled();
    expect(createBenchmarkOrchestrator).toHaveBeenCalledWith(
      {
        presetId: preset.id,
        llmConfig: expect.objectContaining({
          providerType: "openai-compatible",
          apiKey: "token-one",
          baseURL: "https://api.one.test/v1",
          model: "model-one",
        }),
        cpuStrategy: "random",
        rounds: 12,
        decisionIntervalTicks: 10,
        recordReplay: true,
        debug: { recordingProfile: "evaluation", includeTranscript: true },
      },
      expect.any(Object)
    );
    expect(benchmarkOrchestrator.start).toHaveBeenCalledTimes(1);
    expect(state.activeBenchmark).toBe(benchmarkOrchestrator);
  });

  it("builds live state payloads without hitting preset storage or duplicating full state", async () => {
    const presetStore = await createStore();
    const listSpy = vi.spyOn(presetStore, "list");
    const snapshots = Array.from({ length: 25 }, (_, index) => ({
      tick: index,
      state: createMockGameState(index),
      aiOutputs: { player_1: `p1-${index}`, player_2: `p2-${index}` },
    }));

    const state = createServerState(
      presetStore,
      vi.fn(() => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(() => undefined),
        saveRecord: vi.fn(async () => "logs/records/mock.json"),
        getGame: vi.fn(() => ({
          getState: () => createMockGameState(24),
          getAIOutputs: () => snapshots.at(-1)?.aiOutputs ?? {},
          getLatestSnapshot: () => snapshots.at(-1) ?? null,
        })),
      }))
    );
    state.liveEnabled = true;
    const observedOrchestrator = state.createOrchestrator({
      player1: {
        providerType: "openai-compatible",
        apiKey: "token-one",
        baseURL: "https://api.one.test/v1",
        model: "model-one",
      },
      player2: {
        providerType: "openai-compatible",
        apiKey: "token-two",
        baseURL: "https://api.two.test/v1",
        model: "model-two",
      },
    }) as any;
    state.matchRegistry.register({
      ...observedOrchestrator,
      getMatchId: () => "match_payload",
    }, { kind: "live", observe: true });

    const payload = buildStateMessagePayload(state);

    expect(listSpy).not.toHaveBeenCalled();
    expect(payload.liveEnabled).toBe(true);
    expect(payload.observedMatch).toEqual({
      matchId: "match_payload",
      kind: "live",
      recordingEnabled: true,
    });
    expect(payload.matchStatus).toBeNull();
    expect(payload.benchmarkRunning).toBe(false);
    expect(payload.frame).toEqual(expect.objectContaining({
      kind: "keyframe",
      metadata: expect.objectContaining({
        frameSequence: 1,
        simulationTick: 24,
      }),
    }));
    expect(payload.frame?.kind === "keyframe" ? payload.frame.state : null).not.toHaveProperty("logs");
    expect(payload.frame?.kind === "keyframe" ? payload.frame.state : null).not.toHaveProperty("tiles");
  });

  it("saves the explicitly identified live match instead of the observed benchmark", async () => {
    const presetStore = await createStore();
    const state = createServerState(presetStore);
    const liveSaveRecord = vi.fn(async () => "logs/records/live.match.json");
    const benchmarkSaveRecord = vi.fn(async () => "logs/records/benchmark.match.json");
    const game = { getState: () => createMockGameState(42) };
    state.matchRegistry.register({
      getMatchId: () => "match_live",
      getGame: () => game,
      stop: vi.fn(),
      saveRecord: liveSaveRecord,
    }, { kind: "live", terminalPolicy: "save" });
    state.matchRegistry.register({
      getMatchId: () => "match_benchmark",
      getGame: () => game,
      stop: vi.fn(),
      saveRecord: benchmarkSaveRecord,
    }, { kind: "benchmark", terminalPolicy: "save", observe: true });
    const ws = { send: vi.fn() };

    await handleClientMessage({
      data: JSON.stringify({ type: "save_record", matchId: "match_live" }),
      ws: ws as any,
      state,
    });

    expect(liveSaveRecord).toHaveBeenCalledTimes(1);
    expect(benchmarkSaveRecord).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: "record_saved",
      matchId: "match_live",
      fileName: "live.match.json",
    }));
  });

  it("pauses only the explicitly identified live match", async () => {
    const presetStore = await createStore();
    const state = createServerState(presetStore);
    const liveStop = vi.fn();
    const benchmarkStop = vi.fn();
    state.matchRegistry.register({
      getMatchId: () => "match_live_running",
      getMatchStatus: () => "running",
      getGame: () => ({ getState: () => createMockGameState(12) }),
      stop: liveStop,
      saveRecord: vi.fn(async () => "logs/records/live.match.json"),
    }, { kind: "live", observe: true });
    state.activeBenchmark = {
      start: vi.fn(async () => undefined),
      stop: benchmarkStop,
      isRunning: () => true,
    };

    await handleClientMessage({
      data: JSON.stringify({ type: "pause_match", matchId: "match_live_running" }),
      ws: { send: vi.fn() } as any,
      state,
    });

    expect(liveStop).toHaveBeenCalledTimes(1);
    expect(benchmarkStop).not.toHaveBeenCalled();
    expect(state.activeBenchmark).not.toBeNull();
  });

  it("stops a benchmark without pausing the observed live match", async () => {
    const presetStore = await createStore();
    const state = createServerState(presetStore);
    const liveStop = vi.fn();
    const benchmarkStop = vi.fn();
    state.matchRegistry.register({
      getMatchId: () => "match_live_running",
      getMatchStatus: () => "running",
      getGame: () => ({ getState: () => createMockGameState(12) }),
      stop: liveStop,
      saveRecord: vi.fn(async () => "logs/records/live.match.json"),
    }, { kind: "live", observe: true });
    state.activeBenchmark = {
      start: vi.fn(async () => undefined),
      stop: benchmarkStop,
      isRunning: () => true,
    };

    await handleClientMessage({
      data: JSON.stringify({ type: "stop_benchmark" }),
      ws: { send: vi.fn() } as any,
      state,
    });

    expect(benchmarkStop).toHaveBeenCalledTimes(1);
    expect(liveStop).not.toHaveBeenCalled();
    expect(state.activeBenchmark).toBeNull();
  });

  it("rejects save requests for a non-recorded benchmark before calling its recorder", async () => {
    const presetStore = await createStore();
    const state = createServerState(presetStore);
    const saveRecord = vi.fn(async () => {
      throw new Error("MATCH_RECORDING_DISABLED");
    });
    state.matchRegistry.register({
      getMatchId: () => "match_benchmark_off",
      getGame: () => ({ getState: () => createMockGameState(90) }),
      stop: vi.fn(),
      saveRecord,
    }, { kind: "benchmark", terminalPolicy: "none", observe: true });
    const ws = { send: vi.fn() };

    await handleClientMessage({
      data: JSON.stringify({ type: "save_record", matchId: "match_benchmark_off" }),
      ws: ws as any,
      state,
    });

    expect(saveRecord).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: "error",
      message: "指定的实时对局不存在。",
    }));
  });
});
