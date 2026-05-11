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
  TANK: "tank",
  DEMOLISHER: "demolisher",
} as const;

export type UnitType = typeof UNIT_TYPES[keyof typeof UNIT_TYPES];

export const ARMOR_TYPES = {
  LIGHT: "light",
  HEAVY: "heavy",
} as const;

export type ArmorType = typeof ARMOR_TYPES[keyof typeof ARMOR_TYPES];

export const DAMAGE_TYPES = {
  PIERCING: "piercing",
  EXPLOSIVE: "explosive",
} as const;

export type DamageType = typeof DAMAGE_TYPES[keyof typeof DAMAGE_TYPES];

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

export const UNIT_STATS: Record<UnitType, {
  hp: number;
  speed: number;
  attack: number;
  cost: number;
  attackRange: number;
  armorType: ArmorType;
  damageType?: DamageType;
}> = {
  [UNIT_TYPES.WORKER]:   { hp: 50, speed: 1, attack: 0,  cost: 50,  attackRange: 0, armorType: ARMOR_TYPES.LIGHT },
  [UNIT_TYPES.SOLDIER]:  { hp: 80, speed: 1, attack: 12, cost: 80,  attackRange: 1, armorType: ARMOR_TYPES.LIGHT,  damageType: DAMAGE_TYPES.PIERCING },
  [UNIT_TYPES.TANK]:     { hp: 200, speed: 1, attack: 20, cost: 150, attackRange: 1, armorType: ARMOR_TYPES.HEAVY },
  [UNIT_TYPES.DEMOLISHER]: { hp: 40, speed: 1, attack: 25, cost: 120, attackRange: 3, armorType: ARMOR_TYPES.LIGHT,  damageType: DAMAGE_TYPES.EXPLOSIVE },
};

export const BUILDING_STATS: Record<BuildingType, { hp: number; cost: number; armorType: ArmorType }> = {
  [BUILDING_TYPES.HQ]: { hp: 1000, cost: 0, armorType: ARMOR_TYPES.HEAVY },
  [BUILDING_TYPES.BARRACKS]: { hp: 300, cost: 120, armorType: ARMOR_TYPES.HEAVY },
};

export const ECONOMY_RULES = {
  WORKER_CARRY_CAPACITY: 100,
  WORKER_GATHER_RATE: 10,
  HQ_DELIVERY_RANGE: 1,
} as const;

export const DAMAGE_INTERACTION: Record<DamageType, Record<ArmorType, number>> = {
  [DAMAGE_TYPES.PIERCING]:  { [ARMOR_TYPES.LIGHT]: 1.0, [ARMOR_TYPES.HEAVY]: 0.5 },
  [DAMAGE_TYPES.EXPLOSIVE]: { [ARMOR_TYPES.LIGHT]: 0.5, [ARMOR_TYPES.HEAVY]: 1.5 },
};

export function calculateDamage(
  attackerStats: { attack: number; damageType?: DamageType },
  defenderArmorType: ArmorType,
): number {
  if (attackerStats.attack <= 0) return 0;
  if (!attackerStats.damageType) return attackerStats.attack;
  const multiplier = DAMAGE_INTERACTION[attackerStats.damageType]?.[defenderArmorType] ?? 1;
  return Math.floor(attackerStats.attack * multiplier);
}

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
  [ACTOR_IDS.PLAYER_1]: "#ff2a4a",  // 红色
  [ACTOR_IDS.PLAYER_2]: "#00e5ff",  // 青色
  [ACTOR_IDS.SYSTEM]: "#ffb300",  // 金色（系统消息）
};

/** 游戏内通用颜色配置 */
export const GAME_COLORS = {
  empty: "#0d1014",
  obstacle: "#2a3440",
  resource: "#ffb300",
  hq: "#c45fff",
  barracks: "#2979ff",
  tank: "#76ff03",
  demolisher: "#ff6d00",
} as const;
