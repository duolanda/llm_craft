import * as dotenv from "dotenv";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClientMessage,
  ClientStartBenchmarkMessage,
  CreateLLMPresetRequest,
  GameSnapshot,
  GameState,
  MatchLLMConfig,
  OpenAICompatibleRuntimeConfig,
  ServerMessage,
  UpdateLLMPresetRequest,
  isClientMessage,
} from "@llmcraft/shared";
import WebSocket, { WebSocketServer } from "ws";
import { GameOrchestrator, GameOrchestratorConfig } from "./GameOrchestrator";
import { PresetStore } from "./PresetStore";
import { BenchmarkOrchestrator } from "./benchmark/BenchmarkOrchestrator";

dotenv.config();

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE_PATH);
const SERVER_PACKAGE_DIR = path.resolve(CURRENT_DIR, "..");
const WORKSPACE_ROOT = path.resolve(SERVER_PACKAGE_DIR, "..", "..");

const PORT = parseInt(process.env.PORT || "3001", 10);
const RECORDS_DIR = path.resolve(SERVER_PACKAGE_DIR, "logs", "records");
const LIVE_STATE_SNAPSHOT_LIMIT = 1;

export function getDefaultPresetPaths() {
  return {
    filePath: path.resolve(SERVER_PACKAGE_DIR, "data", "llm-presets.json"),
  };
}

const { filePath: PRESETS_FILE } = getDefaultPresetPaths();
const BUILTIN_PRESET_SECRET = "llms-rule-the-world-oneday";

interface OrchestratorLike {
  start(): Promise<void>;
  stop(): void;
  saveRecord(): Promise<string>;
  getGame(): {
    getState(): GameState | null;
    getSnapshots(): GameSnapshot[];
    getLatestSnapshot?: () => GameSnapshot | null;
  };
}

export interface ServerState {
  presetStore: PresetStore;
  orchestrator: OrchestratorLike | null;
  createOrchestrator: (config: GameOrchestratorConfig) => OrchestratorLike;
  createBenchmarkOrchestrator: (
    config: {
      presetId: string;
      llmConfig: OpenAICompatibleRuntimeConfig;
      cpuStrategy: ClientStartBenchmarkMessage["cpuStrategy"];
      rounds: number;
      recordReplay: boolean;
      decisionIntervalTicks?: number;
      debug?: ClientStartBenchmarkMessage["debug"];
    },
    ws: Pick<WebSocket, "send"> | null
  ) => OrchestratorLike;
  liveEnabled: boolean | null;
}

export function resolvePresetSecret(): string {
  return BUILTIN_PRESET_SECRET;
}

export function createPresetStore(options?: {
  filePath?: string;
}): PresetStore {
  return new PresetStore({
    filePath: options?.filePath || PRESETS_FILE,
    encryptionSecret: resolvePresetSecret(),
  });
}

export function createServerState(
  presetStore: PresetStore,
  createOrchestrator: (config: GameOrchestratorConfig) => OrchestratorLike = (config) => new GameOrchestrator(config),
  createBenchmarkOrchestrator: ServerState["createBenchmarkOrchestrator"] = (config, ws) =>
    new BenchmarkOrchestrator(config, ws)
): ServerState {
  return {
    presetStore,
    orchestrator: null,
    createOrchestrator,
    createBenchmarkOrchestrator,
    liveEnabled: null,
  };
}

type StateMessagePayload = {
  type: "state";
  state: GameState | null;
  snapshots: GameSnapshot[];
  liveEnabled: boolean;
};

async function refreshLiveEnabled(state: ServerState): Promise<boolean> {
  const presets = await state.presetStore.list();
  state.liveEnabled = presets.length > 0;
  return state.liveEnabled;
}

