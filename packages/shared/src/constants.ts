export const TICK_INTERVAL_MS = 500;
export const MAP_WIDTH = 144;
export const MAP_HEIGHT = 96;

export interface MapCoordinate {
  x: number;
  y: number;
}

export const DEFAULT_MAP_LAYOUT = {
  centerX: 72,
  centerY: 48,
  player1Hq: { x: 14, y: 48 },
  player2Hq: { x: 129, y: 48 },
  player1Workers: [
    { x: 18, y: 44 },
    { x: 18, y: 46 },
    { x: 18, y: 50 },
    { x: 18, y: 52 },
  ],
  player2Workers: [
    { x: 125, y: 44 },
    { x: 125, y: 46 },
    { x: 125, y: 50 },
    { x: 125, y: 52 },
  ],
  resources: [
    { x: 31, y: 35 }, { x: 34, y: 39 }, { x: 31, y: 57 }, { x: 34, y: 61 },
    { x: 112, y: 35 }, { x: 109, y: 39 }, { x: 112, y: 57 }, { x: 109, y: 61 },
    { x: 47, y: 18 }, { x: 50, y: 22 },
    { x: 47, y: 74 }, { x: 50, y: 78 },
    { x: 96, y: 18 }, { x: 93, y: 22 },
    { x: 96, y: 74 }, { x: 93, y: 78 },
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
  REFINERY: "refinery",
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

export const PROJECTILE_TYPES = {
  INSTANT: "instant",
  BULLET: "bullet",
  SHELL: "shell",
  ROCKET: "rocket",
} as const;

export type ProjectileType = typeof PROJECTILE_TYPES[keyof typeof PROJECTILE_TYPES];

export const ECONOMY_RULES = {
  WORKER_CARRY_CAPACITY: 100,
  WORKER_GATHER_RATE: 10,
  HQ_DELIVERY_RANGE: 1,
  REFINERY_DELIVERY_RANGE: 1,
  RESOURCE_DEPOSIT_CAPACITY: 5000,
} as const;

export interface RulesetUnitDefinition {
  hp: number;
  speed: number;
  attack: number;
  cost: number;
  attackRange: number;
  visionRange: number;
  armor: ArmorType;
  productionTicks: number;
  damageModifiers?: Partial<Record<ArmorType, number>>;
  weapon?: RulesetWeaponDefinition;
}

export interface RulesetWeaponDefinition {
  damage: number;
  range: number;
  minRange?: number;
  reloadTicks: number;
  projectileType: ProjectileType;
  projectileSpeed: number;
  splashRadius?: number;
  splashFalloff?: number[];
  damageModifiers?: Partial<Record<ArmorType, number>>;
  targetPriority?: AttackTargetType[];
}

export interface RulesetBuildingDefinition {
  hp: number;
  cost: number;
  visionRange: number;
  armor: ArmorType;
  produces: UnitType[];
  footprint: { width: number; height: number };
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
    [UNIT_TYPES.WORKER]: { hp: 50, speed: 1, attack: 0, cost: 50, attackRange: 0, visionRange: 5, armor: ARMOR_TYPES.INFANTRY, productionTicks: 4 },
    [UNIT_TYPES.SOLDIER]: {
      hp: 115,
      speed: 1,
      attack: 10,
      cost: 55,
      attackRange: 1,
      visionRange: 5,
      armor: ARMOR_TYPES.INFANTRY,
      productionTicks: 4,
      damageModifiers: {
        [ARMOR_TYPES.INFANTRY]: 1,
        [ARMOR_TYPES.VEHICLE]: 0.25,
        [ARMOR_TYPES.STRUCTURE]: 0.35,
      },
      weapon: {
        damage: 10,
        range: 1,
        reloadTicks: 3,
        projectileType: PROJECTILE_TYPES.INSTANT,
        projectileSpeed: 99,
        damageModifiers: {
          [ARMOR_TYPES.INFANTRY]: 1,
          [ARMOR_TYPES.VEHICLE]: 0.25,
          [ARMOR_TYPES.STRUCTURE]: 0.35,
        },
        targetPriority: [UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.SOLDIER, UNIT_TYPES.WORKER, UNIT_TYPES.LIGHT_TANK, BUILDING_TYPES.BARRACKS, BUILDING_TYPES.REFINERY, BUILDING_TYPES.HQ],
      },
    },
    [UNIT_TYPES.RIFLEMAN]: {
      hp: 95,
      speed: 1,
      attack: 9,
      cost: 70,
      attackRange: 6,
      visionRange: 7,
      armor: ARMOR_TYPES.INFANTRY,
      productionTicks: 6,
      damageModifiers: {
        [ARMOR_TYPES.INFANTRY]: 1.45,
        [ARMOR_TYPES.VEHICLE]: 0.25,
        [ARMOR_TYPES.STRUCTURE]: 0.35,
      },
      weapon: {
        damage: 9,
        range: 6,
        reloadTicks: 2,
        projectileType: PROJECTILE_TYPES.BULLET,
        projectileSpeed: 9,
        damageModifiers: {
          [ARMOR_TYPES.INFANTRY]: 1.45,
          [ARMOR_TYPES.VEHICLE]: 0.25,
          [ARMOR_TYPES.STRUCTURE]: 0.35,
        },
        targetPriority: [UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.SOLDIER, UNIT_TYPES.WORKER, UNIT_TYPES.LIGHT_TANK, BUILDING_TYPES.BARRACKS, BUILDING_TYPES.REFINERY, BUILDING_TYPES.HQ],
      },
    },
    [UNIT_TYPES.ROCKET_SOLDIER]: {
      hp: 80,
      speed: 1,
      attack: 34,
      cost: 110,
      attackRange: 6,
      visionRange: 7,
      armor: ARMOR_TYPES.INFANTRY,
      productionTicks: 8,
      damageModifiers: {
        [ARMOR_TYPES.INFANTRY]: 0.35,
        [ARMOR_TYPES.VEHICLE]: 2.25,
        [ARMOR_TYPES.STRUCTURE]: 0.9,
      },
      weapon: {
        damage: 34,
        range: 6,
        minRange: 2,
        reloadTicks: 8,
        projectileType: PROJECTILE_TYPES.ROCKET,
        projectileSpeed: 4,
        splashRadius: 1,
        splashFalloff: [1, 0.35],
        damageModifiers: {
          [ARMOR_TYPES.INFANTRY]: 0.35,
          [ARMOR_TYPES.VEHICLE]: 2.25,
          [ARMOR_TYPES.STRUCTURE]: 0.9,
        },
        targetPriority: [UNIT_TYPES.LIGHT_TANK, BUILDING_TYPES.WAR_FACTORY, BUILDING_TYPES.BARRACKS, BUILDING_TYPES.HQ, BUILDING_TYPES.REFINERY, UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.RIFLEMAN],
      },
    },
    [UNIT_TYPES.LIGHT_TANK]: {
      hp: 420,
      speed: 1,
      attack: 42,
      cost: 240,
      attackRange: 5,
      visionRange: 7,
      armor: ARMOR_TYPES.VEHICLE,
      productionTicks: 14,
      damageModifiers: {
        [ARMOR_TYPES.INFANTRY]: 0.8,
        [ARMOR_TYPES.VEHICLE]: 1,
        [ARMOR_TYPES.STRUCTURE]: 0.9,
      },
      weapon: {
        damage: 42,
        range: 5,
        reloadTicks: 6,
        projectileType: PROJECTILE_TYPES.SHELL,
        projectileSpeed: 5,
        splashRadius: 1,
        splashFalloff: [1, 0.5],
        damageModifiers: {
          [ARMOR_TYPES.INFANTRY]: 0.8,
          [ARMOR_TYPES.VEHICLE]: 1,
          [ARMOR_TYPES.STRUCTURE]: 0.9,
        },
        targetPriority: [UNIT_TYPES.LIGHT_TANK, UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.SOLDIER, BUILDING_TYPES.WAR_FACTORY, BUILDING_TYPES.BARRACKS, BUILDING_TYPES.HQ, BUILDING_TYPES.REFINERY],
      },
    },
  },
  buildings: {
    [BUILDING_TYPES.HQ]: { hp: 1400, cost: 0, visionRange: 8, armor: ARMOR_TYPES.STRUCTURE, produces: [UNIT_TYPES.WORKER], footprint: { width: 7, height: 7 } },
    [BUILDING_TYPES.BARRACKS]: {
      hp: 420,
      cost: 120,
      visionRange: 6,
      armor: ARMOR_TYPES.STRUCTURE,
      produces: [UNIT_TYPES.SOLDIER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.ROCKET_SOLDIER],
      footprint: { width: 5, height: 5 },
    },
    [BUILDING_TYPES.WAR_FACTORY]: { hp: 650, cost: 220, visionRange: 6, armor: ARMOR_TYPES.STRUCTURE, produces: [UNIT_TYPES.LIGHT_TANK], footprint: { width: 7, height: 5 } },
    [BUILDING_TYPES.REFINERY]: { hp: 560, cost: 300, visionRange: 6, armor: ARMOR_TYPES.STRUCTURE, produces: [], footprint: { width: 5, height: 5 } },
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
    footprint: DEFAULT_RULESET.buildings[BUILDING_TYPES.HQ].footprint,
  },
  [BUILDING_TYPES.BARRACKS]: {
    hp: DEFAULT_RULESET.buildings[BUILDING_TYPES.BARRACKS].hp,
    cost: DEFAULT_RULESET.buildings[BUILDING_TYPES.BARRACKS].cost,
    visionRange: DEFAULT_RULESET.buildings[BUILDING_TYPES.BARRACKS].visionRange,
    armor: DEFAULT_RULESET.buildings[BUILDING_TYPES.BARRACKS].armor,
    footprint: DEFAULT_RULESET.buildings[BUILDING_TYPES.BARRACKS].footprint,
  },
  [BUILDING_TYPES.WAR_FACTORY]: {
    hp: DEFAULT_RULESET.buildings[BUILDING_TYPES.WAR_FACTORY].hp,
    cost: DEFAULT_RULESET.buildings[BUILDING_TYPES.WAR_FACTORY].cost,
    visionRange: DEFAULT_RULESET.buildings[BUILDING_TYPES.WAR_FACTORY].visionRange,
    armor: DEFAULT_RULESET.buildings[BUILDING_TYPES.WAR_FACTORY].armor,
    footprint: DEFAULT_RULESET.buildings[BUILDING_TYPES.WAR_FACTORY].footprint,
  },
  [BUILDING_TYPES.REFINERY]: {
    hp: DEFAULT_RULESET.buildings[BUILDING_TYPES.REFINERY].hp,
    cost: DEFAULT_RULESET.buildings[BUILDING_TYPES.REFINERY].cost,
    visionRange: DEFAULT_RULESET.buildings[BUILDING_TYPES.REFINERY].visionRange,
    armor: DEFAULT_RULESET.buildings[BUILDING_TYPES.REFINERY].armor,
    footprint: DEFAULT_RULESET.buildings[BUILDING_TYPES.REFINERY].footprint,
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
