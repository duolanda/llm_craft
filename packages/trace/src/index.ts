import type {
  AITerminalEvent,
  DomainEvent,
  DomainEventType,
  GameRecord,
  GameState,
  MatchDefinition,
  MatchTraceRecordV3,
  SavedAITurnRecord,
  TickDeltaRecord,
  TraceCapabilitiesV3,
  TraceCapabilityState,
  TraceCommandSubmissionRecord,
  TraceManifestV3,
  TraceReplayProjectionV1,
  TraceStateHashRecord,
  GameLog,
  Command,
  ResultType,
  ResultCode,
  ActorId,
  AIFeedbackTarget,
  StateProjectionDeltaV1,
  StateProjectionFrameV1,
} from "@llmcraft/shared";
import {
  AI_FEEDBACK_TARGETS,
  LOG_LEVELS,
  LOG_TYPES,
  defaultLogMeta,
} from "@llmcraft/shared";

export * from "./analysis.js";

const CAPABILITY_KEYS = [
  "commandSubmissions",
  "domainEvents",
  "commandResults",
  "agentTurns",
  "terminalEvents",
  "modelRequestSpans",
  "toolCallSpans",
  "stateHashes",
  "replay",
] as const satisfies readonly (keyof TraceCapabilitiesV3)[];

const CAPABILITY_STATES = new Set<TraceCapabilityState>(["complete", "partial", "absent"]);
const TRACE_STATUSES = new Set<TraceManifestV3["status"]>([
  "created",
  "running",
  "stopped",
  "finished",
  "failed",
]);
const DOMAIN_EVENT_TYPES = new Set<DomainEventType>([
  "command_envelope_accepted",
  "command_envelope_duplicate",
  "command_envelope_rejected",
  "command_envelope_released",
  "command_envelope_rolled_back",
  "command_result",
  "simulation_tick_failed",
  "resource_gathered",
  "credits_delivered",
  "building_completed",
  "building_cancelled",
  "unit_spawned",
  "unit_spawn_failed",
  "player_eliminated",
]);

export type SupportedRecordFormat = "compact-v2" | "trace-v3";

export class TraceRecordValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "TraceRecordValidationError";
  }
}

export class RecordCapabilityError extends Error {
  constructor(readonly capability: keyof TraceCapabilitiesV3, message: string) {
    super(message);
    this.name = "RecordCapabilityError";
  }
}

