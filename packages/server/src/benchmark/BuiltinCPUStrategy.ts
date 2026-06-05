import {
  BUILDING_TYPES,
  CPUStrategyType,
  UNIT_TYPES,
  getBuildingCost,
  getCombatUnitTypes,
  getUnitCost,
} from "@llmcraft/shared";

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
    { x: hq.x + side * 2, y: hq.y },
    { x: hq.x + side * 2, y: hq.y - 2 },
    { x: hq.x + side * 2, y: hq.y + 2 },
    { x: hq.x + side * 3, y: hq.y - 1 },
    { x: hq.x + side * 3, y: hq.y + 1 },
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
  const barracksBuildings = buildings.filter((building: any) => building.type === "barracks");
  const warFactoryBuildings = buildings.filter((building: any) => building.type === "war_factory");
  const hasBarracks = barracksBuildings.length > 0;
  const hasWarFactory = warFactoryBuildings.length > 0;
  const workers = myUnits.filter((unit: any) => unit.type === "worker");
  const combatUnitTypes = new Set(getCombatUnitTypes());
  const combatUnits = myUnits.filter((unit: any) => combatUnitTypes.has(unit.type));
  const mapCells = Array.isArray(mapState?.cells) ? mapState.cells : [];
  const mapBuildings = Array.isArray(mapState?.buildings)
    ? mapState.buildings
    : mapCells.filter((cell: any) => cell?.building).map((cell: any) => ({ x: cell.x, y: cell.y, ...cell.building }));
  const mapUnits = Array.isArray(mapState?.units)
    ? mapState.units
    : mapCells.filter((cell: any) => cell?.unit).map((cell: any) => ({ x: cell.x, y: cell.y, ...cell.unit }));
  const enemyHQ = mapBuildings.find((building: any) => building?.relation === "enemy" && building.type === "hq") ?? null;

  const canBuildBarracks = credits >= getBuildingCost(BUILDING_TYPES.BARRACKS);
  const canBuildWarFactory = credits >= getBuildingCost(BUILDING_TYPES.WAR_FACTORY);
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

  const callTool = options.callTool;
  const issueWorkerEconomy = async () => {
    for (const worker of workers) {
      if (worker.intent?.type !== "harvest_loop" && worker.state === "idle") {
        await callTool("start_harvest_loop", { unitId: worker.id });
      }
    }
  };

  if (options.strategy === "random") {
    if (workers.length === 0 && canSpawnWorker && hq) {
      await callTool("spawn_unit", { buildingId: hq.id, unitType: "worker" });
    } else if (!hasBarracks && canBuildBarracks && workers[0] && hq) {
      const site = findBuildSite(hq, mapState?.width ?? 21, buildings, myUnits);
      await callTool("build_structure", {
        unitId: workers[0].id,
        buildingType: "barracks",
        x: site.x,
        y: site.y,
      });
    } else {
      const candidatePlans: Array<"mine" | "spawn-worker" | "build-war-factory" | "spawn-infantry" | "spawn-tank" | "attack"> = ["mine"];
      if (canSpawnWorker && workers.length < 4 && hq) {
        candidatePlans.push("spawn-worker");
      }
      if (hasBarracks && !hasWarFactory && canBuildWarFactory && workers[0]) {
        candidatePlans.push("build-war-factory");
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
      } else if (selectedPlan === "build-war-factory" && workers[0] && hq) {
        const site = findBuildSite(hq, mapState?.width ?? 21, buildings, myUnits);
        await callTool("build_structure", {
          unitId: workers[0].id,
          buildingType: "war_factory",
          x: site.x,
          y: site.y,
        });
      } else if (selectedPlan === "spawn-infantry") {
        for (const barracks of barracksBuildings) {
          await callTool("spawn_unit", { buildingId: barracks.id, unitType: preferredBarracksUnit });
        }
      } else if (selectedPlan === "spawn-tank") {
        for (const warFactory of warFactoryBuildings) {
          await callTool("spawn_unit", { buildingId: warFactory.id, unitType: UNIT_TYPES.LIGHT_TANK });
        }
      } else if (selectedPlan === "attack" && enemyHQ) {
        const shouldAttackThisTurn = Math.random() > 0.75;
        if (combatUnits.length === 0 && barracksBuildings.length > 0 && (canSpawnRifleman || canSpawnRocketSoldier || canSpawnSoldier)) {
          for (const barracks of barracksBuildings) {
            await callTool("spawn_unit", { buildingId: barracks.id, unitType: preferredBarracksUnit });
          }
        } else {
          for (const combatUnit of combatUnits) {
            const roleTarget = findRoleTarget(combatUnit, enemyUnits, enemyBuildings);
            if (roleTarget && (combatUnit.type === UNIT_TYPES.LIGHT_TANK || combatUnit.type === UNIT_TYPES.ROCKET_SOLDIER || shouldAttackThisTurn)) {
              await callTool("attack", {
                unitId: combatUnit.id,
                targetId: roleTarget.id,
              });
            } else {
              await callTool("attack_move_unit", { unitId: combatUnit.id, x: enemyHQ.x, y: enemyHQ.y });
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

  if (hq && workers.length < 2 && canSpawnWorker) {
    await callTool("spawn_unit", { buildingId: hq.id, unitType: "worker" });
  }

  if (!hasBarracks && canBuildBarracks && workers[0] && hq) {
    const site = findBuildSite(hq, mapState?.width ?? 21, buildings, myUnits);
    await callTool("build_structure", {
      unitId: workers[0].id,
      buildingType: "barracks",
      x: site.x,
      y: site.y,
    });
  }

  if (hasBarracks && (canSpawnRifleman || canSpawnRocketSoldier || canSpawnSoldier)) {
    for (const barracks of barracksBuildings) {
      await callTool("spawn_unit", { buildingId: barracks.id, unitType: preferredBarracksUnit });
    }
  }

  if (hasBarracks && !hasWarFactory && canBuildWarFactory && workers[0] && hq) {
    const site = findBuildSite(hq, mapState?.width ?? 21, buildings, myUnits);
    await callTool("build_structure", {
      unitId: workers[0].id,
      buildingType: "war_factory",
      x: site.x,
      y: site.y,
    });
  }

  if (hasWarFactory && canSpawnLightTank) {
    for (const warFactory of warFactoryBuildings) {
      await callTool("spawn_unit", { buildingId: warFactory.id, unitType: UNIT_TYPES.LIGHT_TANK });
    }
  }

  await issueWorkerEconomy();

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
    for (const combatUnit of combatUnits) {
      if (!enemyHQ) {
        const closestEnemy = enemyUnits[0];
        if (closestEnemy) {
          await callTool("attack", { unitId: combatUnit.id, targetId: closestEnemy.id });
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
