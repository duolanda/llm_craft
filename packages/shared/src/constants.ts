export const TICK_INTERVAL_MS = 500;
export const MAP_WIDTH = 20;
export const MAP_HEIGHT = 20;

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
