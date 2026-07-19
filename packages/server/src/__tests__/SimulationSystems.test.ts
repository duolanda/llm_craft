import { describe, expect, it } from "vitest";
import { BUILDING_TYPES, RESULT_CODES, UNIT_TYPES } from "@llmcraft/shared";
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
