import {
  BUILDING_TYPES,
  CommandResultData,
  GameRecord,
  GameState,
  LOG_TYPES,
  PlayerId,
  RESULT_CODES,
  RESULT_TYPES,
  SavedAITurnRecord,
  TickDeltaRecord,
  UNIT_STATS,
  Unit,
} from "@llmcraft/shared";

export type DiagnosticTag =
  | "missed_defense"
  | "late_defense"
  | "read_loop_under_pressure"
  | "invalid_unit_after_pressure"
  | "spawn_trap";

export interface RecordListEntry {
  fileName: string;
  fullPath: string;
  size: number;
  modifiedAt: string;
}

export interface DiagnosticTimelineEvent {
  tick: number;
  playerId: PlayerId | "system";
  type:
    | "enemy_near_hq"
    | "hq_damage"
    | "hq_death"
    | "llm_request"
    | "read_tool"
    | "action_tool"
    | "combat_command"
    | "invalid_unit"
    | "spawn"
    | "unit_death";
  label: string;
  detail?: string;
  severity: "info" | "warning" | "danger" | "success";
}

export interface PlayerDiagnostic {
  playerId: PlayerId;
  enemyNearHqTickByRadius: Record<2 | 3 | 5, number | null>;
  hqFirstDamageTick: number | null;
  hqDeathTick: number | null;
  firstDefensiveCommandTick: number | null;
  firstCombatCommandTick: number | null;
  modelRequestsAfterPressure: number;
  toolCallsAfterPressure: number;
  readToolCallsAfterPressure: number;
  actionToolCallsAfterPressure: number;
  invalidUnitAfterPressureCount: number;
  spawnedCombatUnderPressure: number;
  spawnedCombatDeathsUnderPressure: number;
  finalWorkers: number;
  finalCombatUnits: number;
  finalCredits: number;
  tags: DiagnosticTag[];
}

export interface MatchDiagnosticReport {
  recordName: string;
  status: string;
  winner: PlayerId | null;
  durationTicks: number;
  durationSeconds: number;
  mapWidth: number;
  mapHeight: number;
  players: PlayerDiagnostic[];
  timeline: DiagnosticTimelineEvent[];
}

type MutableUnit = Pick<Unit, "id" | "type" | "x" | "y" | "hp" | "maxHp" | "attackRange" | "playerId">;

type MutableBuilding = {
  id: string;
  type: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  playerId: PlayerId;
};

interface WorldState {
  tick: number;
  players: Record<PlayerId, {
    credits: number;
    units: Map<string, MutableUnit>;
    buildings: Map<string, MutableBuilding>;
  }>;
}

interface UnitLifecycle {
  id: string;
  playerId: PlayerId;
  type: string;
  createdTick: number;
  removedTick: number | null;
  createdNearDefensiveBuilding: boolean;
}

const PRESSURE_RADII = [5, 3, 2] as const;
const READ_TOOL_NAMES = new Set([
  "get_my_state",
  "get_map_state",
  "get_my_units",
  "get_enemy_units",
  "get_my_buildings",
  "get_enemy_buildings",
  "get_visible_enemies",
]);
const ACTION_TOOL_NAMES = new Set([
  "move_unit",
  "attack_move_unit",
  "attack",
  "spawn_unit",
  "build_structure",
  "start_harvest_loop",
  "hold_unit",
  "orchestrate_plan",
]);
const COMBAT_COMMANDS = new Set(["attack", "attack_in_range", "attack_move"]);
const ACTION_COMMANDS = new Set(["move", "attack", "attack_in_range", "attack_move", "spawn", "build", "harvest_loop", "hold"]);

