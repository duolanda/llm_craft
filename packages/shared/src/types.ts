import { UnitType, BuildingType, UnitState, TileType, ResultCode, PlayerId } from "./constants";
import type { GameLog } from "./logs";

export type LLMProviderType = "openai-compatible";

export type CPUStrategyType = "random" | "rush";

export interface OpenAICompatibleRuntimeConfig {
  providerType: "openai-compatible";
  apiKey: string;
  baseURL: string;
  model: string;
  rpm?: number | null;
}

export interface BuiltinCPURuntimeConfig {
  providerType: "builtin-cpu";
  strategy: CPUStrategyType;
}

export type MatchPlayerLLMConfig = OpenAICompatibleRuntimeConfig | BuiltinCPURuntimeConfig;

export interface MatchDebugOptions {
  recordLLMTranscript?: boolean;
}

export interface MatchLLMConfig {
  player1: MatchPlayerLLMConfig;
  player2: MatchPlayerLLMConfig;
  debug?: MatchDebugOptions;
}

export interface LLMPresetSummary {
  id: string;
  name: string;
  providerType: LLMProviderType;
  baseURL: string;
  model: string;
  rpm?: number | null;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLLMPresetRequest {
  name: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey: string;
  rpm?: number | null;
}

export interface UpdateLLMPresetRequest {
  name: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey?: string;
  rpm?: number | null;
}

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

export interface Unit extends GameObject {
  type: UnitType;
  hp: number;
  maxHp: number;
  state: UnitState;
  my: boolean;
  playerId: PlayerId;
  attackRange: number;
  carryingCredits: number;
  carryCapacity: number;
  // 意图显示
  intent?: {
    type: 'move' | 'attack' | 'hold' | 'gather' | 'deposit';
    targetX?: number;
    targetY?: number;
    targetId?: string;
    targetPriority?: string[];
  };
  // 寻路路径缓存
  path?: Array<{ x: number; y: number }>;
  // 寻路目标
  pathTarget?: { x: number; y: number };
  // 防止同一 tick 重复攻击
  lastAttackTick?: number;
}

export interface Building extends GameObject {
  type: BuildingType;
  hp: number;
  maxHp: number;
  my: boolean;
  playerId: PlayerId;
  productionQueue: UnitType[];
}

export interface Resources {
  credits: number;
}

export interface Player {
  id: PlayerId;
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
  winner: PlayerId | null;
  logs: GameLog[];
}

export interface Command {
  id: string;
  type: string;
  unitId?: string;
  buildingId?: string;
  targetId?: string;
  targetPriority?: string[];
  position?: Position;
  unitType?: UnitType;
  buildingType?: BuildingType;
  playerId: PlayerId;
}

export interface GameSnapshot {
  tick: number;
  state: GameState;
  aiOutputs: Record<string, string>;
}

export interface CommandResult {
  tick: number;
  command: Command;
  result: ResultCode;
  success: boolean;
  message: string;
}

export interface UnitStats {
  hp: number;
  speed: number;
  attack: number;
  cost: number;
  attackRange: number;
}

export interface BuildingStats {
  hp: number;
  cost: number;
}

export interface AIStatePackage {
  tick: number;
  my: {
    resources: Resources;
    units: Unit[];
    buildings: Building[];
  };
  enemies: Array<{
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
  buildingStats: Record<BuildingType, BuildingStats>;
  economy: {
    workerCarryCapacity: number;
    workerGatherRate: number;
    hqDeliveryRange: number;
  };
  aiFeedbackSinceLastCall: GameLog[];
  gameTimeRemaining: number;
}

export interface AIPromptPayload {
  mode: "full" | "delta";
  tick: number;
  tickIntervalMs: number;
  summary: string;
  state: AIStatePackage | null;
  delta: {
    creditsChanged?: number;
    myUnitChanges: Array<{
      id: string;
      type: UnitType;
      change: "created" | "removed" | "moved" | "damaged" | "updated";
      x?: number;
      y?: number;
      hp?: number;
      maxHp?: number;
      state?: UnitState;
      carryingCredits?: number;
      carryCapacity?: number;
    }>;
    myBuildingChanges: Array<{
      id: string;
      type: BuildingType;
      change: "created" | "removed" | "damaged" | "updated";
      x?: number;
      y?: number;
      hp?: number;
      maxHp?: number;
    }>;
    enemyUnitChanges: Array<{
      id: string;
      type: string;
      change: "created" | "removed" | "moved" | "damaged" | "updated";
      x?: number;
      y?: number;
      hp?: number;
      maxHp?: number;
    }>;
    enemyBuildingChanges: Array<{
      id: string;
      type: string;
      change: "created" | "removed" | "damaged" | "updated";
      x?: number;
      y?: number;
      hp?: number;
      maxHp?: number;
    }>;
    aiFeedback: GameLog[];
  } | null;
}

export interface AITurnRecord {
  playerId: PlayerId;
  requestTick: number;
  executeTick: number;
  requestMessages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  promptPayload: AIPromptPayload;
  response: string;
  commands: Command[];
  errorType?: string;
  errorMessage?: string;
  model: string;
  baseURL?: string;
  createdAt: string;
}

export interface SavedAITurnRecord {
  playerId: PlayerId;
  requestTick: number;
  executeTick: number;
  windowMessageCount: number;
  promptPayload: AIPromptPayload;
  response: string;
  commands: Command[];
  errorType?: string;
  errorMessage?: string;
  model: string;
  baseURL?: string;
  createdAt: string;
}

export interface TickDeltaRecord {
  tick: number;
  players: Array<{
    playerId: PlayerId;
    credits?: number;
    units: Array<{
      id: string;
      type: UnitType;
      change: "created" | "removed" | "moved" | "damaged" | "updated";
      x?: number;
      y?: number;
      hp?: number;
      maxHp?: number;
      state?: UnitState;
      attackRange?: number;
      carryingCredits?: number;
      carryCapacity?: number;
    }>;
    buildings: Array<{
      id: string;
      type: BuildingType;
      change: "created" | "removed" | "damaged" | "updated";
      x?: number;
      y?: number;
      hp?: number;
      maxHp?: number;
      productionQueue?: UnitType[];
    }>;
  }>;
  newLogs: GameLog[];
  aiOutputs: Record<string, string>;
  winner?: PlayerId | null;
}

export interface GameRecord {
  metadata: {
    startedAt: string;
    savedAt: string;
    endedAt?: string;
    status: "running" | "stopped" | "finished";
    winner: PlayerId | null;
    aiIntervalTicks: number;
    aiContextWindowTurns: number;
    map: {
      width: number;
      height: number;
    };
    recordFormat: "compact-v2";
    systemPrompt: string;
    players: Array<{
      playerId: PlayerId;
      model: string;
      baseURL?: string;
    }>;
  };
  initialState: GameState;
  finalState: GameState;
  tickDeltas: TickDeltaRecord[];
  commandResults: GameLog[];
  aiTurns: SavedAITurnRecord[];
}
