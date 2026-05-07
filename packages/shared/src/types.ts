import { UnitType, BuildingType, UnitState, TileType, ResultCode, PlayerId } from "./constants";
import type { GameLog } from "./logs";

export type LLMProviderType = "openai-compatible";

export type CPUStrategyType = "random" | "rush";

export type OpenAICompatibleReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface OpenAICompatibleRuntimeConfig {
  providerType: "openai-compatible";
  apiKey: string;
  baseURL: string;
  model: string;
  rpm?: number | null;
  reasoningEffort?: OpenAICompatibleReasoningEffort | null;
  extraRequestParams?: Record<string, unknown> | null;
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
  reasoningEffort?: OpenAICompatibleReasoningEffort | null;
  extraRequestParams?: Record<string, unknown> | null;
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
  reasoningEffort?: OpenAICompatibleReasoningEffort | null;
  extraRequestParams?: Record<string, unknown> | null;
}

export interface UpdateLLMPresetRequest {
  name: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey?: string;
  rpm?: number | null;
  reasoningEffort?: OpenAICompatibleReasoningEffort | null;
  extraRequestParams?: Record<string, unknown> | null;
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

export type UnitIntent =
  | {
      type: "move";
      targetX?: number;
      targetY?: number;
      targetId?: string;
      targetPriority?: string[];
    }
  | {
      type: "attack";
      targetX?: number;
      targetY?: number;
      targetId?: string;
      targetPriority?: string[];
    }
  | {
      type: "attack_move";
      targetX?: number;
      targetY?: number;
      targetId?: string;
      targetPriority?: string[];
    }
  | {
      type: "harvest_loop";
      targetX?: number;
      targetY?: number;
      targetId?: string;
    }
  | {
      type: "hold";
      targetX?: number;
      targetY?: number;
      targetId?: string;
      targetPriority?: string[];
    }
  | {
      type: "gather";
      targetX?: number;
      targetY?: number;
      targetId?: string;
      targetPriority?: string[];
    }
  | {
      type: "deposit";
      targetX?: number;
      targetY?: number;
      targetId?: string;
      targetPriority?: string[];
    };

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
  intent?: UnitIntent;
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

export interface AgentRunInput {
  playerId: PlayerId;
  tick: number;
  tickIntervalMs: number;
  summary: string;
}

export interface AgentToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}

export interface AgentMapStateUnit {
  id: string;
  type: UnitType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: UnitState;
  relation: "self" | "enemy";
}

export interface AgentMapStateBuilding {
  id: string;
  type: BuildingType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  relation: "self" | "enemy";
}

export interface AgentMapStateCell {
  x: number;
  y: number;
  tile: TileType;
  unit?: AgentMapStateUnit;
  building?: AgentMapStateBuilding;
}

export interface AgentMapState {
  tick: number;
  width: number;
  height: number;
  asciiMap: string;
  units: AgentMapStateUnit[];
  buildings: AgentMapStateBuilding[];
  cells?: AgentMapStateCell[];
}

interface AITerminalEventBase {
  id: string;
  playerId: PlayerId;
  requestNumber: number;
  requestTick: number;
  createdAt: string;
}

export interface AITerminalRequestEvent extends AITerminalEventBase {
  kind: "request";
}

export interface AITerminalAssistantEvent extends AITerminalEventBase {
  kind: "assistant";
  text: string;
}

export interface AITerminalToolCallEvent extends AITerminalEventBase {
  kind: "tool_call";
  toolCall: AgentToolCallRecord;
}

export type AITerminalEvent =
  | AITerminalRequestEvent
  | AITerminalAssistantEvent
  | AITerminalToolCallEvent;

export type PlanCondition =
  | "cargo_full"
  | "cargo_empty"
  | "hq_in_range"
  | "enemy_in_range"
  | { all: PlanCondition[] }
  | { any: PlanCondition[] }
  | { not: PlanCondition };

export type PlanStep =
  | { do: "move_to"; x: number; y: number; formation?: "direct" | "spread" }
  | { do: "hold_position" }
  | { do: "wait_until"; condition: PlanCondition; maxTicks?: number }
  | { do: "branch"; if: PlanCondition; then: PlanStep[]; else?: PlanStep[] }
  | { do: "stop" };

export interface OrchestratePlanInput {
  unitIds: string[];
  replaceExisting?: boolean;
  loop?: number;
  steps: PlanStep[];
}

export interface AgentPlanRecord {
  planId: string;
  unitIds: string[];
  loop: number;
  steps: PlanStep[];
  currentStepIndex: number;
  status: "active" | "completed" | "interrupted" | "failed";
}

export interface AgentRunMetrics {
  modelRequests: number;
  toolCalls: number;
  stallDetected: boolean;
}

export interface AITurnRecord {
  playerId: PlayerId;
  requestTick: number;
  executeTick: number;
  runInput: AgentRunInput;
  assistantMessages: string[];
  toolCalls: AgentToolCallRecord[];
  plans: AgentPlanRecord[];
  commands: Command[];
  stopReason: string;
  metrics: AgentRunMetrics;
  model: string;
  baseURL?: string;
  createdAt: string;
}

export interface SavedAITurnRecord {
  playerId: PlayerId;
  requestTick: number;
  executeTick: number;
  runInput: AgentRunInput;
  assistantMessages: string[];
  toolCalls: AgentToolCallRecord[];
  plans: AgentPlanRecord[];
  commands: Command[];
  stopReason: string;
  metrics: AgentRunMetrics;
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
      intent?: UnitIntent | null;
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