export function buildMatchDiagnosticReport(record: GameRecord, recordName: string): MatchDiagnosticReport {
  const playerIds = getPlayerIds(record);
  const world = createWorldState(record.initialState);
  const metrics = createPlayerMetrics(playerIds);
  const timeline: DiagnosticTimelineEvent[] = [];
  const lifecycles = new Map<string, UnitLifecycle>();

  seedInitialLifecycles(record.initialState, lifecycles);
  inspectWorldTick(world, metrics, timeline, lifecycles);

  for (const delta of record.tickDeltas) {
    applyDelta(world, delta, metrics, timeline, lifecycles);
    inspectWorldTick(world, metrics, timeline, lifecycles);
  }

  applyCommandDiagnostics(record, world, metrics, timeline);
  applyTurnDiagnostics(record.aiTurns ?? [], metrics, timeline);
  applySpawnTrapDiagnostics(metrics, lifecycles, timeline);

  const players = playerIds.map((playerId) => finalizePlayerDiagnostic(record, playerId, metrics[playerId]!));

  return {
    recordName,
    status: record.metadata?.status ?? "unknown",
    winner: record.metadata?.winner ?? record.finalState?.winner ?? null,
    durationTicks: record.finalState?.tick ?? 0,
    durationSeconds: ((record.finalState?.tick ?? 0) * record.definition.tickIntervalMs) / 1000,
    mapWidth: record.definition.map.width,
    mapHeight: record.definition.map.height,
    players,
    timeline: dedupeTimeline(timeline).sort((a, b) => a.tick - b.tick || eventPriority(a.type) - eventPriority(b.type)),
  };
}

function getPlayerIds(record: GameRecord): PlayerId[] {
  return (record.initialState.players.length > 0 ? record.initialState.players : record.finalState.players)
    .map((player) => player.id);
}

function createPlayerMetrics(playerIds: PlayerId[]) {
  return Object.fromEntries(
    playerIds.map((playerId) => [
      playerId,
      {
        enemyNearHqTickByRadius: { 5: null, 3: null, 2: null } as Record<2 | 3 | 5, number | null>,
        hqFirstDamageTick: null as number | null,
        hqDeathTick: null as number | null,
        firstDefensiveCommandTick: null as number | null,
        firstCombatCommandTick: null as number | null,
        modelRequestsAfterPressure: 0,
        toolCallsAfterPressure: 0,
        readToolCallsAfterPressure: 0,
        actionToolCallsAfterPressure: 0,
        invalidUnitAfterPressureCount: 0,
        spawnedCombatUnderPressure: 0,
        spawnedCombatDeathsUnderPressure: 0,
      },
    ])
  ) as Record<PlayerId, Omit<PlayerDiagnostic, "playerId" | "finalWorkers" | "finalCombatUnits" | "finalCredits" | "tags">>;
}

function createWorldState(state: GameState): WorldState {
  const players = Object.fromEntries(
    state.players.map((player) => [
      player.id,
      {
        credits: player.resources.credits,
        units: new Map(player.units.map((unit) => [unit.id, {
          id: unit.id,
          type: unit.type,
          x: unit.x,
          y: unit.y,
          hp: unit.hp,
          maxHp: unit.maxHp,
          attackRange: unit.attackRange,
          playerId: player.id,
        }])),
        buildings: new Map(player.buildings.map((building) => [building.id, {
          id: building.id,
          type: building.type,
          x: building.x,
          y: building.y,
          hp: building.hp,
          maxHp: building.maxHp,
          playerId: player.id,
        }])),
      },
    ])
  ) as WorldState["players"];

  return {
    tick: state.tick,
    players,
  };
}

function seedInitialLifecycles(state: GameState, lifecycles: Map<string, UnitLifecycle>) {
  for (const player of state.players) {
    for (const unit of player.units) {
      lifecycles.set(unit.id, {
        id: unit.id,
        playerId: player.id,
        type: unit.type,
        createdTick: state.tick,
        removedTick: null,
        createdNearDefensiveBuilding: isNearOwnDefensiveBuilding(unit, state.players.find((entry) => entry.id === player.id)?.buildings ?? []),
      });
    }
  }
}