export function buildStateMessagePayload(state: ServerState): StateMessagePayload {
  const currentOrchestrator = state.orchestrator;
  const game = currentOrchestrator?.getGame();
  const latestSnapshot = game?.getLatestSnapshot?.() ?? game?.getSnapshots()?.slice(-LIVE_STATE_SNAPSHOT_LIMIT) ?? [];

  return {
    type: "state",
    state: game?.getState() ?? null,
    snapshots: Array.isArray(latestSnapshot) ? latestSnapshot : latestSnapshot ? [latestSnapshot] : [],
    liveEnabled: Boolean(state.liveEnabled),
  };
}

function setCorsHeaders(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return JSON.parse(raw || "{}") as T;
}

function normalizePresetRpm(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error("RPM 必须是正整数，留空表示不限制。");
  }
  return value;
}

function validateCreatePresetRequest(body: CreateLLMPresetRequest): CreateLLMPresetRequest {
  if (!body.name?.trim()) {
    throw new Error("预设名称不能为空。");
  }
  if (!body.baseURL?.trim()) {
    throw new Error("Base URL 不能为空。");
  }
  if (!body.model?.trim()) {
    throw new Error("模型名称不能为空。");
  }
  if (!body.apiKey?.trim()) {
    throw new Error("API Key 不能为空。");
  }
  if (body.providerType !== "openai-compatible") {
    throw new Error("当前仅支持 OpenAI-compatible 预设。");
  }

  return {
    ...body,
    name: body.name.trim(),
    baseURL: body.baseURL.trim(),
    model: body.model.trim(),
    apiKey: body.apiKey.trim(),
    rpm: normalizePresetRpm(body.rpm),
  };
}

function validateUpdatePresetRequest(body: UpdateLLMPresetRequest): UpdateLLMPresetRequest {
  if (!body.name?.trim()) {
    throw new Error("预设名称不能为空。");
  }
  if (!body.baseURL?.trim()) {
    throw new Error("Base URL 不能为空。");
  }
  if (!body.model?.trim()) {
    throw new Error("模型名称不能为空。");
  }
  if (body.providerType !== "openai-compatible") {
    throw new Error("当前仅支持 OpenAI-compatible 预设。");
  }

  return {
    ...body,
    name: body.name.trim(),
    baseURL: body.baseURL.trim(),
    model: body.model.trim(),
    apiKey: body.apiKey?.trim(),
    rpm: normalizePresetRpm(body.rpm),
  };
}

function parsePresetId(urlPath: string): string {
  const presetId = decodeURIComponent(urlPath.replace("/api/settings/presets/", ""));
  if (!presetId || presetId.includes("/")) {
    throw new Error("预设 ID 无效。");
  }
  return presetId;
}

function sendPresetError(res: http.ServerResponse, error: unknown) {
  if (error instanceof SyntaxError) {
    sendJson(res, 400, { error: "请求体不是有效的 JSON。" });
    return;
  }
  if (error instanceof Error) {
    if (error.message === "PRESET_NOT_FOUND") {
      sendJson(res, 404, { error: "指定的预设不存在。" });
      return;
    }
    sendJson(res, 400, { error: error.message });
    return;
  }
  sendJson(res, 500, { error: "预设操作失败。" });
}