function valuesDiffer(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

/** Builds the exact, version-independent state delta used by live transport and replay buffering. */
export function createStateProjectionDelta(
  previous: GameState,
  current: GameState,
): StateProjectionDeltaV1 {
  const previousTiles = new Map(previous.tiles.flat().map((tile) => [`${tile.x}:${tile.y}`, tile]));
  const tileUpserts = current.tiles.flat().filter((tile) => valuesDiffer(previousTiles.get(`${tile.x}:${tile.y}`), tile));
  return {
    tick: current.tick,
    players: current.players.map((player) => {
      const previousPlayer = previous.players.find((entry) => entry.id === player.id);
      const previousUnits = new Map(previousPlayer?.units.map((unit) => [unit.id, unit]) ?? []);
      const currentUnitIds = new Set(player.units.map((unit) => unit.id));
      const previousBuildings = new Map(previousPlayer?.buildings.map((building) => [building.id, building]) ?? []);
      const currentBuildingIds = new Set(player.buildings.map((building) => building.id));
      return {
        playerId: player.id,
        ...(valuesDiffer(previousPlayer?.resources, player.resources)
          ? { resources: structuredClone(player.resources) }
          : {}),
        unitUpserts: player.units
          .filter((unit) => valuesDiffer(previousUnits.get(unit.id), unit))
          .map((unit) => structuredClone(unit)),
        removedUnitIds: [...previousUnits.keys()].filter((id) => !currentUnitIds.has(id)),
        buildingUpserts: player.buildings
          .filter((building) => valuesDiffer(previousBuildings.get(building.id), building))
          .map((building) => structuredClone(building)),
        removedBuildingIds: [...previousBuildings.keys()].filter((id) => !currentBuildingIds.has(id)),
      };
    }),
    tileUpserts: tileUpserts.map((tile) => structuredClone(tile)),
    ...(valuesDiffer(previous.projectiles ?? [], current.projectiles ?? [])
      ? { projectiles: structuredClone(current.projectiles ?? []) }
      : {}),
    logs: current.logs.length >= previous.logs.length
      && previous.logs.every((log, index) => !valuesDiffer(log, current.logs[index]))
      ? { mode: "append", entries: structuredClone(current.logs.slice(previous.logs.length)) }
      : { mode: "replace", entries: structuredClone(current.logs) },
    ...(previous.winner !== current.winner ? { winner: current.winner } : {}),
  };
}

/** Applies a transport delta without mutating the prior projection. */
export function applyStateProjectionDelta(
  previous: GameState,
  delta: StateProjectionDeltaV1,
): GameState {
  const next = structuredClone(previous);
  next.tick = delta.tick;
  for (const playerDelta of delta.players) {
    const player = next.players.find((entry) => entry.id === playerDelta.playerId);
    if (!player) continue;
    if (playerDelta.resources) player.resources = structuredClone(playerDelta.resources);
    const removedUnits = new Set(playerDelta.removedUnitIds);
    player.units = player.units.filter((unit) => !removedUnits.has(unit.id));
    for (const unit of playerDelta.unitUpserts) {
      const index = player.units.findIndex((entry) => entry.id === unit.id);
      if (index === -1) player.units.push(structuredClone(unit));
      else player.units[index] = structuredClone(unit);
    }
    const removedBuildings = new Set(playerDelta.removedBuildingIds);
    player.buildings = player.buildings.filter((building) => !removedBuildings.has(building.id));
    for (const building of playerDelta.buildingUpserts) {
      const index = player.buildings.findIndex((entry) => entry.id === building.id);
      if (index === -1) player.buildings.push(structuredClone(building));
      else player.buildings[index] = structuredClone(building);
    }
  }
  if (delta.tileUpserts.length > 0) {
    const upserts = new Map(delta.tileUpserts.map((tile) => [`${tile.x}:${tile.y}`, tile]));
    next.tiles = next.tiles.map((row) => row.map((tile) => structuredClone(upserts.get(`${tile.x}:${tile.y}`) ?? tile)));
  }
  if (delta.projectiles) next.projectiles = structuredClone(delta.projectiles);
  next.logs = delta.logs.mode === "append"
    ? next.logs.concat(structuredClone(delta.logs.entries))
    : structuredClone(delta.logs.entries);
  if ("winner" in delta) next.winner = delta.winner ?? null;
  return next;
}

type BufferedSimulationFrame = {
  frame: StateProjectionFrameV1;
  state: GameState;
  receivedAtMs: number;
  positions: Map<string, { x: number; y: number }>;
};

/** Bounded simulation-time buffer shared by live rendering and replay playback. */
export class SimulationFrameBuffer {
  private frames: BufferedSimulationFrame[] = [];

  constructor(private readonly capacity = 8) {}

  clear(): void {
    this.frames = [];
  }

  ingest(frame: StateProjectionFrameV1, receivedAtMs = performance.now()): GameState | null {
    const latest = this.frames.at(-1);
    if (latest && frame.metadata.frameSequence <= latest.frame.metadata.frameSequence) return latest.state;
    let state: GameState;
    if (frame.kind === "keyframe") {
      state = structuredClone(frame.state);
    } else {
      if (!latest || frame.baseFrameSequence !== latest.frame.metadata.frameSequence) return null;
      state = applyStateProjectionDelta(latest.state, frame.delta);
    }
    this.frames.push({ frame, state, receivedAtMs, positions: indexEntityPositions(state) });
    if (this.frames.length > this.capacity) this.frames.splice(0, this.frames.length - this.capacity);
    return state;
  }

  getLatestState(): GameState | null {
    return this.frames.at(-1)?.state ?? null;
  }

  getLatestFrame(): StateProjectionFrameV1 | null {
    return this.frames.at(-1)?.frame ?? null;
  }

  getRenderSimulationTime(nowMs = performance.now()): number {
    const latest = this.frames.at(-1);
    if (!latest) return 0;
    const delayMs = latest.frame.metadata.tickIntervalMs * 1.1;
    const extrapolated = latest.frame.metadata.simulationTimeMs + (nowMs - latest.receivedAtMs) - delayMs;
    const earliestTime = this.frames[0]?.frame.metadata.simulationTimeMs ?? extrapolated;
    return Math.max(earliestTime, Math.min(latest.frame.metadata.simulationTimeMs, extrapolated));
  }

  sampleEntityPosition(entityId: string, simulationTimeMs = this.getRenderSimulationTime()): { x: number; y: number } | null {
    if (this.frames.length === 0) return null;
    let before = this.frames[0]!;
    let after = this.frames.at(-1)!;
    for (const candidate of this.frames) {
      if (candidate.frame.metadata.simulationTimeMs <= simulationTimeMs) before = candidate;
      if (candidate.frame.metadata.simulationTimeMs >= simulationTimeMs) {
        after = candidate;
        break;
      }
    }
    const from = before.positions.get(entityId) ?? null;
    const to = after.positions.get(entityId) ?? null;
    if (!from) return to;
    if (!to) return from;
    const duration = after.frame.metadata.simulationTimeMs - before.frame.metadata.simulationTimeMs;
    const progress = duration <= 0 ? 1 : Math.max(0, Math.min(1,
      (simulationTimeMs - before.frame.metadata.simulationTimeMs) / duration,
    ));
    return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
  }
}

function indexEntityPositions(state: GameState): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  for (const player of state.players) {
    for (const unit of player.units) positions.set(unit.id, { x: unit.x, y: unit.y });
    for (const building of player.buildings) positions.set(building.id, { x: building.x, y: building.y });
  }
  return positions;
}

