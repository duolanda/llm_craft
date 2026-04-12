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

function buildTickDeltas(snapshots = [], oldCommandResults = []) {
  if (snapshots.length <= 1) {
    return [];
  }

  // 按 tick 索引 snapshots（snapshots[0] 是 initialState，snapshots[1..] 是每 tick 结束状态）
  // snapshots[i].tick 对应第 i 个 snapshot（i>=1 时 tick = i * TICK_INTERVAL）
  // 我们的 tickDeltas 第 i 项对应 snapshots[i]（i>=1），代表 tick 的增量

  // 先把 oldCommandResults 按 tick 分组，转换成 command_result 日志
  const commandResultsByTick = new Map();
  for (const cr of oldCommandResults) {
    if (!cr || cr.tick == null) continue;
    const tick = cr.tick;
    if (!commandResultsByTick.has(tick)) {
      commandResultsByTick.set(tick, []);
    }
    commandResultsByTick.get(tick).push(cr);
  }

  const deltas = [];
  for (let i = 1; i < snapshots.length; i++) {
    const previous = snapshots[i - 1];
    const current = snapshots[i];
    const tick = current.tick;

    // 从旧 commandResults 转换的日志（放在 newLogs 最前面，保持执行顺序）
    const legacyCommandLogs = (commandResultsByTick.get(tick) || []).map((cr) => ({
      tick,
      type: "command_result",
      message: cr.message || "Command processed",
      data: {
        command: cr.command,
        result: cr.result,
        success: cr.success,
        playerId: cr.command?.playerId,
      },
    }));

    // 从当前 snapshot 的 logs 切片（排除已作为 command_result 插入的重复条目）
    // 注意：旧格式 snapshots 里的 logs 可能已经包含 command_result（如果是新格式旧记录）
    // 这里我们只取非 command_result 类型的日志，避免重复
    const currentLogs = current.state.logs || [];
    const previousLogs = previous.state.logs || [];

    // 计算增量日志：取 current 比 previous 新增的部分
    const incrementalLogs = currentLogs.length >= previousLogs.length
      ? currentLogs.slice(previousLogs.length)
      : currentLogs;

    // 过滤掉已经是 command_result 类型的（这些我们会从 oldCommandResults 重建）
    const filteredIncrementalLogs = incrementalLogs.filter(
      (log) => log.type !== "command_result"
    );

    // 合并：先 legacy command logs，再其他新增日志（保持命令结果优先的顺序）
    const mergedNewLogs = [...legacyCommandLogs, ...filteredIncrementalLogs];

    deltas.push({
      tick,
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
      newLogs: mergedNewLogs,
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
  const oldCommandResults = record.commandResults || [];
  const compactRecord = {
    metadata: {
      ...record.metadata,
      recordFormat: "compact-v2",
      systemPrompt: record.metadata?.systemPrompt || "",
    },
    initialState: snapshots[0]?.state || record.finalState,
    finalState: record.finalState,
    tickDeltas: buildTickDeltas(snapshots, oldCommandResults),
    // ❌ 不再保留顶层 commandResults 字段——已并入 tickDeltas[].newLogs
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


