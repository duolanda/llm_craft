import {
  BUILDING_TYPES,
  BuildingType,
  CPUStrategyType,
  DEFAULT_MAP_LAYOUT,
  UNIT_TYPES,
  getBuildingCost,
  getBuildingFootprintCells,
  getCombatUnitTypes,
  getUnitCost,
} from "@llmcraft/shared";

const ARMY_MASSING_THRESHOLD = 20;

function chebyshevDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function chooseRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

function findBuildSite(
  hq: { x: number; y: number },
  mapWidth: number,
  buildings: Array<{ x: number; y: number }>,
  units: Array<{ x: number; y: number }>,
): { x: number; y: number } {
  const side = hq.x < mapWidth / 2 ? 1 : -1;
  const candidates = [
    { x: hq.x + side * 12, y: hq.y },
    { x: hq.x + side * 20, y: hq.y },
    { x: hq.x + side * 28, y: hq.y },
    { x: hq.x + side * 12, y: hq.y - 9 },
    { x: hq.x + side * 12, y: hq.y + 9 },
    { x: hq.x + side * 22, y: hq.y + 9 },
  ];
  const occupied = new Set([...buildings, ...units].map((item) => `${item.x},${item.y}`));
  return candidates.find((candidate) => !occupied.has(`${candidate.x},${candidate.y}`)) ?? candidates[0]!;
}

function findRoleTarget(
  combatUnit: any,
  enemyUnits: any[],
  enemyBuildings: any[],
): any | null {
  if (combatUnit.type === UNIT_TYPES.ROCKET_SOLDIER) {
    return enemyUnits.find((unit) => unit.type === UNIT_TYPES.LIGHT_TANK) ?? enemyBuildings.find((building) => building.type === BUILDING_TYPES.WAR_FACTORY) ?? null;
  }

  if (combatUnit.type === UNIT_TYPES.LIGHT_TANK) {
    return (
      enemyBuildings.find((building) => building.type === BUILDING_TYPES.HQ) ??
      enemyBuildings.find((building) => building.type === BUILDING_TYPES.WAR_FACTORY) ??
      enemyBuildings.find((building) => building.type === BUILDING_TYPES.BARRACKS) ??
      enemyUnits.find((unit) => unit.type === UNIT_TYPES.LIGHT_TANK) ??
      null
    );
  }

  if (combatUnit.type === UNIT_TYPES.RIFLEMAN || combatUnit.type === UNIT_TYPES.SOLDIER) {
    return (
      enemyUnits.find((unit) => unit.type === UNIT_TYPES.RIFLEMAN) ??
      enemyUnits.find((unit) => unit.type === UNIT_TYPES.ROCKET_SOLDIER) ??
      enemyUnits.find((unit) => unit.type === UNIT_TYPES.SOLDIER) ??
      enemyUnits.find((unit) => unit.type === UNIT_TYPES.WORKER) ??
      null
    );
  }

  return null;
}

function findForwardRefinerySite(hq: { x: number; y: number }, mapWidth: number): { x: number; y: number } {
  return hq.x < mapWidth / 2 ? { x: 44, y: 18 } : { x: 99, y: 18 };
}

function isAdjacentToBuildSite(
  worker: { x: number; y: number },
  buildingType: BuildingType,
  site: { x: number; y: number },
): boolean {
  return getBuildingFootprintCells(buildingType, site.x, site.y).some((cell) =>
    Math.max(Math.abs(worker.x - cell.x), Math.abs(worker.y - cell.y)) <= 1
  );
}

