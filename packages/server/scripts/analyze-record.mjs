import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const file = args[0];
const debugArgIndex = args.findIndex((arg) => arg === "--debug" || arg === "--llm-debug");
const debugFile = debugArgIndex >= 0 ? args[debugArgIndex + 1] : null;

if (!file) {
  console.error("Usage: pnpm --filter @llmcraft/server analyze:record <record.json> [--debug <llm-debug.log>]");
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const filePath = resolveInputPath(file);
const record = JSON.parse(readFileSync(filePath, "utf8"));
const debugPath = debugFile ? resolveInputPath(debugFile) : null;
const debugText = debugPath ? readFileSync(debugPath, "utf8") : null;
const players = (record.finalState?.players ?? record.initialState?.players ?? []).map((player) => player.id);

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

for (const turn of record.aiTurns ?? []) {
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
  console.log(`  agent: modelRequests=${entry.modelRequests}, toolCalls=${entry.toolCalls}`);
  console.log(`  tools: ${formatCounter(entry.toolNames)}`);
  console.log(`  commands: ${formatCounter(entry.commands)}`);
  console.log(`  results: ${formatCounter(entry.commandResults)}`);
  console.log(`  firstEnemyHqDamageTick: ${entry.firstEnemyHqDamageTick ?? "never"}`);
  console.log(`  flags: ${flags.length > 0 ? flags.join(", ") : "none"}`);
  console.log("");
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
