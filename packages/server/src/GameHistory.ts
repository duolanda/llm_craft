import type { GameSnapshot, GameState, TickDeltaRecord } from "@llmcraft/shared";

export function buildTickDelta(
  previous: GameSnapshot,
  current: GameSnapshot,
  newLogsOverride?: GameState["logs"],
): TickDeltaRecord {
  return {
    tick: current.tick,
    players: current.state.players.map((player, playerIndex) => {
      const previousPlayer = previous.state.players[playerIndex];
      return {
        playerId: player.id,
        credits: player.resources.credits !== previousPlayer.resources.credits
          ? player.resources.credits
          : undefined,
        units: diffUnits(previousPlayer.units, player.units),
        buildings: diffBuildings(previousPlayer.buildings, player.buildings),
      };
    }),
    newLogs: newLogsOverride ?? (current.state.logs.length >= previous.state.logs.length
      ? current.state.logs.slice(previous.state.logs.length)
      : current.state.logs),
    aiOutputs: diffAIOutputs(previous.aiOutputs, current.aiOutputs),
    winner: current.state.winner !== previous.state.winner ? current.state.winner : undefined,
  };
}

function diffUnits(
  previousUnits: GameState["players"][number]["units"],
  currentUnits: GameState["players"][number]["units"],
): TickDeltaRecord["players"][number]["units"] {
  const previousMap = new Map(previousUnits.map((unit) => [unit.id, unit]));
  const currentMap = new Map(currentUnits.map((unit) => [unit.id, unit]));
  const changes: TickDeltaRecord["players"][number]["units"] = [];

  for (const unit of currentUnits) {
    const previousUnit = previousMap.get(unit.id);
    if (!previousUnit) {
      changes.push({
        id: unit.id,
        type: unit.type,
        change: "created",
        x: unit.x,
        y: unit.y,
        hp: unit.hp,
        maxHp: unit.maxHp,
        state: unit.state,
        attackRange: unit.attackRange,
        carryingCredits: unit.carryingCredits,
        carryCapacity: unit.carryCapacity,
        intent: unit.intent ?? null,
      });
      continue;
    }

    const moved = previousUnit.x !== unit.x || previousUnit.y !== unit.y;
    const damaged = previousUnit.hp !== unit.hp;
    const carryingChanged = previousUnit.carryingCredits !== unit.carryingCredits;
    const updated = previousUnit.state !== unit.state
      || carryingChanged
      || JSON.stringify(previousUnit.intent ?? null) !== JSON.stringify(unit.intent ?? null);

    if (moved || damaged || updated) {
      changes.push({
        id: unit.id,
        type: unit.type,
        change: moved ? "moved" : damaged ? "damaged" : "updated",
        x: unit.x,
        y: unit.y,
        hp: unit.hp,
        maxHp: unit.maxHp,
        state: unit.state,
        attackRange: unit.attackRange,
        carryingCredits: unit.carryingCredits,
        carryCapacity: unit.carryCapacity,
        intent: unit.intent ?? null,
      });
    }
  }

  for (const unit of previousUnits) {
    if (!currentMap.has(unit.id)) {
      changes.push({ id: unit.id, type: unit.type, change: "removed" });
    }
  }

  return changes;
}

function diffBuildings(
  previousBuildings: GameState["players"][number]["buildings"],
  currentBuildings: GameState["players"][number]["buildings"],
): TickDeltaRecord["players"][number]["buildings"] {
  const previousMap = new Map(previousBuildings.map((building) => [building.id, building]));
  const currentMap = new Map(currentBuildings.map((building) => [building.id, building]));
  const changes: TickDeltaRecord["players"][number]["buildings"] = [];

  for (const building of currentBuildings) {
    const previousBuilding = previousMap.get(building.id);
    if (!previousBuilding) {
      changes.push({
        id: building.id,
        type: building.type,
        change: "created",
        x: building.x,
        y: building.y,
        hp: building.hp,
        maxHp: building.maxHp,
        productionQueue: building.productionQueue,
        productionProgress: building.productionProgress ?? null,
      });
      continue;
    }

    const damaged = previousBuilding.hp !== building.hp;
    const updated = JSON.stringify(previousBuilding.productionQueue) !== JSON.stringify(building.productionQueue)
      || JSON.stringify(previousBuilding.productionProgress) !== JSON.stringify(building.productionProgress);

    if (damaged || updated) {
      changes.push({
        id: building.id,
        type: building.type,
        change: damaged ? "damaged" : "updated",
        x: building.x,
        y: building.y,
        hp: building.hp,
        maxHp: building.maxHp,
        productionQueue: building.productionQueue,
        productionProgress: building.productionProgress ?? null,
      });
    }
  }

  for (const building of previousBuildings) {
    if (!currentMap.has(building.id)) {
      changes.push({ id: building.id, type: building.type, change: "removed" });
    }
  }

  return changes;
}

function diffAIOutputs(previousOutputs: Record<string, string>, currentOutputs: Record<string, string>) {
  const diff: Record<string, string> = {};
  for (const key of Object.keys(currentOutputs)) {
    if (currentOutputs[key] !== previousOutputs[key]) {
      diff[key] = currentOutputs[key];
    }
  }
  return diff;
}