function findBuildApproach(
  worker: { x: number; y: number },
  buildingType: BuildingType,
  site: { x: number; y: number },
  mapWidth: number,
  mapHeight: number,
  units: Array<{ x: number; y: number }>,
): { x: number; y: number } {
  const footprint = getBuildingFootprintCells(buildingType, site.x, site.y);
  const footprintKeys = new Set(footprint.map((cell) => `${cell.x},${cell.y}`));
  const occupiedUnitKeys = new Set(
    units
      .filter((unit) => unit !== worker)
      .map((unit) => `${Math.round(unit.x)},${Math.round(unit.y)}`),
  );
  const minX = Math.min(...footprint.map((cell) => cell.x));
  const maxX = Math.max(...footprint.map((cell) => cell.x));
  const minY = Math.min(...footprint.map((cell) => cell.y));
  const maxY = Math.max(...footprint.map((cell) => cell.y));
  const candidates: Array<{ x: number; y: number }> = [];

  for (let x = minX - 1; x <= maxX + 1; x++) {
    candidates.push({ x, y: minY - 1 }, { x, y: maxY + 1 });
  }
  for (let y = minY; y <= maxY; y++) {
    candidates.push({ x: minX - 1, y }, { x: maxX + 1, y });
  }

  return candidates
    .filter((candidate) =>
      candidate.x >= 0 &&
      candidate.x < mapWidth &&
      candidate.y >= 0 &&
      candidate.y < mapHeight &&
      !footprintKeys.has(`${candidate.x},${candidate.y}`) &&
      !occupiedUnitKeys.has(`${candidate.x},${candidate.y}`)
    )
    .sort((a, b) => chebyshevDistance(worker, a) - chebyshevDistance(worker, b))[0]
    ?? { x: minX - 1, y: site.y };
}

export interface BuiltinCPURuntimeState {
  myState?: unknown;
  myUnits?: unknown;
  mapState?: unknown;
}

export interface BuiltinCPUToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

