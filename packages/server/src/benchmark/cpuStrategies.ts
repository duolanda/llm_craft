import { AIPromptPayload, CPUStrategyType } from "@llmcraft/shared";

function serializeLines(lines: string[]): string {
  return lines.filter(Boolean).join("\n");
}

function withCommentHeader(
  strategy: CPUStrategyType,
  plan: string,
  lines: string[],
  annotations: string[] = []
): string {
  return serializeLines([
    `// ===== CPU STRATEGY: ${strategy} =====`,
    `// plan: ${plan}`,
    ...annotations.map((annotation) => `// ${annotation}`),
    "// ================================",
    ...lines,
  ]);
}

function chooseRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

function buildWorkerEconomyLines(): string[] {
  return [
    "const resourceTiles = map.tiles.filter((tile) => tile.type === 'resource');",
    "for (const worker of me.workers) {",
    "  const carryingFull = worker.carryingCredits >= worker.carryCapacity;",
    "  if (carryingFull && me.hq) {",
    "    worker.moveTo({ x: me.hq.x, y: me.hq.y });",
    "    continue;",
    "  }",
    "  if (worker.state === 'idle') {",
    "    const nearestResource = utils.findClosestByRange(worker, resourceTiles);",
    "    if (nearestResource) {",
    "      worker.moveTo({ x: nearestResource.x, y: nearestResource.y });",
    "    }",
    "  }",
    "}",
  ];
}

function buildRandomStrategy(payload: AIPromptPayload): string {
  const state = payload.state;
  if (!state) {
    return "// Waiting for full state";
  }

  const hasBarracks = state.my.buildings.some((building) => building.type === "barracks");
  const canBuildBarracks = state.my.resources.credits >= state.buildingStats.barracks.cost;
  const canSpawnWorker = state.my.resources.credits >= state.unitStats.worker.cost;
  const canSpawnSoldier = state.my.resources.credits >= state.unitStats.soldier.cost;
  const workerCount = state.my.units.filter((unit) => unit.type === "worker").length;
  const soldierCount = state.my.units.filter((unit) => unit.type === "soldier").length;

  const lines = ["const enemyHQ = enemyBuildings.find((building) => building.type === 'hq');"];

  if (workerCount === 0 && canSpawnWorker) {
    lines.push("if (me.hq) { me.hq.spawnUnit('worker'); }");
    return withCommentHeader("random", "bootstrap-worker", lines);
  }

  if (!hasBarracks && canBuildBarracks) {
    lines.push(
      "const builder = me.workers[0];",
      "if (builder && me.hq) {",
      "  const offset = me.hq.x < map.width / 2 ? 2 : -2;",
      "  builder.build('barracks', { x: me.hq.x + offset, y: me.hq.y });",
      "}"
    );
    return withCommentHeader("random", "build-barracks", lines);
  }

  const candidatePlans: Array<"mine" | "spawn-worker" | "spawn-soldier" | "attack"> = ["mine"];
  if (canSpawnWorker && workerCount < 4) {
    candidatePlans.push("spawn-worker");
  }
  if (hasBarracks && canSpawnSoldier) {
    candidatePlans.push("spawn-soldier");
  }
  if (soldierCount > 0 || hasBarracks) {
    candidatePlans.push("attack");
  }

  const selectedPlan = chooseRandom(candidatePlans);

  if (selectedPlan === "mine") {
    lines.push(...buildWorkerEconomyLines());
    return withCommentHeader("random", "mine", lines);
  }

  if (selectedPlan === "spawn-worker") {
    lines.push(...buildWorkerEconomyLines());
    lines.push("if (me.hq) { me.hq.spawnUnit('worker'); }");
    return withCommentHeader("random", "spawn-worker", lines);
  }

  if (selectedPlan === "spawn-soldier") {
    lines.push(...buildWorkerEconomyLines());
    lines.push(
      "for (const barracks of me.buildings.filter((building) => building.type === 'barracks')) {",
      "  barracks.spawnUnit('soldier');",
      "}"
    );
    return withCommentHeader("random", "spawn-soldier", lines);
  }

  const shouldAttackThisTurn = Math.random() > 0.75;
  lines.push(
    "if (me.soldiers.length === 0 && me.buildings.some((building) => building.type === 'barracks') && me.resources.credits >= unitStats.soldier.cost) {",
    "  for (const barracks of me.buildings.filter((building) => building.type === 'barracks')) {",
    "    barracks.spawnUnit('soldier');",
    "  }",
    "} else {"
  );
  lines.push(
    "  for (const soldier of me.soldiers) {",
    "    if (enemyHQ) {",
    "      soldier.moveTo({ x: enemyHQ.x, y: enemyHQ.y });",
    shouldAttackThisTurn
      ? "      soldier.attackInRange(['hq', 'soldier', 'worker', 'barracks']);"
      : "",
    "    }",
    "  }",
    "}"
  );

  return withCommentHeader(
    "random",
    "attack",
    lines,
    [`attack-roll: ${shouldAttackThisTurn ? "hit" : "miss"}`]
  );
}

