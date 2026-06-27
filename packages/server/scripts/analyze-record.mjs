import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const options = parseArgs(args);
const file = options.file;

if (!file) {
  console.error([
    "Usage: pnpm --filter @llmcraft/server analyze:record <record.json> [options]",
    "",
    "Options:",
    "  --debug <llm-debug.log>      Merge rough model/tool metrics from an LLM debug log",
    "  --timeline                   Print pressure, HQ damage, skill, and key command events",
    "  --snapshots <ticks>          Print battlefield snapshots, e.g. --snapshots 54,59,62,82",
    "  --focus <player_id>          Limit timeline/snapshot detail to one player",
    "  --skill <command_type>       Analyze a one-shot command or ability timing",
  ].join("\n"));
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const filePath = resolveInputPath(file);
const record = JSON.parse(readFileSync(filePath, "utf8"));
const debugPath = options.debugFile ? resolveInputPath(options.debugFile) : null;
const debugText = debugPath ? readFileSync(debugPath, "utf8") : null;
const players = (record.finalState?.players ?? record.initialState?.players ?? []).map((player) => player.id);
const analysis = buildReplayAnalysis(record, players, options.skill);
const aiTurns = record.aiTurns ?? [];
const metadataByPlayer = new Map((record.metadata?.players ?? []).map((player) => [player.playerId, player]));

const createCounter = () => Object.create(null);
const bump = (counter, key, amount = 1) => {
  if (!key) {
    return;
  }
  counter[key] = (counter[key] ?? 0) + amount;
};

const metrics = Object.fromEntries(
  players.map((playerId) => [
    playerId,
    {
      modelRequests: 0,
      toolCalls: 0,
      toolNames: createCounter(),
      commands: createCounter(),
      turnCommandCount: 0,
      commandResults: createCounter(),
      finalCredits: 0,
      maxCredits: 0,
      workerCount: 0,
      soldierCount: 0,
      barracksCount: 0,
      hqAlive: false,
      firstEnemyHqDamageTick: null,
    },
  ])
);

if (debugText) {
  applyDebugMetrics(metrics, debugText);
}

for (const player of record.initialState?.players ?? []) {
  if (metrics[player.id]) {
    metrics[player.id].maxCredits = player.resources?.credits ?? 0;
  }
}

for (const turn of aiTurns) {
  const entry = metrics[turn.playerId];
  if (!entry) {
    continue;
  }
  entry.modelRequests += turn.metrics?.modelRequests ?? 0;
  entry.toolCalls += turn.metrics?.toolCalls ?? turn.toolCalls?.length ?? 0;
  for (const toolCall of turn.toolCalls ?? []) {
    bump(entry.toolNames, toolCall.toolName);
  }
  for (const command of turn.commands ?? []) {
    bump(entry.commands, command.type);
    entry.turnCommandCount++;
    if (command.type === "spawn" && command.unitType) {
      bump(entry.commands, `spawn:${command.unitType}`);
    }
  }
}

for (const log of record.commandResults ?? []) {
  const data = log.data;
  const playerId = data?.command?.playerId;
  if (!metrics[playerId]) {
    continue;
  }
  if (metrics[playerId].turnCommandCount === 0) {
    bump(metrics[playerId].commands, data?.command?.type);
    if (data?.command?.type === "spawn" && data.command.unitType) {
      bump(metrics[playerId].commands, `spawn:${data.command.unitType}`);
    }
  }
  bump(metrics[playerId].commandResults, data?.type);
  if (data?.type === "spawn_success" && data.result_data?.unitType) {
    bump(metrics[playerId].commandResults, `spawn_success:${data.result_data.unitType}`);
  }
}

const currentCredits = Object.fromEntries(
  (record.initialState?.players ?? []).map((player) => [player.id, player.resources?.credits ?? 0])
);
const hqHpByPlayer = Object.fromEntries(
  (record.initialState?.players ?? []).map((player) => [
    player.id,
    player.buildings?.find((building) => building.type === "hq")?.hp ?? null,
  ])
);

for (const delta of record.tickDeltas ?? []) {
  for (const playerDelta of delta.players ?? []) {
    if (typeof playerDelta.credits === "number" && metrics[playerDelta.playerId]) {
      currentCredits[playerDelta.playerId] = playerDelta.credits;
      metrics[playerDelta.playerId].maxCredits = Math.max(metrics[playerDelta.playerId].maxCredits, playerDelta.credits);
    }

    for (const building of playerDelta.buildings ?? []) {
      if (building.type !== "hq" || typeof building.hp !== "number") {
        continue;
      }
      const previousHp = hqHpByPlayer[playerDelta.playerId];
      if (typeof previousHp === "number" && building.hp < previousHp) {
        const attackerId = players.find((id) => id !== playerDelta.playerId);
        if (attackerId && metrics[attackerId]?.firstEnemyHqDamageTick === null) {
          metrics[attackerId].firstEnemyHqDamageTick = delta.tick;
        }
      }
      hqHpByPlayer[playerDelta.playerId] = building.hp;
    }
  }
}

for (const player of record.finalState?.players ?? []) {
  const entry = metrics[player.id];
  if (!entry) {
    continue;
  }
  entry.finalCredits = player.resources?.credits ?? 0;
  entry.maxCredits = Math.max(entry.maxCredits, entry.finalCredits);
  entry.workerCount = (player.units ?? []).filter((unit) => unit.exists && unit.type === "worker").length;
  entry.soldierCount = (player.units ?? []).filter((unit) => unit.exists && unit.type === "soldier").length;
  entry.barracksCount = (player.buildings ?? []).filter((building) => building.exists && building.type === "barracks").length;
  entry.hqAlive = (player.buildings ?? []).some((building) => building.exists && building.type === "hq");
}

const durationTicks = record.finalState?.tick ?? 0;
const durationSeconds = durationTicks * 0.5;

console.log(`Record: ${basename(filePath)}`);
console.log(`Status: ${record.metadata?.status ?? "unknown"}; winner: ${record.metadata?.winner ?? "none"}; duration: ${durationTicks} ticks (${durationSeconds.toFixed(1)}s)`);
if (debugText && debugPath) {
  console.log(`Debug: ${basename(debugPath)}; chars=${debugText.length}; roughTokens=${Math.ceil(debugText.length / 4)}`);
}
console.log("");

for (const playerId of players) {
  const entry = metrics[playerId];
  const flags = [];
  if (entry.maxCredits >= 2000 || entry.finalCredits >= 1000) {
    flags.push("floating_credits");
  }
  if (entry.workerCount > 8 || (entry.commands["spawn:worker"] ?? 0) > 12) {
    flags.push("worker_overproduction_possible");
  }
  if (entry.maxCredits >= 1000 && entry.barracksCount < 2) {
    flags.push("production_bottleneck_possible");
  }
  if ((entry.commandResults.attack_no_target_in_range ?? 0) + (entry.commandResults.attack_out_of_range ?? 0) > (entry.commandResults.attack_success ?? 0)) {
    flags.push("combat_execution_noisy");
  }

  console.log(`${playerId}:`);
  console.log(`  economy: finalCredits=${entry.finalCredits}, maxCredits=${entry.maxCredits}, workers=${entry.workerCount}, soldiers=${entry.soldierCount}, barracks=${entry.barracksCount}, hqAlive=${entry.hqAlive}`);
  if (isAgentMetricsUnavailable(playerId)) {
    console.log("  agent: unavailable (record has no aiTurns; model/tool metrics were not persisted)");
    console.log("  tools: unavailable");
  } else {
    console.log(`  agent: modelRequests=${entry.modelRequests}, toolCalls=${entry.toolCalls}`);
    console.log(`  tools: ${formatCounter(entry.toolNames)}`);
  }
  console.log(`  commands: ${formatCounter(entry.commands)}`);
  console.log(`  results: ${formatCounter(entry.commandResults)}`);
  console.log(`  firstEnemyHqDamageTick: ${entry.firstEnemyHqDamageTick ?? "never"}`);
  console.log(`  flags: ${flags.length > 0 ? flags.join(", ") : "none"}`);
  console.log("");
}

function isAgentMetricsUnavailable(playerId) {
  if (aiTurns.length > 0 || debugText) {
    return false;
  }
  const metadata = metadataByPlayer.get(playerId);
  const model = String(metadata?.model ?? "");
  const baseURL = String(metadata?.baseURL ?? "");
  const hasModelBackedPlayer = Boolean(model || baseURL) && !/cpu|benchmark/i.test(`${model} ${baseURL}`);
  return hasModelBackedPlayer;
}

if (options.timeline) {
  printTimeline(analysis.timeline, options.focusPlayer);
}

if (options.snapshotTicks.length > 0) {
  printSnapshots(analysis.snapshots, options.snapshotTicks, options.focusPlayer);
}

if (options.skill) {
  printSkillAnalysis(record, analysis, options.skill, options.focusPlayer);
}

function parseArgs(rawArgs) {
  const parsed = {
    file: null,
    debugFile: null,
    timeline: false,
    snapshotTicks: [],
    focusPlayer: null,
    skill: null,
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--debug" || arg === "--llm-debug") {
      parsed.debugFile = rawArgs[++i] ?? null;
    } else if (arg === "--timeline") {
      parsed.timeline = true;
    } else if (arg === "--snapshots") {
      const snapshotParts = [];
      while (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("--")) {
        snapshotParts.push(rawArgs[++i]);
      }
      parsed.snapshotTicks = parseTickList(snapshotParts.join(" "));
    } else if (arg === "--focus") {
      parsed.focusPlayer = rawArgs[++i] ?? null;
    } else if (arg === "--skill") {
      parsed.skill = rawArgs[++i] ?? null;
    } else if (!arg.startsWith("--") && parsed.file === null) {
      parsed.file = arg;
    }
  }

  return parsed;
}

