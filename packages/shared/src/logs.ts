import { ResultCode, PlayerId, ActorId } from "./constants";
import type { Command } from "./types";

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
} as const;

export type GameLogType = typeof GAME_LOG_TYPES[keyof typeof GAME_LOG_TYPES];

// ============================================================
// 命令反馈的 commandMeta（命令执行细节）
// ============================================================
export interface CommandLogMeta {
  x?: number;
  y?: number;
  requestedX?: number;
  requestedY?: number;
  targetId?: string;
  hint?: string;
  [key: string]: unknown;
}

// ============================================================
// 命令反馈共用的 data 结构
// ============================================================
export interface CommandFeedbackData {
  command: Command;
  result: ResultCode;
  phase: "command";
  code: string;
  commandMeta?: CommandLogMeta;
}

// ============================================================
// GameLog 基础字段（所有日志共有）
// ============================================================
export interface GameLogBase {
  tick: number;
  message: string;
  meta: {
    level: LogLevel;
    owner: ActorId;
    feedbackTarget: AIFeedbackTarget;
    displayTarget: LogDisplayTarget;
  };
}

// ============================================================
// GameLogType → data 类型的映射表
// ============================================================
export interface GameLogDataMap {
  game_start: undefined;
  game_started: undefined;
  game_stopped: undefined;
  game_end: { winner: string; loser: string };
  resource_gathered: {
    playerId: string;
    unitId: string;
    amount: number;
    carryingCredits?: number;
  };
  credits_delivered: {
    playerId: string;
    unitId: string;
    buildingId: string;
    amount: number;
    credits: number;
  };
  building_constructed: { command: Command };
  unit_spawned: { playerId: string; unitType: string };
  spawn_failed: { playerId: string; unitType: string };
  tick_error: { error: string };
  command_error: Record<string, unknown>; // 临时宽类型，稍后细化
  move_adjusted: CommandFeedbackData;
  move_blocked: CommandFeedbackData;
  attack_not_in_range: CommandFeedbackData;
  attack_in_range_no_target: CommandFeedbackData;
  build_failed: CommandFeedbackData;
  spawn_command_failed: CommandFeedbackData;
  unknown_command: CommandFeedbackData;
}

/** 命令反馈类型集合 */
export type CommandFeedbackType =
  | "move_adjusted"
  | "move_blocked"
  | "attack_not_in_range"
  | "attack_in_range_no_target"
  | "build_failed"
  | "spawn_command_failed"
  | "unknown_command"
  | "command_error";

// ============================================================
// 从映射表推导 GameLog 判别联合类型
// ============================================================
export type GameLog = {
  [T in GameLogType]: GameLogBase & {
    type: T;
    data: GameLogDataMap[T];
  };
}[GameLogType];

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
};

// ============================================================
// 辅助类型：日志类型到默认反馈目标的映射
// ============================================================
export const LOG_TYPE_DEFAULT_FEEDBACK_TARGET: Record<GameLogType, AIFeedbackTarget> = {
  game_start: "none",
  game_started: "none",
  game_stopped: "none",
  game_end: "none",
  resource_gathered: "none",
  credits_delivered: "none",
  building_constructed: "none",
  unit_spawned: "none",
  spawn_failed: "both",
  command_error: "both",
  tick_error: "both",
  move_adjusted: "both",
  move_blocked: "both",
  attack_not_in_range: "both",
  attack_in_range_no_target: "both",
  build_failed: "both",
  spawn_command_failed: "both",
  unknown_command: "both",
};

// ============================================================
// 辅助类型：日志类型到默认展示目标的映射
// ============================================================
export const LOG_TYPE_DEFAULT_DISPLAY_TARGET: Record<GameLogType, LogDisplayTarget> = {
  game_start: "both",
  game_started: "both",
  game_stopped: "both",
  game_end: "both",
  resource_gathered: "both",
  credits_delivered: "both",
  building_constructed: "both",
  unit_spawned: "both",
  spawn_failed: "both",
  command_error: "both",
  tick_error: "both",
  move_adjusted: "both",
  move_blocked: "both",
  attack_not_in_range: "both",
  attack_in_range_no_target: "both",
  build_failed: "both",
  spawn_command_failed: "both",
  unknown_command: "both",
};

// ============================================================
// 辅助函数：根据日志类型判断默认反馈目标
// ============================================================
export function getDefaultFeedbackTarget(logType: GameLogType): AIFeedbackTarget {
  return LOG_TYPE_DEFAULT_FEEDBACK_TARGET[logType];
}

// ============================================================
// 辅助函数：根据日志类型判断默认展示目标
// ============================================================
export function getDefaultDisplayTarget(logType: GameLogType): LogDisplayTarget {
  return LOG_TYPE_DEFAULT_DISPLAY_TARGET[logType];
}
