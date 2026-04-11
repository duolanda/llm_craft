import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresetStore } from "../PresetStore";
import {
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

  it("creates a fresh orchestrator from the selected presets for each player", async () => {
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
      start,
      stop,
      saveRecord,
      getGame,
      config,
    }));
    const state = createServerState(presetStore, createOrchestrator);

    await handleClientMessage({
      data: JSON.stringify({
        type: "start",
        player1PresetId: player1Preset.id,
        player2PresetId: player2Preset.id,
      }),
      ws: { send: vi.fn() } as any,
      state,
    });

    expect(createOrchestrator).toHaveBeenCalledTimes(1);
    expect(createOrchestrator).toHaveBeenCalledWith({
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
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(state.orchestrator).not.toBeNull();
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
      start: vi.fn<[], Promise<void>>(async () => undefined),
      stop: vi.fn<[], void>(() => undefined),
      saveRecord: vi.fn<[], Promise<string>>(async () => "logs/records/old.json"),
      getGame: vi.fn(() => ({
        getState: () => ({ tick: 1 }),
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
    const state = createServerState(presetStore, vi.fn(() => failedOrchestrator as any));
    state.orchestrator = previousOrchestrator;
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
    expect(state.orchestrator).toBe(previousOrchestrator);
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining("处理客户端消息失败"));
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
});
