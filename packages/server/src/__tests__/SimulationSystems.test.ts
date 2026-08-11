import { describe, expect, it, vi } from "vitest";
import { BUILDING_TYPES, DEFAULT_MAP_LAYOUT, getAttackDamageAgainstUnit, getUnitStats, RESULT_CODES, UNIT_TYPES } from "@llmcraft/shared";
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
  it("sends a produced unit toward the nearest reachable tile around an occupied rally point", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const barracks = world.createBuilding(BUILDING_TYPES.BARRACKS, 30, 48, "player_1");
    const occupiedRallyPoint = { x: 45, y: 48, mode: "move" as const };
    barracks.rallyPoint = occupiedRallyPoint;
    const [order] = world.buildings.enqueueProduction(barracks, [{ unitType: UNIT_TYPES.RIFLEMAN, count: 1 }]);
    barracks.productionProgress = {
      orderId: order.orderId,
      unitType: UNIT_TYPES.RIFLEMAN,
      remainingTicks: 1,
      totalTicks: 1,
      paidCredits: 0,
      totalCost: 80,
      status: "producing",
    };
    world.createUnit(UNIT_TYPES.WORKER, occupiedRallyPoint.x, occupiedRallyPoint.y, "player_1");

    const events = new ProductionSystem().step(world);
    const spawned = events.find((event) => event.type === "unit_spawned");
    expect(spawned?.type).toBe("unit_spawned");
    if (!spawned || spawned.type !== "unit_spawned") return;
    const unit = world.units.getUnit(spawned.unitId)!;

    expect(unit.order).toMatchObject({ type: "move" });
    expect(unit.pathTarget).toBeDefined();
    expect(unit.pathTarget).not.toEqual(occupiedRallyPoint);
    expect(Math.abs(unit.pathTarget!.x - occupiedRallyPoint.x) + Math.abs(unit.pathTarget!.y - occupiedRallyPoint.y)).toBe(1);
  });

  it("gives produced combat units an attack-move order for an attack-move rally point", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const barracks = world.createBuilding(BUILDING_TYPES.BARRACKS, 30, 48, "player_1");
    barracks.rallyPoint = { x: 45, y: 48, mode: "attack_move" };
    const [order] = world.buildings.enqueueProduction(barracks, [{ unitType: UNIT_TYPES.RIFLEMAN, count: 1 }]);
    barracks.productionProgress = {
      orderId: order.orderId,
      unitType: UNIT_TYPES.RIFLEMAN,
      remainingTicks: 1,
      totalTicks: 1,
      paidCredits: 0,
      totalCost: 80,
      status: "producing",
    };

    const events = new ProductionSystem().step(world);
    const spawned = events.find((event) => event.type === "unit_spawned");
    expect(spawned?.type).toBe("unit_spawned");
    if (!spawned || spawned.type !== "unit_spawned") return;

    expect(world.units.getUnit(spawned.unitId)?.order).toMatchObject({
      type: "attack_move",
      targetX: 45,
      targetY: 48,
    });
  });

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

  it("moves an isolated unit monotonically along a straight target without lateral drift or overspeed", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const soldier = world.createUnit(UNIT_TYPES.SOLDIER, 50, 30, "player_1");
    soldier.path = Array.from({ length: 8 }, (_, index) => ({ x: 51 + index, y: 30 }));
    soldier.pathTarget = { x: 58, y: 30 };
    const positions = [{ x: soldier.x, y: soldier.y }];

    for (let tick = 0; tick < 6; tick++) {
      new MovementSystem().step(world);
      positions.push({ x: soldier.x, y: soldier.y });
    }

    const maxStep = getUnitStats(soldier.type).speed;
    for (let index = 1; index < positions.length; index++) {
      const previous = positions[index - 1]!;
      const current = positions[index]!;
      expect(current.x).toBeGreaterThan(previous.x);
      expect(current.y).toBeCloseTo(30, 8);
      expect(Math.hypot(current.x - previous.x, current.y - previous.y)).toBeLessThanOrEqual(maxStep + 1e-8);
    }
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

  it("lets a tank and worker escape traffic beside an HQ instead of oscillating forever", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const tank = world.createUnit(UNIT_TYPES.LIGHT_TANK, 11.637597859575969, 42.97192172836485, "player_1");
    tank.heading = 1.5347068724483233;
    tank.path = [
      { x: 12, y: 42 },
      { x: 13, y: 42 },
      { x: 14, y: 42 },
      { x: 15, y: 42 },
      { x: 16, y: 42 },
      { x: 17, y: 42 },
      { x: 18, y: 42 },
      { x: 19, y: 42 },
      { x: 20, y: 42 },
      { x: 20, y: 43 },
    ];
    tank.pathTarget = { x: 20, y: 43 };

    // Preserve the odd unit-id avoidance side from the benchmark fixture.
    world.createUnit(UNIT_TYPES.WORKER, 40, 40, "player_1");
    const worker = world.createUnit(UNIT_TYPES.WORKER, 10.087894146970639, 43.407306036546764, "player_1");
    worker.heading = 1.1518951022505093;
    worker.path = [
      { x: 11, y: 43 },
      { x: 12, y: 43 },
      { x: 13, y: 43 },
      { x: 14, y: 43 },
      { x: 15, y: 43 },
      { x: 16, y: 43 },
      { x: 17, y: 43 },
      { x: 18, y: 43 },
      { x: 19, y: 43 },
      { x: 20, y: 43 },
      { x: 20, y: 44 },
      { x: 20, y: 45 },
      { x: 20, y: 46 },
      { x: 20, y: 47 },
      { x: 20, y: 48 },
    ];
    worker.pathTarget = { x: 20, y: 48 };

    for (let tick = 0; tick < 30; tick++) new MovementSystem().step(world);

    expect(tank.x).toBeGreaterThan(14);
    expect(worker.x).toBeGreaterThan(12);
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

  it("separates canonical heavy and light tank bodies in a dense vehicle pile", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const vehicles = [
      world.createUnit(UNIT_TYPES.HEAVY_TANK, 70, 50, "player_1"),
      world.createUnit(UNIT_TYPES.HEAVY_TANK, 70.8, 50.2, "player_2"),
      world.createUnit(UNIT_TYPES.LIGHT_TANK, 69.5, 49.7, "player_1"),
    ];

    for (let tick = 0; tick < 16; tick++) new MovementSystem().step(world);

    for (let leftIndex = 0; leftIndex < vehicles.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < vehicles.length; rightIndex++) {
        expect(getCollisionManifold(
          getUnitCollisionShape(vehicles[leftIndex]),
          getUnitCollisionShape(vehicles[rightIndex]),
        )).toBeNull();
      }
    }
  });

  it.each([
    UNIT_TYPES.WORKER,
    UNIT_TYPES.RIFLEMAN,
    UNIT_TYPES.ROCKET_SOLDIER,
  ])("lets a moving light tank crush an enemy %s", (targetType) => {
    const world = new WorldState(createDefaultMatchDefinition());
    const tank = world.createUnit(UNIT_TYPES.LIGHT_TANK, 70, 50, "player_1");
    const target = world.createUnit(targetType, 72, 50, "player_2");
    tank.path = [{ x: 71, y: 50 }];
    tank.pathTarget = { x: 71, y: 50 };

    const events = new MovementSystem().step(world);

    expect(tank.x).toBe(71);
    expect(target.exists).toBe(false);
    expect(target.hp).toBe(0);
    expect(events).toEqual([{
      type: "unit_destroyed",
      playerId: "player_2",
      unitId: target.id,
      unitType: targetType,
    }]);
  });

  it.each([
    ["friendly worker", UNIT_TYPES.WORKER, "player_1"],
    ["enemy legacy soldier", UNIT_TYPES.SOLDIER, "player_2"],
    ["enemy light tank", UNIT_TYPES.LIGHT_TANK, "player_2"],
  ] as const)("does not let a light tank crush a %s", (_label, targetType, playerId) => {
    const world = new WorldState(createDefaultMatchDefinition());
    const tank = world.createUnit(UNIT_TYPES.LIGHT_TANK, 70, 50, "player_1");
    const target = world.createUnit(targetType, 72, 50, playerId);
    tank.path = [{ x: 71, y: 50 }];
    tank.pathTarget = { x: 71, y: 50 };

    const events = new MovementSystem().step(world);

    expect(target.exists).toBe(true);
    expect(events).toEqual([]);
    expect(getCollisionManifold(getUnitCollisionShape(tank), getUnitCollisionShape(target))).toBeNull();
  });

  it("does not crush enemy infantry merely because stationary bodies overlap", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const tank = world.createUnit(UNIT_TYPES.LIGHT_TANK, 70, 50, "player_1");
    const target = world.createUnit(UNIT_TYPES.RIFLEMAN, 71, 50, "player_2");

    const events = new MovementSystem().step(world);

    expect(target.exists).toBe(true);
    expect(events).toEqual([]);
    expect(getCollisionManifold(getUnitCollisionShape(tank), getUnitCollisionShape(target))).toBeNull();
  });

  it("reports multiple crushed units in deterministic entity order", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const tank = world.createUnit(UNIT_TYPES.LIGHT_TANK, 70, 50, "player_1");
    const upper = world.createUnit(UNIT_TYPES.WORKER, 72, 49.4, "player_2");
    const lower = world.createUnit(UNIT_TYPES.ROCKET_SOLDIER, 72, 50.6, "player_2");
    tank.path = [{ x: 71, y: 50 }];
    tank.pathTarget = { x: 71, y: 50 };

    const events = new MovementSystem().step(world);

    expect([upper.exists, lower.exists]).toEqual([false, false]);
    expect(events.map((event) => event.unitId)).toEqual([upper.id, lower.id]);
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
    expect(worker.order).toMatchObject({ type: "harvest_loop" });
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
    const [order] = world.buildings.enqueueProduction(building, [{ unitType: UNIT_TYPES.SOLDIER, count: 1 }]);
    building.productionProgress = {
      orderId: order.orderId,
      unitType: UNIT_TYPES.SOLDIER,
      remainingTicks: 1,
      totalTicks: 1,
      paidCredits: 0,
      totalCost: 60,
      status: "producing",
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

  it("acquires a nearby replacement after a direct attack target is destroyed", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const attacker = world.createUnit(UNIT_TYPES.SOLDIER, 40, 40, "player_1");
    const destroyed = world.createUnit(UNIT_TYPES.SOLDIER, 41, 40, "player_2");
    const replacement = world.createUnit(UNIT_TYPES.ROCKET_SOLDIER, 40, 41, "player_2");
    attacker.order = { type: "attack", targetId: destroyed.id };
    world.destroyEntity(destroyed.id);

    new CombatSystem().step(world);

    expect(world.projectiles.some((projectile) => projectile.targetId === replacement.id)).toBe(true);
    expect(attacker.order).toMatchObject({ type: "attack", targetId: replacement.id });
  });

  it("assigns a newly produced worker to a harvest loop when no rally point overrides it", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const hq = world.buildings.getBuildingsByPlayer("player_1")
      .find((building) => building.type === BUILDING_TYPES.HQ)!;
    const [order] = world.buildings.enqueueProduction(hq, [{ unitType: UNIT_TYPES.WORKER, count: 1 }]);
    hq.productionProgress = {
      orderId: order.orderId,
      unitType: UNIT_TYPES.WORKER,
      remainingTicks: 1,
      totalTicks: 1,
      paidCredits: 0,
      totalCost: 50,
      status: "producing",
    };

    const event = new ProductionSystem().step(world)
      .find((candidate) => candidate.type === "unit_spawned");

    expect(event?.type).toBe("unit_spawned");
    if (!event || event.type !== "unit_spawned") return;
    expect(world.units.getUnit(event.unitId)?.order).toMatchObject({ type: "harvest_loop" });
  });

  it("lets completed defensive buildings acquire targets and deal armor-aware projectile damage", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const turret = world.createBuilding(BUILDING_TYPES.MACHINE_GUN_TURRET, 40, 40, "player_1");
    const rifleman = world.createUnit(UNIT_TYPES.RIFLEMAN, 44, 40, "player_2");
    const scoutCar = world.createUnit(UNIT_TYPES.SCOUT_CAR, 45, 42, "player_2");
    const initialHp = rifleman.hp;

    new CombatSystem().step(world);

    expect(world.projectiles).toEqual([
      expect.objectContaining({
        attackerId: turret.id,
        attackerType: BUILDING_TYPES.MACHINE_GUN_TURRET,
        targetId: rifleman.id,
        targetKind: "unit",
      }),
    ]);
    world.tick = world.projectiles[0]!.impactTick;
    new ProjectileSystem().step(world);
    expect(rifleman.hp).toBe(initialHp - getAttackDamageAgainstUnit(BUILDING_TYPES.MACHINE_GUN_TURRET, UNIT_TYPES.RIFLEMAN));
    expect(scoutCar.hp).toBe(scoutCar.maxHp);
  });

  it("enforces minimum range for siege units", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const artillery = world.createUnit(UNIT_TYPES.ARTILLERY, 40, 40, "player_1");
    const closeTarget = world.createUnit(UNIT_TYPES.RIFLEMAN, 42, 40, "player_2");

    const result = new CombatSystem().executeAttackOrder(world, artillery, "player_1", {
      type: "attack",
      targetId: closeTarget.id,
    });

    expect(result).toBe(RESULT_CODES.ERR_NOT_IN_RANGE);
    expect(world.projectiles).toHaveLength(0);
  });

  it("moves a siege unit away from a target inside minimum range before firing", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const artillery = world.createUnit(UNIT_TYPES.ARTILLERY, 40, 40, "player_1");
    const closeTarget = world.createUnit(UNIT_TYPES.RIFLEMAN, 42, 40, "player_2");
    artillery.order = { type: "attack", targetId: closeTarget.id };
    const combat = new CombatSystem();

    combat.step(world);

    expect(artillery.pathTarget).toBeDefined();
    expect(Math.max(
      Math.abs(closeTarget.x - artillery.pathTarget!.x),
      Math.abs(closeTarget.y - artillery.pathTarget!.y),
    )).toBeGreaterThanOrEqual(4);
    expect(artillery.order).toEqual({ type: "attack", targetId: closeTarget.id });

    artillery.x = artillery.pathTarget!.x;
    artillery.y = artillery.pathTarget!.y;
    world.units.clearPath(artillery);
    combat.step(world);

    expect(world.projectiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ attackerId: artillery.id, targetId: closeTarget.id }),
    ]));
  });

  it("delivers a full load while the worker remains on a resource inside refinery range", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const resource = createDefaultMatchDefinition().map.resources[0];
    const worker = world.units.getUnitsByPlayer("player_1").find((unit) => unit.type === UNIT_TYPES.WORKER)!;
    world.createBuilding(BUILDING_TYPES.REFINERY, resource.x - 3, resource.y, "player_1");
    worker.x = resource.x;
    worker.y = resource.y;
    worker.carryingCredits = worker.carryCapacity;
    worker.order = { type: "harvest_loop", targetX: resource.x, targetY: resource.y };
    const creditsBefore = world.getPlayerState("player_1")!.resources.credits;

    const events = new EconomySystem().step(world);

    expect(worker.carryingCredits).toBe(0);
    expect(world.getPlayerState("player_1")!.resources.credits).toBe(creditsBefore + worker.carryCapacity);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "credits_delivered", unitId: worker.id }),
    ]));
  });

  it("retargets an explicit harvest loop after its resource is depleted", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const depleted = createDefaultMatchDefinition().map.resources[0];
    const worker = world.units.getUnitsByPlayer("player_1").find((unit) => unit.type === UNIT_TYPES.WORKER)!;
    worker.order = { type: "harvest_loop", targetX: depleted.x, targetY: depleted.y };
    world.setResourceRemaining(depleted.x, depleted.y, 0);

    new HarvestOrderSystem().step(world);

    expect(worker.order).toMatchObject({ type: "harvest_loop" });
    expect(worker.order).not.toMatchObject({ targetX: depleted.x, targetY: depleted.y });
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
