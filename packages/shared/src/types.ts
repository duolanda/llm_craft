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
  recordingProfile?: MatchRecordingProfile;
  includeTranscript?: boolean;
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

export interface AttackWindup {
  targetId: string;
  startedTick: number;
  completesAtTick: number;
}

export interface AttackStream {
  targetId: string;
  startedTick: number;
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
      /** Present only for simulation-acquired targets; bounds pursuit around the acquisition point. */
      autoEngagement?: {
        originX: number;
        originY: number;
      };
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
  playerId: PlayerId;
  attackRange: number;
  carryingCredits: number;
  carryCapacity: number;
  /** Authoritative body heading in simulation XY radians; zero points toward +X. */
  heading?: number;
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
  // 权威攻击前摇；目标改变、离开射程或收到移动/停止命令时取消
  attackWindup?: AttackWindup;
  // 权威持续攻击；目标改变、离开射程或收到移动/停止命令时取消
  attackStream?: AttackStream;
  // 当前正在施工的建筑 ID；施工时 worker 被占用
  constructingBuildingId?: string;
}

export type RallyMode = "move" | "attack_move";

export interface RallyPoint extends Position {
  mode: RallyMode;
}

export interface ProductionBatchRequest {
  unitType: UnitType;
  count: number;
}

export interface ProductionOrder extends ProductionBatchRequest {
  orderId: string;
  /** Units from this order that have not spawned yet, including the active unit. */
  remainingCount: number;
}

export type ProductionStatus = "producing" | "waiting_for_credits" | "waiting_for_spawn" | "waiting_for_prerequisite" | "waiting_for_unit_limit";

export interface ProductionProgress {
  orderId: string;
  unitType: UnitType;
  remainingTicks: number;
  totalTicks: number;
  paidCredits: number;
  totalCost: number;
  status: ProductionStatus;
  missingPrerequisites?: BuildingType[];
}

