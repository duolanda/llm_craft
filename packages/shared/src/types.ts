import { UnitType, BuildingType, UnitState, TileType, ResultCode } from "./constants";

export interface Position {
  x: number;
  y: number;
}

export interface GameObject {
  id: string;
  x: number;
  y: number;
  exists: boolean;
}

// 修正: 添加attackRange属性
export interface Unit extends GameObject {
  type: UnitType;
  hp: number;
  maxHp: number;
  state: UnitState;
  my: boolean;
  playerId: string;
  attackRange: number; // worker=0, soldier=1, scout=0
  // 意图显示
  intent?: {
    type: 'move' | 'attack' | 'hold';
    targetX?: number;
    targetY?: number;
    targetId?: string;
  };
  // 寻路路径缓存
  path?: Array<{ x: number; y: number }>;
  // 寻路目标
  pathTarget?: { x: number; y: number };
}

export interface Building extends GameObject {
  type: BuildingType;
  hp: number;
  maxHp: number;
  my: boolean;
  playerId: string;
  productionQueue: UnitType[];
}

export interface Resources {
  energy: number;
  energyPerTick: number;
}

export interface Player {
  id: string;
  units: Unit[];
  buildings: Building[];
  resources: Resources;
}

export interface Tile {
  x: number;
  y: number;
  type: TileType;
}

export interface GameState {
  tick: number;
  players: Player[];
  tiles: Tile[][];
  winner: string | null;
  logs: GameLog[];
}

export interface GameLog {
  tick: number;
  type: string;
  message: string;
  data?: any;
}

export interface Command {
  id: string;
  type: string;
  unitId?: string;
  buildingId?: string;
  targetId?: string;
  position?: Position;
  unitType?: UnitType;
  playerId: string;
}

export interface GameSnapshot {
  tick: number;
  state: GameState;
  aiOutputs: Record<string, string>;
}

// 单位属性信息
export interface UnitStats {
  hp: number;
  speed: number;
  attack: number;
  cost: number;
  attackRange: number;
}

// AI State Package for AI Sandbox
export interface AIStatePackage {
  tick: number;
  my: {
    resources: Resources;
    units: Unit[];
    buildings: Building[];
  };
  visibleEnemies: Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
  }>;
  enemyBuildings: Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
  }>;
  map: {
    width: number;
    height: number;
    tiles: Tile[]; // 所有地块信息（MVP：全图可见）
  };
  unitStats: Record<UnitType, UnitStats>; // 单位属性表
  eventsSinceLastCall: GameLog[];
  gameTimeRemaining: number;
}
