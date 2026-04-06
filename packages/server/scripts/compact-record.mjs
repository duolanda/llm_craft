import fs from "node:fs/promises";
import path from "node:path";

function diffUnits(previousUnits, currentUnits) {
  const previousMap = new Map(previousUnits.map((unit) => [unit.id, unit]));
  const currentMap = new Map(currentUnits.map((unit) => [unit.id, unit]));
  const changes = [];

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
      });
      continue;
    }

    const moved = previousUnit.x !== unit.x || previousUnit.y !== unit.y;
    const damaged = previousUnit.hp !== unit.hp;
    const updated = previousUnit.state !== unit.state;

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
      });
    }
  }

  for (const unit of previousUnits) {
    if (!currentMap.has(unit.id)) {
      changes.push({
        id: unit.id,
        type: unit.type,
        change: "removed",
      });
    }
  }

  return changes;
}

function diffBuildings(previousBuildings, currentBuildings) {
  const previousMap = new Map(previousBuildings.map((building) => [building.id, building]));
  const currentMap = new Map(currentBuildings.map((building) => [building.id, building]));
  const changes = [];

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
      });
      continue;
    }

    const damaged = previousBuilding.hp !== building.hp;
    const updated =
      JSON.stringify(previousBuilding.productionQueue) !== JSON.stringify(building.productionQueue);

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
      });
    }
  }

  for (const building of previousBuildings) {
    if (!currentMap.has(building.id)) {
      changes.push({
        id: building.id,
        type: building.type,
        change: "removed",
      });
    }
  }

  return changes;
}

function diffAIOutputs(previousOutputs = {}, currentOutputs = {}) {
  const diff = {};
  for (const key of Object.keys(currentOutputs)) {
    if (currentOutputs[key] !== previousOutputs[key]) {
      diff[key] = currentOutputs[key];
    }
  }
  return diff;
}

function buildTickDeltas(snapshots = []) {
  if (snapshots.length <= 1) {
    return [];
  }

  const deltas = [];
  for (let i = 1; i < snapshots.length; i++) {
    const previous = snapshots[i - 1];
    const current = snapshots[i];
    deltas.push({
      tick: current.tick,
      players: current.state.players.map((player, playerIndex) => {
        const previousPlayer = previous.state.players[playerIndex];
        return {
          playerId: player.id,
          credits:
            player.resources.credits !== previousPlayer.resources.credits
              ? player.resources.credits
              : undefined,
          units: diffUnits(previousPlayer.units, player.units),
          buildings: diffBuildings(previousPlayer.buildings, player.buildings),
        };
      }),
      newLogs:
        current.state.logs.length >= previous.state.logs.length
          ? current.state.logs.slice(previous.state.logs.length)
          : current.state.logs,
      aiOutputs: diffAIOutputs(previous.aiOutputs, current.aiOutputs),
      winner: current.state.winner !== previous.state.winner ? current.state.winner : undefined,
    });
  }

  return deltas;
}

function buildSavedAITurns(aiTurns = []) {
  return aiTurns.map((turn) => ({
    playerId: turn.playerId,
    requestTick: turn.requestTick ?? turn.tick,
    executeTick: turn.executeTick ?? turn.requestTick ?? turn.tick,
    windowMessageCount: turn.requestMessages?.length || 0,
    promptPayload: turn.promptPayload,
    response: turn.response,
    commands: turn.commands,
    errorMessage: turn.errorMessage,
    model: turn.model,
    baseURL: turn.baseURL,
    createdAt: turn.createdAt,
  }));
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node packages/server/scripts/compact-record.mjs <record.json>");
    process.exit(1);
  }

  const absoluteInputPath = path.resolve(inputPath);
  const raw = await fs.readFile(absoluteInputPath, "utf8");
  const record = JSON.parse(raw);

  if (record.metadata?.recordFormat === "compact-v2") {
    console.log("Record is already compact-v2.");
    return;
  }

  const snapshots = record.snapshots || [];
  const compactRecord = {
    metadata: {
      ...record.metadata,
      recordFormat: "compact-v2",
      systemPrompt: record.metadata?.systemPrompt || "",
    },
    initialState: snapshots[0]?.state || record.finalState,
    finalState: record.finalState,
    tickDeltas: buildTickDeltas(snapshots),
    commandResults: record.commandResults || [],
    aiTurns: buildSavedAITurns(record.aiTurns || []),
  };

  const parsedPath = path.parse(absoluteInputPath);
  const outputPath = path.join(parsedPath.dir, `${parsedPath.name}.compact${parsedPath.ext}`);
  await fs.writeFile(outputPath, JSON.stringify(compactRecord, null, 2), "utf8");

  const [beforeStat, afterStat] = await Promise.all([
    fs.stat(absoluteInputPath),
    fs.stat(outputPath),
  ]);

  console.log(`Input:  ${absoluteInputPath}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Size:   ${beforeStat.size} -> ${afterStat.size} bytes`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});


