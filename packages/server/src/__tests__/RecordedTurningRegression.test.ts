import { describe, expect, it } from "vitest";
import { BUILDING_TYPES, RESULT_CODES, UNIT_TYPES } from "@llmcraft/shared";
import { Game } from "../Game";
import { getCollisionManifold } from "../navigation/CollisionShape";
import { isShapeBlockedByGrid } from "../navigation/NavigationGrid";
import { getUnitCollisionShape } from "../navigation/UnitCollision";
import { createDefaultMatchDefinition } from "../MatchDefinition";
import { WorldState } from "../WorldState";
import { ProductionSystem } from "../simulation/ProductionSystem";
import { MovementSystem } from "../simulation/MovementSystem";

// Continuous poses and buildings from the final frame of CLI match 2186824d.
// Keep this fixture independent of the saved record and its compressed logs.
function runRecordedTurningScenario() {
  const game = new Game();
  const units = game.getUnitManager();
  const buildings = game.getBuildingManager();
  for (const unit of units.getAllUnits()) units.removeUnit(unit.id);
  for (const building of buildings.getBuildingsByPlayer("player_1")) {
    buildings.removeBuilding(building.id);
  }
  for (const seed of [
    { type: BUILDING_TYPES.WAR_FACTORY, x: 14, y: 38 },
    { type: BUILDING_TYPES.WAR_FACTORY, x: 6, y: 48 },
    { type: BUILDING_TYPES.WAR_FACTORY, x: 6, y: 58 },
    { type: BUILDING_TYPES.TECH_CENTER, x: 6, y: 38 },
    { type: BUILDING_TYPES.BARRACKS, x: 21, y: 50 },
    { type: BUILDING_TYPES.BARRACKS, x: 26, y: 48 },
  ]) buildings.createBuilding(seed.type, seed.x, seed.y, "player_1");

  const movers = [
    { type: UNIT_TYPES.HEAVY_TANK, x: 2.966904654634222, y: 53.93407211281227, heading: -0.41863360356933654 },
    { type: UNIT_TYPES.HEAVY_TANK, x: 6.6, y: 52, heading: 0 },
  ].map((seed, index) => {
    const unit = units.createUnit(seed.type, seed.x, seed.y, "player_1");
    unit.heading = seed.heading;
    game.queueCommand({
      id: `recorded_turning_${unit.id}`,
      type: "move",
      playerId: "player_1",
      unitId: unit.id,
      position: { x: 40, y: 64 + index * 4 },
    });
    return unit;
  });
  const tiles = game.getState().tiles.map((row) => row.map((tile) => tile.type));
  const occupied = buildings.getOccupiedPositions();

  game.start();
  for (let tick = 0; tick < 180; tick++) {
    game.tickUpdate();
    for (const unit of movers) {
      expect(isShapeBlockedByGrid(getUnitCollisionShape(unit), tiles, occupied),
        `tick ${tick}: ${unit.id} at (${unit.x}, ${unit.y}) heading ${unit.heading}`,
      ).toBe(false);
    }
    for (let left = 0; left < movers.length; left++) {
      for (let right = left + 1; right < movers.length; right++) {
        expect(getCollisionManifold(
          getUnitCollisionShape(movers[left]!),
          getUnitCollisionShape(movers[right]!),
        )).toBeNull();
      }
    }
  }
  game.stop();

  expect(game.getCommandResults().every((log) =>
    (log.data as { result_code: number }).result_code === RESULT_CODES.OK
  )).toBe(true);
  for (const [index, unit] of movers.entries()) {
    expect(unit.x).toBeCloseTo(40, 5);
    expect(unit.y).toBeCloseTo(64 + index * 4, 5);
    expect(unit.path).toBeUndefined();
    expect(unit.order).toBeUndefined();
  }
  return movers.map((unit) => ({ x: unit.x, y: unit.y, heading: unit.heading }));
}

describe("recorded static turning regression", () => {
  it("escapes the factory gap without intersecting bodies", () => {
    runRecordedTurningScenario();
  });

  it("replays the recorded escape deterministically", () => {
    expect(runRecordedTurningScenario()).toEqual(runRecordedTurningScenario());
  });

  it("spawns a vehicle with room to turn and leave the recorded factory gap", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const factory = world.createBuilding(BUILDING_TYPES.WAR_FACTORY, 6, 48, "player_1");
    world.createBuilding(BUILDING_TYPES.WAR_FACTORY, 6, 58, "player_1");
    world.createBuilding(BUILDING_TYPES.TECH_CENTER, 6, 38, "player_1");
    factory.rallyPoint = { x: 40, y: 65, mode: "move" };
    const [order] = world.buildings.enqueueProduction(factory, [{ unitType: UNIT_TYPES.HEAVY_TANK, count: 1 }]);
    factory.productionProgress = {
      orderId: order!.orderId,
      unitType: UNIT_TYPES.HEAVY_TANK,
      remainingTicks: 0,
      totalTicks: 26,
      paidCredits: 520,
      totalCost: 520,
      status: "producing",
    };
    const event = new ProductionSystem().step(world).find((event) => event.type === "unit_spawned");
    expect(event?.type).toBe("unit_spawned");
    if (!event || event.type !== "unit_spawned") throw new Error("Expected heavy tank production");
    const unit = world.units.getUnit(event.unitId)!;
    const movement = new MovementSystem();
    for (let tick = 0; tick < 180; tick++) {
      movement.step(world);
      expect(isShapeBlockedByGrid(
        getUnitCollisionShape(unit), world.tiles, world.buildings.getOccupiedPositions(),
      )).toBe(false);
    }
    expect(unit.x).toBeCloseTo(40, 5);
    expect(unit.y).toBeCloseTo(65, 5);
    expect(unit.path).toBeUndefined();
  });
});
