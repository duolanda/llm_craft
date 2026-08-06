import {
  DEFAULT_RULESET,
  type GameState,
  type MatchRecord,
  type MatchDefinition,
  type StateProjectionDelta,
  type StateProjectionFrame,
  type Unit,
} from "@llmcraft/shared";

export * from "./analysis.js";

export type SupportedRecordFormat = "match-record" | "legacy-record";

export class MatchRecordValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "MatchRecordValidationError";
  }
}

function valuesDiffer(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

/** Builds the state delta shared by live transport and Match Record playback. */
export function createStateProjectionDelta(
  previous: GameState,
  current: GameState,
): StateProjectionDelta {
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
  delta: StateProjectionDelta,
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

export const SIMULATION_FRAME_SNAP_DISTANCE = 10;

export interface SampledEntityTransform {
  x: number;
  y: number;
  heading?: number;
}

export interface SimulationClock {
  getSimulationTimeMs(nowMs: number): number;
}

export class LiveSimulationClock implements SimulationClock {
  constructor(private readonly frameBuffer: SimulationFrameBuffer) {}

  getSimulationTimeMs(nowMs: number): number {
    return this.frameBuffer.getRenderSimulationTime(nowMs);
  }
}

export class ReplaySimulationClock implements SimulationClock {
  private playheadMs = 0;
  private minimumMs = 0;
  private maximumMs = 0;
  private rate = 1;
  private playing = false;
  private lastNowMs: number | null = null;

  getSimulationTimeMs(nowMs: number): number {
    if (this.lastNowMs !== null && this.playing && nowMs > this.lastNowMs) {
      this.playheadMs = clampSimulationTime(
        this.playheadMs + (nowMs - this.lastNowMs) * this.rate,
        this.minimumMs,
        this.maximumMs,
      );
    }
    this.lastNowMs = this.lastNowMs === null ? nowMs : Math.max(this.lastNowMs, nowMs);
    return this.playheadMs;
  }

  setBounds(minimumMs: number, maximumMs: number, nowMs: number): void {
    this.getSimulationTimeMs(nowMs);
    this.minimumMs = Math.min(minimumMs, maximumMs);
    this.maximumMs = Math.max(minimumMs, maximumMs);
    this.playheadMs = clampSimulationTime(this.playheadMs, this.minimumMs, this.maximumMs);
  }

  seek(simulationTimeMs: number, nowMs: number): void {
    this.playheadMs = clampSimulationTime(simulationTimeMs, this.minimumMs, this.maximumMs);
    this.lastNowMs = nowMs;
  }

  setPlaying(playing: boolean, nowMs: number): void {
    this.getSimulationTimeMs(nowMs);
    this.playing = playing;
    this.lastNowMs = nowMs;
  }

  setRate(rate: number, nowMs: number): void {
    this.getSimulationTimeMs(nowMs);
    this.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    this.lastNowMs = nowMs;
  }

  isAtEnd(): boolean {
    return this.playheadMs >= this.maximumMs;
  }
}

export class SimulationVisualTimeline {
  constructor(
    private readonly frameBuffer: SimulationFrameBuffer,
    private readonly clock: SimulationClock,
  ) {}

  getSimulationTimeMs(nowMs: number): number {
    return this.clock.getSimulationTimeMs(nowMs);
  }

  sampleEntityTransform(entityId: string, nowMs: number): SampledEntityTransform | null {
    return this.sampleEntityTransformAtSimulationTime(entityId, this.getSimulationTimeMs(nowMs));
  }

  sampleEntityTransformAtSimulationTime(
    entityId: string,
    simulationTimeMs: number,
  ): SampledEntityTransform | null {
    return this.frameBuffer.sampleEntityTransform(entityId, simulationTimeMs);
  }

  sampleEntityPosition(entityId: string, nowMs: number): { x: number; y: number } | null {
    const transform = this.sampleEntityTransform(entityId, nowMs);
    return transform ? { x: transform.x, y: transform.y } : null;
  }
}

export interface VisualTimelineSampler {
  getSimulationTimeMs(nowMs: number): number;
  sampleEntityTransformAtSimulationTime(
    entityId: string,
    simulationTimeMs: number,
  ): SampledEntityTransform | null;
}

export interface VisualUnitTransform extends SampledEntityTransform {
  bodyHeading: number;
  aimHeading: number;
}

/** Mutable render-only entity world, updated once per visual frame. */
export class VisualWorld {
  private readonly transforms = new Map<string, VisualUnitTransform>();
  private readonly liveIds = new Set<string>();
  private simulationTimeMs = 0;
  private frame = 0;

  step(units: readonly Unit[], timeline: VisualTimelineSampler | undefined, nowMs: number): void {
    this.frame += 1;
    this.simulationTimeMs = timeline?.getSimulationTimeMs(nowMs) ?? nowMs;

    this.liveIds.clear();
    for (const unit of units) {
      this.liveIds.add(unit.id);
      const sampled = timeline?.sampleEntityTransformAtSimulationTime(unit.id, this.simulationTimeMs);
      const transform = this.transforms.get(unit.id) ?? {
        x: unit.x,
        y: unit.y,
        heading: unit.heading,
        bodyHeading: 0,
        aimHeading: 0,
      };
      transform.x = sampled?.x ?? unit.x;
      transform.y = sampled?.y ?? unit.y;
      transform.heading = sampled?.heading ?? unit.heading;
      this.transforms.set(unit.id, transform);
    }

    for (const entityId of this.transforms.keys()) {
      if (!this.liveIds.has(entityId)) this.transforms.delete(entityId);
    }

    for (const unit of units) {
      const transform = this.transforms.get(unit.id)!;
      transform.bodyHeading = getVisualBodyHeading(unit, transform);
      transform.aimHeading = getVisualAimHeading(unit, transform, this.transforms);
    }
  }

  getTransform(entityId: string): VisualUnitTransform | undefined {
    return this.transforms.get(entityId);
  }

  getSimulationTimeMs(): number {
    return this.simulationTimeMs;
  }

  getFrame(): number {
    return this.frame;
  }
}

type BufferedSimulationFrame = {
  frame: StateProjectionFrame;
  state: GameState;
  receivedAtMs: number;
  transforms: Map<string, SampledEntityTransform>;
};

/** Bounded simulation-time buffer shared by live rendering and record playback. */
export class SimulationFrameBuffer {
  private frames: BufferedSimulationFrame[] = [];
  private renderSimulationTimeMs: number | null = null;
  private lastRenderNowMs: number | null = null;
  private arrivalOffsetsMs: number[] = [];

  constructor(private readonly capacity = 8) {}

  clear(): void {
    this.frames = [];
    this.renderSimulationTimeMs = null;
    this.lastRenderNowMs = null;
    this.arrivalOffsetsMs = [];
  }

  ingest(frame: StateProjectionFrame, receivedAtMs = performance.now()): GameState | null {
    const latest = this.frames.at(-1);
    if (latest && frame.metadata.frameSequence <= latest.frame.metadata.frameSequence) return latest.state;
    let state: GameState;
    if (frame.kind === "keyframe") {
      state = structuredClone(frame.state);
    } else {
      if (!latest || frame.baseFrameSequence !== latest.frame.metadata.frameSequence) return null;
      state = applyStateProjectionDelta(latest.state, frame.delta);
    }
    this.frames.push({ frame, state, receivedAtMs, transforms: indexEntityTransforms(state) });
    this.arrivalOffsetsMs.push(receivedAtMs - frame.metadata.simulationTimeMs);
    if (this.frames.length > this.capacity) this.frames.splice(0, this.frames.length - this.capacity);
    if (this.arrivalOffsetsMs.length > this.capacity) {
      this.arrivalOffsetsMs.splice(0, this.arrivalOffsetsMs.length - this.capacity);
    }
    return state;
  }

  getLatestState(): GameState | null {
    return this.frames.at(-1)?.state ?? null;
  }

  getLatestFrame(): StateProjectionFrame | null {
    return this.frames.at(-1)?.frame ?? null;
  }

  getRenderSimulationTime(nowMs = performance.now()): number {
    const latest = this.frames.at(-1);
    if (!latest) return 0;
    // Stay two authoritative ticks behind live simulation. This costs one
    // second at the default cadence, but keeps a known frame on both sides of
    // the render playhead through ordinary arrival jitter instead of consuming
    // 0.8 tick of extrapolation and visibly waiting for every next snapshot.
    const delayMs = latest.frame.metadata.tickIntervalMs * 2;
    const earliestTime = this.frames[0]?.frame.metadata.simulationTimeMs ?? latest.frame.metadata.simulationTimeMs;
    const minimumArrivalOffsetMs = Math.min(...this.arrivalOffsetsMs);
    const desiredTimeMs = nowMs - minimumArrivalOffsetMs - delayMs;

    if (this.renderSimulationTimeMs === null || this.lastRenderNowMs === null) {
      this.renderSimulationTimeMs = Math.max(
        earliestTime,
        Math.min(latest.frame.metadata.simulationTimeMs, desiredTimeMs),
      );
      this.lastRenderNowMs = nowMs;
      return this.renderSimulationTimeMs;
    }

    const elapsedMs = Math.max(0, nowMs - this.lastRenderNowMs);
    const currentTimeMs = this.renderSimulationTimeMs;
    let nextTimeMs = currentTimeMs;
    if (desiredTimeMs > currentTimeMs) {
      // Normal playback follows wall time exactly. After a resync, close a large
      // lag gradually instead of jumping or starting another easing transition.
      nextTimeMs = Math.min(desiredTimeMs, currentTimeMs + elapsedMs * 1.25);
    } else if (currentTimeMs > earliestTime && latest.frame.metadata.simulationTimeMs > currentTimeMs) {
      // Never reverse for a late frame. A slightly slower clock lets a changed
      // network offset converge without a visible freeze.
      nextTimeMs = currentTimeMs + elapsedMs * 0.75;
    }

    const extrapolationLimitMs = latest.frame.metadata.tickIntervalMs * 0.8;
    nextTimeMs = Math.min(nextTimeMs, latest.frame.metadata.simulationTimeMs + extrapolationLimitMs);
    this.renderSimulationTimeMs = Math.max(currentTimeMs, nextTimeMs);
    this.lastRenderNowMs = Math.max(this.lastRenderNowMs, nowMs);
    return this.renderSimulationTimeMs;
  }

  sampleEntityTransform(
    entityId: string,
    simulationTimeMs = this.getRenderSimulationTime(),
  ): SampledEntityTransform | null {
    if (this.frames.length === 0) return null;

    for (let index = 1; index < this.frames.length; index++) {
      const previous = this.frames[index - 1]!;
      const current = this.frames[index]!;
      if (current.frame.metadata.simulationTimeMs <= simulationTimeMs) continue;
      const from = previous.transforms.get(entityId);
      const to = current.transforms.get(entityId);
      if (from && to && transformDistance(from, to) > SIMULATION_FRAME_SNAP_DISTANCE) return { ...to };
    }

    let before = this.frames[0]!;
    let after = this.frames.at(-1)!;
    for (const candidate of this.frames) {
      if (candidate.frame.metadata.simulationTimeMs <= simulationTimeMs) before = candidate;
      if (candidate.frame.metadata.simulationTimeMs >= simulationTimeMs) {
        after = candidate;
        break;
      }
    }
    const from = before.transforms.get(entityId) ?? null;
    const to = after.transforms.get(entityId) ?? null;
    if (!from) return to ? { ...to } : null;
    if (!to) return { ...from };

    if (before === after && simulationTimeMs > before.frame.metadata.simulationTimeMs) {
      const previous = this.frames.at(-2);
      const previousTransform = previous?.transforms.get(entityId);
      const durationMs = previous
        ? before.frame.metadata.simulationTimeMs - previous.frame.metadata.simulationTimeMs
        : 0;
      if (
        previousTransform
        && durationMs > 0
        && transformDistance(previousTransform, from) <= SIMULATION_FRAME_SNAP_DISTANCE
      ) {
        const extrapolationMs = Math.min(
          simulationTimeMs - before.frame.metadata.simulationTimeMs,
          before.frame.metadata.tickIntervalMs * 0.8,
        );
        const progress = extrapolationMs / durationMs;
        return interpolateTransform(from, {
          x: from.x + (from.x - previousTransform.x),
          y: from.y + (from.y - previousTransform.y),
          heading: extrapolateHeading(previousTransform.heading, from.heading),
        }, progress);
      }
      return { ...from };
    }

    if (transformDistance(from, to) > SIMULATION_FRAME_SNAP_DISTANCE) return { ...to };
    const duration = after.frame.metadata.simulationTimeMs - before.frame.metadata.simulationTimeMs;
    const progress = duration <= 0 ? 1 : Math.max(0, Math.min(1,
      (simulationTimeMs - before.frame.metadata.simulationTimeMs) / duration,
    ));
    return interpolateTransform(from, to, progress);
  }

  sampleEntityPosition(
    entityId: string,
    simulationTimeMs = this.getRenderSimulationTime(),
  ): { x: number; y: number } | null {
    const transform = this.sampleEntityTransform(entityId, simulationTimeMs);
    return transform ? { x: transform.x, y: transform.y } : null;
  }
}

export function detectRecordFormat(value: unknown): SupportedRecordFormat | "unknown" {
  if (!isObject(value)) return "unknown";
  if (value.recordFormat === "match-record") return "match-record";
  if (
    isObject(value.metadata)
    && isObject(value.initialState)
    && isObject(value.finalState)
    && Array.isArray(value.tickDeltas)
  ) {
    return "legacy-record";
  }
  return "unknown";
}

export function validateMatchRecord(value: unknown): asserts value is MatchRecord {
  if (!isObject(value)) fail("$record", "must be an object");
  if (value.recordFormat !== "match-record") fail("$record.recordFormat", "must equal match-record");
  if (typeof value.matchId !== "string" || !value.matchId) fail("$record.matchId", "must be a non-empty string");
  if (!isObject(value.definition)) fail("$record.definition", "must be an object");
  if (!isObject(value.metadata)) fail("$record.metadata", "must be an object");
  if (!isGameState(value.initialState)) fail("$record.initialState", "must be a game state");
  if (!isGameState(value.finalState)) fail("$record.finalState", "must be a game state");
  if (!Array.isArray(value.tickDeltas)) fail("$record.tickDeltas", "must be an array");
  if (value.commandResults !== undefined && !Array.isArray(value.commandResults)) {
    fail("$record.commandResults", "must be an array when present");
  }
  if (value.aiTurns !== undefined && !Array.isArray(value.aiTurns)) {
    fail("$record.aiTurns", "must be an array when present");
  }
}

export function parseMatchRecord(json: string): MatchRecord {
  return projectRecordToMatchRecord(JSON.parse(json));
}

export function projectRecordToMatchRecord(value: unknown): MatchRecord {
  const format = detectRecordFormat(value);
  if (format === "match-record") {
    validateMatchRecord(value);
    return structuredClone(value);
  }
  if (format === "legacy-record") return migrateLegacyRecord(value as LegacyRecord);
  fail("$record", "unsupported Match Record format");
}

interface LegacyRecord {
  metadata: Record<string, unknown>;
  initialState: GameState;
  finalState: GameState;
  tickDeltas: MatchRecord["tickDeltas"];
  commandResults?: MatchRecord["commandResults"];
  aiTurns?: MatchRecord["aiTurns"];
}

function migrateLegacyRecord(legacy: LegacyRecord): MatchRecord {
  const definition = inferDefinition(legacy);
  const startedAt = typeof legacy.metadata.startedAt === "string"
    ? legacy.metadata.startedAt
    : new Date(0).toISOString();
  const savedAt = typeof legacy.metadata.savedAt === "string"
    ? legacy.metadata.savedAt
    : startedAt;
  const status = legacy.metadata.status === "running"
    || legacy.metadata.status === "stopped"
    || legacy.metadata.status === "finished"
    || legacy.metadata.status === "failed"
    ? legacy.metadata.status
    : legacy.finalState.winner ? "finished" : "stopped";
  const players = Array.isArray(legacy.metadata.players)
    ? legacy.metadata.players as MatchRecord["metadata"]["players"]
    : legacy.initialState.players.map((player) => ({
        playerId: player.id,
        model: "legacy-record",
      }));
  return {
    recordFormat: "match-record",
    matchId: `legacy-${startedAt.replace(/[^0-9A-Za-z]/g, "-")}`,
    definition,
    metadata: {
      startedAt,
      savedAt,
      ...(typeof legacy.metadata.endedAt === "string" ? { endedAt: legacy.metadata.endedAt } : {}),
      status,
      winner: legacy.finalState.winner,
      recordingProfile: "evaluation",
      includeTranscript: (legacy.aiTurns ?? []).some((turn) => turn.assistantMessages.length > 0),
      ...(typeof legacy.metadata.systemPrompt === "string"
        ? { systemPrompt: legacy.metadata.systemPrompt }
        : {}),
      players: structuredClone(players),
    },
    initialState: structuredClone(legacy.initialState),
    finalState: structuredClone(legacy.finalState),
    tickDeltas: structuredClone(legacy.tickDeltas),
    commandResults: structuredClone(legacy.commandResults ?? []),
    aiTurns: structuredClone(legacy.aiTurns ?? []),
  };
}

function inferDefinition(legacy: LegacyRecord): MatchDefinition {
  const initial = legacy.initialState;
  const width = initial.tiles[0]?.length
    ?? (Number((legacy.metadata.map as { width?: unknown } | undefined)?.width) || 1);
  const height = initial.tiles.length
    || Number((legacy.metadata.map as { height?: unknown } | undefined)?.height)
    || 1;
  const playerStarts = initial.players.map((player) => ({
    playerId: player.id,
    units: player.units.map((unit) => ({ type: unit.type, position: { x: unit.x, y: unit.y } })),
    buildings: player.buildings.map((building) => ({
      type: building.type,
      position: { x: building.x, y: building.y },
    })),
  })) as MatchDefinition["map"]["playerStarts"];
  return {
    rulesetId: typeof legacy.metadata.rulesetId === "string"
      ? legacy.metadata.rulesetId
      : DEFAULT_RULESET.id,
    tickIntervalMs: typeof legacy.metadata.tickIntervalMs === "number"
      ? legacy.metadata.tickIntervalMs
      : 500,
    map: {
      id: "legacy-import",
      width,
      height,
      resources: initial.tiles.flat()
        .filter((tile) => tile.type === "resource")
        .map((tile) => ({ x: tile.x, y: tile.y })),
      obstacles: initial.tiles.flat()
        .filter((tile) => tile.type === "obstacle")
        .map((tile) => ({ x: tile.x, y: tile.y })),
      playerStarts,
    },
    players: initial.players.map((player) => ({
      id: player.id,
      startingCredits: player.resources.credits,
    })) as MatchDefinition["players"],
    victoryCondition: { type: "eliminate_all_buildings" },
  };
}

function indexEntityTransforms(state: GameState): Map<string, SampledEntityTransform> {
  const transforms = new Map<string, SampledEntityTransform>();
  for (const player of state.players) {
    for (const unit of player.units) transforms.set(unit.id, { x: unit.x, y: unit.y, heading: unit.heading });
    for (const building of player.buildings) transforms.set(building.id, { x: building.x, y: building.y });
  }
  return transforms;
}

function transformDistance(left: SampledEntityTransform, right: SampledEntityTransform): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function interpolateTransform(
  from: SampledEntityTransform,
  to: SampledEntityTransform,
  progress: number,
): SampledEntityTransform {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    heading: interpolateHeading(from.heading, to.heading, progress),
  };
}

function getVisualBodyHeading(unit: Unit, transform: SampledEntityTransform): number {
  if (unit.type === "light_tank" && transform.heading !== undefined) {
    return Math.PI - transform.heading;
  }
  const targetX = unit.intent?.targetX;
  const targetY = unit.intent?.targetY;
  if (targetX === undefined || targetY === undefined) {
    return unit.playerId === "player_1" ? Math.PI / 2 : -Math.PI / 2;
  }
  return Math.atan2(targetX - transform.x, targetY - transform.y);
}

function getVisualAimHeading(
  unit: Unit,
  transform: VisualUnitTransform,
  transforms: ReadonlyMap<string, VisualUnitTransform>,
): number {
  const target = unit.intent?.targetId ? transforms.get(unit.intent.targetId) : undefined;
  if (target) {
    return Math.atan2(target.x - transform.x, target.y - transform.y) + Math.PI / 2;
  }
  const targetX = unit.intent?.targetX;
  const targetY = unit.intent?.targetY;
  if (targetX !== undefined && targetY !== undefined) {
    return Math.atan2(targetX - transform.x, targetY - transform.y) + Math.PI / 2;
  }
  return transform.bodyHeading;
}

function interpolateHeading(from: number | undefined, to: number | undefined, progress: number): number | undefined {
  if (from === undefined) return to;
  if (to === undefined) return from;
  return from + Math.atan2(Math.sin(to - from), Math.cos(to - from)) * progress;
}

function extrapolateHeading(previous: number | undefined, current: number | undefined): number | undefined {
  if (previous === undefined || current === undefined) return current;
  return current + Math.atan2(Math.sin(current - previous), Math.cos(current - previous));
}

function clampSimulationTime(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGameState(value: unknown): value is GameState {
  return isObject(value)
    && typeof value.tick === "number"
    && Array.isArray(value.players)
    && Array.isArray(value.tiles)
    && Array.isArray(value.logs);
}

function fail(path: string, message: string): never {
  throw new MatchRecordValidationError(path, message);
}
