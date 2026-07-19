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
  provenance?: CommandProvenance;
}

export interface CommandProvenance {
  controllerId: string;
  source: "macro_tool" | "mission" | "tactical" | "external" | "subagent" | "test";
  turnId?: string;
  toolCallId?: string;
  missionId?: string;
  parentControllerId?: string;
}

export interface CommandEnvelopeV1 {
  envelopeVersion: 1;
  matchId: string;
  actorId: string;
  baseTick: number;
  applyAtTick: number;
  sequence: number;
  clientRequestId: string;
  commands: Command[];
}

export type CommandEnvelope = CommandEnvelopeV1;

export type CommandEnvelopeRejectCode =
  | "invalid_envelope"
  | "wrong_match"
  | "invalid_tick"
  | "unauthorized_actor"
  | "batch_too_large"
  | "tick_command_budget_exceeded"
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

export type DomainEventType =
  | "command_envelope_accepted"
  | "command_envelope_duplicate"
  | "command_envelope_rejected"
  | "command_envelope_released"
  | "command_envelope_rolled_back"
  | "command_result"
  | "simulation_tick_failed"
  | "resource_gathered"
  | "credits_delivered"
  | "building_completed"
  | "building_cancelled"
  | "unit_spawned"
  | "unit_spawn_failed"
  | "player_eliminated";

export interface DomainEvent<TPayload = Record<string, unknown>> {
  eventVersion: 1;
  matchId: string;
  eventSequence: number;
  tick: number;
  type: DomainEventType;
  actorId?: string;
  commandId?: string;
  entityIds?: string[];
  payload: TPayload;
}

export interface MatchPlayerDefinition {
  id: PlayerId;
  startingCredits: number;
  hq: Position;
  workers: Position[];
}

export interface CommandBudgetPolicy {
  maxCommandsPerActorPerTick: number;
  maxPathCommandsPerTick: number;
}

interface MatchDefinitionBase {
  rulesetId: string;
  scenarioId: string;
  seed: number;
  tickIntervalMs: number;
  map: {
    width: number;
    height: number;
    resources: Position[];
  };
  players: [MatchPlayerDefinition, MatchPlayerDefinition];
  victoryCondition: {
    type: "eliminate_all_buildings";
  };
}

/** Legacy definition persisted before runtime budgets became explicit. */
export interface MatchDefinitionV1 extends MatchDefinitionBase {
  definitionVersion: 1;
}

export interface MatchDefinitionV2 extends MatchDefinitionBase {
  definitionVersion: 2;
  rules: {
    schemaVersion: 1;
    commandBudget: CommandBudgetPolicy;
  };
}

export type MatchDefinition = MatchDefinitionV1 | MatchDefinitionV2;

export type TraceCapabilityState = "complete" | "partial" | "absent";

export interface TraceCapabilitiesV3 {
  commandSubmissions: TraceCapabilityState;
  domainEvents: TraceCapabilityState;
  commandResults: TraceCapabilityState;
  agentTurns: TraceCapabilityState;
  terminalEvents: TraceCapabilityState;
  modelRequestSpans: TraceCapabilityState;
  toolCallSpans: TraceCapabilityState;
  stateHashes: TraceCapabilityState;
  replay: TraceCapabilityState;
}

export interface TraceManifestV3 {
  schemaVersion: 3;
  recordFormat: "trace-v3";
  matchId: string;
  createdAt: string;
  updatedAt: string;
  status: "created" | "running" | "stopped" | "finished" | "failed";
  definition: MatchDefinition;
  capabilities: TraceCapabilitiesV3;
}

export interface TraceStateHashRecord {
  hashVersion: 2;
  tick: number;
  algorithm: "sha256";
  hash: string;
}

export interface TraceCommandSubmissionRecord {
  submissionVersion: 1;
  matchId: string;
  submissionSequence: number;
  receivedAtTick: number;
  envelope: unknown;
  result: CommandEnvelopeSubmissionResult;
}

export type TraceReplayMetadataV1 = Omit<GameRecord["metadata"], "recordFormat">;

/** Cached, reproducible compatibility projection; not an authoritative fact stream. */
export interface TraceReplayProjectionV1 {
  projectionVersion: 1;
  metadata: TraceReplayMetadataV1;
  tickDeltas: TickDeltaRecord[];
  commandResults: GameLog[];
}

/**
 * Formal trace-v3 interchange shape. Active journals may contain only a prefix
 * of these streams until they are atomically finalized into this record.
 */
export interface MatchTraceRecordV3 {
  schemaVersion: 3;
  manifest: TraceManifestV3;
  initialKeyframe: GameState;
  finalKeyframe: GameState;
  commandSubmissions: TraceCommandSubmissionRecord[];
  stateHashes: TraceStateHashRecord[];
  domainEvents: DomainEvent[];
  aiTurns: SavedAITurnRecord[];
  terminalEvents: AITerminalEvent[];
  replayProjection?: TraceReplayProjectionV1;
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
  lastAttempt?: AgentPlanAttemptRecord;
}

export type MissionRecord = AgentPlanRecord;

export interface AgentRunMetrics {
  modelRequests: number;
  toolCalls: number;
  stallDetected: boolean;
  modelRequestRecords?: AgentModelRequestRecord[];
  memory?: AgentMemoryPolicyRecord;
}

export interface AgentMemoryPolicyRecord {
  policyVersion: 1;
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
  messagesVersion?: 1;
  messagesHash?: string;
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

export interface StateFrameMetadataV1 {
  frameVersion: 1;
  frameSequence: number;
  simulationTick: number;
  simulationTimeMs: number;
  tickIntervalMs: number;
  serverTimeMs: number;
}

export interface StateProjectionDeltaV1 {
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

export type StateProjectionFrameV1 =
  | {
      kind: "keyframe";
      metadata: StateFrameMetadataV1;
      state: GameState;
      aiOutputs: Record<string, string>;
    }
  | {
      kind: "delta";
      metadata: StateFrameMetadataV1;
      baseFrameSequence: number;
      delta: StateProjectionDeltaV1;
      aiOutputs: Record<string, string>;
    };

export interface GameRecord {
  metadata: {
    startedAt: string;
    savedAt: string;
    endedAt?: string;
    status: "running" | "stopped" | "finished";
    winner: PlayerId | null;
    aiIntervalTicks: number;
    aiContextWindowTurns: number;
    tickIntervalMs?: number;
    rulesetId?: string;
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
  | "preparing"
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