function parseTickList(value) {
  return value
    .split(/[,\s]+/)
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((tick) => Number.isFinite(tick) && tick >= 0);
}

function formatCounter(counter) {
  const entries = Object.entries(counter).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return "none";
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function resolveInputPath(input) {
  if (isAbsolute(input)) {
    return input;
  }

  const cwdPath = resolve(process.cwd(), input);
  if (existsSync(cwdPath)) {
    return cwdPath;
  }

  return resolve(repoRoot, input);
}

function buildReplayAnalysis(gameRecord, playerIds, skillCommand) {
  const world = cloneState(gameRecord.initialState);
  const snapshots = new Map([[world.tick, cloneState(world)]]);
  const timeline = [];
  const seenPressure = new Set();
  const hqHpByPlayer = Object.fromEntries(
    (world.players ?? []).map((player) => [player.id, getHq(player)?.hp ?? null])
  );

  inspectPressure(world, playerIds, timeline, seenPressure);

  for (const delta of gameRecord.tickDeltas ?? []) {
    applyDelta(world, delta, (event) => {
      if (event.type === "hq_damage") {
        const previousHp = hqHpByPlayer[event.playerId];
        hqHpByPlayer[event.playerId] = event.hp;
        timeline.push({
          tick: delta.tick,
          playerId: event.playerId,
          type: "hq_damage",
          label: `HQ ${previousHp} -> ${event.hp}`,
        });
      } else if (event.type === "hq_death") {
        hqHpByPlayer[event.playerId] = 0;
        timeline.push({
          tick: delta.tick,
          playerId: event.playerId,
          type: "hq_death",
          label: "HQ destroyed",
        });
      }
    });
    inspectPressure(world, playerIds, timeline, seenPressure);
    snapshots.set(world.tick, cloneState(world));
  }

  for (const log of gameRecord.commandResults ?? []) {
    const data = log.data;
    const command = data?.command;
    if (!command?.playerId || !command.type) {
      continue;
    }
    if (isTimelineCommand(command.type, data.type, skillCommand)) {
      timeline.push({
        tick: log.tick,
        playerId: command.playerId,
        type: command.type === skillCommand ? "skill" : "command",
        label: formatCommandEvent(log),
      });
    }
  }

  return {
    snapshots,
    timeline: timeline.sort((a, b) => a.tick - b.tick || eventWeight(a.type) - eventWeight(b.type)),
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state ?? { tick: 0, players: [] }));
}