export function createTraceManifestV3(
  matchId: string,
  definition: MatchDefinition,
  createdAt = new Date().toISOString(),
): TraceManifestV3 {
  return {
    schemaVersion: 3,
    recordFormat: "trace-v3",
    matchId,
    createdAt,
    updatedAt: createdAt,
    status: "created",
    definition: structuredClone(definition),
    capabilities: {
      commandSubmissions: "complete",
      domainEvents: "complete",
      commandResults: "complete",
      agentTurns: "complete",
      terminalEvents: "complete",
      modelRequestSpans: "partial",
      toolCallSpans: "partial",
      stateHashes: "complete",
      replay: "partial",
    },
  };
}

/**
 * Compatibility projection only. DomainEvent remains the authoritative fact;
 * clients that still require GameLog receive a deterministic derived view.
 */
export function projectCommandResultEventToGameLog(event: DomainEvent): GameLog | null {
  if (event.type !== "command_result" || !isObject(event.payload)) return null;
  const command = event.payload.command as Command | undefined;
  const resultType = event.payload.resultType as ResultType | undefined;
  const resultCode = event.payload.resultCode as ResultCode | undefined;
  if (!command || typeof command.type !== "string" || !resultType || typeof resultCode !== "number") {
    return null;
  }
  const base = defaultLogMeta(LOG_TYPES.COMMAND_RESULT);
  const owner = (event.actorId ?? command.playerId) as ActorId;
  const feedbackTarget = (
    command.playerId === "player_1" || command.playerId === "player_2"
      ? command.playerId
      : AI_FEEDBACK_TARGETS.NONE
  ) as AIFeedbackTarget;
  return {
    tick: event.tick,
    type: LOG_TYPES.COMMAND_RESULT,
    message: `Command ${command.type} -> ${resultType}`,
    data: {
      command: structuredClone(command),
      result_code: resultCode,
      type: resultType,
      result_data: structuredClone(event.payload.resultData ?? {}),
    } as GameLog["data"],
    meta: {
      ...base,
      owner,
      feedbackTarget,
      level: event.payload.success === true ? LOG_LEVELS.INFO : LOG_LEVELS.WARNING,
    },
  } as GameLog;
}

export function detectRecordFormat(value: unknown): SupportedRecordFormat | "unknown" {
  if (!isObject(value)) return "unknown";
  if (value.schemaVersion === 3 && isObject(value.manifest) && value.manifest.recordFormat === "trace-v3") {
    return "trace-v3";
  }
  if (isObject(value.metadata) && value.metadata.recordFormat === "compact-v2") {
    return "compact-v2";
  }
  return "unknown";
}

