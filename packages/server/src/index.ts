import * as dotenv from "dotenv";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { MatchLLMConfig } from "@llmcraft/shared";
import WebSocket, { WebSocketServer } from "ws";
import { GameOrchestrator } from "./GameOrchestrator";

dotenv.config();

const PORT = parseInt(process.env.PORT || "3001");
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const RECORDS_DIR = path.resolve(process.cwd(), "logs", "records");

console.log("启动 LLMCraft 服务器...");
console.log(`模型: ${OPENAI_MODEL}`);
if (OPENAI_BASE_URL) {
  console.log(`API地址: ${OPENAI_BASE_URL}`);
}
if (!OPENAI_KEY) {
  console.log("未检测到 OPENAI_API_KEY，实时对战功能已禁用，可使用回放模式。");
}

const orchestrator = OPENAI_KEY
  ? new GameOrchestrator({
      player1: {
        providerType: "openai-compatible",
        apiKey: OPENAI_KEY,
        baseURL: OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
        model: OPENAI_MODEL,
      },
      player2: {
        providerType: "openai-compatible",
        apiKey: OPENAI_KEY,
        baseURL: OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
        model: OPENAI_MODEL,
      },
    } satisfies MatchLLMConfig)
  : null;

function setCorsHeaders(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
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

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      sendJson(res, 400, { error: "Missing request URL" });
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
        sendJson(res, 400, { error: "Invalid record file name" });
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
          sendJson(res, 404, { error: "Record not found" });
          return;
        }
        console.error("读取记录失败:", error);
        sendJson(res, 500, { error: "Failed to read record" });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("HTTP 处理失败:", error);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

const wss = new WebSocketServer({ server });

console.log(`WebSocket 服务器运行在端口 ${PORT}`);

wss.on("connection", (ws) => {
  console.log("客户端已连接");

  // 发送初始状态
  const sendState = () => {
    const state = orchestrator?.getGame().getState() ?? null;
    const snapshots = orchestrator?.getGame().getSnapshots() ?? [];
    ws.send(JSON.stringify({
      type: "state",
      state,
      snapshots: snapshots.slice(-100),
      liveEnabled: Boolean(orchestrator),
    }));
  };

  sendState();

  // 轮询更新 (100ms 间隔)
  const interval = setInterval(sendState, 100);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "start") {
        if (!orchestrator) {
          ws.send(JSON.stringify({
            type: "error",
            message: "服务端当前处于回放模式，未启用实时对战。",
          }));
          return;
        }
        console.log("收到开始命令");
        void orchestrator.start();
      } else if (msg.type === "stop") {
        if (!orchestrator) {
          return;
        }
        console.log("收到停止命令");
        orchestrator.stop();
      } else if (msg.type === "save_record") {
        if (!orchestrator) {
          ws.send(JSON.stringify({
            type: "error",
            message: "回放模式下没有实时对局可保存。",
          }));
          return;
        }
        void orchestrator.saveRecord().then((filePath) => {
          ws.send(JSON.stringify({
            type: "record_saved",
            filePath,
          }));
        });
      }
    } catch (e) {
      console.error("消息错误:", e);
    }
  });

  ws.on("close", () => {
    console.log("客户端已断开");
    clearInterval(interval);
  });
});

// 优雅关闭
process.on("SIGINT", () => {
  console.log("\n关闭服务器...");
  server.close();
  wss.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`HTTP/WebSocket 服务器运行在端口 ${PORT}`);
});