function applyDelta(world, delta, onEvent) {
  world.tick = delta.tick;
  for (const playerDelta of delta.players ?? []) {
    const player = world.players.find((entry) => entry.id === playerDelta.playerId);
    if (!player) {
      continue;
    }

    if (typeof playerDelta.credits === "number") {
      player.resources.credits = playerDelta.credits;
    }

    for (const unitChange of playerDelta.units ?? []) {
      const index = player.units.findIndex((unit) => unit.id === unitChange.id);
      if (unitChange.change === "removed") {
        if (index >= 0) {
          player.units.splice(index, 1);
        }
        continue;
      }
      const current = index >= 0 ? player.units[index] : { id: unitChange.id, playerId: playerDelta.playerId };
      const next = { ...current, ...unitChange, playerId: playerDelta.playerId, exists: true };
      delete next.change;
      if (index >= 0) {
        player.units[index] = next;
      } else {
        player.units.push(next);
      }
    }

    for (const buildingChange of playerDelta.buildings ?? []) {
      const index = player.buildings.findIndex((building) => building.id === buildingChange.id);
      const current = index >= 0 ? player.buildings[index] : null;

      if (buildingChange.type === "hq" && typeof buildingChange.hp === "number" && current?.hp !== undefined && buildingChange.hp < current.hp) {
        onEvent({ type: "hq_damage", playerId: playerDelta.playerId, hp: buildingChange.hp });
      }

      if (buildingChange.change === "removed") {
        if (index >= 0) {
          player.buildings.splice(index, 1);
        }
        if (buildingChange.type === "hq") {
          onEvent({ type: "hq_death", playerId: playerDelta.playerId });
        }
        continue;
      }

      const next = { ...(current ?? { id: buildingChange.id, playerId: playerDelta.playerId }), ...buildingChange, playerId: playerDelta.playerId, exists: true };
      delete next.change;
      if (index >= 0) {
        player.buildings[index] = next;
      } else {
        player.buildings.push(next);
      }
    }
  }
}