export function validateMatchTraceRecordV3(value: unknown): asserts value is MatchTraceRecordV3 {
  const record = expectObject(value, "$trace");
  expectExact(record.schemaVersion, 3, "$trace.schemaVersion");
  const manifest = validateTraceManifestV3(record.manifest);
  const initialKeyframe = validateKeyframe(record.initialKeyframe, "$trace.initialKeyframe");
  const finalKeyframe = validateKeyframe(record.finalKeyframe, "$trace.finalKeyframe");
  if (finalKeyframe.tick < initialKeyframe.tick) {
    fail("$trace.finalKeyframe.tick", "must not precede the initial keyframe");
  }

  const stateHashes = expectArray(record.stateHashes, "$trace.stateHashes")
    .map((entry, index) => validateStateHash(entry, `$trace.stateHashes[${index}]`));
  validateMonotonicTicks(stateHashes, "$trace.stateHashes");
  if (manifest.capabilities.stateHashes === "complete") {
    if (stateHashes[0]?.tick !== initialKeyframe.tick) {
      fail("$trace.stateHashes", "complete state hashes must begin at the initial keyframe tick");
    }
    if (stateHashes.at(-1)?.tick !== finalKeyframe.tick) {
      fail("$trace.stateHashes", "complete state hashes must end at the final keyframe tick");
    }
  }
  if (manifest.capabilities.stateHashes === "absent" && stateHashes.length > 0) {
    fail("$trace.stateHashes", "must be empty when the stateHashes capability is absent");
  }

  const commandSubmissions = expectArray(record.commandSubmissions, "$trace.commandSubmissions")
    .map((entry, index) => validateCommandSubmission(entry, manifest.matchId, index));
  validateSubmissionSequence(commandSubmissions);
  if (manifest.capabilities.commandSubmissions === "absent" && commandSubmissions.length > 0) {
    fail("$trace.commandSubmissions", "must be empty when the capability is absent");
  }

  const domainEvents = expectArray(record.domainEvents, "$trace.domainEvents")
    .map((entry, index) => validateDomainEvent(entry, manifest.matchId, index));
  validateEventSequence(domainEvents);
  if (manifest.capabilities.domainEvents === "absent" && domainEvents.length > 0) {
    fail("$trace.domainEvents", "must be empty when the capability is absent");
  }

  const aiTurns = expectArray(record.aiTurns, "$trace.aiTurns");
  aiTurns.forEach((entry, index) => validateAITurn(entry, `$trace.aiTurns[${index}]`));
  if (manifest.capabilities.agentTurns === "absent" && aiTurns.length > 0) {
    fail("$trace.aiTurns", "must be empty when the capability is absent");
  }

  const terminalEvents = expectArray(record.terminalEvents, "$trace.terminalEvents");
  terminalEvents.forEach((entry, index) => validateTerminalEvent(entry, `$trace.terminalEvents[${index}]`));
  if (manifest.capabilities.terminalEvents === "absent" && terminalEvents.length > 0) {
    fail("$trace.terminalEvents", "must be empty when the capability is absent");
  }

  if (manifest.capabilities.replay === "complete") {
    validateReplayProjection(record.replayProjection, initialKeyframe, finalKeyframe, manifest);
  } else if (manifest.capabilities.replay === "absent" && record.replayProjection !== undefined) {
    fail("$trace.replayProjection", "must be omitted when replay capability is absent");
  } else if (record.replayProjection !== undefined) {
    validateReplayProjection(record.replayProjection, initialKeyframe, finalKeyframe, manifest);
  }
}