function buildRushStrategy(payload: AIPromptPayload): string {
  const state = payload.state;
  if (!state) {
    return "// Waiting for full state";
  }

  const hasBarracks = state.my.buildings.some((building) => building.type === "barracks");
  const canBuildBarracks = state.my.resources.credits >= state.buildingStats.barracks.cost;
  const canSpawnWorker = state.my.resources.credits >= state.unitStats.worker.cost;
  const canSpawnSoldier = state.my.resources.credits >= state.unitStats.soldier.cost;
  const enemyUnits = state.enemies;
  const hq = state.my.buildings.find((building) => building.type === "hq");
  const isHQUnderPressure = hq
    ? enemyUnits.some((enemy) => Math.max(Math.abs(enemy.x - hq.x), Math.abs(enemy.y - hq.y)) <= 2)
    : false;

  const plan = isHQUnderPressure ? "defend-hq" : "rush-hq";
  const lines = [
    "const enemyHQ = enemyBuildings.find((building) => building.type === 'hq');",
    "const pressuredEnemies = enemies.filter((enemy) => me.hq && Math.max(Math.abs(enemy.x - me.hq.x), Math.abs(enemy.y - me.hq.y)) <= 2);",
    "const desiredWorkers = 2;",
    "if (me.hq && me.workers.length < desiredWorkers && me.resources.credits >= unitStats.worker.cost) {",
    "  me.hq.spawnUnit('worker');",
    "}",
  ];

  if (!hasBarracks && canBuildBarracks) {
    lines.push(
      "const builder = me.workers[0];",
      "if (builder && me.hq) {",
      "  const offset = me.hq.x < map.width / 2 ? 2 : -2;",
      "  builder.build('barracks', { x: me.hq.x + offset, y: me.hq.y });",
      "}"
    );
  }

  if (hasBarracks && canSpawnSoldier) {
    lines.push(
      "for (const barracks of me.buildings.filter((building) => building.type === 'barracks')) {",
      "  barracks.spawnUnit('soldier');",
      "}"
    );
  }

  lines.push(...buildWorkerEconomyLines());
  if (isHQUnderPressure) {
    lines.push(
      "for (const soldier of me.soldiers) {",
      "  const closestThreat = utils.findClosestByRange(soldier, pressuredEnemies);",
      "  if (closestThreat) {",
      "    const inRange = Math.max(Math.abs(soldier.x - closestThreat.x), Math.abs(soldier.y - closestThreat.y)) <= soldier.attackRange;",
      "    if (inRange) {",
      "      soldier.attackInRange(['soldier', 'worker', 'barracks', 'hq']);",
      "    } else {",
      "      soldier.moveTo({ x: closestThreat.x, y: closestThreat.y });",
      "    }",
      "    continue;",
      "  }",
      "  if (enemyHQ) {",
      "    soldier.moveTo({ x: enemyHQ.x, y: enemyHQ.y });",
      "  }",
      "}"
    );
  } else {
    lines.push(
      "for (const soldier of me.soldiers) {",
      "  if (!enemyHQ) {",
      "    soldier.attackInRange(['soldier', 'worker', 'barracks', 'hq']);",
      "    continue;",
      "  }",
      "  const inRange = Math.max(Math.abs(soldier.x - enemyHQ.x), Math.abs(soldier.y - enemyHQ.y)) <= soldier.attackRange;",
      "  if (inRange) {",
      "    soldier.attackInRange(['hq', 'soldier', 'worker', 'barracks']);",
      "  } else {",
      "    soldier.moveTo({ x: enemyHQ.x, y: enemyHQ.y });",
      "  }",
      "}"
    );
  }

  if (!hasBarracks && !canBuildBarracks && canSpawnWorker) {
    lines.push(
      "if (me.hq && me.workers.length < 4) {",
      "  me.hq.spawnUnit('worker');",
      "}"
    );
  }

  return withCommentHeader("rush", plan, lines);
}

export function buildCPUCode(strategy: CPUStrategyType, payload: AIPromptPayload): string {
  switch (strategy) {
    case "random":
      return buildRandomStrategy(payload);
    case "rush":
      return buildRushStrategy(payload);
    default:
      return "// Unsupported CPU strategy";
  }
}