export async function runBuiltinCPUStrategy(options: {
  strategy: CPUStrategyType;
  runtime: BuiltinCPURuntimeState;
  callTool: (toolName: string, args: Record<string, unknown>) => unknown | Promise<unknown>;
}): Promise<void> {
  const myState = (options.runtime.myState ?? {}) as any;
  const myUnitsPayload = (options.runtime.myUnits ?? {}) as any;
  const myUnits = Array.isArray(myUnitsPayload)
    ? myUnitsPayload
    : Array.isArray(myUnitsPayload.units)
      ? myUnitsPayload.units
      : [];
  const mapState = (options.runtime.mapState ?? {}) as any;

  const credits = typeof myState?.credits === "number" ? myState.credits : 0;
  const hq = myState?.hq ?? null;
  const buildings = Array.isArray(myState?.buildings) ? myState.buildings : [];
  const startedBarracksBuildings = buildings.filter((building: any) => building.type === BUILDING_TYPES.BARRACKS);
  const startedWarFactoryBuildings = buildings.filter((building: any) => building.type === BUILDING_TYPES.WAR_FACTORY);
  const startedRefineryBuildings = buildings.filter((building: any) => building.type === BUILDING_TYPES.REFINERY);
  const barracksBuildings = startedBarracksBuildings.filter((building: any) => !building.constructionProgress);
  const warFactoryBuildings = startedWarFactoryBuildings.filter((building: any) => !building.constructionProgress);
  const hasBarracks = barracksBuildings.length > 0;
  const hasWarFactory = warFactoryBuildings.length > 0;
  const refineryBuildings = startedRefineryBuildings.filter((building: any) => !building.constructionProgress);
  const hasStartedBarracks = startedBarracksBuildings.length > 0;
  const hasStartedWarFactory = startedWarFactoryBuildings.length > 0;
  const hasStartedRefinery = startedRefineryBuildings.length > 0;
  const hasRefinery = refineryBuildings.length > 0;
  const workers = myUnits.filter((unit: any) => unit.type === "worker");
  const availableWorkers = workers.filter((worker: any) => !worker.constructingBuildingId);
  const combatUnitTypes = new Set(getCombatUnitTypes());
  const combatUnits = myUnits.filter((unit: any) => combatUnitTypes.has(unit.type));
  const mapCells = Array.isArray(mapState?.cells) ? mapState.cells : [];
  const mapResources = Array.isArray(mapState?.resources)
    ? mapState.resources.filter((resource: any) => typeof resource?.remaining !== "number" || resource.remaining > 0)
    : [];
  const mapBuildings = Array.isArray(mapState?.buildings)
    ? mapState.buildings
    : mapCells.filter((cell: any) => cell?.building).map((cell: any) => ({ x: cell.x, y: cell.y, ...cell.building }));
  const mapUnits = Array.isArray(mapState?.units)
    ? mapState.units
    : mapCells.filter((cell: any) => cell?.unit).map((cell: any) => ({ x: cell.x, y: cell.y, ...cell.unit }));
  const enemyHQ = mapBuildings.find((building: any) => building?.relation === "enemy" && building.type === "hq") ?? null;
  const enemyBase = enemyHQ ?? (hq?.x < (mapState?.width ?? 144) / 2
    ? DEFAULT_MAP_LAYOUT.player2Hq
    : DEFAULT_MAP_LAYOUT.player1Hq);

  const canBuildBarracks = credits >= getBuildingCost(BUILDING_TYPES.BARRACKS);
  const canBuildWarFactory = credits >= getBuildingCost(BUILDING_TYPES.WAR_FACTORY);
  const canBuildRefinery = credits >= getBuildingCost(BUILDING_TYPES.REFINERY);
  const canSpawnWorker = credits >= getUnitCost(UNIT_TYPES.WORKER);
  const canSpawnSoldier = credits >= getUnitCost(UNIT_TYPES.SOLDIER);
  const canSpawnRifleman = credits >= getUnitCost(UNIT_TYPES.RIFLEMAN);
  const canSpawnRocketSoldier = credits >= getUnitCost(UNIT_TYPES.ROCKET_SOLDIER);
  const canSpawnLightTank = credits >= getUnitCost(UNIT_TYPES.LIGHT_TANK);
  const enemyUnits = mapUnits.filter((unit: any) => unit?.relation === "enemy");
  const enemyBuildings = mapBuildings.filter((building: any) => building?.relation === "enemy");
  const enemyHasVehicles = enemyUnits.some((unit: any) => unit.type === UNIT_TYPES.LIGHT_TANK);
  const preferredBarracksUnit = enemyHasVehicles && canSpawnRocketSoldier
    ? UNIT_TYPES.ROCKET_SOLDIER
    : canSpawnRifleman
      ? UNIT_TYPES.RIFLEMAN
      : UNIT_TYPES.SOLDIER;
  const rushInfrastructureReserve = !hasStartedBarracks
    ? getBuildingCost(BUILDING_TYPES.BARRACKS)
    : hasBarracks && !hasStartedRefinery
      ? getBuildingCost(BUILDING_TYPES.REFINERY)
      : hasBarracks && !hasStartedWarFactory
        ? getBuildingCost(BUILDING_TYPES.WAR_FACTORY)
        : 0;
  const rushProductionCredits = Math.max(0, credits - rushInfrastructureReserve);
  const rushBarracksUnit = enemyHasVehicles && rushProductionCredits >= getUnitCost(UNIT_TYPES.ROCKET_SOLDIER)
    ? UNIT_TYPES.ROCKET_SOLDIER
    : rushProductionCredits >= getUnitCost(UNIT_TYPES.RIFLEMAN)
      ? UNIT_TYPES.RIFLEMAN
      : rushProductionCredits >= getUnitCost(UNIT_TYPES.SOLDIER)
        ? UNIT_TYPES.SOLDIER
        : null;

  const callTool = options.callTool;
  const reservedWorkerIds = new Set<string>();
  let buildActionIssued = false;
  const prepareBuild = async (
    worker: any,
    buildingType: BuildingType,
    site: { x: number; y: number },
  ): Promise<boolean> => {
    reservedWorkerIds.add(worker.id);
    buildActionIssued = true;
    if (isAdjacentToBuildSite(worker, buildingType, site)) {
      return true;
    }
    const approach = findBuildApproach(
      worker,
      buildingType,
      site,
      mapState?.width ?? 144,
      mapState?.height ?? 96,
      myUnits,
    );
    await callTool("move_unit", { unitId: worker.id, x: approach.x, y: approach.y });
    return false;
  };
  const issueMultiFrontAdvance = async (): Promise<boolean> => {
    if (!enemyBase || combatUnits.length < ARMY_MASSING_THRESHOLD) {
      return false;
    }
    const awaitingOrders = combatUnits.filter((unit: any) =>
      unit.intent?.type !== "attack_move" && unit.intent?.type !== "attack"
    );
    if (awaitingOrders.length === 0) {
      return true;
    }
    const frontY = [20, 48, 76];
    const stagingX = enemyBase.x + (hq?.x < enemyBase.x ? -9 : 9);
    for (let front = 0; front < frontY.length; front++) {
      const unitIds = awaitingOrders.filter((_: any, index: number) => index % 3 === front).map((unit: any) => unit.id);
      if (unitIds.length > 0) {
        await callTool("attack_move_unit", {
          unitIds,
          x: stagingX,
          y: frontY[front],
        });
      }
    }
    return true;
  };
  const issueWorkerEconomy = async () => {
    for (const [index, worker] of workers.entries()) {
      if (worker.constructingBuildingId || reservedWorkerIds.has(worker.id)) {
        continue;
      }
      const forwardResources = refineryBuildings.length > 0
        ? [...mapResources].sort((a: any, b: any) => {
            const distanceA = Math.min(...refineryBuildings.map((refinery: any) => chebyshevDistance(refinery, a)));
            const distanceB = Math.min(...refineryBuildings.map((refinery: any) => chebyshevDistance(refinery, b)));
            return distanceA - distanceB;
          })
        : [];
      const forwardResource = forwardResources.length > 0
        ? forwardResources[(index - 2) % Math.min(2, forwardResources.length)]
        : undefined;
      const needsForwardAssignment = hasRefinery && index >= 2 && forwardResource && (
        worker.intent?.type !== "harvest_loop" ||
        worker.intent?.targetX !== forwardResource.x ||
        worker.intent?.targetY !== forwardResource.y
      );
      if (needsForwardAssignment || (worker.intent?.type !== "harvest_loop" && worker.state === "idle")) {
        await callTool(
          "start_harvest_loop",
          needsForwardAssignment
            ? { unitId: worker.id, x: forwardResource.x, y: forwardResource.y }
            : { unitId: worker.id },
        );
      }
    }
  };

  if (options.strategy === "random") {
    if (workers.length === 0 && canSpawnWorker && hq) {
      await callTool("spawn_unit", { buildingId: hq.id, unitType: "worker" });
    } else if (!hasStartedBarracks && canBuildBarracks && availableWorkers[0] && hq) {
      const site = findBuildSite(hq, mapState?.width ?? 21, buildings, myUnits);
      const worker = availableWorkers[0];
      if (await prepareBuild(worker, BUILDING_TYPES.BARRACKS, site)) {
        await callTool("build_structure", {
          unitId: worker.id,
          buildingType: BUILDING_TYPES.BARRACKS,
          x: site.x,
          y: site.y,
        });
      }
    } else {
      const candidatePlans: Array<"mine" | "spawn-worker" | "build-refinery" | "build-war-factory" | "spawn-infantry" | "spawn-tank" | "attack"> = ["mine"];
      if (canSpawnWorker && workers.length < 4 && hq) {
        candidatePlans.push("spawn-worker");
      }
      if (hasBarracks && !hasStartedWarFactory && canBuildWarFactory && availableWorkers[0]) {
        candidatePlans.push("build-war-factory");
      }
      if (hasBarracks && !hasStartedRefinery && canBuildRefinery && availableWorkers[0] && hq) {
        candidatePlans.push("build-refinery");
      }
      if (hasBarracks && (canSpawnRifleman || canSpawnRocketSoldier || canSpawnSoldier)) {
        candidatePlans.push("spawn-infantry");
      }
      if (hasWarFactory && canSpawnLightTank) {
        candidatePlans.push("spawn-tank");
      }
      if (combatUnits.length > 0 || hasBarracks) {
        candidatePlans.push("attack");
      }

      const selectedPlan = chooseRandom(candidatePlans);
      await issueWorkerEconomy();

      if (selectedPlan === "spawn-worker" && hq) {
        await callTool("spawn_unit", { buildingId: hq.id, unitType: "worker" });
      } else if (selectedPlan === "build-refinery" && availableWorkers[0] && hq) {
        const site = findForwardRefinerySite(hq, mapState?.width ?? 144);
        const worker = availableWorkers[0];
        if (await prepareBuild(worker, BUILDING_TYPES.REFINERY, site)) {
          await callTool("build_structure", { unitId: worker.id, buildingType: BUILDING_TYPES.REFINERY, x: site.x, y: site.y });
        }
      } else if (selectedPlan === "build-war-factory" && availableWorkers[0] && hq) {
        const site = findBuildSite(hq, mapState?.width ?? 21, buildings, myUnits);
        const worker = availableWorkers[0];
        if (await prepareBuild(worker, BUILDING_TYPES.WAR_FACTORY, site)) {
          await callTool("build_structure", {
            unitId: worker.id,
            buildingType: BUILDING_TYPES.WAR_FACTORY,
            x: site.x,
            y: site.y,
          });
        }
      } else if (selectedPlan === "spawn-infantry") {
        for (const barracks of barracksBuildings) {
          await callTool("spawn_unit", { buildingId: barracks.id, unitType: preferredBarracksUnit });
        }
      } else if (selectedPlan === "spawn-tank") {
        for (const warFactory of warFactoryBuildings) {
          await callTool("spawn_unit", { buildingId: warFactory.id, unitType: UNIT_TYPES.LIGHT_TANK });
        }
      } else if (selectedPlan === "attack") {
        const shouldAttackThisTurn = Math.random() > 0.75;
        if (combatUnits.length === 0 && barracksBuildings.length > 0 && (canSpawnRifleman || canSpawnRocketSoldier || canSpawnSoldier)) {
          for (const barracks of barracksBuildings) {
            await callTool("spawn_unit", { buildingId: barracks.id, unitType: preferredBarracksUnit });
          }
        } else if (!(await issueMultiFrontAdvance())) {
          for (const combatUnit of combatUnits) {
            const roleTarget = findRoleTarget(combatUnit, enemyUnits, enemyBuildings);
            if (roleTarget && (combatUnit.type === UNIT_TYPES.LIGHT_TANK || combatUnit.type === UNIT_TYPES.ROCKET_SOLDIER || shouldAttackThisTurn)) {
              await callTool("attack", {
                unitId: combatUnit.id,
                targetId: roleTarget.id,
              });
            } else {
              await callTool("attack_move_unit", { unitId: combatUnit.id, x: enemyBase.x, y: enemyBase.y });
            }
          }
        }
      }
    }
    return;
  }

  const isHQUnderPressure = hq
    ? enemyUnits.some((enemy: any) => chebyshevDistance(enemy, hq) <= 2)
    : false;

  if (hq && workers.length < 4 && canSpawnWorker) {
    await callTool("spawn_unit", { buildingId: hq.id, unitType: "worker" });
  }

  if (!hasStartedBarracks && canBuildBarracks && availableWorkers[0] && hq) {
    const site = findBuildSite(hq, mapState?.width ?? 21, buildings, myUnits);
    const worker = availableWorkers[0];
    if (await prepareBuild(worker, BUILDING_TYPES.BARRACKS, site)) {
      await callTool("build_structure", {
        unitId: worker.id,
        buildingType: BUILDING_TYPES.BARRACKS,
        x: site.x,
        y: site.y,
      });
    }
  }

  if (!buildActionIssued && hasBarracks && !hasStartedRefinery && canBuildRefinery && availableWorkers[0] && hq) {
    const site = findForwardRefinerySite(hq, mapState?.width ?? 144);
    const worker = availableWorkers[0];
    if (await prepareBuild(worker, BUILDING_TYPES.REFINERY, site)) {
      await callTool("build_structure", {
        unitId: worker.id,
        buildingType: BUILDING_TYPES.REFINERY,
        x: site.x,
        y: site.y,
      });
    }
  }

  if (!buildActionIssued && hasBarracks && !hasStartedWarFactory && canBuildWarFactory && availableWorkers[0] && hq) {
    const site = findBuildSite(hq, mapState?.width ?? 21, buildings, myUnits);
    const worker = availableWorkers[0];
    if (await prepareBuild(worker, BUILDING_TYPES.WAR_FACTORY, site)) {
      await callTool("build_structure", {
        unitId: worker.id,
        buildingType: BUILDING_TYPES.WAR_FACTORY,
        x: site.x,
        y: site.y,
      });
    }
  }

  if (hasBarracks && rushBarracksUnit) {
    for (const barracks of barracksBuildings) {
      await callTool("spawn_unit", { buildingId: barracks.id, unitType: rushBarracksUnit });
    }
  }

  if (hasWarFactory && canSpawnLightTank) {
    for (const warFactory of warFactoryBuildings) {
      await callTool("spawn_unit", { buildingId: warFactory.id, unitType: UNIT_TYPES.LIGHT_TANK });
    }
  }

  await issueWorkerEconomy();

  if (
    startedBarracksBuildings.length < 2 &&
    hasRefinery &&
    hasWarFactory &&
    credits >= getBuildingCost(BUILDING_TYPES.BARRACKS) + getUnitCost(UNIT_TYPES.RIFLEMAN) &&
    availableWorkers[0] && hq &&
    !buildActionIssued
  ) {
    const site = findBuildSite(hq, mapState?.width ?? 144, buildings, myUnits);
    const worker = availableWorkers[0];
    if (await prepareBuild(worker, BUILDING_TYPES.BARRACKS, site)) {
      await callTool("build_structure", {
        unitId: worker.id,
        buildingType: BUILDING_TYPES.BARRACKS,
        x: site.x,
        y: site.y,
      });
    }
  }

  if (!isHQUnderPressure && combatUnits.length < ARMY_MASSING_THRESHOLD) {
    return;
  }

  if (isHQUnderPressure) {
    const pressuredEnemies = enemyUnits.filter((enemy: any) => hq && chebyshevDistance(enemy, hq) <= 2);
    for (const combatUnit of combatUnits) {
      const closestThreat = pressuredEnemies.reduce((best: any, enemy: any) => {
        if (!best) return enemy;
        return chebyshevDistance(combatUnit, enemy) < chebyshevDistance(combatUnit, best) ? enemy : best;
      }, null);
      if (closestThreat) {
        const inRange = chebyshevDistance(combatUnit, closestThreat) <= combatUnit.attackRange;
        if (inRange) {
          await callTool("attack", {
            unitId: combatUnit.id,
            targetId: closestThreat.id,
          });
        } else {
          await callTool("attack_move_unit", { unitId: combatUnit.id, x: closestThreat.x, y: closestThreat.y });
        }
        continue;
      }
      if (enemyHQ) {
        await callTool("attack_move_unit", { unitId: combatUnit.id, x: enemyHQ.x, y: enemyHQ.y });
      }
    }
  } else {
    if (await issueMultiFrontAdvance()) {
      return;
    }
    for (const combatUnit of combatUnits) {
      if (!enemyHQ) {
        const closestEnemy = enemyUnits[0];
        if (closestEnemy) {
          await callTool("attack", { unitId: combatUnit.id, targetId: closestEnemy.id });
        } else {
          await callTool("attack_move_unit", { unitId: combatUnit.id, x: enemyBase.x, y: enemyBase.y });
        }
        continue;
      }
      const roleTarget = findRoleTarget(combatUnit, enemyUnits, enemyBuildings);
      if (roleTarget && (combatUnit.type === UNIT_TYPES.LIGHT_TANK || combatUnit.type === UNIT_TYPES.ROCKET_SOLDIER)) {
        await callTool("attack", { unitId: combatUnit.id, targetId: roleTarget.id });
        continue;
      }
      const inRange = chebyshevDistance(combatUnit, enemyHQ) <= combatUnit.attackRange;
      if (inRange) {
        await callTool("attack", {
          unitId: combatUnit.id,
          targetId: enemyHQ.id,
        });
      } else {
        await callTool("attack_move_unit", { unitId: combatUnit.id, x: enemyHQ.x, y: enemyHQ.y });
      }
    }
  }

  if (!hasBarracks && !canBuildBarracks && canSpawnWorker && hq && workers.length < 4) {
    await callTool("spawn_unit", { buildingId: hq.id, unitType: "worker" });
  }
}