export function validateTraceManifestV3(value: unknown): TraceManifestV3 {
  const manifest = expectObject(value, "$trace.manifest");
  expectExact(manifest.schemaVersion, 3, "$trace.manifest.schemaVersion");
  expectExact(manifest.recordFormat, "trace-v3", "$trace.manifest.recordFormat");
  expectNonEmptyString(manifest.matchId, "$trace.manifest.matchId");
  expectNonEmptyString(manifest.createdAt, "$trace.manifest.createdAt");
  expectNonEmptyString(manifest.updatedAt, "$trace.manifest.updatedAt");
  if (!TRACE_STATUSES.has(manifest.status as TraceManifestV3["status"])) {
    fail("$trace.manifest.status", "is not a supported trace status");
  }
  validateDefinition(manifest.definition);
  const capabilities = expectObject(manifest.capabilities, "$trace.manifest.capabilities");
  for (const key of CAPABILITY_KEYS) {
    if (!CAPABILITY_STATES.has(capabilities[key] as TraceCapabilityState)) {
      fail(`$trace.manifest.capabilities.${key}`, "must be complete, partial, or absent");
    }
  }
  return manifest as unknown as TraceManifestV3;
}

export function validateGameRecordV2(value: unknown): asserts value is GameRecord {
  const record = expectObject(value, "$record");
  const metadata = expectObject(record.metadata, "$record.metadata");
  expectExact(metadata.recordFormat, "compact-v2", "$record.metadata.recordFormat");
  expectNonEmptyString(metadata.startedAt, "$record.metadata.startedAt");
  expectNonEmptyString(metadata.savedAt, "$record.metadata.savedAt");
  validateKeyframe(record.initialState, "$record.initialState");
  validateKeyframe(record.finalState, "$record.finalState");
  expectArray(record.tickDeltas, "$record.tickDeltas");
  expectArray(record.commandResults, "$record.commandResults");
  expectArray(record.aiTurns, "$record.aiTurns");
}

export function parseMatchTraceRecordV3(json: string): MatchTraceRecordV3 {
  const parsed: unknown = JSON.parse(json);
  validateMatchTraceRecordV3(parsed);
  return parsed;
}

export function parseRecordForReplay(json: string): GameRecord {
  return projectRecordToGameRecord(JSON.parse(json) as unknown);
}

export function projectRecordToGameRecord(value: unknown): GameRecord {
  const format = detectRecordFormat(value);
  if (format === "compact-v2") {
    validateGameRecordV2(value);
    return structuredClone(value);
  }
  if (format === "trace-v3") {
    validateMatchTraceRecordV3(value);
    return projectTraceV3ToGameRecord(value);
  }
  throw new TraceRecordValidationError("$record", "unsupported or missing record format");
}

export function projectTraceV3ToGameRecord(trace: MatchTraceRecordV3): GameRecord {
  validateMatchTraceRecordV3(trace);
  if (trace.manifest.capabilities.replay !== "complete" || !trace.replayProjection) {
    throw new RecordCapabilityError(
      "replay",
      `Trace ${trace.manifest.matchId} does not contain a complete replay projection.`,
    );
  }
  return {
    metadata: {
      ...structuredClone(trace.replayProjection.metadata),
      recordFormat: "compact-v2",
    },
    initialState: structuredClone(trace.initialKeyframe),
    finalState: structuredClone(trace.finalKeyframe),
    tickDeltas: structuredClone(trace.replayProjection.tickDeltas),
    commandResults: structuredClone(trace.replayProjection.commandResults),
    aiTurns: structuredClone(trace.aiTurns),
  };
}

export function migrateCompactV2ToTraceV3(
  record: GameRecord,
  options: { matchId: string; definition: MatchDefinition },
): MatchTraceRecordV3 {
  validateGameRecordV2(record);
  const manifest = createTraceManifestV3(options.matchId, options.definition, record.metadata.startedAt);
  manifest.updatedAt = record.metadata.savedAt;
  manifest.status = record.metadata.status;
  manifest.capabilities = {
    commandSubmissions: "absent",
    domainEvents: "absent",
    commandResults: "complete",
    agentTurns: "complete",
    terminalEvents: "absent",
    modelRequestSpans: "absent",
    toolCallSpans: record.aiTurns.some((turn) => turn.toolCalls.length > 0) ? "partial" : "absent",
    stateHashes: "absent",
    replay: "complete",
  };
  const { recordFormat: _recordFormat, ...metadata } = record.metadata;
  const migrated: MatchTraceRecordV3 = {
    schemaVersion: 3,
    manifest,
    initialKeyframe: structuredClone(record.initialState),
    finalKeyframe: structuredClone(record.finalState),
    commandSubmissions: [],
    stateHashes: [],
    domainEvents: [],
    aiTurns: structuredClone(record.aiTurns),
    terminalEvents: [],
    replayProjection: {
      projectionVersion: 1,
      metadata: structuredClone(metadata),
      tickDeltas: structuredClone(record.tickDeltas),
      commandResults: structuredClone(record.commandResults),
    },
  };
  validateMatchTraceRecordV3(migrated);
  return migrated;
}