function inspectWorldTick(
  world: WorldState,
  metrics: ReturnType<typeof createPlayerMetrics>,
  timeline: DiagnosticTimelineEvent[],
  lifecycles: Map<string, UnitLifecycle>
) {
  for (const [playerId, player] of Object.entries(world.players) as Array<[PlayerId, WorldState["players"][PlayerId]]>) {
    const hq = getHq(player);
    if (!hq) {
      continue;
    }

    for (const enemyUnit of getEnemyCombatUnits(world, playerId)) {
      const distance = chebyshev(hq, enemyUnit);
      for (const radius of PRESSURE_RADII) {
        if (distance <= radius && metrics[playerId]!.enemyNearHqTickByRadius[radius] === null) {
          metrics[playerId]!.enemyNearHqTickByRadius[radius] = world.tick;
          timeline.push({
            tick: world.tick,
            playerId,
            type: "enemy_near_hq",
            label: `${playerLabel(enemyUnit.playerId)}战斗单位进入总部 ${radius} 格内`,
            detail: `${unitTypeLabel(enemyUnit.type)} ${enemyUnit.id} 位于 (${enemyUnit.x}, ${enemyUnit.y})`,
            severity: radius <= 2 ? "danger" : "warning",
          });
        }
      }
    }
  }

  for (const player of Object.values(world.players)) {
    for (const unit of player.units.values()) {
      const lifecycle = lifecycles.get(unit.id);
      if (lifecycle && !lifecycle.createdNearDefensiveBuilding) {
        lifecycle.createdNearDefensiveBuilding = isNearDefensiveBuilding(world, unit.playerId, unit, 3);
      }
    }
  }
}

function applyDelta(
  world: WorldState,
  delta: TickDeltaRecord,
  metrics: ReturnType<typeof createPlayerMetrics>,
  timeline: DiagnosticTimelineEvent[],
  lifecycles: Map<string, UnitLifecycle>
) {
  world.tick = delta.tick;

  for (const playerDelta of delta.players) {
    const player = world.players[playerDelta.playerId];
    if (!player) {
      continue;
    }

    if (typeof playerDelta.credits === "number") {
      player.credits = playerDelta.credits;
    }

    for (const unitChange of playerDelta.units) {
      if (unitChange.change === "removed") {
        player.units.delete(unitChange.id);
        const lifecycle = lifecycles.get(unitChange.id);
        if (lifecycle && lifecycle.removedTick === null) {
          lifecycle.removedTick = delta.tick;
          timeline.push({
            tick: delta.tick,
            playerId: playerDelta.playerId,
            type: "unit_death",
            label: `${playerLabel(playerDelta.playerId)}${unitTypeLabel(unitChange.type)}阵亡`,
            detail: unitChange.id,
            severity: "danger",
          });
        }
        continue;
      }

      const current = player.units.get(unitChange.id);
      const next: MutableUnit = {
        id: unitChange.id,
        type: unitChange.type,
        x: unitChange.x ?? current?.x ?? 0,
        y: unitChange.y ?? current?.y ?? 0,
        hp: unitChange.hp ?? current?.hp ?? 0,
        maxHp: unitChange.maxHp ?? current?.maxHp ?? unitChange.hp ?? 0,
        attackRange: unitChange.attackRange ?? current?.attackRange ?? UNIT_STATS[unitChange.type]?.attackRange ?? 0,
        playerId: playerDelta.playerId,
      };
      player.units.set(unitChange.id, next);

      if (unitChange.change === "created") {
        lifecycles.set(unitChange.id, {
          id: unitChange.id,
          playerId: playerDelta.playerId,
          type: unitChange.type,
          createdTick: delta.tick,
          removedTick: null,
          createdNearDefensiveBuilding: isNearDefensiveBuilding(world, playerDelta.playerId, next, 3),
        });
      }
    }

    for (const buildingChange of playerDelta.buildings) {
      const current = player.buildings.get(buildingChange.id);

      if (buildingChange.type === BUILDING_TYPES.HQ && typeof buildingChange.hp === "number") {
        const previousHp = current?.hp;
        if (typeof previousHp === "number" && buildingChange.hp < previousHp && metrics[playerDelta.playerId]!.hqFirstDamageTick === null) {
          metrics[playerDelta.playerId]!.hqFirstDamageTick = delta.tick;
          timeline.push({
            tick: delta.tick,
            playerId: playerDelta.playerId,
            type: "hq_damage",
            label: `${playerLabel(playerDelta.playerId)}总部首次受伤`,
            detail: `${previousHp} -> ${buildingChange.hp}`,
            severity: "danger",
          });
        }
      }

      if (buildingChange.change === "removed") {
        player.buildings.delete(buildingChange.id);
        if (buildingChange.type === BUILDING_TYPES.HQ && metrics[playerDelta.playerId]!.hqDeathTick === null) {
          metrics[playerDelta.playerId]!.hqDeathTick = delta.tick;
          timeline.push({
            tick: delta.tick,
            playerId: playerDelta.playerId,
            type: "hq_death",
            label: `${playerLabel(playerDelta.playerId)}总部被摧毁`,
            severity: "danger",
          });
        }
        continue;
      }

      player.buildings.set(buildingChange.id, {
        id: buildingChange.id,
        type: buildingChange.type,
        x: buildingChange.x ?? current?.x ?? 0,
        y: buildingChange.y ?? current?.y ?? 0,
        hp: buildingChange.hp ?? current?.hp ?? 0,
        maxHp: buildingChange.maxHp ?? current?.maxHp ?? buildingChange.hp ?? 0,
        playerId: playerDelta.playerId,
      });
    }
  }
}

