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
  COMMANDO: "commando",
  LIGHT_TANK: "light_tank",
  FLAME_TANK: "flame_tank",
  HEAVY_TANK: "heavy_tank",
} as const;

export type UnitType = typeof UNIT_TYPES[keyof typeof UNIT_TYPES];

export const BUILDING_TYPES = {
  HQ: "hq",
  BARRACKS: "barracks",
  WAR_FACTORY: "war_factory",
  REFINERY: "refinery",
  MACHINE_GUN_TURRET: "machine_gun_turret",
  ANTI_TANK_TURRET: "anti_tank_turret",
  TECH_CENTER: "tech_center",
} as const;

export type BuildingType = typeof BUILDING_TYPES[keyof typeof BUILDING_TYPES];

export type AttackTargetType = UnitType | BuildingType;

export type TechTier = 1 | 2 | 3;

export const UNIT_STATES = {
  IDLE: "idle",
  MOVING: "moving",
  ATTACKING: "attacking",
  GATHERING: "gathering",
  BUILDING: "building",
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
  FLAME: "flame",
  DEMOLITION: "demolition",
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
  techTier: TechTier;
  unitLimit?: number;
  requires?: BuildingType[];
  damageModifiers?: Partial<Record<ArmorType, number>>;
  weapon?: RulesetWeaponDefinition;
}

export interface RulesetWeaponDefinition {
  damage: number;
  range: number;
  minRange?: number;
  windupTicks?: number;
  continuousFire?: {
    damageIntervalTicks: number;
  };
  instantKill?: boolean;
  reloadTicks: number;
  projectileType: ProjectileType;
  projectileSpeed: number;
  splashRadius?: number;
  splashFalloff?: number[];
  damageModifiers?: Partial<Record<ArmorType, number>>;
  targetOverrides?: Partial<Record<ArmorType, RulesetWeaponTargetOverride>>;
  targetPriority?: AttackTargetType[];
}

export interface RulesetWeaponTargetOverride {
  range?: number;
  minRange?: number;
  reloadTicks?: number;
  projectileType?: ProjectileType;
  projectileSpeed?: number;
  instantKill?: boolean;
}

export interface RulesetBuildingDefinition {
  hp: number;
  cost: number;
  constructionTicks: number;
  visionRange: number;
  armor: ArmorType;
  produces: UnitType[];
  footprint: { width: number; height: number };
  techTier: TechTier;
  requires?: BuildingType[];
  weapon?: RulesetWeaponDefinition;
}

export interface GameRuleset {
  id: string;
  name: string;
  units: Record<UnitType, RulesetUnitDefinition>;
  buildings: Record<BuildingType, RulesetBuildingDefinition>;
  economy: typeof ECONOMY_RULES;
}