function validateReplayProjection(
  value: unknown,
  initialKeyframe: { tick: number },
  finalKeyframe: GameState & { tick: number },
  manifest: TraceManifestV3,
): TraceReplayProjectionV1 {
  const projection = expectObject(value, "$trace.replayProjection");
  expectExact(projection.projectionVersion, 1, "$trace.replayProjection.projectionVersion");
  const metadata = expectObject(projection.metadata, "$trace.replayProjection.metadata");
  expectNonEmptyString(metadata.startedAt, "$trace.replayProjection.metadata.startedAt");
  expectNonEmptyString(metadata.savedAt, "$trace.replayProjection.metadata.savedAt");
  if (manifest.status !== "failed" && metadata.status !== manifest.status) {
    fail("$trace.replayProjection.metadata.status", "must match the trace manifest status");
  }
  if (metadata.winner !== finalKeyframe.winner) {
    fail("$trace.replayProjection.metadata.winner", "must match the final keyframe winner");
  }
  const map = expectObject(metadata.map, "$trace.replayProjection.metadata.map");
  expectExact(map.width, manifest.definition.map.width, "$trace.replayProjection.metadata.map.width");
  expectExact(map.height, manifest.definition.map.height, "$trace.replayProjection.metadata.map.height");
  const tickDeltas = expectArray(projection.tickDeltas, "$trace.replayProjection.tickDeltas");
  let previousTick = initialKeyframe.tick;
  tickDeltas.forEach((delta, index) => {
    const validated = validateTickDelta(delta, `$trace.replayProjection.tickDeltas[${index}]`);
    if (validated.tick <= previousTick) {
      fail(`$trace.replayProjection.tickDeltas[${index}].tick`, "must be strictly increasing");
    }
    previousTick = validated.tick;
  });
  if (previousTick !== finalKeyframe.tick) {
    fail("$trace.replayProjection.tickDeltas", "must end at the final keyframe tick");
  }
  expectArray(projection.commandResults, "$trace.replayProjection.commandResults");
  return projection as unknown as TraceReplayProjectionV1;
}

function validateTickDelta(value: unknown, path: string): TickDeltaRecord {
  const delta = expectObject(value, path);
  expectNonNegativeInteger(delta.tick, `${path}.tick`);
  expectArray(delta.players, `${path}.players`);
  expectArray(delta.newLogs, `${path}.newLogs`);
  expectObject(delta.aiOutputs, `${path}.aiOutputs`);
  return delta as unknown as TickDeltaRecord;
}

function validateCommandSubmission(
  value: unknown,
  matchId: string,
  index: number,
): TraceCommandSubmissionRecord {
  const path = `$trace.commandSubmissions[${index}]`;
  const submission = expectObject(value, path);
  expectExact(submission.submissionVersion, 1, `${path}.submissionVersion`);
  expectExact(submission.matchId, matchId, `${path}.matchId`);
  expectPositiveInteger(submission.submissionSequence, `${path}.submissionSequence`);
  expectNonNegativeInteger(submission.receivedAtTick, `${path}.receivedAtTick`);
  expectObject(submission.result, `${path}.result`);
  return submission as unknown as TraceCommandSubmissionRecord;
}

