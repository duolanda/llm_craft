import type { UnitType, BuildingType, UnitState, TileType, ResultCode, PlayerId, AttackTargetType, ProjectileType } from "./constants.js";
import type { GameLog } from "./logs.js";

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

export interface MatchWarmupOptions {
  player_1?: boolean;
  player_2?: boolean;
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

export interface TestLLMPresetRequest {
  presetId?: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey?: string;
  rpm?: number | null;
  reasoningEffort?: OpenAICompatibleReasoningEffort | null;
  extraRequestParams?: Record<string, unknown> | null;
}

export interface TestLLMPresetResponse {
  ok: true;
  model: string;
  baseURL?: string;
  latencyMs: number;
  responseText: string;
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
      targetPriority?: AttackTargetType[];
    }
  | {
      type: "attack";
      targetX?: number;
      targetY?: number;
      targetId?: string;
      targetPriority?: AttackTargetType[];
    }
  | {
      type: "attack_move";
      targetX?: number;
      targetY?: number;
      targetId?: string;
      targetPriority?: AttackTargetType[];
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
      targetPriority?: AttackTargetType[];
    }
  | {
      type: "gather";
      targetX?: number;
      targetY?: number;
      targetId?: string;
      targetPriority?: AttackTargetType[];
    }
  | {
      type: "deposit";
      targetX?: number;
      targetY?: number;
      targetId?: string;
      targetPriority?: AttackTargetType[];
    }
  | {
      type: "build";
      targetX?: number;
      targetY?: number;
      targetId?: string;
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
  // 下一次可开火的 tick，用于武器装填/冷却
  nextAttackTick?: number;
  // 当前正在施工的建筑 ID；施工时 worker 被占用
  constructingBuildingId?: string;
}

export interface Building extends GameObject {
  type: BuildingType;
  hp: number;
  maxHp: number;
  my: boolean;
  playerId: PlayerId;
  productionQueue: UnitType[];
  productionProgress?: {
    unitType: UnitType;
    remainingTicks: number;
    totalTicks: number;
  };
  constructionProgress?: {
    workerId: string;
    remainingTicks: number;
    totalTicks: number;
  };
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
  resourceRemaining?: number;
}

export interface ActiveProjectile {
  id: string;
  playerId: PlayerId;
  attackerId: string;
  attackerType: UnitType;
  projectileType: ProjectileType;
  x: number;
  y: number;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  launchedTick: number;
  impactTick: number;
  targetId?: string;
  targetKind?: "unit" | "building";
  splashRadius?: number;
}

export interface GameState {
  tick: number;
  players: Player[];
  tiles: Tile[][];
  winner: PlayerId | null;
  logs: GameLog[];
  projectiles?: ActiveProjectile[];
}

export interface Command {
  id: string;
  type: string;
  unitId?: string;
  buildingId?: string;
  targetId?: string;
  targetPriority?: AttackTargetType[];
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
  constructionProgress?: Building["constructionProgress"];
}

export interface AgentMapStateCell {
  x: number;
  y: number;
  tile: TileType;
  resourceRemaining?: number;
  unit?: AgentMapStateUnit;
  building?: AgentMapStateBuilding;
}

export interface AgentMapStateResource {
  x: number;
  y: number;
  remaining: number;
}

export interface AgentMapState {
  tick: number;
  width: number;
  height: number;
  units: AgentMapStateUnit[];
  buildings: AgentMapStateBuilding[];
  resources: AgentMapStateResource[];
  cells?: AgentMapStateCell[];
}

export type AgentUnitGroupRole = "worker" | "combat";

export interface AgentUnitGroup {
  role: AgentUnitGroupRole;
  intent: string;
  count: number;
  unitIds: string[];
  types: Partial<Record<UnitType, number>>;
  center?: Position;
  hasActivePlanCount: number;
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

export type PlanCallToolName =
  | "move_unit"
  | "attack_move_unit"
  | "attack"
  | "spawn_unit"
  | "build_structure"
  | "start_harvest_loop"
  | "hold_unit";

export type PlanStepScope = "global" | "per_unit";

export type PlanStepCondition =
  | { condition: "arrived" }
  | { condition: "enemy_in_range" }
  | { condition: "hq_in_range" }
  | { condition: "near_position"; x: number; y: number; distance?: number }
  | { condition: "target_in_range"; targetId: string }
  | { condition: "target_destroyed"; targetId: string }
  | { condition: "credits_at_least"; amount: number }
  | { condition: "building_exists"; buildingType: BuildingType; count?: number }
  | { condition: "enemy_building_exists"; buildingType: BuildingType; count?: number }
  | { condition: "unit_count_at_least"; unitType: UnitType; count: number }
  | { condition: "enemy_unit_count_at_least"; unitType: UnitType; count: number }
  | { condition: "production_queue_empty"; buildingId?: string; buildingType?: BuildingType };

export interface PlanStep {
  call: PlanCallToolName;
  args: Record<string, unknown>;
  scope?: PlanStepScope;
  when?: PlanStepCondition;
  until?: PlanStepCondition;
  retry?: boolean;
  maxTicks?: number;
}

export interface OrchestratePlanInput {
  unitIds: string[];
  replaceExisting?: boolean;
  scope?: PlanStepScope;
  loop?: number;
  steps: PlanStep[];
}

export interface AgentPlanAttemptRecord {
  tick: number;
  stepIndex: number;
  call: PlanCallToolName;
  status: "waiting" | "command_created" | "advanced" | "failed";
  detail?: string;
  commandCount?: number;
}

export interface AgentPlanRecord {
  planId: string;
  unitIds: string[];
  scope?: PlanStepScope;
  loop: number;
  steps: PlanStep[];
  currentStepIndex: number;
  status: "active" | "completed" | "interrupted" | "failed";
  currentStep?: PlanStep;
  waitingReason?: string;
  lastAttempt?: AgentPlanAttemptRecord;
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
      constructingBuildingId?: string | null;
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
      productionProgress?: Building["productionProgress"] | null;
      constructionProgress?: Building["constructionProgress"] | null;
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

// --- Control Plane Types ---

export interface ControlSession {
  id: string;
  gameId: string;
  playerId: PlayerId;
  createdAt: string;
  lastUsedAt: string;
}

export interface ControlError {
  code: string;
  message: string;
  hint?: string;
}

export interface ControlWarning {
  type: string;
  message: string;
}

export interface ControlResponse<T = unknown> {
  ok: boolean;
  tick: number;
  kind: "state" | "selection" | "action_result" | "plan_result" | "batch_result";
  data: T;
  warnings?: ControlWarning[];
  error?: ControlError;
}

export interface CreateControlSessionRequest {
  gameId?: string;
  playerId: PlayerId;
}

export interface ControlToolCallRequest {
  args?: Record<string, unknown>;
}
