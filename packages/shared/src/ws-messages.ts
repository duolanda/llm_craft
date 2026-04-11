import { GameState, GameSnapshot, ResetMatchMessage, StartMatchMessage } from "./types";

// ============================================================
// WebSocket 消息类型契约
// 前后端共享定义，确保编译时类型安全
// ============================================================

// ---------- 客户端 → 服务端 ----------

/** 停止 AI 对战模拟 */
export interface ClientStopMessage {
  type: "stop";
}

/** 保存当前对局记录 */
export interface ClientSaveRecordMessage {
  type: "save_record";
}

/** 所有客户端发送的消息联合类型 */
export type ClientMessage =
  | StartMatchMessage
  | ResetMatchMessage
  | ClientStopMessage
  | ClientSaveRecordMessage;

/** 客户端消息类型字符串（用于路由） */
export type ClientMessageType = ClientMessage["type"];

// ---------- 服务端 → 客户端 ----------

/** 游戏状态推送（连接时 + 状态变化时） */
export interface ServerStateMessage {
  type: "state";
  state: GameState | null;
  snapshots: GameSnapshot[];
  liveEnabled: boolean;
}

/** 错误通知 */
export interface ServerErrorMessage {
  type: "error";
  message: string;
}

/** 对局记录保存成功通知 */
export interface ServerRecordSavedMessage {
  type: "record_saved";
  filePath: string;
}

/** 所有服务端发送的消息联合类型 */
export type ServerMessage =
  | ServerStateMessage
  | ServerErrorMessage
  | ServerRecordSavedMessage;

/** 服务端消息类型字符串（用于路由） */
export type ServerMessageType = ServerMessage["type"];

// ---------- 辅助类型 ----------

/** 解析服务端消息 JSON 后的类型守卫 */
export function isServerMessage(data: unknown): data is ServerMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    typeof (data as { type: string }).type === "string"
  );
}

/** 解析客户端消息 JSON 后的类型守卫 */
export function isClientMessage(data: unknown): data is ClientMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    typeof (data as { type: string }).type === "string"
  );
}