export interface Building extends GameObject {
  type: BuildingType;
  hp: number;
  maxHp: number;
  playerId: PlayerId;
  /** Authoritative defensive-turret heading in simulation XY radians; zero points toward +X. */
  heading?: number;
  /** Persistent destination and travel order assigned to newly produced units. */
  rallyPoint?: RallyPoint;
  productionQueue: ProductionOrder[];
  productionProgress?: ProductionProgress;
  /** Defensive structures use the same deterministic weapon cooldown semantics as units. */
  lastAttackTick?: number;
  nextAttackTick?: number;
  constructionProgress?: {
    workerId: string;
    remainingTicks: number;
    totalTicks: number;
    resumeWorkerOrder?: UnitIntent;
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
  attackerType: AttackTargetType;
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
  productionRequests?: ProductionBatchRequest[];
  productionOrderIds?: string[];
  buildingType?: BuildingType;
  rallyMode?: RallyMode;
  resumeWorkerOrder?: UnitIntent;
  playerId: PlayerId;
  provenance?: CommandProvenance;
}

export interface CommandProvenance {
  controllerId: string;
  source: "macro_tool" | "mission" | "tactical" | "external" | "subagent" | "cpu";
  turnId?: string;
  toolCallId?: string;
  missionId?: string;
  parentControllerId?: string;
}

export interface CommandEnvelope {
  matchId: string;
  actorId: string;
  baseTick: number;
  applyAtTick: number;
  sequence: number;
  clientRequestId: string;
  commands: Command[];
}

export type CommandEnvelopeRejectCode =
  | "invalid_envelope"
  | "wrong_match"
  | "invalid_tick"
  | "unauthorized_actor"
  | "duplicate_command_id"
  | "idempotency_conflict";

export type CommandEnvelopeSubmissionResult =
  | {
      accepted: true;
      duplicate: boolean;
      matchId: string;
      clientRequestId: string;
      applyAtTick: number;
    }
  | {
      accepted: false;
      duplicate: false;
      matchId: string;
      clientRequestId: string;
      code: CommandEnvelopeRejectCode;
      message: string;
    };

export interface MatchPlayerDefinition {
  id: PlayerId;
  startingCredits: number;
}

export interface MapStartingUnit {
  type: UnitType;
  position: Position;
}

export interface MapStartingBuilding {
  type: BuildingType;
  position: Position;
}

export interface MapPlayerStart {
  playerId: PlayerId;
  units: MapStartingUnit[];
  buildings: MapStartingBuilding[];
}

export interface MapDefinition {
  id: string;
  width: number;
  height: number;
  resources: Position[];
  obstacles: Position[];
  playerStarts: [MapPlayerStart, MapPlayerStart];
}

export interface MatchDefinition {
  rulesetId: string;
  tickIntervalMs: number;
  map: MapDefinition;
  players: [MatchPlayerDefinition, MatchPlayerDefinition];
  victoryCondition: {
    type: "eliminate_all_buildings";
  };
}

export type MatchRecordingProfile = "off" | "replay" | "evaluation";

export interface MatchRecordingOptions {
  profile: MatchRecordingProfile;
  includeTranscript: boolean;
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
  turnId?: string;
  controllerId?: string;
  modelRequestIndex?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  observationTick?: number;
  resultTick?: number;
  resultBytes?: number;
  commandIds?: string[];
}

export interface AgentMapStateUnit {
  id: string;
  type: UnitType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  /** Instantaneous simulation phase; intent remains the authoritative durable assignment. */
  phase: UnitState;
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
  rallyPoint?: RallyPoint;
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
  | "build_structure"
  | "start_harvest_loop"
  | "stop_unit"
  | "hold_unit";

export type PlanStepScope = "global" | "per_unit";

export type PlanStepCondition =
  | { condition: "arrived" }
  | { condition: "enemy_in_range" }
  | { condition: "hq_in_range" }
  | { condition: "near_position"; x: number; y: number; distance?: number }
  | { condition: "worker_adjacent_to_build_footprint"; buildingType: BuildingType; x: number; y: number }
  | { condition: "target_in_range"; targetId: string }
  | { condition: "target_destroyed"; targetId: string }
  | { condition: "credits_at_least"; amount: number }
  | { condition: "building_exists"; buildingType: BuildingType; count?: number; x?: number; y?: number }
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
  unitIds?: string[];
  replaceExisting?: boolean;
  scope?: PlanStepScope;
  loop?: number;
  steps: PlanStep[];
}

export interface AgentPlanWaitingDiagnostic {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AgentPlanAttemptRecord {
  tick: number;
  stepIndex: number;
  call: PlanCallToolName;
  status: "waiting" | "command_created" | "advanced" | "failed";
  detail?: string;
  waiting?: AgentPlanWaitingDiagnostic;
  commandCount?: number;
}

export interface AgentPlanRecord {
  planId: string;
  missionId?: string;
  controllerId?: string;
  createdByTurnId?: string;
  unitIds: string[];
  scope?: PlanStepScope;
  loop: number;
  steps: PlanStep[];
  currentStepIndex: number;
  status: "active" | "completed" | "interrupted" | "failed";
  currentStep?: PlanStep;
  waitingReason?: string;
  waiting?: AgentPlanWaitingDiagnostic;
  lastAttempt?: AgentPlanAttemptRecord;
}

export type MissionRecord = AgentPlanRecord;

export interface AgentRunMetrics {
  modelRequests: number;
  toolCalls: number;
  stallDetected: boolean;
  modelRequestRecords?: AgentModelRequestRecord[];
  contextWindow?: ContextWindowLimitRecord;
}

export interface ContextWindowLimitRecord {
  maxMessages: number;
  maxBytes: number;
  messagesBefore: number;
  messagesAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  droppedMessages: number;
  truncatedMessages: number;
}

export interface AgentModelRequestRecord {
  requestIndex: number;
  phase: "warmup" | "turn" | "subagent";
  requestId?: string;
  model?: string;
  finishReason: string;
  latencyMs?: number;
  messageCount: number;
  toolCount: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  status?: "success" | "error";
  attempt?: number;
  retryOfRequestIndex?: number;
  error?: string;
  messages?: unknown[];
}

export interface AITurnRecord {
  turnId?: string;
  controllerId?: string;
  decisionKind?: "macro" | "tactical";
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
  turnId?: string;
  controllerId?: string;
  decisionKind?: "macro" | "tactical";
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
      heading?: number;
      intent?: UnitIntent | null;
      attackWindup?: AttackWindup | null;
      attackStream?: AttackStream | null;
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
      heading?: number;
      rallyPoint?: RallyPoint | null;
      productionQueue?: ProductionOrder[];
      productionProgress?: Building["productionProgress"] | null;
      constructionProgress?: Building["constructionProgress"] | null;
      lastAttackTick?: number;
      nextAttackTick?: number;
    }>;
  }>;
  newLogs: GameLog[];
  aiOutputs: Record<string, string>;
  winner?: PlayerId | null;
}

export interface StateFrameMetadata {
  frameSequence: number;
  simulationTick: number;
  simulationTimeMs: number;
  tickIntervalMs: number;
  serverTimeMs: number;
}