function validateDefinition(value: unknown): void {
  const definition = expectObject(value, "$trace.manifest.definition");
  if (definition.definitionVersion !== 1 && definition.definitionVersion !== 2) {
    fail("$trace.manifest.definition.definitionVersion", "must be 1 or 2");
  }
  expectNonEmptyString(definition.rulesetId, "$trace.manifest.definition.rulesetId");
  expectNonEmptyString(definition.scenarioId, "$trace.manifest.definition.scenarioId");
  expectInteger(definition.seed, "$trace.manifest.definition.seed");
  expectPositiveNumber(definition.tickIntervalMs, "$trace.manifest.definition.tickIntervalMs");
  const players = expectArray(definition.players, "$trace.manifest.definition.players");
  if (players.length !== 2) fail("$trace.manifest.definition.players", "must contain exactly two players");
  expectObject(definition.map, "$trace.manifest.definition.map");
  expectObject(definition.victoryCondition, "$trace.manifest.definition.victoryCondition");
  if (definition.definitionVersion === 2) {
    const rules = expectObject(definition.rules, "$trace.manifest.definition.rules");
    expectExact(rules.schemaVersion, 1, "$trace.manifest.definition.rules.schemaVersion");
    const budget = expectObject(
      rules.commandBudget,
      "$trace.manifest.definition.rules.commandBudget",
    );
    expectPositiveInteger(
      budget.maxCommandsPerActorPerTick,
      "$trace.manifest.definition.rules.commandBudget.maxCommandsPerActorPerTick",
    );
    expectNonNegativeInteger(
      budget.maxPathCommandsPerTick,
      "$trace.manifest.definition.rules.commandBudget.maxPathCommandsPerTick",
    );
  }
}

function validateKeyframe(value: unknown, path: string): GameState & { tick: number } {
  const state = expectObject(value, path);
  expectNonNegativeInteger(state.tick, `${path}.tick`);
  expectArray(state.players, `${path}.players`);
  expectArray(state.tiles, `${path}.tiles`);
  expectArray(state.logs, `${path}.logs`);
  return state as unknown as GameState & { tick: number };
}

function validateStateHash(value: unknown, path: string): TraceStateHashRecord {
  const hash = expectObject(value, path);
  expectExact(hash.hashVersion, 2, `${path}.hashVersion`);
  expectNonNegativeInteger(hash.tick, `${path}.tick`);
  expectExact(hash.algorithm, "sha256", `${path}.algorithm`);
  if (typeof hash.hash !== "string" || !/^[a-f0-9]{64}$/.test(hash.hash)) {
    fail(`${path}.hash`, "must be a lowercase SHA-256 digest");
  }
  return hash as unknown as TraceStateHashRecord;
}

function validateDomainEvent(value: unknown, matchId: string, index: number): DomainEvent {
  const path = `$trace.domainEvents[${index}]`;
  const event = expectObject(value, path);
  expectExact(event.eventVersion, 1, `${path}.eventVersion`);
  expectExact(event.matchId, matchId, `${path}.matchId`);
  expectPositiveInteger(event.eventSequence, `${path}.eventSequence`);
  expectNonNegativeInteger(event.tick, `${path}.tick`);
  if (!DOMAIN_EVENT_TYPES.has(event.type as DomainEventType)) {
    fail(`${path}.type`, "is not a supported DomainEvent v1 type");
  }
  expectObject(event.payload, `${path}.payload`);
  return event as unknown as DomainEvent;
}