function applyCommandDiagnostics(
  record: GameRecord,
  finalWorld: WorldState,
  metrics: ReturnType<typeof createPlayerMetrics>,
  timeline: DiagnosticTimelineEvent[]
) {
  for (const log of record.commandResults ?? []) {
    if (log.type !== LOG_TYPES.COMMAND_RESULT || !log.data) {
      continue;
    }

    const data = log.data as CommandResultData;
    const playerId = data.command.playerId;
    const metric = metrics[playerId];
    if (!metric) {
      continue;
    }

    if (COMBAT_COMMANDS.has(data.command.type) && metric.firstCombatCommandTick === null) {
      metric.firstCombatCommandTick = log.tick;
    }

    if (COMBAT_COMMANDS.has(data.command.type)) {
      timeline.push({
        tick: log.tick,
        playerId,
        type: "combat_command",
        label: `${playerLabel(playerId)}执行${commandTypeLabel(data.command.type)}`,
        detail: data.command.targetId ? `目标=${data.command.targetId}` : log.message,
        severity: data.result_code === RESULT_CODES.OK ? "success" : "warning",
      });
    }

    const pressureTick = metric.enemyNearHqTickByRadius[5];
    if (pressureTick !== null && log.tick >= pressureTick) {
      if (data.type === RESULT_TYPES.INVALID_UNIT) {
        metric.invalidUnitAfterPressureCount += 1;
        timeline.push({
          tick: log.tick,
          playerId,
          type: "invalid_unit",
          label: `${playerLabel(playerId)}命令引用了已不存在的单位`,
          detail: data.result_data.unitId,
          severity: "danger",
        });
      }

      if (
        data.type === RESULT_TYPES.SPAWN_SUCCESS &&
        data.result_data.orders.some((order) => isCombatUnitType(order.unitType))
      ) {
        metric.spawnedCombatUnderPressure += 1;
        timeline.push({
          tick: log.tick,
          playerId,
          type: "spawn",
          label: `${playerLabel(playerId)}在总部受压时生产作战单位`,
          detail: data.result_data.buildingId,
          severity: "info",
        });
      }

      if (metric.firstDefensiveCommandTick === null && isDefensiveCommand(data, finalWorld, playerId)) {
        metric.firstDefensiveCommandTick = log.tick;
      }
    }
  }
}

