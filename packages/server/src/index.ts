import * as dotenv from "dotenv";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import {
  CreateLLMPresetRequest,
  MatchLLMConfig,
  StartMatchMessage,
  UpdateLLMPresetRequest,
} from "@llmcraft/shared";
import WebSocket, { WebSocketServer } from "ws";
import { GameOrchestrator } from "./GameOrchestrator";
import { PresetStore } from "./PresetStore";

dotenv.config();

const PORT = parseInt(process.env.PORT || "3001", 10);
const RECORDS_DIR = path.resolve(process.cwd(), "logs", "records");
const PRESETS_FILE = path.resolve(process.cwd(), "packages", "server", "data", "llm-presets.json");
const PRESET_SECRET_FILE = path.resolve(process.cwd(), "packages", "server", "data", "llm-presets.secret");

interface OrchestratorLike {
  start(): Promise<void>;
  stop(): void;
  saveRecord(): Promise<string>;
  getGame(): {
    getState(): unknown;
    getSnapshots(): Array<unknown>;
  };
}

interface ServerState {
  presetStore: PresetStore;
  orchestrator: OrchestratorLike | null;
  createOrchestrator: (config: MatchLLMConfig) => OrchestratorLike;
}

export function resolvePresetSecret(
  secretFilePath = PRESET_SECRET_FILE,
  envSecret = process.env.LLMCRAFT_PRESET_SECRET
): string {
  if (envSecret !== undefined) {
    if (!envSecret.trim()) {
      throw new Error("LLMCRAFT_PRESET_SECRET 不能为空。");
    }
    return envSecret;
  }

  try {
    const existingSecret = fsSync.readFileSync(secretFilePath, "utf8").trim();
    if (!existingSecret) {
      throw new Error("本地预设密钥文件为空，请删除后重启服务端重新生成。");
    }
    return existingSecret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const generatedSecret = crypto.randomBytes(32).toString("hex");
  fsSync.mkdirSync(path.dirname(secretFilePath), { recursive: true });
  fsSync.writeFileSync(secretFilePath, generatedSecret, "utf8");
  return generatedSecret;
}

export function createPresetStore(options?: {
  filePath?: string;
  secretFilePath?: string;
  envSecret?: string;
}): PresetStore {
  return new PresetStore({
    filePath: options?.filePath || PRESETS_FILE,
    encryptionSecret: resolvePresetSecret(options?.secretFilePath, options?.envSecret),
  });
}

export function createServerState(
  presetStore: PresetStore,
  createOrchestrator: (config: MatchLLMConfig) => OrchestratorLike = (config) => new GameOrchestrator(config)
): ServerState {
  return {
    presetStore,
    orchestrator: null,
    createOrchestrator,
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

function validateCreatePresetRequest(body: CreateLLMPresetRequest) {
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
}

function validateUpdatePresetRequest(body: UpdateLLMPresetRequest) {
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
      sendJson(res, 200, { presets });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/presets") {
      try {
        const body = await readJsonBody<CreateLLMPresetRequest>(req);
        validateCreatePresetRequest(body);
        const preset = await state.presetStore.create(body);
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
        validateUpdatePresetRequest(body);
        const preset = await state.presetStore.update(presetId, body);
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
  ws: Pick<WebSocket, "send">;
  state: ServerState;
};

export async function handleClientMessage({ data, ws, state }: ClientMessageContext): Promise<void> {
  try {
    const message = JSON.parse(data.toString()) as
      | StartMatchMessage
      | { type: "stop" }
      | { type: "save_record" };

    if (message.type === "start") {
      if (!message.player1PresetId || !message.player2PresetId) {
        ws.send(JSON.stringify({
          type: "error",
          message: "启动对局前必须为红蓝双方选择预设。",
        }));
        return;
      }

      const player1 = await state.presetStore.getRuntimeConfig(message.player1PresetId);
      const player2 = await state.presetStore.getRuntimeConfig(message.player2PresetId);
      const previousOrchestrator = state.orchestrator;
      const nextOrchestrator = state.createOrchestrator({ player1, player2 });

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

    if (message.type === "save_record") {
      if (!state.orchestrator) {
        ws.send(JSON.stringify({
          type: "error",
          message: "当前没有可保存的实时对局。",
        }));
        return;
      }

      const filePath = await state.orchestrator.saveRecord();
      ws.send(JSON.stringify({
        type: "record_saved",
        filePath,
      }));
    }
  } catch (error) {
    console.error("消息错误:", error);
    ws.send(JSON.stringify({
      type: "error",
      message: error instanceof Error && error.message === "PRESET_NOT_FOUND"
        ? "所选预设不存在或已被删除。"
        : "处理客户端消息失败。",
    }));
  }
}

function createServer(state: ServerState) {
  const server = http.createServer((req, res) => {
    void handleHttpRequest(req, res, state);
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    console.log("客户端已连接");

    const sendState = async () => {
      const currentOrchestrator = state.orchestrator;
      const gameState = currentOrchestrator?.getGame();
      const presets = await state.presetStore.list();

      ws.send(JSON.stringify({
        type: "state",
        state: gameState?.getState() ?? null,
        snapshots: (gameState?.getSnapshots() ?? []).slice(-100),
        liveEnabled: presets.length > 0,
      }));
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
