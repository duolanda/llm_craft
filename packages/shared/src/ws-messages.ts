import { PlayerId } from "./constants";
import { AITerminalEvent, CPUStrategyType, GameState, GameSnapshot, MatchDebugOptions, MatchPlayerLLMConfig, MatchWarmupOptions } from "./types";

// ============================================================
// WebSocket 消息类型契约
// 前后端共享定义，确保编译时类型安全
// ============================================================

// ---------- 客户端 → 服务端 ----------

/** 开始 AI 对战模拟（携带完整 LLM 配置，不再通过 presetId 查找） */
export interface ClientStartMatchMessage {
  type: "start";
  player1: MatchPlayerLLMConfig;
  player2: MatchPlayerLLMConfig;
  debug?: MatchDebugOptions;
}

/** 赛前准备指定 AI：发送首个真实 agent 请求，但不启动游戏 tick */
export interface ClientPrepareMatchMessage {
  type: "prepare";
  player1: MatchPlayerLLMConfig;
  player2: MatchPlayerLLMConfig;
  debug?: MatchDebugOptions;
  warmup?: MatchWarmupOptions;
}

/** 重置当前对局（携带完整 LLM 配置） */
export interface ClientResetMatchMessage {
  type: "reset";
  player1: MatchPlayerLLMConfig;
  player2: MatchPlayerLLMConfig;
  debug?: MatchDebugOptions;
}

/** 停止 AI 对战模拟 */
export interface ClientStopMessage {
  type: "stop";
}

/** 保存当前对局记录 */
export interface ClientSaveRecordMessage {
  type: "save_record";
}

/** 开始 LLM 对 CPU 的 benchmark（携带完整 LLM 配置） */
export interface ClientStartBenchmarkMessage {
  type: "start_benchmark";
  player: MatchPlayerLLMConfig;
  cpuStrategy: CPUStrategyType;
  rounds: number;
  recordReplay?: boolean;
  decisionIntervalTicks?: number;
  debug?: MatchDebugOptions;
}

/** 所有客户端发送的消息联合类型 */
export type ClientMessage =
  | ClientStartMatchMessage
  | ClientPrepareMatchMessage
  | ClientResetMatchMessage
  | ClientStopMessage
  | ClientSaveRecordMessage
  | ClientStartBenchmarkMessage;

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

export interface ServerAITerminalEventsMessage {
  type: "ai_terminal_events";
  sessionId: string | null;
  reset: boolean;
  events: AITerminalEvent[];
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

export interface ServerBenchmarkProgressMessage {
  type: "benchmark_progress";
  cpuStrategy: CPUStrategyType;
  completedRounds: number;
  totalRounds: number;
  llmWins: number;
  cpuWins: number;
  draws: number;
}

export interface ServerBenchmarkRoundResult {
  round: number;
  llmSide: "player_1" | "player_2";
  winner: "llm" | "cpu" | "draw";
  durationTicks: number;
  recordPath?: string;
  transcriptPath?: string;
}

export interface ServerBenchmarkCompleteMessage {
  type: "benchmark_complete";
  cpuStrategy: CPUStrategyType;
  model: string;
  totalRounds: number;
  completedRounds: number;
  llmWins: number;
  cpuWins: number;
  draws: number;
  llmWinRate: number;
  averageDurationTicks: number;
  stopped: boolean;
  rounds: ServerBenchmarkRoundResult[];
}

export type MatchPrepareState = "idle" | "preparing" | "ready" | "error";

export interface ServerPrepareStatusMessage {
  type: "prepare_status";
  statuses: Partial<Record<PlayerId, MatchPrepareState>>;
  message?: string;
}

/** 所有服务端发送的消息联合类型 */
export type ServerMessage =
  | ServerStateMessage
  | ServerAITerminalEventsMessage
  | ServerErrorMessage
  | ServerRecordSavedMessage
  | ServerBenchmarkProgressMessage
  | ServerBenchmarkCompleteMessage
  | ServerPrepareStatusMessage;

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