function applyTurnDiagnostics(
  turns: SavedAITurnRecord[],
  metrics: ReturnType<typeof createPlayerMetrics>,
  timeline: DiagnosticTimelineEvent[]
) {
  for (const turn of turns) {
    const metric = metrics[turn.playerId];
    if (!metric) {
      continue;
    }

    timeline.push({
      tick: turn.requestTick,
      playerId: turn.playerId,
      type: "llm_request",
      label: `${playerLabel(turn.playerId)}发起模型请求`,
      detail: `${turn.metrics?.modelRequests ?? 0} 次模型请求，${turn.metrics?.toolCalls ?? turn.toolCalls.length} 次工具调用`,
      severity: "info",
    });

    const pressureTick = metric.enemyNearHqTickByRadius[5];
    if (pressureTick === null || turn.requestTick < pressureTick) {
      continue;
    }

    metric.modelRequestsAfterPressure += turn.metrics?.modelRequests ?? 1;
    metric.toolCallsAfterPressure += turn.metrics?.toolCalls ?? turn.toolCalls.length;

    for (const toolCall of turn.toolCalls) {
      if (READ_TOOL_NAMES.has(toolCall.toolName)) {
        metric.readToolCallsAfterPressure += 1;
        timeline.push({
          tick: turn.requestTick,
          playerId: turn.playerId,
          type: "read_tool",
          label: `${playerLabel(turn.playerId)}读取状态：${toolCall.toolName}`,
          severity: "info",
        });
      } else if (ACTION_TOOL_NAMES.has(toolCall.toolName)) {
        metric.actionToolCallsAfterPressure += 1;
        timeline.push({
          tick: turn.requestTick,
          playerId: turn.playerId,
          type: "action_tool",
          label: `${playerLabel(turn.playerId)}执行工具：${toolCall.toolName}`,
          severity: toolCall.isError ? "warning" : "success",
        });
      }
    }
  }
}

function applySpawnTrapDiagnostics(
  metrics: ReturnType<typeof createPlayerMetrics>,
  lifecycles: Map<string, UnitLifecycle>,
  timeline: DiagnosticTimelineEvent[]
) {
  for (const lifecycle of lifecycles.values()) {
    if (!isCombatUnitType(lifecycle.type) || lifecycle.removedTick === null) {
      continue;
    }
    const pressureTick = metrics[lifecycle.playerId]?.enemyNearHqTickByRadius[5];
    if (pressureTick === null || pressureTick === undefined) {
      continue;
    }
    if (lifecycle.createdTick >= pressureTick && lifecycle.removedTick - lifecycle.createdTick <= 5 && lifecycle.createdNearDefensiveBuilding) {
      metrics[lifecycle.playerId]!.spawnedCombatDeathsUnderPressure += 1;
      timeline.push({
        tick: lifecycle.removedTick,
        playerId: lifecycle.playerId,
        type: "unit_death",
        label: `${playerLabel(lifecycle.playerId)}疑似出生点陷阱`,
        detail: `${lifecycle.id} 生产后 ${lifecycle.removedTick - lifecycle.createdTick} tick 内阵亡`,
        severity: "danger",
      });
    }
  }
}

function finalizePlayerDiagnostic(
  record: GameRecord,
  playerId: PlayerId,
  metric: ReturnType<typeof createPlayerMetrics>[PlayerId]
): PlayerDiagnostic {
  const finalPlayer = record.finalState.players.find((player) => player.id === playerId);
  const pressureTick = metric.enemyNearHqTickByRadius[5];
  const tags: DiagnosticTag[] = [];

  if (pressureTick !== null && metric.firstDefensiveCommandTick === null) {
    tags.push("missed_defense");
  }
  if (pressureTick !== null && metric.firstDefensiveCommandTick !== null && metric.firstDefensiveCommandTick - pressureTick >= 5) {
    tags.push("late_defense");
  }
  if (pressureTick !== null && metric.readToolCallsAfterPressure >= 3 && metric.actionToolCallsAfterPressure === 0) {
    tags.push("read_loop_under_pressure");
  }
  if (metric.invalidUnitAfterPressureCount > 0) {
    tags.push("invalid_unit_after_pressure");
  }
  if (metric.spawnedCombatDeathsUnderPressure > 0) {
    tags.push("spawn_trap");
  }

  return {
    playerId,
    ...metric,
    finalWorkers: finalPlayer?.units.filter((unit) => unit.exists && unit.type === "worker").length ?? 0,
    finalCombatUnits: finalPlayer?.units.filter((unit) => unit.exists && isCombatUnitType(unit.type)).length ?? 0,
    finalCredits: finalPlayer?.resources.credits ?? 0,
    tags,
  };
}