export const DEFAULT_RULESET = {
  id: "standard",
  name: "LLMCraft Standard",
  units: {
    [UNIT_TYPES.WORKER]: { hp: 50, speed: 1, attack: 0, cost: 50, attackRange: 0, visionRange: 5, armor: ARMOR_TYPES.INFANTRY, productionTicks: 4, techTier: 1 },
    [UNIT_TYPES.SOLDIER]: {
      hp: 115,
      speed: 1,
      attack: 10,
      cost: 55,
      attackRange: 1,
      visionRange: 5,
      armor: ARMOR_TYPES.INFANTRY,
      productionTicks: 4,
      techTier: 1,
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
        targetPriority: [UNIT_TYPES.COMMANDO, UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.SOLDIER, UNIT_TYPES.WORKER, UNIT_TYPES.LIGHT_TANK, BUILDING_TYPES.BARRACKS, BUILDING_TYPES.REFINERY, BUILDING_TYPES.HQ],
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
      techTier: 1,
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
        targetPriority: [UNIT_TYPES.COMMANDO, UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.SOLDIER, UNIT_TYPES.WORKER, UNIT_TYPES.LIGHT_TANK, BUILDING_TYPES.BARRACKS, BUILDING_TYPES.REFINERY, BUILDING_TYPES.HQ],
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
      techTier: 1,
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
        targetPriority: [UNIT_TYPES.HEAVY_TANK, UNIT_TYPES.LIGHT_TANK, UNIT_TYPES.FLAME_TANK, BUILDING_TYPES.ANTI_TANK_TURRET, BUILDING_TYPES.WAR_FACTORY, BUILDING_TYPES.TECH_CENTER, BUILDING_TYPES.HQ, BUILDING_TYPES.BARRACKS, BUILDING_TYPES.REFINERY, UNIT_TYPES.COMMANDO, UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.RIFLEMAN],
      },
    },
    [UNIT_TYPES.COMMANDO]: {
      hp: 160,
      speed: 1.2,
      attack: 1,
      cost: 600,
      attackRange: 7,
      visionRange: 10,
      armor: ARMOR_TYPES.INFANTRY,
      productionTicks: 24,
      techTier: 3,
      unitLimit: 1,
      requires: [BUILDING_TYPES.TECH_CENTER],
      damageModifiers: {
        [ARMOR_TYPES.INFANTRY]: 1,
        [ARMOR_TYPES.VEHICLE]: 0,
        [ARMOR_TYPES.STRUCTURE]: 0,
      },
      weapon: {
        damage: 1,
        range: 7,
        reloadTicks: 2,
        projectileType: PROJECTILE_TYPES.BULLET,
        projectileSpeed: 14,
        damageModifiers: {
          [ARMOR_TYPES.INFANTRY]: 1,
          [ARMOR_TYPES.VEHICLE]: 0,
          [ARMOR_TYPES.STRUCTURE]: 0,
        },
        targetOverrides: {
          [ARMOR_TYPES.INFANTRY]: { instantKill: true },
          [ARMOR_TYPES.STRUCTURE]: {
            range: 1,
            reloadTicks: 6,
            projectileType: PROJECTILE_TYPES.DEMOLITION,
            projectileSpeed: 99,
            instantKill: true,
          },
        },
        targetPriority: [
          UNIT_TYPES.COMMANDO,
          UNIT_TYPES.ROCKET_SOLDIER,
          UNIT_TYPES.RIFLEMAN,
          UNIT_TYPES.SOLDIER,
          UNIT_TYPES.WORKER,
          BUILDING_TYPES.ANTI_TANK_TURRET,
          BUILDING_TYPES.MACHINE_GUN_TURRET,
          BUILDING_TYPES.TECH_CENTER,
          BUILDING_TYPES.WAR_FACTORY,
          BUILDING_TYPES.BARRACKS,
          BUILDING_TYPES.REFINERY,
          BUILDING_TYPES.HQ,
          UNIT_TYPES.FLAME_TANK,
          UNIT_TYPES.LIGHT_TANK,
          UNIT_TYPES.HEAVY_TANK,
        ],
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
      techTier: 2,
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
        targetPriority: [UNIT_TYPES.HEAVY_TANK, UNIT_TYPES.LIGHT_TANK, UNIT_TYPES.FLAME_TANK, UNIT_TYPES.COMMANDO, UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.SOLDIER, BUILDING_TYPES.ANTI_TANK_TURRET, BUILDING_TYPES.WAR_FACTORY, BUILDING_TYPES.BARRACKS, BUILDING_TYPES.HQ, BUILDING_TYPES.REFINERY],
      },
    },
    [UNIT_TYPES.FLAME_TANK]: {
      hp: 420,
      speed: 1,
      attack: 6,
      cost: 320,
      attackRange: 3,
      visionRange: 7,
      armor: ARMOR_TYPES.VEHICLE,
      productionTicks: 18,
      techTier: 2,
      damageModifiers: {
        [ARMOR_TYPES.INFANTRY]: 2,
        [ARMOR_TYPES.VEHICLE]: 0.2,
        [ARMOR_TYPES.STRUCTURE]: 1.6,
      },
      weapon: {
        damage: 6,
        range: 3,
        windupTicks: 2,
        continuousFire: { damageIntervalTicks: 1 },
        reloadTicks: 1,
        projectileType: PROJECTILE_TYPES.FLAME,
        projectileSpeed: 4,
        splashRadius: 1,
        splashFalloff: [1, 0.65],
        damageModifiers: {
          [ARMOR_TYPES.INFANTRY]: 2,
          [ARMOR_TYPES.VEHICLE]: 0.2,
          [ARMOR_TYPES.STRUCTURE]: 1.6,
        },
        targetPriority: [UNIT_TYPES.COMMANDO, UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.SOLDIER, UNIT_TYPES.WORKER, BUILDING_TYPES.MACHINE_GUN_TURRET, BUILDING_TYPES.BARRACKS, BUILDING_TYPES.REFINERY, BUILDING_TYPES.WAR_FACTORY, BUILDING_TYPES.TECH_CENTER, BUILDING_TYPES.HQ, UNIT_TYPES.FLAME_TANK, UNIT_TYPES.LIGHT_TANK, UNIT_TYPES.HEAVY_TANK, BUILDING_TYPES.ANTI_TANK_TURRET],
      },
    },
    [UNIT_TYPES.HEAVY_TANK]: {
      hp: 850,
      speed: 0.6,
      attack: 90,
      cost: 520,
      attackRange: 6,
      visionRange: 8,
      armor: ARMOR_TYPES.VEHICLE,
      productionTicks: 26,
      techTier: 3,
      requires: [BUILDING_TYPES.TECH_CENTER],
      damageModifiers: {
        [ARMOR_TYPES.INFANTRY]: 0.7,
        [ARMOR_TYPES.VEHICLE]: 1.35,
        [ARMOR_TYPES.STRUCTURE]: 1.15,
      },
      weapon: {
        damage: 90,
        range: 6,
        reloadTicks: 8,
        projectileType: PROJECTILE_TYPES.SHELL,
        projectileSpeed: 5,
        splashRadius: 1,
        splashFalloff: [1, 0.45],
        damageModifiers: {
          [ARMOR_TYPES.INFANTRY]: 0.7,
          [ARMOR_TYPES.VEHICLE]: 1.35,
          [ARMOR_TYPES.STRUCTURE]: 1.15,
        },
        targetPriority: [UNIT_TYPES.HEAVY_TANK, UNIT_TYPES.LIGHT_TANK, UNIT_TYPES.FLAME_TANK, UNIT_TYPES.COMMANDO, BUILDING_TYPES.ANTI_TANK_TURRET, BUILDING_TYPES.TECH_CENTER, BUILDING_TYPES.WAR_FACTORY, BUILDING_TYPES.HQ],
      },
    },
  },
  buildings: {
    [BUILDING_TYPES.HQ]: { hp: 1400, cost: 0, constructionTicks: 0, visionRange: 8, armor: ARMOR_TYPES.STRUCTURE, produces: [UNIT_TYPES.WORKER], footprint: { width: 7, height: 7 }, techTier: 1 },
    [BUILDING_TYPES.BARRACKS]: {
      hp: 420,
      cost: 120,
      constructionTicks: 12,
      visionRange: 6,
      armor: ARMOR_TYPES.STRUCTURE,
      produces: [UNIT_TYPES.SOLDIER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.COMMANDO],
      footprint: { width: 5, height: 5 },
      techTier: 1,
    },
    [BUILDING_TYPES.WAR_FACTORY]: {
      hp: 650,
      cost: 220,
      constructionTicks: 18,
      visionRange: 7,
      armor: ARMOR_TYPES.STRUCTURE,
      produces: [UNIT_TYPES.LIGHT_TANK, UNIT_TYPES.FLAME_TANK, UNIT_TYPES.HEAVY_TANK],
      footprint: { width: 7, height: 5 },
      techTier: 2,
      requires: [BUILDING_TYPES.BARRACKS],
    },
    [BUILDING_TYPES.REFINERY]: { hp: 560, cost: 300, constructionTicks: 16, visionRange: 6, armor: ARMOR_TYPES.STRUCTURE, produces: [], footprint: { width: 5, height: 5 }, techTier: 1 },
    [BUILDING_TYPES.MACHINE_GUN_TURRET]: {
      hp: 380,
      cost: 160,
      constructionTicks: 14,
      visionRange: 9,
      armor: ARMOR_TYPES.STRUCTURE,
      produces: [],
      footprint: { width: 3, height: 3 },
      techTier: 1,
      requires: [BUILDING_TYPES.BARRACKS],
      weapon: {
        damage: 11,
        range: 7,
        reloadTicks: 1,
        projectileType: PROJECTILE_TYPES.BULLET,
        projectileSpeed: 12,
        damageModifiers: {
          [ARMOR_TYPES.INFANTRY]: 1.5,
          [ARMOR_TYPES.VEHICLE]: 0.12,
          [ARMOR_TYPES.STRUCTURE]: 0.1,
        },
        targetPriority: [UNIT_TYPES.COMMANDO, UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.WORKER, UNIT_TYPES.FLAME_TANK, UNIT_TYPES.LIGHT_TANK],
      },
    },
    [BUILDING_TYPES.ANTI_TANK_TURRET]: {
      hp: 520,
      cost: 300,
      constructionTicks: 20,
      visionRange: 10,
      armor: ARMOR_TYPES.STRUCTURE,
      produces: [],
      footprint: { width: 3, height: 3 },
      techTier: 2,
      requires: [BUILDING_TYPES.WAR_FACTORY],
      weapon: {
        damage: 58,
        range: 9,
        reloadTicks: 5,
        projectileType: PROJECTILE_TYPES.SHELL,
        projectileSpeed: 7,
        damageModifiers: {
          [ARMOR_TYPES.INFANTRY]: 0.25,
          [ARMOR_TYPES.VEHICLE]: 1.75,
          [ARMOR_TYPES.STRUCTURE]: 0.4,
        },
        targetPriority: [UNIT_TYPES.HEAVY_TANK, UNIT_TYPES.LIGHT_TANK, UNIT_TYPES.FLAME_TANK, UNIT_TYPES.COMMANDO, UNIT_TYPES.ROCKET_SOLDIER],
      },
    },
    [BUILDING_TYPES.TECH_CENTER]: {
      hp: 600,
      cost: 500,
      constructionTicks: 28,
      visionRange: 7,
      armor: ARMOR_TYPES.STRUCTURE,
      produces: [],
      footprint: { width: 5, height: 5 },
      techTier: 3,
      requires: [BUILDING_TYPES.WAR_FACTORY],
    },
  },
  economy: ECONOMY_RULES,
} satisfies GameRuleset;

// Convenient views of the standard ruleset for diagnostics, tests, and UI code.
export const UNIT_STATS: Record<UnitType, RulesetUnitDefinition> = DEFAULT_RULESET.units;

export const BUILDING_STATS = Object.fromEntries(
  Object.entries(DEFAULT_RULESET.buildings).map(([buildingType, definition]) => {
    const { produces: _produces, ...stats } = definition;
    return [buildingType, stats];
  }),
) as Record<BuildingType, Omit<RulesetBuildingDefinition, "produces">>;

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
  machineGunTurret: "#69a7ff",
  antiTankTurret: "#ff684c",
  techCenter: "#b97cff",
} as const;