async function listRecordEntries() {
  try {
    const entries = await fs.readdir(RECORDS_DIR, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const fullPath = path.join(RECORDS_DIR, entry.name);
          const stat = await fs.stat(fullPath);
          return {
            fileName: entry.name,
            fullPath,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          };
        })
    );
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: ServerState
): Promise<void> {
  try {
    if (!req.url) {
      sendJson(res, 400, { error: "缺少请求 URL。" });
      return;
    }

    if (req.method === "OPTIONS") {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/api/replay/records") {
      const records = await listRecordEntries();
      sendJson(res, 200, { records });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/replay/records/")) {
      const requestedFile = decodeURIComponent(url.pathname.replace("/api/replay/records/", ""));
      const safeFileName = path.basename(requestedFile);
      if (!safeFileName.endsWith(".json") || safeFileName !== requestedFile) {
        sendJson(res, 400, { error: "记录文件名无效。" });
        return;
      }

      const fullPath = path.join(RECORDS_DIR, safeFileName);
      try {
        const content = await fs.readFile(fullPath, "utf8");
        setCorsHeaders(res);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          sendJson(res, 404, { error: "记录不存在。" });
          return;
        }
        console.error("读取记录失败:", error);
        sendJson(res, 500, { error: "读取记录失败。" });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings/presets") {
      const presets = await state.presetStore.list();
      state.liveEnabled = presets.length > 0;
      sendJson(res, 200, { presets });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/presets") {
      try {
        const body = await readJsonBody<CreateLLMPresetRequest>(req);
        const validatedBody = validateCreatePresetRequest(body);
        const preset = await state.presetStore.create(validatedBody);
        state.liveEnabled = true;
        sendJson(res, 201, { preset });
      } catch (error) {
        sendPresetError(res, error);
      }
      return;
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/settings/presets/")) {
      try {
        const presetId = parsePresetId(url.pathname);
        const body = await readJsonBody<UpdateLLMPresetRequest>(req);
        const validatedBody = validateUpdatePresetRequest(body);
        const preset = await state.presetStore.update(presetId, validatedBody);
        state.liveEnabled = true;
        sendJson(res, 200, { preset });
      } catch (error) {
        sendPresetError(res, error);
      }
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/settings/presets/")) {
      try {
        const presetId = parsePresetId(url.pathname);
        await state.presetStore.delete(presetId);
        await refreshLiveEnabled(state);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendPresetError(res, error);
      }
      return;
    }

    sendJson(res, 404, { error: "未找到请求资源。" });
  } catch (error) {
    console.error("HTTP 处理失败:", error);
    sendJson(res, 500, { error: "服务器内部错误。" });
  }
}

type ClientMessageContext = {
  data: { toString(): string };
  ws: WebSocket;
  state: ServerState;
};