function isDefensiveCommand(data: CommandResultData, world: WorldState, playerId: PlayerId) {
  if (!ACTION_COMMANDS.has(data.command.type)) {
    return false;
  }

  const player = world.players[playerId];
  const hq = player ? getHq(player) : null;
  if (!hq) {
    return COMBAT_COMMANDS.has(data.command.type);
  }

  if (data.command.position && chebyshev(data.command.position, hq) <= 5) {
    return true;
  }

  if (data.command.targetId) {
    const target = findObject(world, data.command.targetId);
    if (target && chebyshev(target, hq) <= 5) {
      return true;
    }
  }

  return COMBAT_COMMANDS.has(data.command.type);
}

function getHq(player: WorldState["players"][PlayerId]) {
  return [...player.buildings.values()].find((building) => building.type === BUILDING_TYPES.HQ) ?? null;
}

function getEnemyCombatUnits(world: WorldState, playerId: PlayerId) {
  return (Object.entries(world.players) as Array<[PlayerId, WorldState["players"][PlayerId]]>)
    .filter(([enemyPlayerId]) => enemyPlayerId !== playerId)
    .flatMap(([, player]) => [...player.units.values()])
    .filter((unit) => UNIT_STATS[unit.type]?.attack > 0 || unit.attackRange > 0);
}

function findObject(world: WorldState, id: string) {
  for (const player of Object.values(world.players)) {
    const unit = player.units.get(id);
    if (unit) {
      return unit;
    }
    const building = player.buildings.get(id);
    if (building) {
      return building;
    }
  }
  return null;
}

function isNearDefensiveBuilding(world: WorldState, playerId: PlayerId, unit: { x: number; y: number }, radius: number) {
  const player = world.players[playerId];
  if (!player) {
    return false;
  }
  return [...player.buildings.values()].some((building) =>
    (building.type === BUILDING_TYPES.HQ || building.type === BUILDING_TYPES.BARRACKS) &&
    chebyshev(building, unit) <= radius
  );
}

function isNearOwnDefensiveBuilding(unit: { x: number; y: number }, buildings: Array<{ type: string; x: number; y: number }>) {
  return buildings.some((building) =>
    (building.type === BUILDING_TYPES.HQ || building.type === BUILDING_TYPES.BARRACKS) &&
    chebyshev(building, unit) <= 3
  );
}

function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function playerLabel(playerId: PlayerId) {
  return playerId === "player_1" ? "红方" : "蓝方";
}

function unitTypeLabel(unitType: string) {
  if (unitType === "worker") {
    return "工人";
  }
  if (unitType === "soldier") {
    return "旧版士兵";
  }
  if (unitType === "rifleman") {
    return "步兵";
  }
  if (unitType === "rocket_soldier") {
    return "火箭兵";
  }
  if (unitType === "commando") {
    return "特种兵";
  }
  if (unitType === "light_tank") {
    return "轻型坦克";
  }
  if (unitType === "flame_tank") {
    return "火焰坦克";
  }
  if (unitType === "heavy_tank") {
    return "重型坦克";
  }
  return unitType;
}

function isCombatUnitType(unitType: string): boolean {
  const stats = UNIT_STATS[unitType as keyof typeof UNIT_STATS];
  return Boolean(stats && stats.attack > 0);
}

function commandTypeLabel(commandType: string) {
  const labels: Record<string, string> = {
    attack: "攻击命令",
    attack_in_range: "范围攻击命令",
    attack_move: "移动攻击命令",
    move: "移动命令",
    spawn: "生产命令",
    build: "建造命令",
    harvest_loop: "采矿循环命令",
    hold: "固守命令",
  };
  return labels[commandType] ?? `${commandType} 命令`;
}

function dedupeTimeline(events: DiagnosticTimelineEvent[]) {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.tick}:${event.playerId}:${event.type}:${event.label}:${event.detail ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function eventPriority(type: DiagnosticTimelineEvent["type"]) {
  const priority: Record<DiagnosticTimelineEvent["type"], number> = {
    enemy_near_hq: 1,
    hq_damage: 2,
    hq_death: 3,
    llm_request: 4,
    read_tool: 5,
    action_tool: 6,
    combat_command: 7,
    invalid_unit: 8,
    spawn: 9,
    unit_death: 10,
  };
  return priority[type];
}
