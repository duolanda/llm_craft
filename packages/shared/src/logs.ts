import { ResultCode, PlayerId, ActorId } from "./constants";

// ============================================================
// 日志等级
// ============================================================
export const LOG_LEVELS = {
  DEBUG: "debug",
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
} as const;

export type LogLevel = typeof LOG_LEVELS[keyof typeof LOG_LEVELS];

// ============================================================
// 日志等级颜色映射（用于前端/控制台显示）
// ============================================================
export const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "#888888",
  info: "#aaaaaa",
  warning: "#ffaa00",
  error: "#ff4444",
} as const;

// ============================================================
// 日志等级图标映射（用于前端显示）
// ============================================================
export const LOG_LEVEL_ICONS: Record<LogLevel, string> = {
  debug: "🔍",
  info: "ℹ️",
  warning: "⚠️",
  error: "❌",
} as const;

// ============================================================
// 反馈给哪个 AI
// ============================================================
export const AI_FEEDBACK_TARGETS = {
  NONE: "none",
  BOTH: "both",
  PLAYER_1: "player_1",
  PLAYER_2: "player_2",
} as const;

export type AIFeedbackTarget = typeof AI_FEEDBACK_TARGETS[keyof typeof AI_FEEDBACK_TARGETS];

// ============================================================
// 日志展示方式
// ============================================================
export const LOG_DISPLAY_TARGETS = {
  NONE: "none",
  FRONTEND: "frontend",
  BACKEND: "backend",
  BOTH: "both",
} as const;

export type LogDisplayTarget = typeof LOG_DISPLAY_TARGETS[keyof typeof LOG_DISPLAY_TARGETS];

// ============================================================
// 日志类型
// ============================================================
export const GAME_LOG_TYPES = {
  // 游戏生命周期
  GAME_START: "game_start",
  GAME_STARTED: "game_started",
  GAME_STOPPED: "game_stopped",
  GAME_END: "game_end",

  // 经济系统
  RESOURCE_GATHERED: "resource_gathered",
  CREDITS_DELIVERED: "credits_delivered",

  // 建筑系统
  BUILDING_CONSTRUCTED: "building_constructed",

  // 单位系统
  UNIT_SPAWNED: "unit_spawned",
  SPAWN_FAILED: "spawn_failed",

  // 命令执行
  COMMAND_ERROR: "command_error",
  TICK_ERROR: "tick_error",

  // 移动命令反馈
  MOVE_ADJUSTED: "move_adjusted",
  MOVE_BLOCKED: "move_blocked",

  // 攻击命令反馈
  ATTACK_NOT_IN_RANGE: "attack_not_in_range",
  ATTACK_IN_RANGE_NO_TARGET: "attack_in_range_no_target",

  // 建造命令反馈
  BUILD_FAILED: "build_failed",

  // 生产命令反馈
  SPAWN_COMMAND_FAILED: "spawn_command_failed",

  // 未知命令
  UNKNOWN_COMMAND: "unknown_command",

  // AI 反馈（专用）
  AI_FEEDBACK: "ai_feedback",
} as const;

export type GameLogType = typeof GAME_LOG_TYPES[keyof typeof GAME_LOG_TYPES];

// ============================================================
// 命令相关的元数据
// ============================================================
export interface CommandLogMeta {
  x?: number;
  y?: number;
  requestedX?: number;
  requestedY?: number;
  targetId?: string;
  hint?: string;
}

// ============================================================
// GameLogData（日志附带的一般数据）
// ============================================================
export interface GameLogData {
  // 基础数据
  command?: any; // Command 对象（避免循环依赖，使用 any）
  result?: ResultCode;
  error?: string;
  amount?: number;
  carryingCredits?: number;
  credits?: number;
  playerId?: string;
  unitId?: string;
  buildingId?: string;
  unitType?: string;

  // 反馈控制
  phase?: "generation" | "execution" | "command";
  severity?: "error" | "warning";
  code?: string;
  meta?: CommandLogMeta;

  // 其他扩展字段
  [key: string]: any;
}

// ============================================================
// GameLog 基础接口（超集）
// ============================================================
export interface GameLog {
  tick: number;
  type: GameLogType;
  message: string;
  data?: GameLogData;

  // 元数据
  meta?: {
    level: LogLevel;
    owner: ActorId;
    feedbackTarget: AIFeedbackTarget;
    displayTarget: LogDisplayTarget;
  };
}

// ============================================================
// AIFeedback（GameLog 的子集，专用于 AI 反馈）
// ============================================================
export interface AIFeedback {
  tick: number;
  type: GameLogType;
  message: string;
  data?: {
    phase: "generation" | "execution" | "command";
    severity: "error" | "warning";
    code?: string;
    meta?: CommandLogMeta;
    [key: string]: any;
  };

  // AIFeedback 只保留归属信息（仅针对具体玩家）
  meta?: {
    owner: PlayerId;
  };
}

// ============================================================
// 辅助类型：日志类型到默认等级的映射
// ============================================================
export const LOG_TYPE_DEFAULT_LEVEL: Record<GameLogType, LogLevel> = {
  game_start: "info",
  game_started: "info",
  game_stopped: "info",
  game_end: "info",
  resource_gathered: "debug",
  credits_delivered: "debug",
  building_constructed: "info",
  unit_spawned: "info",
  spawn_failed: "warning",
  command_error: "error",
  tick_error: "error",
  move_adjusted: "warning",
  move_blocked: "warning",
  attack_not_in_range: "warning",
  attack_in_range_no_target: "warning",
  build_failed: "warning",
  spawn_command_failed: "warning",
  unknown_command: "error",
  ai_feedback: "warning",
};

// ============================================================
// 辅助函数：根据日志类型判断默认反馈目标
// ============================================================
export function getDefaultFeedbackTarget(logType: GameLogType): AIFeedbackTarget {
  switch (logType) {
    case "move_adjusted":
    case "move_blocked":
    case "attack_not_in_range":
    case "attack_in_range_no_target":
    case "build_failed":
    case "spawn_command_failed":
    case "command_error":
    case "ai_feedback":
      return "both";

    case "tick_error":
    case "unknown_command":
      return "both";

    default:
      return "none";
  }
}