export async function handleClientMessage({ data, ws, state }: ClientMessageContext): Promise<void> {
  try {
    const parsed = JSON.parse(data.toString());
    if (!isClientMessage(parsed)) {
      ws.send(JSON.stringify({
        type: "error",
        message: "未知的消息类型。",
      } satisfies ServerMessage));
      return;
    }

    const message: ClientMessage = parsed;

    if (message.type === "start") {
      if (!message.player1PresetId || !message.player2PresetId) {
        ws.send(JSON.stringify({
          type: "error",
          message: "启动对局前必须为红蓝双方选择预设。",
        } satisfies ServerMessage));
        return;
      }

      const player1 = await state.presetStore.getRuntimeConfig(message.player1PresetId);
      const player2 = await state.presetStore.getRuntimeConfig(message.player2PresetId);
      const previousOrchestrator = state.orchestrator;
      const nextOrchestrator = state.createOrchestrator({ player1, player2, debug: message.debug });

      try {
        await nextOrchestrator.start();
      } catch (error) {
        nextOrchestrator.stop();
        throw error;
      }

      state.orchestrator = nextOrchestrator;
      previousOrchestrator?.stop();
      return;
    }

    if (message.type === "stop") {
      state.orchestrator?.stop();
      return;
    }

    if (message.type === "reset") {
      if (!message.player1PresetId || !message.player2PresetId) {
        ws.send(JSON.stringify({
          type: "error",
          message: "重置对局前必须为红蓝双方选择预设。",
        } satisfies ServerMessage));
        return;
      }

      const player1 = await state.presetStore.getRuntimeConfig(message.player1PresetId);
      const player2 = await state.presetStore.getRuntimeConfig(message.player2PresetId);
      const previousOrchestrator = state.orchestrator;
      const nextOrchestrator = state.createOrchestrator({ player1, player2, debug: message.debug });

      state.orchestrator = nextOrchestrator;
      previousOrchestrator?.stop();
      return;
    }

    if (message.type === "save_record") {
      if (!state.orchestrator) {
        ws.send(JSON.stringify({
          type: "error",
          message: "当前没有可保存的实时对局。",
        } satisfies ServerMessage));
        return;
      }

      const filePath = await state.orchestrator.saveRecord();
      ws.send(JSON.stringify({
        type: "record_saved",
        filePath,
      } satisfies ServerMessage));
      return;
    }

    if (message.type === "start_benchmark") {
      if (!message.presetId) {
        ws.send(JSON.stringify({
          type: "error",
          message: "启动 benchmark 前必须选择一个 LLM 预设。",
        } satisfies ServerMessage));
        return;
      }

      if (!Number.isInteger(message.rounds) || message.rounds <= 0 || message.rounds > 100) {
        ws.send(JSON.stringify({
          type: "error",
          message: "Benchmark 局数必须是 1 到 100 之间的整数。",
        } satisfies ServerMessage));
        return;
      }

      const llmConfig = await state.presetStore.getRuntimeConfig(message.presetId);
      if (llmConfig.providerType !== "openai-compatible") {
        throw new Error("BENCHMARK_PRESET_INVALID");
      }

      const previousOrchestrator = state.orchestrator;
      const benchmarkOrchestrator = state.createBenchmarkOrchestrator(
        {
          presetId: message.presetId,
          llmConfig,
          cpuStrategy: message.cpuStrategy,
          rounds: message.rounds,
          recordReplay: message.recordReplay ?? true,
          decisionIntervalTicks: message.decisionIntervalTicks,
          debug: message.debug,
        },
        ws
      );

      state.orchestrator = benchmarkOrchestrator;
      previousOrchestrator?.stop();

      try {
        await benchmarkOrchestrator.start();
      } catch (error) {
        benchmarkOrchestrator.stop();
        state.orchestrator = previousOrchestrator;
        throw error;
      }

      return;
    }
  } catch (error) {
    console.error("消息错误:", error);
    ws.send(JSON.stringify({
      type: "error",
      message: error instanceof Error
        ? error.message === "PRESET_NOT_FOUND"
          ? "所选预设不存在或已被删除。"
          : error.message === "PRESET_DECRYPT_FAILED"
            ? "预设中的 API Key 无法解密。请重新填写该预设的 API Key。"
            : error.message === "BENCHMARK_PRESET_INVALID"
              ? "Benchmark 只能使用 OpenAI-compatible 预设。"
            : "处理客户端消息失败。"
        : "处理客户端消息失败。",
    } satisfies ServerMessage));
  }
}

function createServer(state: ServerState) {
  const server = http.createServer((req, res) => {
    void handleHttpRequest(req, res, state);
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    console.log("客户端已连接");
    let isSendingState = false;

    const sendState = async () => {
      if (isSendingState) {
        return;
      }
      isSendingState = true;
      try {
        if (state.liveEnabled === null) {
          await refreshLiveEnabled(state);
        }
        ws.send(JSON.stringify(buildStateMessagePayload(state)));
      } finally {
        isSendingState = false;
      }
    };

    void sendState();
    const interval = setInterval(() => {
      void sendState();
    }, 100);

    ws.on("message", (data) => {
      void handleClientMessage({ data, ws, state });
    });

    ws.on("close", () => {
      console.log("客户端已断开");
      clearInterval(interval);
    });
  });

  return { server, wss };
}

export function startServer() {
  const state = createServerState(createPresetStore());
  const { server, wss } = createServer(state);

  console.log("启动 LLMCraft 服务器...");
  console.log(`HTTP/WebSocket 服务器运行在端口 ${PORT}`);

  process.on("SIGINT", () => {
    console.log("\n关闭服务器...");
    state.orchestrator?.stop();
    server.close();
    wss.close();
    process.exit(0);
  });

  server.listen(PORT);
  return { server, wss, state };
}

if (process.env.VITEST !== "true") {
  startServer();
}