function inspectPressure(world, playerIds, timeline, seenPressure) {
  for (const playerId of playerIds) {
    const player = world.players.find((entry) => entry.id === playerId);
    const hq = player ? getHq(player) : null;
    if (!hq) {
      continue;
    }
    const enemyUnits = getEnemyCombatUnits(world, playerId);
    for (const radius of [5, 3, 2]) {
      const key = `${playerId}:${radius}`;
      if (seenPressure.has(key)) {
        continue;
      }
      const threat = enemyUnits.find((unit) => chebyshev(unit, hq) <= radius);
      if (threat) {
        seenPressure.add(key);
        timeline.push({
          tick: world.tick,
          playerId,
          type: "pressure",
          label: `${threat.id} entered HQ radius ${radius} at (${threat.x},${threat.y})`,
        });
      }
    }
  }
}

function isTimelineCommand(commandType, resultType, skillCommand) {
  return commandType === skillCommand ||
    commandType === "build" ||
    commandType === "spawn" ||
    resultType === "building_constructed" ||
    resultType === "spawn_success";
}

function formatCommandEvent(log) {
  const data = log.data;
  const command = data?.command ?? {};
  const result = data?.type ?? "unknown";
  if (command.type === "spawn") {
    return `spawn ${command.unitType ?? "unit"} -> ${result}`;
  }
  if (command.type === "build") {
    return `build ${command.buildingType ?? "building"} -> ${result}`;
  }
  return `${command.type ?? "command"} -> ${result}`;
}

function eventWeight(type) {
  return {
    pressure: 1,
    hq_damage: 2,
    skill: 3,
    command: 4,
    hq_death: 5,
  }[type] ?? 9;
}