function validateAITurn(value: unknown, path: string): SavedAITurnRecord {
  const turn = expectObject(value, path);
  expectNonEmptyString(turn.playerId, `${path}.playerId`);
  expectNonNegativeInteger(turn.requestTick, `${path}.requestTick`);
  expectNonNegativeInteger(turn.executeTick, `${path}.executeTick`);
  expectArray(turn.assistantMessages, `${path}.assistantMessages`);
  expectArray(turn.toolCalls, `${path}.toolCalls`);
  expectArray(turn.commands, `${path}.commands`);
  const metrics = expectObject(turn.metrics, `${path}.metrics`);
  expectNonNegativeInteger(metrics.modelRequests, `${path}.metrics.modelRequests`);
  expectNonNegativeInteger(metrics.toolCalls, `${path}.metrics.toolCalls`);
  if (metrics.modelRequestRecords !== undefined) {
    const requests = expectArray(metrics.modelRequestRecords, `${path}.metrics.modelRequestRecords`);
    requests.forEach((entry, index) => {
      const requestPath = `${path}.metrics.modelRequestRecords[${index}]`;
      const request = expectObject(entry, requestPath);
      expectPositiveInteger(request.requestIndex, `${requestPath}.requestIndex`);
      if (request.phase !== "warmup" && request.phase !== "turn" && request.phase !== "subagent") {
        fail(`${requestPath}.phase`, "is not a supported agent model request phase");
      }
      expectNonEmptyString(request.finishReason, `${requestPath}.finishReason`);
      expectNonNegativeInteger(request.messageCount, `${requestPath}.messageCount`);
      expectNonNegativeInteger(request.toolCount, `${requestPath}.toolCount`);
      if (request.latencyMs !== undefined) {
        expectNonNegativeNumber(request.latencyMs, `${requestPath}.latencyMs`);
      }
    });
  }
  if (metrics.memory !== undefined) {
    const memory = expectObject(metrics.memory, `${path}.metrics.memory`);
    expectExact(memory.policyVersion, 1, `${path}.metrics.memory.policyVersion`);
    expectPositiveInteger(memory.maxMessages, `${path}.metrics.memory.maxMessages`);
    expectPositiveInteger(memory.maxBytes, `${path}.metrics.memory.maxBytes`);
    for (const field of [
      "messagesBefore",
      "messagesAfter",
      "bytesBefore",
      "bytesAfter",
      "droppedMessages",
      "truncatedMessages",
    ] as const) {
      expectNonNegativeInteger(memory[field], `${path}.metrics.memory.${field}`);
    }
    if ((memory.messagesAfter as number) > (memory.maxMessages as number)) {
      fail(`${path}.metrics.memory.messagesAfter`, "must not exceed maxMessages");
    }
    if ((memory.bytesAfter as number) > (memory.maxBytes as number)) {
      fail(`${path}.metrics.memory.bytesAfter`, "must not exceed maxBytes");
    }
  }
  expectNonEmptyString(turn.model, `${path}.model`);
  return turn as unknown as SavedAITurnRecord;
}

function validateTerminalEvent(value: unknown, path: string): AITerminalEvent {
  const event = expectObject(value, path);
  if (event.kind !== "request" && event.kind !== "assistant" && event.kind !== "tool_call") {
    fail(`${path}.kind`, "is not a supported terminal event kind");
  }
  expectNonEmptyString(event.id, `${path}.id`);
  expectNonEmptyString(event.playerId, `${path}.playerId`);
  expectPositiveInteger(event.requestNumber, `${path}.requestNumber`);
  expectNonNegativeInteger(event.requestTick, `${path}.requestTick`);
  expectNonEmptyString(event.createdAt, `${path}.createdAt`);
  return event as unknown as AITerminalEvent;
}

function validateMonotonicTicks(records: readonly TraceStateHashRecord[], path: string): void {
  for (let index = 1; index < records.length; index += 1) {
    if (records[index]!.tick <= records[index - 1]!.tick) {
      fail(`${path}[${index}].tick`, "must be strictly greater than the preceding tick");
    }
  }
}

function validateEventSequence(events: readonly DomainEvent[]): void {
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.eventSequence !== index + 1) {
      fail(`$trace.domainEvents[${index}].eventSequence`, "must be contiguous and start at 1");
    }
  }
}

function validateSubmissionSequence(submissions: readonly TraceCommandSubmissionRecord[]): void {
  for (let index = 0; index < submissions.length; index += 1) {
    if (submissions[index]!.submissionSequence !== index + 1) {
      fail(
        `$trace.commandSubmissions[${index}].submissionSequence`,
        "must be contiguous and start at 1",
      );
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) fail(path, "must be an object");
  return value;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function expectNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
}

function expectInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isInteger(value)) fail(path, "must be an integer");
}

function expectNonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(path, "must be a non-negative integer");
}

function expectPositiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) fail(path, "must be a positive integer");
}

function expectPositiveNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(path, "must be positive");
}

function expectNonNegativeNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(path, "must be non-negative");
}

function expectExact(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) fail(path, `must equal ${JSON.stringify(expected)}`);
}

function fail(path: string, message: string): never {
  throw new TraceRecordValidationError(path, message);
}
