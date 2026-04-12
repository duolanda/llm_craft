import {
  Building,
  Command,
  CommandResult,
  GameRecord,
  GameSnapshot,
  GameState,
  Player,
  TickDeltaRecord,
  Unit,
  LOG_TYPES,
} from "@llmcraft/shared";

export interface ReplayFrame {
  tick: number;
  state: GameState;
  aiOutputs: Record<string, string>;
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clearTransientIntentState(state: GameState) {
  for (const player of state.players) {
    for (const unit of player.units) {
      delete unit.path;
      delete unit.pathTarget;
    }
  }
}

function applyUnitDelta(player: Player, change: TickDeltaRecord["players"][number]["units"][number]) {
  const index = player.units.findIndex((unit) => unit.id === change.id);

  if (change.change === "removed") {
    if (index >= 0) {
      player.units.splice(index, 1);
    }
    return;
  }

  if (index === -1) {
    const createdUnit: Unit = {
      id: change.id,
      type: change.type,
      x: change.x ?? 0,
      y: change.y ?? 0,
      hp: change.hp ?? 0,
      maxHp: change.maxHp ?? change.hp ?? 0,
      state: change.state ?? "idle",
      my: false,
      playerId: player.id,
      exists: true,
      attackRange: change.attackRange ?? 0,
      carryingCredits: change.carryingCredits ?? 0,
      carryCapacity: change.carryCapacity ?? 0,
    };
    player.units.push(createdUnit);
    return;
  }

  const current = player.units[index];
  player.units[index] = {
    ...current,
    exists: true,
    x: change.x ?? current.x,
    y: change.y ?? current.y,
    hp: change.hp ?? current.hp,
    maxHp: change.maxHp ?? current.maxHp,
    state: change.state ?? current.state,
    attackRange: change.attackRange ?? current.attackRange,
    carryingCredits: change.carryingCredits ?? current.carryingCredits,
    carryCapacity: change.carryCapacity ?? current.carryCapacity,
  };
}

function applyBuildingDelta(player: Player, change: TickDeltaRecord["players"][number]["buildings"][number]) {
  const index = player.buildings.findIndex((building) => building.id === change.id);

  if (change.change === "removed") {
    if (index >= 0) {
      player.buildings.splice(index, 1);
    }
    return;
  }

  if (index === -1) {
    const createdBuilding: Building = {
      id: change.id,
      type: change.type,
      x: change.x ?? 0,
      y: change.y ?? 0,
      hp: change.hp ?? 0,
      maxHp: change.maxHp ?? change.hp ?? 0,
      my: false,
      playerId: player.id,
      exists: true,
      productionQueue: change.productionQueue ?? [],
    };
    player.buildings.push(createdBuilding);
    return;
  }

  const current = player.buildings[index];
  player.buildings[index] = {
    ...current,
    exists: true,
    x: change.x ?? current.x,
    y: change.y ?? current.y,
    hp: change.hp ?? current.hp,
    maxHp: change.maxHp ?? current.maxHp,
    productionQueue: change.productionQueue ?? current.productionQueue,
  };
}

function getUnitById(state: GameState, unitId: string) {
  for (const player of state.players) {
    const unit = player.units.find((entry) => entry.id === unitId);
    if (unit) {
      return unit;
    }
  }
  return null;
}

function getTargetPosition(state: GameState, targetId: string) {
  for (const player of state.players) {
    const unit = player.units.find((entry) => entry.id === targetId);
    if (unit) {
      return { x: unit.x, y: unit.y };
    }
    const building = player.buildings.find((entry) => entry.id === targetId);
    if (building) {
      return { x: building.x, y: building.y };
    }
  }
  return null;
}

function resolveMoveTarget(
  command: Command,
  logs: GameState["logs"]
) {
  const adjusted = logs.find((log) =>
    log.type === LOG_TYPES.MOVE_ADJUSTED &&
    (log.data as any)?.command?.id === command.id &&
    typeof (log.data as any)?.commandMeta?.x === "number" &&
    typeof (log.data as any)?.commandMeta?.y === "number"
  );

  if (adjusted && adjusted.data && (adjusted.data as any).commandMeta) {
    return { x: (adjusted.data as any).commandMeta.x as number, y: (adjusted.data as any).commandMeta.y as number };
  }

  if (command.position) {
    return { x: command.position.x, y: command.position.y };
  }

  return null;
}

function findAttackTargetFromDelta(
  delta: TickDeltaRecord,
  playerId: string
) {
  const enemyPlayers = delta.players.filter((entry) => entry.playerId !== playerId);
  for (const enemy of enemyPlayers) {
    const unitChange = enemy.units.find((entry) =>
      (entry.change === "damaged" || entry.change === "removed" || entry.change === "updated") &&
      typeof entry.x === "number" &&
      typeof entry.y === "number"
    );
    if (unitChange?.x !== undefined && unitChange.y !== undefined) {
      return { targetId: unitChange.id, x: unitChange.x, y: unitChange.y };
    }

    const buildingChange = enemy.buildings.find((entry) =>
      (entry.change === "damaged" || entry.change === "removed" || entry.change === "updated") &&
      typeof entry.x === "number" &&
      typeof entry.y === "number"
    );
    if (buildingChange?.x !== undefined && buildingChange.y !== undefined) {
      return { targetId: buildingChange.id, x: buildingChange.x, y: buildingChange.y };
    }
  }
  return null;
}

function applyCommandIntentsForTick(
  state: GameState,
  delta: TickDeltaRecord,
  commandResults: CommandResult[]
) {
  for (const result of commandResults) {
    const command = result.command;
    if (!result.success || !command.unitId) {
      continue;
    }

    const unit = getUnitById(state, command.unitId);
    if (!unit) {
      continue;
    }

    if (command.type === "move") {
      const target = resolveMoveTarget(command, delta.newLogs);
      if (target) {
        unit.intent = {
          type: "move",
          targetX: target.x,
          targetY: target.y,
        };
        unit.pathTarget = target;
      }
      continue;
    }

    if (command.type === "attack") {
      if (!command.targetId) {
        continue;
      }
      const target = getTargetPosition(state, command.targetId);
      unit.intent = {
        type: "attack",
        targetId: command.targetId,
        targetX: target?.x,
        targetY: target?.y,
      };
      continue;
    }

    if (command.type === "attack_in_range") {
      const target = findAttackTargetFromDelta(delta, command.playerId);
      unit.intent = {
        type: "attack",
        targetId: target?.targetId,
        targetX: target?.x,
        targetY: target?.y,
      };
      continue;
    }

    if (command.type === "hold") {
      unit.intent = { type: "hold" };
      continue;
    }
  }
}

export function buildReplayFrames(record: GameRecord): ReplayFrame[] {
  const currentState = cloneState(record.initialState);
  const currentAIOutputs: Record<string, string> = {};
  clearTransientIntentState(currentState);
  const commandResultsByTick = new Map<number, CommandResult[]>();
  for (const result of record.commandResults) {
    const bucket = commandResultsByTick.get(result.tick) ?? [];
    bucket.push(result);
    commandResultsByTick.set(result.tick, bucket);
  }
  const frames: ReplayFrame[] = [
    {
      tick: currentState.tick,
      state: cloneState(currentState),
      aiOutputs: {},
    },
  ];

  for (const delta of record.tickDeltas) {
    currentState.tick = delta.tick;

    for (const playerDelta of delta.players) {
      const player = currentState.players.find((entry) => entry.id === playerDelta.playerId);
      if (!player) {
        continue;
      }

      if (playerDelta.credits !== undefined) {
        player.resources.credits = playerDelta.credits;
      }

      for (const unitChange of playerDelta.units) {
        applyUnitDelta(player, unitChange);
      }

      for (const buildingChange of playerDelta.buildings) {
        applyBuildingDelta(player, buildingChange);
      }
    }

    if (delta.newLogs.length > 0) {
      currentState.logs = currentState.logs.concat(delta.newLogs);
    }

    if (delta.winner !== undefined) {
      currentState.winner = delta.winner;
    }

    for (const [playerId, output] of Object.entries(delta.aiOutputs)) {
      currentAIOutputs[playerId] = output;
    }

    applyCommandIntentsForTick(currentState, delta, commandResultsByTick.get(delta.tick) ?? []);

    frames.push({
      tick: delta.tick,
      state: cloneState(currentState),
      aiOutputs: { ...currentAIOutputs },
    });
  }

  return frames;
}

export function buildReplaySnapshots(frames: ReplayFrame[]): GameSnapshot[] {
  return frames.map((frame) => ({
    tick: frame.tick,
    state: frame.state,
    aiOutputs: frame.aiOutputs,
  }));
}

export function formatTickTime(tick: number) {
  const totalSeconds = Math.floor((tick * 500) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
