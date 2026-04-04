export const TICK_INTERVAL_MS = 500;
export const MAP_WIDTH = 20;
export const MAP_HEIGHT = 20;

export const RESULT_CODES = {
  OK: 0,
  ERR_NOT_OWNER: -1,
  ERR_NOT_IN_RANGE: -2,
  ERR_INVALID_TARGET: -3,
  ERR_NOT_ENOUGH_ENERGY: -4,
  ERR_BUSY: -5,
  ERR_POSITION_OCCUPIED: -6,
  ERR_EXCEEDS_SPEED: -7,
} as const;

export type ResultCode = typeof RESULT_CODES[keyof typeof RESULT_CODES];

export const UNIT_TYPES = {
  WORKER: "worker",
  SOLDIER: "soldier",
  SCOUT: "scout",
} as const;

export type UnitType = typeof UNIT_TYPES[keyof typeof UNIT_TYPES];

export const BUILDING_TYPES = {
  HQ: "hq",
  GENERATOR: "generator",
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

// 修正: 添加attackRange属性
export const UNIT_STATS: Record<UnitType, { hp: number; speed: number; attack: number; cost: number; attackRange: number }> = {
  [UNIT_TYPES.WORKER]: { hp: 50, speed: 1, attack: 5, cost: 50, attackRange: 0 },
  [UNIT_TYPES.SOLDIER]: { hp: 100, speed: 1, attack: 15, cost: 80, attackRange: 1 },
  [UNIT_TYPES.SCOUT]: { hp: 30, speed: 2, attack: 5, cost: 30, attackRange: 0 },
};

export const BUILDING_STATS: Record<BuildingType, { hp: number; cost: number; energyPerTick?: number }> = {
  [BUILDING_TYPES.HQ]: { hp: 1000, cost: 0 },
  [BUILDING_TYPES.GENERATOR]: { hp: 200, cost: 100, energyPerTick: 5 },
  [BUILDING_TYPES.BARRACKS]: { hp: 300, cost: 150 },
};
