import { ResultCode, PLAYER_IDS, PlayerId, ActorId, ACTOR_IDS } from "./constants";
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
  ...PLAYER_IDS
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
// RESULT_TYPES：命令结果类型名称的简单映射
// ============================================================
export const RESULT_TYPES = {
  // 移动相关
  MOVE_SUCCESS: "move_success",
  MOVE_ADJUSTED: "move_adjusted",
  MOVE_BLOCKED: "move_blocked",

  // 攻击相关
  ATTACK_SUCCESS: "attack_success",
  ATTACK_OUT_OF_RANGE: "attack_out_of_range",
  ATTACK_NO_TARGET_IN_RANGE: "attack_no_target_in_range",
  ATTACK_INVALID_TARGET: "attack_invalid_target",
  ATTACK_MOVE_SUCCESS: "attack_move_success",

  // 建造相关
  BUILDING_CONSTRUCTED: "building_constructed",
  BUILD_INVALID_POSITION: "build_invalid_position",
  BUILD_INSUFFICIENT_CREDITS: "build_insufficient_credits",
  BUILD_INVALID_BUILDING: "build_invalid_building",

  // 生产相关
  SPAWN_SUCCESS: "spawn_success",
  SPAWN_INSUFFICIENT_CREDITS: "spawn_insufficient_credits",
  SPAWN_INVALID_BUILDING: "spawn_invalid_building",

  // 暂停相关
  HOLD_SUCCESS: "hold_success",
  HARVEST_LOOP_SUCCESS: "harvest_loop_success",

  // 通用错误
  INVALID_UNIT: "invalid_unit",
  COMMAND_CRASHED: "command_crashed",
} as const;

export type ResultType = typeof RESULT_TYPES[keyof typeof RESULT_TYPES];

// ============================================================
// 命令结果的额外数据（按 result_type 分类）
// ============================================================
export interface CommandResultExtraDataMap {
  [RESULT_TYPES.MOVE_SUCCESS]: Record<string, never>;
  [RESULT_TYPES.MOVE_ADJUSTED]: {
    x: number;
    y: number;
    requestedX: number;
    requestedY: number;
    hint: string;
  };
  [RESULT_TYPES.MOVE_BLOCKED]: {
    x: number;
    y: number;
    requestedX: number;
    requestedY: number;
    hint: string;
    type: string;
  };
  [RESULT_TYPES.ATTACK_SUCCESS]: Record<string, never>;
  [RESULT_TYPES.ATTACK_OUT_OF_RANGE]: {
    targetId: string;
    hint: string;
  };
  [RESULT_TYPES.ATTACK_NO_TARGET_IN_RANGE]: {
    hint: string;
  };
  [RESULT_TYPES.ATTACK_INVALID_TARGET]: {
    hint: string;
  };
  [RESULT_TYPES.ATTACK_MOVE_SUCCESS]: Record<string, never>;
  [RESULT_TYPES.BUILDING_CONSTRUCTED]: {
    buildingId: string;
    buildingType: string;
    x: number;
    y: number;
  };
  [RESULT_TYPES.BUILD_INVALID_POSITION]: {
    x: number;
    y: number;
    hint: string;
    type: string;
  };
  [RESULT_TYPES.BUILD_INSUFFICIENT_CREDITS]: {
    x: number;
    y: number;
    requiredCredits: number;
    currentCredits: number;
    hint: string;
  };
  [RESULT_TYPES.BUILD_INVALID_BUILDING]: {
    hint: string;
  };
  [RESULT_TYPES.SPAWN_SUCCESS]: {
    buildingId: string;
    unitType: string;
  };
  [RESULT_TYPES.SPAWN_INSUFFICIENT_CREDITS]: {
    buildingId: string;
    unitType: string;
    requiredCredits: number;
    currentCredits: number;
    hint: string;
  };
  [RESULT_TYPES.SPAWN_INVALID_BUILDING]: {
    buildingId: string;
    buildingType: string;
    unitType: string;
    hint: string;
  };
  [RESULT_TYPES.HOLD_SUCCESS]: {
    unitId: string;
  };
  [RESULT_TYPES.HARVEST_LOOP_SUCCESS]: {
    targetX: number;
    targetY: number;
  };
  [RESULT_TYPES.INVALID_UNIT]: {
    unitId: string;
    hint: string;
  };
  [RESULT_TYPES.COMMAND_CRASHED]: {
    error: string;
  };
}

