import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameState, type ClientMessage, type PlayerId } from "@llmcraft/shared";
import type WebSocket from "ws";
import { PresetStore } from "../PresetStore";
import { PromptStore } from "../PromptStore";
import { OpenAICompatibleProvider } from "../OpenAICompatibleProvider";
import type { PromptReflectionOptions, PromptReflectionResult } from "../PromptReflection";
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

async function createPromptStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-server-prompts-"));
  tempDirs.push(dir);
  return new PromptStore({ filePath: path.join(dir, "strategy-prompts.json") });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function createReflectionFixture(reflectPrompt: (playerId: PlayerId, options?: PromptReflectionOptions) => Promise<PromptReflectionResult>) {
  const promptStore = await createPromptStore();
  const state = createServerState(await createStore(), undefined, undefined, promptStore);
  const matchId = "match_cancellable_reflection";
  const orchestrator = {
    getMatchId: () => matchId, getMatchStatus: () => "finished" as const,
    getGame: () => ({ getState: () => ({ ...createMockGameState(88), winner: "player_1" as const }) }),
    reflectPrompt, stop: vi.fn(), saveRecord: vi.fn(async () => "unused.match.json"),
  };
  state.matchRegistry.register(orchestrator, { kind: "live", observe: true });
  const ws = { send: vi.fn() };
  const send = (message: ClientMessage) => handleClientMessage({ data: JSON.stringify(message), ws: ws as unknown as WebSocket, state });
  const statuses = () => buildStateMessagePayload(state).observedMatch?.promptReflections;
  return { state, promptStore, matchId, ws, send, statuses };
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

  it("supports named strategy prompt revisions through HTTP", async () => {
    const presetStore = await createStore();
    const promptStore = await createPromptStore();
    const state = createServerState(presetStore, undefined, undefined, promptStore);

    const createResponse = createResponseCapture();
    await handleHttpRequest(createRequest({
      method: "POST",
      url: "/api/prompts",
      body: JSON.stringify({ name: "Rush", content: "Attack early." }),
    }), createResponse.res, state);
    expect(createResponse.statusCode).toBe(201);
    const created = JSON.parse(createResponse.payload) as { prompt: { id: string; activeVersionId: string } };

    const updateResponse = createResponseCapture();
    await handleHttpRequest(createRequest({
      method: "PUT",
      url: `/api/prompts/${created.prompt.id}`,
      body: JSON.stringify({ content: "Scout, then attack early." }),
    }), updateResponse.res, state);
    const updated = JSON.parse(updateResponse.payload) as { prompt: { versions: Array<{ id: string }> } };
    expect(updated.prompt.versions).toHaveLength(2);

    const activateResponse = createResponseCapture();
    await handleHttpRequest(createRequest({
      method: "POST",
      url: `/api/prompts/${created.prompt.id}/versions/${created.prompt.activeVersionId}/activate`,
    }), activateResponse.res, state);
    expect(JSON.parse(activateResponse.payload)).toMatchObject({
      prompt: { activeVersionId: created.prompt.activeVersionId },
    });
  });

  it("exposes reflection provenance for edited revisions without changing the prompt", async () => {
    const presetStore = await createStore();
    const promptStore = await createPromptStore();
    const created = await promptStore.createFromReflection({ name: "侦察后推进", content: "Scout first.", model: "reflection-model", matchId: "match_not_recorded", playerId: "player_2" });
    const edited = await promptStore.update(created.id, { content: "先侦察再推进。" });
    const state = createServerState(presetStore, undefined, undefined, promptStore);
    const response = createResponseCapture();

    await handleHttpRequest(createRequest({ method: "GET", url: `/api/prompts/${created.id}/provenance` }), response.res, state);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toMatchObject({ provenance: {
      [edited.activeVersionId]: { sourceVersionId: created.activeVersionId, sourceVersion: 1, model: "reflection-model", matchId: "match_not_recorded", playerId: "player_2" },
    } });
    expect(await promptStore.list()).toEqual([edited]);

    const missingResponse = createResponseCapture();
    await handleHttpRequest(createRequest({ method: "GET", url: "/api/prompts/missing/provenance" }), missingResponse.res, state);
    expect(missingResponse.statusCode).toBe(404);
  });

  it("does not delete a prompt frozen into a running or paused live match", async () => {
    const presetStore = await createStore();
    const promptStore = await createPromptStore();
    const prompt = await promptStore.create({ name: "Protected", content: "Hold the line." });
    const version = prompt.versions[0]!;
    const state = createServerState(presetStore, undefined, undefined, promptStore);
    state.matchRegistry.register({
      getMatchId: () => "match_using_prompt",
      getMatchStatus: () => "stopped",
      getGame: () => ({ getState: () => createMockGameState(12) }),
      stop: vi.fn(),
      saveRecord: vi.fn(async () => "logs/records/protected.match.json"),
    }, {
      kind: "live",
      liveSetup: {
        player1PresetId: "preset-red",
        player2PresetId: "preset-blue",
        prompts: {
          player_1: {
            promptId: prompt.id,
            promptName: prompt.name,
            versionId: version.id,
            version: version.version,
          },
        },
        recordingProfile: "evaluation",
        includeTranscript: false,
      },
    });

    const response = createResponseCapture();
    await handleHttpRequest(createRequest({
      method: "DELETE",
      url: `/api/prompts/${prompt.id}`,
    }), response.res, state);

    expect(response.statusCode).toBe(409);
    expect(response.payload).toContain("正在被运行中或暂停中的对局使用");
    expect(await promptStore.list()).toHaveLength(1);
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

  it("binds an exact prompt revision and saves post-match reflection as an inactive version", async () => {
    const presetStore = await createStore();
    const promptStore = await createPromptStore();
    const preset = await presetStore.create({
      name: "Model",
      providerType: "openai-compatible",
      baseURL: "https://api.example.test/v1",
      model: "model-one",
      apiKey: "token",
    });
    const prompt = await promptStore.create({ name: "Rush", content: "Attack early." });
    const version = prompt.versions[0]!;
    const ended = createDeferred<{ status: string; state: GameState }>();
    const reflectPrompt = vi.fn(async () => ({ title: "侦察后推进", content: "Scout before the early attack.", model: "model-one" }));
    const createOrchestrator = vi.fn((config) => ({
      getMatchId: () => "match_prompt",
      getMatchStatus: () => "running" as const,
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      waitForEnd: () => ended.promise,
      reflectPrompt,
      saveRecord: vi.fn(async () => "logs/records/prompt.match.json"),
      getGame: () => ({ getState: () => createMockGameState(0) }),
      config,
    }));
    const state = createServerState(presetStore, createOrchestrator, undefined, promptStore);
    const ws = { send: vi.fn() };

    await handleClientMessage({
      data: JSON.stringify({
        type: "start",
        player1PresetId: preset.id,
        player2PresetId: preset.id,
        prompts: {
          player_1: {
            promptId: prompt.id,
            versionId: version.id,
          },
        },
        promptReflection: { player_1: true },
      }),
      ws: ws as any,
      state,
    });

    expect(createOrchestrator).toHaveBeenCalledWith(expect.objectContaining({
      strategyPrompts: {
        player_1: {
          content: "Attack early.",
          snapshot: expect.objectContaining({
            promptId: prompt.id,
            versionId: version.id,
            version: 1,
          }),
        },
      },
    }));

    const finalState = { ...createMockGameState(42), winner: "player_1" as const };
    ended.resolve({ status: "finished", state: finalState });
    await vi.waitFor(() => expect(reflectPrompt).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      const stored = (await promptStore.list())[0];
      expect(stored?.versions).toHaveLength(2);
    });

    const stored = (await promptStore.list())[0]!;
    expect(stored.activeVersionId).toBe(version.id);
    expect(stored.versions[1]).toMatchObject({
      source: "reflection",
      content: "Scout before the early attack.",
      basedOnVersionId: version.id,
      matchId: "match_prompt",
      playerId: "player_1",
    });
    expect(reflectPrompt).toHaveBeenCalledWith("player_1", expect.objectContaining({ signal: expect.any(AbortSignal), onRetry: expect.any(Function) }));
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"status":"completed"'));
  });

  it("creates a strategy-library entry from reflection when the match used the default strategy", async () => {
    const presetStore = await createStore();
    const promptStore = await createPromptStore();
    const preset = await presetStore.create({
      name: "Model",
      providerType: "openai-compatible",
      baseURL: "https://api.example.test/v1",
      model: "model-one",
      apiKey: "token",
    });
    const ended = createDeferred<{ status: string; state: GameState }>();
    const reflectPrompt = vi.fn(async () => ({
      title: "侦察后反制",
      content: "Keep early vision and counter the revealed army composition.",
      model: "model-one",
    }));
    const createOrchestrator = vi.fn((config) => ({
      getMatchId: () => "match_seed_prompt",
      getMatchStatus: () => "running" as const,
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      quiesce: vi.fn(async () => undefined),
      waitForEnd: () => ended.promise,
      reflectPrompt,
      saveRecord: vi.fn(async () => "logs/records/seed-prompt.match.json"),
      getGame: () => ({ getState: () => createMockGameState(0) }),
      config,
    }));
    const state = createServerState(presetStore, createOrchestrator, undefined, promptStore);
    const ws = { send: vi.fn() };

    await handleClientMessage({
      data: JSON.stringify({
        type: "start",
        player1PresetId: preset.id,
        player2PresetId: preset.id,
        promptReflection: { player_1: true },
      }),
      ws: ws as any,
      state,
    });

    expect(createOrchestrator.mock.calls[0]?.[0]).not.toHaveProperty("strategyPrompts");
    ended.resolve({
      status: "finished",
      state: { ...createMockGameState(31), winner: "player_2" },
    });
    await vi.waitFor(async () => {
      expect(await promptStore.list()).toHaveLength(1);
    });

    const [created] = await promptStore.list();
    expect(created?.name).toBe("侦察后反制");
    expect(created?.versions[0]).toMatchObject({
      source: "reflection",
      content: "Keep early vision and counter the revealed army composition.",
      title: "侦察后反制",
      model: "model-one",
      matchId: "match_seed_prompt",
      playerId: "player_1",
    });
    expect(reflectPrompt).toHaveBeenCalledWith("player_1", expect.objectContaining({ signal: expect.any(AbortSignal), onRetry: expect.any(Function) }));
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining("已将本局经验沉淀为新策略"));
  });

  it("continues the completed match after preset deletion and deduplicates running and completed reflections", async () => {
    const presetStore = await createStore();
    const promptStore = await createPromptStore();
    const preset = await presetStore.create({
      name: "Model",
      providerType: "openai-compatible",
      baseURL: "https://api.example.test/v1",
      model: "model-one",
      apiKey: "token",
    });
    const finalState = { ...createMockGameState(88), winner: "player_2" as const };
    const reflection = createDeferred<{ title: string; content: string; model: string }>();
    const reflectPrompt = vi.fn(() => reflection.promise);
    const state = createServerState(presetStore, undefined, undefined, promptStore);
    const orchestrator = {
      getMatchId: () => "match_posthoc_reflection",
      getMatchStatus: () => "finished" as const,
      getGame: () => ({ getState: () => finalState }),
      reflectPrompt,
      stop: vi.fn(),
      saveRecord: vi.fn(async () => "logs/records/posthoc-reflection.match.json"),
    };
    state.matchRegistry.register(orchestrator, {
      kind: "live",
      observe: true,
      liveSetup: {
        player1PresetId: preset.id,
        player2PresetId: preset.id,
        recordingProfile: "evaluation",
        includeTranscript: false,
      },
    });
    const ws = { send: vi.fn() };
    const request = JSON.stringify({
      type: "reflect_prompt",
      matchId: "match_posthoc_reflection",
      playerId: "player_1",
    });

    await presetStore.delete(preset.id);
    await handleClientMessage({ data: request, ws: ws as any, state });
    await handleClientMessage({ data: request, ws: ws as any, state });
    expect(reflectPrompt).toHaveBeenCalledTimes(1);
    reflection.resolve({ title: "反制进攻节奏", content: "Turn the observed enemy timing into a reusable counter-plan.", model: "model-one" });
    await vi.waitFor(async () => expect(await promptStore.list()).toHaveLength(1));
    await handleClientMessage({ data: request, ws: ws as any, state });

    expect(reflectPrompt).toHaveBeenCalledTimes(1);
    expect(reflectPrompt).toHaveBeenCalledWith("player_1", expect.objectContaining({ signal: expect.any(AbortSignal), onRetry: expect.any(Function) }));
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"status":"running"'));
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"status":"completed"'));
    expect(buildStateMessagePayload(state).observedMatch?.promptReflections?.player_1)
      .toMatchObject({ status: "completed", playerId: "player_1" });
  });

  it("projects safe retry progress, cancels only the requested side and ignores its late result", async () => {
    const pending = { player_1: createDeferred<PromptReflectionResult>(), player_2: createDeferred<PromptReflectionResult>() };
    const reflectPrompt = vi.fn((playerId: PlayerId, _options?: PromptReflectionOptions) => pending[playerId].promise);
    const { state, promptStore, matchId, ws, send, statuses } = await createReflectionFixture(reflectPrompt);
    const request = { type: "reflect_prompt", matchId, playerId: "player_1" } as const;
    await send(request);
    await send({ ...request, playerId: "player_2" });
    const red = reflectPrompt.mock.calls[0]![1]!;
    const blue = reflectPrompt.mock.calls[1]![1]!;
    expect(red.signal).not.toBe(blue.signal);
    const progress = { phase: "waiting" as const, attempt: 2, maxAttempts: 3, delayMs: 4000, error: new Error("Connection error: private-provider-secret") };
    red.onRetry?.(progress);
    expect(statuses()?.player_1).toMatchObject({ status: "running", canCancel: true });
    expect(statuses()?.player_1?.message).toContain("4 秒后重试（2/3）");
    expect(JSON.stringify(statuses())).not.toContain("private-provider-secret");
    red.onRetry?.({ ...progress, phase: "retrying", delayMs: 0 });
    expect(statuses()?.player_1?.message).toContain("正在重试策略沉淀（2/3）");
    await send({ ...request, type: "cancel_prompt_reflection", matchId: "another-match" });
    expect(red.signal?.aborted).toBe(false);
    await send({ ...request, type: "cancel_prompt_reflection" });
    expect(red.signal?.aborted).toBe(true);
    expect(blue.signal?.aborted).toBe(false);
    expect(statuses()?.player_1).toMatchObject({ status: "running", canCancel: false });
    await send(request);
    expect(reflectPrompt).toHaveBeenCalledTimes(2); // Still locked while the aborted call unwinds.
    pending.player_1.resolve({ title: "迟到结果", content: "不能保存", model: "test-model" });
    await vi.waitFor(() => expect(statuses()?.player_1?.status).toBe("cancelled"));
    red.onRetry?.(progress); // A late callback must not resurrect the cancelled job.
    expect(statuses()?.player_1?.status).toBe("cancelled");
    expect(await promptStore.list()).toHaveLength(0);
    expect(state.promptReflectionControllers.size).toBe(1);

    // A disconnected initiating socket does not cancel the other side's work.
    ws.send.mockImplementation(() => { throw new Error("closed socket"); });
    pending.player_2.resolve({ title: "蓝方策略", content: "蓝方结果", model: "test-model" });
    await vi.waitFor(() => expect(statuses()?.player_2?.status).toBe("completed"));
    expect(await promptStore.list()).toHaveLength(1);
    ws.send.mockImplementation(() => undefined);
    reflectPrompt.mockResolvedValueOnce({ title: "重新复盘", content: "红方重试结果", model: "test-model" });
    await send(request);
    await vi.waitFor(() => expect(statuses()?.player_1?.status).toBe("completed"));
    expect(await promptStore.list()).toHaveLength(2);
    expect(state.promptReflectionControllers.size).toBe(0);
  });

  it("does not claim cancellation once persistence has started, or write a duplicate version", async () => {
    const reflectPrompt = vi.fn(async () => ({ title: "稳健推进", content: "策略正文", model: "test-model" }));
    const { state, promptStore, matchId, send, statuses } = await createReflectionFixture(reflectPrompt);
    const saveGate = createDeferred<void>();
    const persist = promptStore.createFromReflection.bind(promptStore);
    const save = vi.spyOn(promptStore, "createFromReflection").mockImplementation(async (input) => {
      await saveGate.promise;
      return persist(input);
    });
    const request = { type: "reflect_prompt", matchId, playerId: "player_1" } as const;
    await send(request);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(statuses()?.player_1).toMatchObject({ status: "running", canCancel: false });
    expect(state.promptReflectionControllers.size).toBe(0);
    await send({ ...request, type: "cancel_prompt_reflection" });
    await send(request);
    expect(statuses()?.player_1?.status).toBe("running");
    expect(reflectPrompt).toHaveBeenCalledOnce();
    saveGate.resolve();
    await vi.waitFor(() => expect(statuses()?.player_1?.status).toBe("completed"));
    await send({ ...request, type: "cancel_prompt_reflection" });
    expect(statuses()?.player_1?.status).toBe("completed");
    expect(await promptStore.list()).toHaveLength(1);
    expect(save).toHaveBeenCalledOnce();
  });

  it("reports exhausted retries without leaking provider content or changing the library", async () => {
    const reflectPrompt = vi.fn(async (_playerId: PlayerId, options?: PromptReflectionOptions) => {
      const error = new Error("Connection error: private-provider-secret");
      options?.onRetry?.({ phase: "retrying", attempt: 3, maxAttempts: 3, delayMs: 0, error });
      throw error;
    });
    const { state, promptStore, matchId, send, statuses } = await createReflectionFixture(reflectPrompt);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await send({ type: "reflect_prompt", matchId, playerId: "player_1" });
    await vi.waitFor(() => expect(statuses()?.player_1?.status).toBe("failed"));
    expect(statuses()?.player_1?.message).toContain("已自动重试 3 次");
    expect(statuses()?.player_1?.message).not.toContain("private-provider-secret");
    expect(await promptStore.list()).toHaveLength(0);
    expect(state.promptReflectionControllers.size).toBe(0);
  });

  it("reports a missing original session instead of starting an independent reflection", async () => {
    const presetStore = await createStore();
    const promptStore = await createPromptStore();
    const state = createServerState(presetStore, undefined, undefined, promptStore);
    const createOrchestrator = vi.spyOn(state, "createOrchestrator");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.matchRegistry.register({
      getMatchId: () => "match_without_session",
      getMatchStatus: () => "finished",
      getGame: () => ({ getState: () => ({ ...createMockGameState(88), winner: "player_2" }) }),
      stop: vi.fn(),
      saveRecord: vi.fn(async () => "logs/records/no-session.match.json"),
    }, { kind: "live", observe: true });
    const ws = { send: vi.fn() };

    await handleClientMessage({
      data: JSON.stringify({ type: "reflect_prompt", matchId: "match_without_session", playerId: "player_1" }),
      ws: ws as any,
      state,
    });

    expect(buildStateMessagePayload(state).observedMatch?.promptReflections?.player_1)
      .toMatchObject({ status: "failed", playerId: "player_1" });
    expect(await promptStore.list()).toHaveLength(0);
    expect(createOrchestrator).not.toHaveBeenCalled();
  });

  it("reports the provider's empty-message failure safely and allows a same-session retry", async () => {
    const promptStore = await createPromptStore();
    const state = createServerState(await createStore(), undefined, undefined, promptStore);
    const reflectPrompt = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("private provider body"), {
        status: 400, param: "messages[5] assistant must provide content, reasoning_content or tool_calls",
      }))
      .mockResolvedValueOnce({ title: "稳健推进", content: "复盘策略", model: "test-model" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const orchestrator = {
      getMatchId: () => "match_failed_reflection", getMatchStatus: () => "finished" as const,
      getGame: () => ({ getState: () => ({ ...createMockGameState(88), winner: "player_1" as const }) }),
      reflectPrompt, stop: vi.fn(), saveRecord: vi.fn(async () => "unused.match.json"),
    };
    state.matchRegistry.register(orchestrator, { kind: "live", observe: true });
    const ws = { send: vi.fn() };
    const request = JSON.stringify({ type: "reflect_prompt", matchId: "match_failed_reflection", playerId: "player_2" });

    await handleClientMessage({ data: request, ws: ws as any, state });
    await vi.waitFor(() => expect(buildStateMessagePayload(state).observedMatch?.promptReflections?.player_2?.status).toBe("failed"));
    const failed = buildStateMessagePayload(state).observedMatch?.promptReflections?.player_2;
    expect(failed?.message).toContain("HTTP 400");
    expect(failed?.message).toContain("第 6 条空会话消息");
    expect(failed?.message).not.toContain("private provider body");
    expect(await promptStore.list()).toHaveLength(0);

    await handleClientMessage({ data: request, ws: ws as any, state });
    await vi.waitFor(async () => expect(await promptStore.list()).toHaveLength(1));
    expect(reflectPrompt).toHaveBeenCalledTimes(2);
    expect(buildStateMessagePayload(state).observedMatch?.promptReflections?.player_2?.status).toBe("completed");
  });

  it("resumes a paused match with its frozen prompt version after a newer version is saved", async () => {
    const presetStore = await createStore();
    const promptStore = await createPromptStore();
    const preset = await presetStore.create({
      name: "Model",
      providerType: "openai-compatible",
      baseURL: "https://api.example.test/v1",
      model: "model-one",
      apiKey: "token",
    });
    const prompt = await promptStore.create({ name: "Stable", content: "Use version one." });
    const frozenVersion = prompt.versions[0]!;
    let status: "running" | "stopped" = "stopped";
    const start = vi.fn(async () => {
      status = "running";
    });
    const stop = vi.fn(() => {
      status = "stopped";
    });
    const createOrchestrator = vi.fn((config) => ({
      getMatchId: () => "match_resumable_prompt",
      getMatchStatus: () => status,
      start,
      stop,
      saveRecord: vi.fn(async () => "logs/records/resumable-prompt.match.json"),
      getGame: () => ({ getState: () => createMockGameState(12) }),
      config,
    }));
    const state = createServerState(presetStore, createOrchestrator, undefined, promptStore);
    const ws = { send: vi.fn() };
    const startMessage = {
      type: "start",
      player1PresetId: preset.id,
      player2PresetId: preset.id,
      prompts: {
        player_1: {
          promptId: prompt.id,
          versionId: frozenVersion.id,
        },
      },
    };

    await handleClientMessage({ data: JSON.stringify(startMessage), ws: ws as any, state });
    await handleClientMessage({
      data: JSON.stringify({ type: "pause_match", matchId: "match_resumable_prompt" }),
      ws: ws as any,
      state,
    });
    await promptStore.update(prompt.id, { content: "Use version two." });
    await handleClientMessage({ data: JSON.stringify(startMessage), ws: ws as any, state });

    expect(createOrchestrator).toHaveBeenCalledTimes(1);
    expect(createOrchestrator).toHaveBeenCalledWith(expect.objectContaining({
      strategyPrompts: {
        player_1: expect.objectContaining({ content: "Use version one." }),
      },
    }));
    expect(start).toHaveBeenCalledTimes(2);
    expect(status).toBe("running");
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