function printTimeline(timeline, focusPlayer) {
  console.log("Timeline:");
  for (const event of timeline) {
    if (focusPlayer && event.playerId !== focusPlayer) {
      continue;
    }
    console.log(`  T${event.tick} ${event.playerId} ${event.type}: ${event.label}`);
  }
  console.log("");
}

function printSnapshots(snapshots, ticks, focusPlayer) {
  console.log("Snapshots:");
  for (const tick of ticks) {
    const snapshot = snapshots.get(tick);
    if (!snapshot) {
      console.log(`  T${tick}: no snapshot`);
      continue;
    }
    console.log(`  T${tick}:`);
    for (const player of snapshot.players ?? []) {
      if (focusPlayer && player.id !== focusPlayer) {
        continue;
      }
      printPlayerSnapshot(snapshot, player);
    }
  }
  console.log("");
}

function printPlayerSnapshot(world, player) {
  const hq = getHq(player);
  const workers = (player.units ?? []).filter((unit) => unit.type === "worker");
  const soldiers = (player.units ?? []).filter((unit) => unit.type === "soldier");
  const barracks = (player.buildings ?? []).filter((building) => building.type === "barracks");
  console.log(`    ${player.id}: credits=${player.resources?.credits ?? 0}, HQ=${hq ? `${hq.hp}@(${hq.x},${hq.y})` : "dead"}, workers=${workers.length}, soldiers=${soldiers.length}, barracks=${barracks.length}`);
  const units = [...workers, ...soldiers]
    .map((unit) => `${unit.id}:${unit.type}:${unit.hp}@(${unit.x},${unit.y})${unit.statusEffects?.length ? "[status]" : ""}`)
    .join(" ");
  if (units) {
    console.log(`      units: ${units}`);
  }
  if (hq) {
    const nearEnemies = getEnemyCombatUnits(world, player.id)
      .filter((unit) => chebyshev(unit, hq) <= 5)
      .map((unit) => `${unit.id}:${unit.hp}@(${unit.x},${unit.y}) d${chebyshev(unit, hq)}`);
    if (nearEnemies.length > 0) {
      console.log(`      enemies near HQ: ${nearEnemies.join(" ")}`);
    }
  }
}

function printSkillAnalysis(gameRecord, analysisData, skill, focusPlayer) {
  console.log(`Skill analysis: ${skill}`);
  const deathTicks = getHqDeathTicks(analysisData.timeline);
  const pressureTicks = getPressureTicks(analysisData.timeline);
  let printed = false;

  for (const log of gameRecord.commandResults ?? []) {
    const data = log.data;
    const command = data?.command;
    if (command?.type !== skill) {
      continue;
    }
    if (focusPlayer && command.playerId !== focusPlayer) {
      continue;
    }
    printed = true;
    const snapshot = analysisData.snapshots.get(log.tick);
    const player = snapshot?.players?.find((entry) => entry.id === command.playerId);
    const hq = player ? getHq(player) : null;
    const near = snapshot && hq ? countEnemyCombatNearHq(snapshot, command.playerId, hq) : { 2: 0, 3: 0, 5: 0 };
    const deathTick = deathTicks[command.playerId] ?? null;
    const pressureTick = pressureTicks[command.playerId]?.[5] ?? null;
    const affected = data?.result_data?.affectedWorkerIds?.length;
    console.log(`  ${command.playerId}: T${log.tick} ${data?.type ?? "unknown"}`);
    console.log(`    HQ at tick end: ${hq ? `${hq.hp}/${hq.maxHp ?? "?"}` : "dead"}`);
    console.log(`    enemy combat near HQ: <=2 ${near[2]}, <=3 ${near[3]}, <=5 ${near[5]}`);
    console.log(`    affected workers: ${typeof affected === "number" ? affected : "n/a"}`);
    console.log(`    pressure lag: ${pressureTick === null ? "n/a" : `${log.tick - pressureTick} ticks after radius-5 pressure`}`);
    console.log(`    death lag: ${deathTick === null ? "HQ survived" : `${deathTick - log.tick} ticks before HQ death`}`);
  }

  if (!printed) {
    console.log(focusPlayer ? `  ${focusPlayer}: not used` : "  not used");
  }
  console.log("");
}

