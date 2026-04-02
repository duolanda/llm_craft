import * as dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import { GameOrchestrator } from "./GameOrchestrator";

dotenv.config();

const PORT = parseInt(process.env.PORT || "3001");
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!OPENAI_KEY) {
  console.error("需要 OPENAI_API_KEY");
  process.exit(1);
}

console.log("启动 LLMCraft 服务器...");
console.log(`模型: ${OPENAI_MODEL}`);
if (OPENAI_BASE_URL) {
  console.log(`API地址: ${OPENAI_BASE_URL}`);
}

const orchestrator = new GameOrchestrator({
  apiKey: OPENAI_KEY,
  baseURL: OPENAI_BASE_URL,
  model: OPENAI_MODEL,
});
const wss = new WebSocketServer({ port: PORT });

console.log(`WebSocket 服务器运行在端口 ${PORT}`);

wss.on("connection", (ws) => {
  console.log("客户端已连接");

  // 发送初始状态
  const sendState = () => {
    const state = orchestrator.getGame().getState();
    const snapshots = orchestrator.getGame().getSnapshots();
    ws.send(JSON.stringify({
      type: "state",
      state,
      snapshots: snapshots.slice(-100),
    }));
  };

  sendState();

  // 轮询更新 (100ms 间隔)
  const interval = setInterval(sendState, 100);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "start") {
        console.log("收到开始命令");
        orchestrator.start();
      } else if (msg.type === "stop") {
        console.log("收到停止命令");
        orchestrator.stop();
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
  wss.close();
  process.exit(0);
});