// ============================================================
// 命令结果数据结构
// ============================================================
export interface CommandResultBase {
  command: Command;
  result_code: ResultCode;
}

export type CommandResultData = {
  [T in ResultType]: CommandResultBase & {
    type: T;
    result_data: CommandResultExtraDataMap[T];
  };
}[ResultType];

// ============================================================
// AI 执行错误数据结构
// ============================================================
export interface AIExecutionErrorData {
  errorType: string;
}

// ============================================================
// LOG_TYPES：日志类型名称的简单映射
// ============================================================
export const LOG_TYPES = {
  // 游戏生命周期
  GAME_INIT: "game_init",
  GAME_STARTED: "game_started",
  GAME_STOPPED: "game_stopped",
  GAME_END: "game_end",

  // 经济系统
  RESOURCE_GATHERED: "resource_gathered",
  CREDITS_DELIVERED: "credits_delivered",

  // 单位系统
  UNIT_SPAWNED: "unit_spawned",
  SPAWN_FAILED: "spawn_failed",

  // 命令执行结果（统一）
  COMMAND_RESULT: "command_result",

  // AI 相关错误
  AI_GENERATION_ERROR: "ai_generation_error",
  AI_EXECUTION_ERROR: "ai_execution_error",

  // Tick 错误
  TICK_ERROR: "tick_error",
} as const;

export type LogType = typeof LOG_TYPES[keyof typeof LOG_TYPES];

// ============================================================
// LogType → data 类型的映射表
// ============================================================
export interface GameLogDataMap {
  [LOG_TYPES.GAME_INIT]: undefined;
  [LOG_TYPES.GAME_STARTED]: undefined;
  [LOG_TYPES.GAME_STOPPED]: undefined;
  [LOG_TYPES.GAME_END]: { winner: PlayerId; loser: PlayerId };
  [LOG_TYPES.RESOURCE_GATHERED]: {
    unitId: string;
    amount: number;
    carryingCredits?: number;
  };
  [LOG_TYPES.CREDITS_DELIVERED]: {
    unitId: string;
    buildingId: string;
    amount: number;
    credits: number;
  };
  [LOG_TYPES.UNIT_SPAWNED]: { unitType: string };
  [LOG_TYPES.SPAWN_FAILED]: { unitType: string };
  [LOG_TYPES.COMMAND_RESULT]: CommandResultData;
  [LOG_TYPES.AI_GENERATION_ERROR]: undefined;
  [LOG_TYPES.AI_EXECUTION_ERROR]: AIExecutionErrorData;
  [LOG_TYPES.TICK_ERROR]: { error: string };
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
  level: LOG_LEVELS.INFO,
  owner: ACTOR_IDS.SYSTEM,
  feedbackTarget: AI_FEEDBACK_TARGETS.NONE,
  displayTarget: LOG_DISPLAY_TARGETS.FRONTEND,
};

// ============================================================
// LOG_META_DEFAULTS：每个日志类型的默认元数据
// ============================================================
export const LOG_META_DEFAULTS: Record<LogType, LogMetaDefault> = {
  [LOG_TYPES.GAME_INIT]: {},
  [LOG_TYPES.GAME_STARTED]: {},
  [LOG_TYPES.GAME_STOPPED]: {},
  [LOG_TYPES.GAME_END]: {},
  [LOG_TYPES.RESOURCE_GATHERED]: { level: LOG_LEVELS.DEBUG },
  [LOG_TYPES.CREDITS_DELIVERED]: { level: LOG_LEVELS.DEBUG },
  [LOG_TYPES.UNIT_SPAWNED]: {},
  [LOG_TYPES.SPAWN_FAILED]: { level: LOG_LEVELS.WARNING, feedbackTarget: AI_FEEDBACK_TARGETS.BOTH },
  [LOG_TYPES.COMMAND_RESULT]: {},
  [LOG_TYPES.AI_GENERATION_ERROR]: { level: LOG_LEVELS.ERROR, feedbackTarget: AI_FEEDBACK_TARGETS.BOTH },
  [LOG_TYPES.AI_EXECUTION_ERROR]: { level: LOG_LEVELS.ERROR, feedbackTarget: AI_FEEDBACK_TARGETS.BOTH },
  [LOG_TYPES.TICK_ERROR]: { level: LOG_LEVELS.ERROR },
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
