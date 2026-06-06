export const TICK_INTERVAL_MS = 500;
export const MAP_WIDTH = 37;
export const MAP_HEIGHT = 25;

export interface MapCoordinate {
  x: number;
  y: number;
}

export const DEFAULT_MAP_LAYOUT = {
  centerX: 18,
  centerY: 12,
  player1Hq: { x: 4, y: 12 },
  player2Hq: { x: 32, y: 12 },
  player1Workers: [
    { x: 5, y: 11 },
    { x: 5, y: 13 },
  ],
  player2Workers: [
    { x: 31, y: 11 },
    { x: 31, y: 13 },
  ],
  resources: [
    { x: 4, y: 8 },
    { x: 4, y: 16 },
    { x: 32, y: 8 },
    { x: 32, y: 16 },
    { x: 12, y: 5 },
    { x: 24, y: 5 },
    { x: 12, y: 19 },
    { x: 24, y: 19 },
  ],
} as const;

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
  RIFLEMAN: "rifleman",
  ROCKET_SOLDIER: "rocket_soldier",
  LIGHT_TANK: "light_tank",
} as const;

export type UnitType = typeof UNIT_TYPES[keyof typeof UNIT_TYPES];

export const BUILDING_TYPES = {
  HQ: "hq",
  BARRACKS: "barracks",
  WAR_FACTORY: "war_factory",
} as const;

export type BuildingType = typeof BUILDING_TYPES[keyof typeof BUILDING_TYPES];

export type AttackTargetType = UnitType | BuildingType;

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

export const ARMOR_TYPES = {
  INFANTRY: "infantry",
  VEHICLE: "vehicle",
  STRUCTURE: "structure",
} as const;

export type ArmorType = typeof ARMOR_TYPES[keyof typeof ARMOR_TYPES];

export const ECONOMY_RULES = {
  WORKER_CARRY_CAPACITY: 100,
  WORKER_GATHER_RATE: 10,
  HQ_DELIVERY_RANGE: 1,
} as const;

export interface RulesetUnitDefinition {
  hp: number;
  speed: number;
  attack: number;
  cost: number;
  attackRange: number;
  visionRange: number;
  armor: ArmorType;
  damageModifiers?: Partial<Record<ArmorType, number>>;
}

export interface RulesetBuildingDefinition {
  hp: number;
  cost: number;
  visionRange: number;
  armor: ArmorType;
  produces: UnitType[];
}

export interface GameRuleset {
  id: string;
  name: string;
  units: Record<UnitType, RulesetUnitDefinition>;
  buildings: Record<BuildingType, RulesetBuildingDefinition>;
  economy: typeof ECONOMY_RULES;
}

export const DEFAULT_RULESET = {
  id: "mvp",
  name: "LLMCraft MVP",
  units: {
    [UNIT_TYPES.WORKER]: { hp: 50, speed: 1, attack: 0, cost: 50, attackRange: 0, visionRange: 5, armor: ARMOR_TYPES.INFANTRY },
    [UNIT_TYPES.SOLDIER]: { hp: 100, speed: 1, attack: 12, cost: 80, attackRange: 1, visionRange: 5, armor: ARMOR_TYPES.INFANTRY },
    [UNIT_TYPES.RIFLEMAN]: {
      hp: 90,
      speed: 1,
      attack: 14,
      cost: 90,
      attackRange: 3,
      visionRange: 6,
      armor: ARMOR_TYPES.INFANTRY,
      damageModifiers: {
        [ARMOR_TYPES.INFANTRY]: 1.2,
        [ARMOR_TYPES.VEHICLE]: 0.4,
        [ARMOR_TYPES.STRUCTURE]: 0.55,
      },
    },
    [UNIT_TYPES.ROCKET_SOLDIER]: {
      hp: 80,
      speed: 1,
      attack: 24,
      cost: 140,
      attackRange: 4,
      visionRange: 6,
      armor: ARMOR_TYPES.INFANTRY,
      damageModifiers: {
        [ARMOR_TYPES.INFANTRY]: 0.45,
        [ARMOR_TYPES.VEHICLE]: 2,
        [ARMOR_TYPES.STRUCTURE]: 1,
      },
    },
    [UNIT_TYPES.LIGHT_TANK]: {
      hp: 300,
      speed: 1,
      attack: 30,
      cost: 300,
      attackRange: 3,
      visionRange: 7,
      armor: ARMOR_TYPES.VEHICLE,
      damageModifiers: {
        [ARMOR_TYPES.INFANTRY]: 0.7,
        [ARMOR_TYPES.VEHICLE]: 1,
        [ARMOR_TYPES.STRUCTURE]: 1.2,
      },
    },
  },
  buildings: {
    [BUILDING_TYPES.HQ]: { hp: 1400, cost: 0, visionRange: 8, armor: ARMOR_TYPES.STRUCTURE, produces: [UNIT_TYPES.WORKER] },
    [BUILDING_TYPES.BARRACKS]: {
      hp: 420,
      cost: 120,
      visionRange: 6,
      armor: ARMOR_TYPES.STRUCTURE,
      produces: [UNIT_TYPES.SOLDIER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.ROCKET_SOLDIER],
    },
    [BUILDING_TYPES.WAR_FACTORY]: { hp: 650, cost: 220, visionRange: 6, armor: ARMOR_TYPES.STRUCTURE, produces: [UNIT_TYPES.LIGHT_TANK] },
  },
  economy: ECONOMY_RULES,
} satisfies GameRuleset;

// Compatibility exports for existing diagnostics, tests, and UI code.
export const UNIT_STATS: Record<UnitType, RulesetUnitDefinition> = DEFAULT_RULESET.units;

export const BUILDING_STATS: Record<BuildingType, Omit<RulesetBuildingDefinition, "produces">> = {
  [BUILDING_TYPES.HQ]: {
    hp: DEFAULT_RULESET.buildings[BUILDING_TYPES.HQ].hp,
    cost: DEFAULT_RULESET.buildings[BUILDING_TYPES.HQ].cost,
    visionRange: DEFAULT_RULESET.buildings[BUILDING_TYPES.HQ].visionRange,
    armor: DEFAULT_RULESET.buildings[BUILDING_TYPES.HQ].armor,
  },
  [BUILDING_TYPES.BARRACKS]: {
    hp: DEFAULT_RULESET.buildings[BUILDING_TYPES.BARRACKS].hp,
    cost: DEFAULT_RULESET.buildings[BUILDING_TYPES.BARRACKS].cost,
    visionRange: DEFAULT_RULESET.buildings[BUILDING_TYPES.BARRACKS].visionRange,
    armor: DEFAULT_RULESET.buildings[BUILDING_TYPES.BARRACKS].armor,
  },
  [BUILDING_TYPES.WAR_FACTORY]: {
    hp: DEFAULT_RULESET.buildings[BUILDING_TYPES.WAR_FACTORY].hp,
    cost: DEFAULT_RULESET.buildings[BUILDING_TYPES.WAR_FACTORY].cost,
    visionRange: DEFAULT_RULESET.buildings[BUILDING_TYPES.WAR_FACTORY].visionRange,
    armor: DEFAULT_RULESET.buildings[BUILDING_TYPES.WAR_FACTORY].armor,
  },
};

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
  warFactory: "#ff8840",
} as const;