function getHqDeathTicks(timeline) {
  const deaths = Object.create(null);
  for (const event of timeline) {
    if (event.type === "hq_death" && deaths[event.playerId] === undefined) {
      deaths[event.playerId] = event.tick;
    }
  }
  return deaths;
}

function getPressureTicks(timeline) {
  const pressure = Object.create(null);
  for (const event of timeline) {
    if (event.type !== "pressure") {
      continue;
    }
    const radius = Number.parseInt(event.label.match(/radius (\d+)/)?.[1] ?? "", 10);
    if (!Number.isFinite(radius)) {
      continue;
    }
    pressure[event.playerId] ??= {};
    pressure[event.playerId][radius] ??= event.tick;
  }
  return pressure;
}

function countEnemyCombatNearHq(world, playerId, hq) {
  const counts = { 2: 0, 3: 0, 5: 0 };
  for (const unit of getEnemyCombatUnits(world, playerId)) {
    const distance = chebyshev(unit, hq);
    for (const radius of [2, 3, 5]) {
      if (distance <= radius) {
        counts[radius] += 1;
      }
    }
  }
  return counts;
}

function getHq(player) {
  return (player.buildings ?? []).find((building) => building.type === "hq") ?? null;
}

function getEnemyCombatUnits(world, playerId) {
  return (world.players ?? [])
    .filter((player) => player.id !== playerId)
    .flatMap((player) => player.units ?? [])
    .filter((unit) => unit.type === "soldier" || (unit.attackRange ?? 0) > 0);
}

function chebyshev(a, b) {
  return Math.max(Math.abs((a.x ?? 0) - (b.x ?? 0)), Math.abs((a.y ?? 0) - (b.y ?? 0)));
}

function applyDebugMetrics(entries, text) {
  const debugByPlayer = Object.fromEntries(
    Object.keys(entries).map((playerId) => [
      playerId,
      {
        modelRequests: 0,
        toolCalls: 0,
        toolNames: createCounter(),
      },
    ])
  );

  const lines = text.split(/\r?\n/);
  let currentResultPlayer = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const toolHeader = line.match(/^\[tool_call\b.*\bplayer=(player_\d+)\b/);
    if (toolHeader) {
      const playerId = toolHeader[1];
      for (let j = i + 1; j < Math.min(lines.length, i + 20); j++) {
        const toolName = (lines[j] ?? "").match(/"toolName":\s*"([^"]+)"/)?.[1];
        if (toolName) {
          bump(debugByPlayer[playerId].toolNames, toolName);
          break;
        }
      }
      continue;
    }

    const resultHeader = line.match(/^\[result\b.*\bplayer=(player_\d+)\b/);
    if (resultHeader) {
      currentResultPlayer = resultHeader[1];
      continue;
    }

    if (line === "--- metrics ---" && currentResultPlayer && debugByPlayer[currentResultPlayer]) {
      const metricsJson = lines.slice(i + 1, i + 6).join("\n").match(/\{[\s\S]*?\}/)?.[0];
      if (!metricsJson) {
        continue;
      }
      try {
        const parsed = JSON.parse(metricsJson);
        debugByPlayer[currentResultPlayer].modelRequests += parsed.modelRequests ?? 0;
        debugByPlayer[currentResultPlayer].toolCalls += parsed.toolCalls ?? 0;
      } catch {
        // Ignore malformed partial metrics blocks from interrupted logs.
      }
    }
  }

  for (const [playerId, debug] of Object.entries(debugByPlayer)) {
    const entry = entries[playerId];
    if (!entry) {
      continue;
    }
    if (entry.modelRequests === 0 && entry.toolCalls === 0) {
      entry.modelRequests = debug.modelRequests;
      entry.toolCalls = debug.toolCalls;
    }
    if (Object.keys(entry.toolNames).length === 0) {
      for (const [toolName, count] of Object.entries(debug.toolNames)) {
        bump(entry.toolNames, toolName, count);
      }
    }
  }
}
