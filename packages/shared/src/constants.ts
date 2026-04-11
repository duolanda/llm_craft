export const TICK_INTERVAL_MS = 500;
export const MAP_WIDTH = 21;
export const MAP_HEIGHT = 21;

export const RESULT_CODES = {
  OK: 0,
  ERR_NOT_OWNER: -1,
  ERR_NOT_IN_RANGE: -2,
  ERR_INVALID_TARGET: -3,
  ERR_NOT_ENOUGH_CREDITS: -4,
  ERR_BUSY: -5,
  ERR_POSITION_OCCUPIED: -6,
  ERR_EXCEEDS_SPEED: -7,
  ERR_INVALID_BUILDING: -8,
} as const;

export type ResultCode = typeof RESULT_CODES[keyof typeof RESULT_CODES];

export const UNIT_TYPES = {
  WORKER: "worker",
  SOLDIER: "soldier",
} as const;

export type UnitType = typeof UNIT_TYPES[keyof typeof UNIT_TYPES];

export const BUILDING_TYPES = {
  HQ: "hq",
  BARRACKS: "barracks",
} as const;

export type BuildingType = typeof BUILDING_TYPES[keyof typeof BUILDING_TYPES];

export const UNIT_STATES = {
  IDLE: "idle",
  MOVING: "moving",
  ATTACKING: "attacking",
  GATHERING: "gathering",
} as const;

export type UnitState = typeof UNIT_STATES[keyof typeof UNIT_STATES];

export const TILE_TYPES = {
  EMPTY: "empty",
  OBSTACLE: "obstacle",
  RESOURCE: "resource",
} as const;

export type TileType = typeof TILE_TYPES[keyof typeof TILE_TYPES];

export const UNIT_STATS: Record<UnitType, { hp: number; speed: number; attack: number; cost: number; attackRange: number }> = {
  [UNIT_TYPES.WORKER]: { hp: 50, speed: 1, attack: 0, cost: 50, attackRange: 0 },
  [UNIT_TYPES.SOLDIER]: { hp: 100, speed: 1, attack: 15, cost: 80, attackRange: 1 },
};

export const BUILDING_STATS: Record<BuildingType, { hp: number; cost: number }> = {
  [BUILDING_TYPES.HQ]: { hp: 1000, cost: 0 },
  [BUILDING_TYPES.BARRACKS]: { hp: 300, cost: 120 },
};

export const ECONOMY_RULES = {
  WORKER_CARRY_CAPACITY: 100,
  WORKER_GATHER_RATE: 10,
  HQ_DELIVERY_RANGE: 1,
} as const;

/** 对战玩家标识（仅包含实际对局双方） */
export const PLAYER_IDS = {
  PLAYER_1: "player_1",
  PLAYER_2: "player_2",
} as const;

/** 玩家标识类型 */
export type PlayerId = typeof PLAYER_IDS[keyof typeof PLAYER_IDS];

/** 参与者标识（包含所有对局参与者 + 系统） */
export const ACTOR_IDS = {
  ...PLAYER_IDS,
  SYSTEM: "system_0",
} as const;

/** 参与者标识类型 */
export type ActorId = typeof ACTOR_IDS[keyof typeof ACTOR_IDS];

// 编译期校验：确保 PlayerId 是 ActorId 的子集
const _assertPlayerIsActor: PlayerId extends ActorId ? true : false = true;

/** 参与者颜色配置（用于客户端显示） */
export const PLAYER_COLORS: Record<ActorId, string> = {
  player_1: "#ff2a4a",  // 红色
  player_2: "#00e5ff",  // 青色
  system_0: "#ffb300",  // 金色（系统消息）
};

/** 游戏内通用颜色配置 */
export const GAME_COLORS = {
  empty: "#0d1014",
  obstacle: "#2a3440",
  resource: "#ffb300",
  hq: "#c45fff",
  barracks: "#2979ff",
} as const;
