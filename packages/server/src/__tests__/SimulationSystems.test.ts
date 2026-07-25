import { describe, expect, it, vi } from "vitest";
import { BUILDING_TYPES, DEFAULT_MAP_LAYOUT, RESULT_CODES, UNIT_TYPES } from "@llmcraft/shared";
import { createDefaultMatchDefinition } from "../MatchDefinition";
import { WorldState } from "../WorldState";
import { ConstructionSystem } from "../simulation/ConstructionSystem";
import { CombatSystem } from "../simulation/CombatSystem";
import { EconomySystem } from "../simulation/EconomySystem";
import { HarvestOrderSystem } from "../simulation/HarvestOrderSystem";
import { MovementSystem } from "../simulation/MovementSystem";
import { ProductionSystem } from "../simulation/ProductionSystem";
import { ProjectileSystem } from "../simulation/ProjectileSystem";
import { VictorySystem } from "../simulation/VictorySystem";
import { PathFinder } from "../PathFinder";
import { getCollisionManifold } from "../navigation/CollisionShape";
import { getUnitCollisionShape } from "../navigation/UnitCollision";

describe("simulation systems", () => {
  it("advances path movement using only WorldState", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const worker = world.units.getUnitsByPlayer("player_1")[0];
    const start = { x: worker.x, y: worker.y };
    const result = world.units.setMoveTarget(
      worker,
      Math.round(worker.x) + 4,
      Math.round(worker.y),
      world.tiles,
      world.buildings.getOccupiedPositions(),
    );

    expect(result).toBe(RESULT_CODES.OK);
    new MovementSystem().step(world);
    expect({ x: worker.x, y: worker.y }).not.toEqual(start);
  });

  it("updates a tank's authoritative hull heading when it turns", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const tank = world.createUnit(UNIT_TYPES.LIGHT_TANK, 70, 50, "player_1");
    tank.path = [{ x: 70, y: 54 }];
    tank.pathTarget = { x: 70, y: 54 };

    new MovementSystem().step(world);

    expect(tank.y).toBeGreaterThan(50);
    expect(tank.heading).toBeCloseTo(Math.PI / 2);
  });

  it("yields from a dynamically blocked tank path without retrying A* forever", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const mover = world.createUnit(UNIT_TYPES.LIGHT_TANK, 59, 44, "player_2");
    world.createUnit(UNIT_TYPES.LIGHT_TANK, 60, 45, "player_2");
    mover.path = [{ x: 59, y: 45 }, { x: 59, y: 46 }, { x: 59, y: 47 }];
    mover.pathTarget = { x: 59, y: 47 };
    const pathFinder = vi.spyOn(PathFinder, "findPath");

    new MovementSystem().step(world);

    expect(pathFinder).not.toHaveBeenCalled();
    pathFinder.mockRestore();
    expect(Number.isFinite(mover.x)).toBe(true);
    expect(Number.isFinite(mover.y)).toBe(true);
    expect({ x: mover.x, y: mover.y }).not.toEqual({ x: 59, y: 44 });
    expect(mover.pathTarget).toEqual({ x: 59, y: 47 });
  });

  it("keeps congested movement work bounded across repeated ticks", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const movers = Array.from({ length: 24 }, (_, index) => {
      const x = 50 + (index % 6);
      const y = 40 + Math.floor(index / 6);
      const unit = world.createUnit(UNIT_TYPES.SOLDIER, x, y, "player_1");
      unit.path = Array.from({ length: 8 }, (__, step) => ({ x: x + step + 1, y }));
      unit.pathTarget = { x: x + 8, y };
      return unit;
    });
    const starts = movers.map((unit) => ({ x: unit.x, y: unit.y }));

    for (let tick = 0; tick < 20; tick++) new MovementSystem().step(world);

    expect(movers.some((unit, index) => unit.x !== starts[index].x || unit.y !== starts[index].y)).toBe(true);
    expect(movers.every((unit) => Number.isFinite(unit.x) && Number.isFinite(unit.y))).toBe(true);
  });

  it("does not let opposing movers swap through one another in a tick", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const left = world.createUnit(UNIT_TYPES.SOLDIER, 70, 40, "player_1");
    const right = world.createUnit(UNIT_TYPES.SOLDIER, 71, 40, "player_2");
    left.path = [{ x: 71, y: 40 }];
    left.pathTarget = { x: 71, y: 40 };
    right.path = [{ x: 70, y: 40 }];
    right.pathTarget = { x: 70, y: 40 };

    new MovementSystem().step(world);

    expect(
      left.x === 71 && left.y === 40 && right.x === 70 && right.y === 40,
    ).toBe(false);
    expect(getCollisionManifold(getUnitCollisionShape(left), getUnitCollisionShape(right))).toBeNull();
  });

  it("separates tank hulls and infantry bodies using their rendered footprint", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const tank = world.createUnit(UNIT_TYPES.LIGHT_TANK, 70, 50, "player_1");
    const soldier = world.createUnit(UNIT_TYPES.SOLDIER, 70, 50, "player_2");

    new MovementSystem().step(world);

    expect(getCollisionManifold(getUnitCollisionShape(tank), getUnitCollisionShape(soldier))).toBeNull();
  });

  it("resolves a mixed tank and infantry pile without leaving intersecting bodies", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const units = [
      world.createUnit(UNIT_TYPES.LIGHT_TANK, 70, 50, "player_1"),
      world.createUnit(UNIT_TYPES.LIGHT_TANK, 70.6, 50.2, "player_2"),
      world.createUnit(UNIT_TYPES.SOLDIER, 69.8, 50.1, "player_1"),
      world.createUnit(UNIT_TYPES.RIFLEMAN, 70.2, 49.8, "player_2"),
      world.createUnit(UNIT_TYPES.ROCKET_SOLDIER, 70.4, 50.4, "player_1"),
    ];

    for (let tick = 0; tick < 12; tick++) new MovementSystem().step(world);

    for (let leftIndex = 0; leftIndex < units.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < units.length; rightIndex++) {
        expect(getCollisionManifold(
          getUnitCollisionShape(units[leftIndex]),
          getUnitCollisionShape(units[rightIndex]),
        )).toBeNull();
      }
    }
  });

  it("attack-moves toward a moving target using an integer grid destination", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const attacker = world.createUnit(UNIT_TYPES.SOLDIER, 60, 48, "player_1");
    const target = world.createUnit(UNIT_TYPES.SOLDIER, 65, 48, "player_2");
    target.x = 65.4;
    target.y = 48.6;
    attacker.order = {
      type: "attack_move",
      targetX: 100,
      targetY: 48,
      targetPriority: [UNIT_TYPES.SOLDIER],
    };

    new CombatSystem().step(world);

    expect(attacker.pathTarget).toEqual(expect.objectContaining({
      x: expect.any(Number),
      y: expect.any(Number),
    }));
    expect(Number.isInteger(attacker.pathTarget?.x)).toBe(true);
    expect(Number.isInteger(attacker.pathTarget?.y)).toBe(true);
  });

  it("keeps automatic harvest assignments on efficient delivery routes instead of fleeing assigned near deposits", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const workers = world.units.getUnitsByPlayer("player_1");
    const chooser = workers[0];
    const assignedWorkers = [
      ...workers.slice(1),
      world.createUnit(UNIT_TYPES.WORKER, chooser.x, chooser.y, "player_1"),
    ];
    for (const [index, worker] of assignedWorkers.entries()) {
      const resource = DEFAULT_MAP_LAYOUT.resources[index];
      worker.order = { type: "harvest_loop", targetX: resource.x, targetY: resource.y };
    }

    const target = new HarvestOrderSystem().resolveResourceTarget(world, chooser);

    expect(target).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
    expect(DEFAULT_MAP_LAYOUT.resources.slice(0, 4)).toContainEqual(target);
  });

  it("uses a completed forward refinery when automatically selecting a harvest route", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const worker = world.units.getUnitsByPlayer("player_1")[0];
    world.createBuilding(BUILDING_TYPES.REFINERY, 43, 18, "player_1");

    const target = new HarvestOrderSystem().resolveResourceTarget(world, worker);

    expect(target).toEqual(DEFAULT_MAP_LAYOUT.resources[8]);
  });

  it("completes construction and returns a serializable domain outcome", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const worker = world.units.getUnitsByPlayer("player_1")[0];
    const building = world.createBuilding(
      BUILDING_TYPES.BARRACKS,
      30,
      48,
      "player_1",
      {
        constructionProgress: {
          workerId: worker.id,
          remainingTicks: 1,
          totalTicks: 1,
        },
      },
    );
    worker.constructingBuildingId = building.id;

    const events = new ConstructionSystem().step(world);

    expect(events).toEqual([{
      type: "building_completed",
      playerId: "player_1",
      buildingId: building.id,
      buildingType: BUILDING_TYPES.BARRACKS,
      workerId: worker.id,
    }]);
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
    expect(building.constructionProgress).toBeUndefined();
    expect(worker.constructingBuildingId).toBeUndefined();
  });

  it("restores a worker's harvest loop after construction", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const worker = world.units.getUnitsByPlayer("player_1")[0];
    const resumeWorkerOrder = { type: "harvest_loop" as const, targetX: 31, targetY: 35 };
    const building = world.createBuilding(BUILDING_TYPES.BARRACKS, 30, 48, "player_1", {
      constructionProgress: {
        workerId: worker.id,
        remainingTicks: 1,
        totalTicks: 1,
        resumeWorkerOrder,
      },
    });
    worker.constructingBuildingId = building.id;

    new ConstructionSystem().step(world);

    expect(worker.order).toEqual(resumeWorkerOrder);
    expect(worker.state).toBe("idle");
  });

  it("ticks production and returns spawned entity identity without logging", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const building = world.createBuilding(BUILDING_TYPES.BARRACKS, 30, 48, "player_1");
    building.productionQueue.push(UNIT_TYPES.SOLDIER);
    building.productionProgress = {
      unitType: UNIT_TYPES.SOLDIER,
      remainingTicks: 1,
      totalTicks: 1,
    };

    const events = new ProductionSystem().step(world);

    expect(events).toEqual([
      expect.objectContaining({
        type: "unit_spawned",
        playerId: "player_1",
        buildingId: building.id,
        unitType: UNIT_TYPES.SOLDIER,
        unitId: expect.any(String),
      }),
    ]);
    const event = events[0];
    expect(event.type).toBe("unit_spawned");
    if (event.type === "unit_spawned") {
      expect(world.entities.resolve(event.unitId)).toMatchObject({ kind: "unit" });
    }
  });

  it("advances resource economy and returns structured outcomes", () => {
    const definition = createDefaultMatchDefinition();
    const world = new WorldState(definition);
    const worker = world.units.getUnitsByPlayer("player_1")[0];
    const resource = definition.map.resources[0];
    worker.x = resource.x;
    worker.y = resource.y;
    world.setResourceRemaining(resource.x, resource.y, 10);

    const gatherEvents = new EconomySystem().step(world);

    expect(gatherEvents).toEqual([{
      type: "resource_gathered",
      playerId: "player_1",
      unitId: worker.id,
      amount: 10,
      carryingCredits: 10,
    }]);

    const hq = world.buildings.getBuildingsByPlayer("player_1")[0];
    worker.x = hq.x + 1;
    worker.y = hq.y;
    const deliveryEvents = new EconomySystem().step(world);

    expect(deliveryEvents).toEqual([{
      type: "credits_delivered",
      playerId: "player_1",
      unitId: worker.id,
      buildingId: hq.id,
      amount: 10,
      credits: 810,
    }]);
  });

  it("sustains harvest orders without using Game or Agent state", () => {
    const definition = createDefaultMatchDefinition();
    const world = new WorldState(definition);
    const worker = world.units.getUnitsByPlayer("player_1")[0];
    const resource = definition.map.resources[0];
    worker.order = { type: "harvest_loop", targetX: resource.x, targetY: resource.y };

    new HarvestOrderSystem().step(world);

    expect(worker.order).toMatchObject({
      type: "harvest_loop",
      targetX: resource.x,
      targetY: resource.y,
    });
    expect(worker.pathTarget).toEqual(resource);
  });

  it("resolves projectile damage entirely inside WorldState", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const attacker = world.createUnit(UNIT_TYPES.SOLDIER, 30, 48, "player_1");
    const target = world.createUnit(UNIT_TYPES.SOLDIER, 31, 48, "player_2");
    const initialHp = target.hp;
    world.projectiles.push({
      id: "projectile_test",
      playerId: "player_1",
      attackerId: attacker.id,
      attackerType: attacker.type,
      projectileType: "instant",
      x: attacker.x,
      y: attacker.y,
      startX: attacker.x,
      startY: attacker.y,
      targetX: target.x,
      targetY: target.y,
      launchedTick: 0,
      impactTick: 0,
      targetId: target.id,
      targetKind: "unit",
    });

    new ProjectileSystem().step(world);

    expect(world.projectiles).toEqual([]);
    expect(target.hp).toBeLessThan(initialHp);
  });

  it("launches attacks and eligible retaliation using only WorldState", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const attacker = world.createUnit(UNIT_TYPES.SOLDIER, 40, 40, "player_1");
    const defender = world.createUnit(UNIT_TYPES.SOLDIER, 41, 40, "player_2");

    const result = new CombatSystem().executeAttackOrder(world, attacker, "player_1", {
      type: "attack",
      targetId: defender.id,
    });

    expect(result).toBe(RESULT_CODES.OK);
    expect(world.projectiles).toHaveLength(2);
    expect(world.projectiles.map((projectile) => projectile.attackerId)).toEqual([
      attacker.id,
      defender.id,
    ]);
    expect(attacker.order).toMatchObject({ type: "attack", targetId: defender.id });
    expect(defender.order).toMatchObject({ type: "attack", targetId: attacker.id });
  });

  it("preserves an attack-move mission after acquiring and firing on a target", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const attacker = world.createUnit(UNIT_TYPES.SOLDIER, 40, 40, "player_1");
    const defender = world.createUnit(UNIT_TYPES.SOLDIER, 41, 40, "player_2");
    attacker.order = {
      type: "attack_move",
      targetX: 45,
      targetY: 40,
      targetPriority: [UNIT_TYPES.SOLDIER],
    };

    new CombatSystem().step(world);

    expect(world.projectiles.some((projectile) => projectile.targetId === defender.id)).toBe(true);
    expect(attacker.order).toMatchObject({
      type: "attack_move",
      targetX: 45,
      targetY: 40,
      targetId: defender.id,
    });
  });

  it("derives victory from authoritative building lifecycle", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    for (const building of world.buildings.getBuildingsByPlayer("player_2")) {
      world.destroyEntity(building.id);
    }

    expect(new VictorySystem().step(world)).toEqual({
      type: "player_eliminated",
      winnerId: "player_1",
      loserId: "player_2",
    });
    expect(world.winner).toBe("player_1");
  });
});
