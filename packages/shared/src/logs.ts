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
  [LOG_LEVELS.DEBUG]: "#888888",
  [LOG_LEVELS.INFO]: "#aaaaaa",
  [LOG_LEVELS.WARNING]: "#ffaa00",
  [LOG_LEVELS.ERROR]: "#ff4444",
} as const;

// ============================================================
// 日志等级图标映射（用于前端显示）
// ============================================================
export const LOG_LEVEL_ICONS: Record<LogLevel, string> = {
  [LOG_LEVELS.DEBUG]: "🔍",
  [LOG_LEVELS.INFO]: "ℹ️",
  [LOG_LEVELS.WARNING]: "⚠️",
  [LOG_LEVELS.ERROR]: "❌",
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
// LOG_TYPES：日志类型名称的简单映射
// ============================================================
export const LOG_TYPES = {
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

export type LogType = typeof LOG_TYPES[keyof typeof LOG_TYPES];

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
// LogType → data 类型的映射表
// ============================================================
export interface GameLogDataMap {
  [LOG_TYPES.GAME_START]: undefined;
  [LOG_TYPES.GAME_STARTED]: undefined;
  [LOG_TYPES.GAME_STOPPED]: undefined;
  [LOG_TYPES.GAME_END]: { winner: string; loser: string };
  [LOG_TYPES.RESOURCE_GATHERED]: {
    playerId: string;
    unitId: string;
    amount: number;
    carryingCredits?: number;
  };
  [LOG_TYPES.CREDITS_DELIVERED]: {
    playerId: string;
    unitId: string;
    buildingId: string;
    amount: number;
    credits: number;
  };
  [LOG_TYPES.BUILDING_CONSTRUCTED]: { command: Command };
  [LOG_TYPES.UNIT_SPAWNED]: { playerId: string; unitType: string };
  [LOG_TYPES.SPAWN_FAILED]: { playerId: string; unitType: string };
  [LOG_TYPES.TICK_ERROR]: { error: string };
  [LOG_TYPES.COMMAND_ERROR]: Record<string, unknown>; // 临时宽类型，稍后细化
  [LOG_TYPES.MOVE_ADJUSTED]: CommandFeedbackData;
  [LOG_TYPES.MOVE_BLOCKED]: CommandFeedbackData;
  [LOG_TYPES.ATTACK_NOT_IN_RANGE]: CommandFeedbackData;
  [LOG_TYPES.ATTACK_IN_RANGE_NO_TARGET]: CommandFeedbackData;
  [LOG_TYPES.BUILD_FAILED]: CommandFeedbackData;
  [LOG_TYPES.SPAWN_COMMAND_FAILED]: CommandFeedbackData;
  [LOG_TYPES.UNKNOWN_COMMAND]: CommandFeedbackData;
}

// ============================================================
// LogMeta（GameLogBase.meta 的完整类型）
// ============================================================
export interface LogMeta {
  level: LogLevel;
  owner: ActorId;
  feedbackTarget: AIFeedbackTarget;
  displayTarget: LogDisplayTarget;
}

/** 所有字段可选的默认 LogMeta */
export type LogMetaDefault = Partial<LogMeta>;

/** 兜底默认值 */
const LOG_META_FALLBACK: LogMeta = {
  level: "info",
  owner: "system_0" as ActorId,
  feedbackTarget: "none",
  displayTarget: "frontend",
};

// ============================================================
// LOG_META_DEFAULTS：每个日志类型的默认元数据
// ============================================================
export const LOG_META_DEFAULTS: Record<LogType, LogMetaDefault> = {
  [LOG_TYPES.GAME_START]: {},
  [LOG_TYPES.GAME_STARTED]: {},
  [LOG_TYPES.GAME_STOPPED]: {},
  [LOG_TYPES.GAME_END]: {},
  [LOG_TYPES.RESOURCE_GATHERED]: { level: "debug" },
  [LOG_TYPES.CREDITS_DELIVERED]: { level: "debug" },
  [LOG_TYPES.BUILDING_CONSTRUCTED]: {},
  [LOG_TYPES.UNIT_SPAWNED]: {},
  [LOG_TYPES.SPAWN_FAILED]: { level: "warning", feedbackTarget: "both" },
  [LOG_TYPES.COMMAND_ERROR]: { level: "error", feedbackTarget: "both" },
  [LOG_TYPES.TICK_ERROR]: { level: "error", feedbackTarget: "both" },
  [LOG_TYPES.MOVE_ADJUSTED]: { level: "warning", feedbackTarget: "both" },
  [LOG_TYPES.MOVE_BLOCKED]: { level: "warning", feedbackTarget: "both" },
  [LOG_TYPES.ATTACK_NOT_IN_RANGE]: { level: "warning", feedbackTarget: "both" },
  [LOG_TYPES.ATTACK_IN_RANGE_NO_TARGET]: { level: "warning", feedbackTarget: "both" },
  [LOG_TYPES.BUILD_FAILED]: { level: "warning", feedbackTarget: "both" },
  [LOG_TYPES.SPAWN_COMMAND_FAILED]: { level: "warning", feedbackTarget: "both" },
  [LOG_TYPES.UNKNOWN_COMMAND]: { level: "error", feedbackTarget: "both" },
};

// ============================================================
// 辅助函数：从 LOG_META_DEFAULTS 查表
// ============================================================
/** 返回指定日志类型的完整 LogMeta（未指定的字段回退到兜底默认值） */
export function defaultLogMeta(logType: LogType): LogMeta {
  const d = LOG_META_DEFAULTS[logType];
  return {
    level: d.level ?? LOG_META_FALLBACK.level,
    owner: d.owner ?? LOG_META_FALLBACK.owner,
    feedbackTarget: d.feedbackTarget ?? LOG_META_FALLBACK.feedbackTarget,
    displayTarget: d.displayTarget ?? LOG_META_FALLBACK.displayTarget,
  };
}

// ============================================================
// GameLog 基础字段（所有日志共有）
// ============================================================
export interface GameLogBase {
  tick: number;
  message: string;
  meta: LogMeta;
}

// ============================================================
// 从映射表推导 GameLog 判别联合类型
// ============================================================
export type GameLog = {
  [T in LogType]: GameLogBase & {
    type: T;
    data: GameLogDataMap[T];
  };
}[LogType];