export interface StateProjectionDelta {
  tick: number;
  players: Array<{
    playerId: PlayerId;
    resources?: Player["resources"];
    unitUpserts: Unit[];
    removedUnitIds: string[];
    buildingUpserts: Building[];
    removedBuildingIds: string[];
  }>;
  tileUpserts: Tile[];
  projectiles?: ActiveProjectile[];
  logs: { mode: "append" | "replace"; entries: GameLog[] };
  winner?: PlayerId | null;
}

export type StateProjectionFrame =
  | {
      kind: "keyframe";
      metadata: StateFrameMetadata;
      state: GameState;
      aiOutputs: Record<string, string>;
    }
  | {
      kind: "delta";
      metadata: StateFrameMetadata;
      baseFrameSequence: number;
      delta: StateProjectionDelta;
      aiOutputs: Record<string, string>;
    };

/**
 * The deliberately small state shape used by the live WebSocket projection.
 *
 * This is intentionally separate from GameState/StateProjectionFrame.  Those
 * types are the authoritative simulation and replay format and contain
 * historical logs, static map tiles, and server-only bookkeeping that should
 * not cross the live UI boundary.
 */
export interface LiveUnitIntent {
  type: UnitIntent["type"];
  targetX?: number;
  targetY?: number;
  targetId?: string;
}

export interface LiveUnit {
  id: string;
  type: UnitType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: UnitState;
  playerId: PlayerId;
  heading?: number;
  intent?: LiveUnitIntent;
  lastAttackTick?: number;
}

export interface LiveBuilding {
  id: string;
  type: BuildingType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  playerId: PlayerId;
  heading?: number;
  /** Spectator-facing production state; excludes rally points and simulation-only bookkeeping. */
  productionQueue: ProductionOrder[];
  productionProgress?: ProductionProgress;
  /** Only the live UI-relevant construction indicator crosses the wire. */
  constructionProgress?: {
    remainingTicks: number;
    totalTicks: number;
  };
}

export type LiveProjectile = ActiveProjectile;

export interface LivePlayerState {
  id: PlayerId;
  resources: Resources;
  units: LiveUnit[];
  buildings: LiveBuilding[];
}

export interface LiveStateSnapshot {
  tick: number;
  players: LivePlayerState[];
  winner: PlayerId | null;
  projectiles?: LiveProjectile[];
}

export interface LiveStateProjectionDelta {
  tick: number;
  players: Array<{
    playerId: PlayerId;
    resources?: Resources;
    unitUpserts: LiveUnit[];
    removedUnitIds: string[];
    buildingUpserts: LiveBuilding[];
    removedBuildingIds: string[];
  }>;
  projectiles?: LiveProjectile[];
  winner?: PlayerId | null;
}

export interface LiveStateFrameMetadata {
  frameSequence: number;
  simulationTick: number;
  simulationTimeMs: number;
  tickIntervalMs: number;
}

export type LiveStateProjectionFrame =
  | {
      kind: "keyframe";
      metadata: LiveStateFrameMetadata;
      state: LiveStateSnapshot;
    }
  | {
      kind: "delta";
      metadata: LiveStateFrameMetadata;
      baseFrameSequence: number;
      delta: LiveStateProjectionDelta;
    };

export interface MatchRecord {
  recordFormat: "match-record";
  matchId: string;
  definition: MatchDefinition;
  metadata: {
    startedAt: string;
    savedAt: string;
    endedAt?: string;
    status: "running" | "stopped" | "finished" | "failed";
    winner: PlayerId | null;
    recordingProfile: Exclude<MatchRecordingProfile, "off">;
    includeTranscript: boolean;
    systemPrompt?: string;
    players: Array<{
      playerId: PlayerId;
      model: string;
      baseURL?: string;
    }>;
  };
  initialState: GameState;
  finalState: GameState;
  tickDeltas: TickDeltaRecord[];
  commandResults?: GameLog[];
  aiTurns?: SavedAITurnRecord[];
}

/** @deprecated Use MatchRecord. */
export type GameRecord = MatchRecord;

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

export interface ControlBatchAction {
  tool: string;
  args?: Record<string, unknown>;
}

export interface ControlActionBatchRequest {
  clientRequestId: string;
  actions: ControlBatchAction[];
}

export type MatchRegistryKind = "live" | "control" | "benchmark";

export type MatchRegistryStatus =
  | "warming_up"
  | "waiting_for_players"
  | "running"
  | "stopped"
  | "finished"
  | "failed";

export interface MatchRegistrySummary {
  matchId: string;
  kind: MatchRegistryKind;
  status: MatchRegistryStatus;
  tick: number;
  winner: PlayerId | null;
  createdAt: string;
  label?: string;
  parentId?: string;
  observed: boolean;
}

export interface MatchRegistryListResponse {
  matches: MatchRegistrySummary[];
  observedMatchId: string | null;
}
