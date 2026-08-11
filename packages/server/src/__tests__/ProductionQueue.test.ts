import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  RESULT_CODES,
  RESULT_TYPES,
  UNIT_TYPES,
  getUnitCost,
  getUnitProductionTicks,
  type CommandResultData,
} from "@llmcraft/shared";
import { Game } from "../Game";
import { createDefaultMatchDefinition } from "../MatchDefinition";
import { WorldState } from "../WorldState";
import { ProductionSystem } from "../simulation/ProductionSystem";

const queue = (
  game: Game,
  buildingId: string,
  productionRequests: Array<{ unitType: typeof UNIT_TYPES[keyof typeof UNIT_TYPES]; count: number }>,
  id = "queue_production",
): void => {
  game.queueCommand({ id, type: "spawn", buildingId, productionRequests, playerId: "player_1" });
  game.processCommands();
};

describe("finite production queues", () => {
  it("produces mixed batches in strict request order", () => {
    const game = new Game();
    const barracks = game.getBuildingManager().createBuilding(BUILDING_TYPES.BARRACKS, 30, 48, "player_1");
    queue(game, barracks.id, [
      { unitType: UNIT_TYPES.RIFLEMAN, count: 2 },
      { unitType: UNIT_TYPES.ROCKET_SOLDIER, count: 1 },
    ]);

    game.start();
    for (let tick = 0; tick < getUnitProductionTicks(UNIT_TYPES.RIFLEMAN) * 2; tick++) game.tickUpdate();
    expect(game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.RIFLEMAN)).toHaveLength(2);
    expect(game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.ROCKET_SOLDIER)).toHaveLength(0);
    for (let tick = 0; tick < getUnitProductionTicks(UNIT_TYPES.ROCKET_SOLDIER); tick++) game.tickUpdate();
    game.stop();

    expect(game.getState().players[0].units.filter((unit) => unit.type === UNIT_TYPES.ROCKET_SOLDIER)).toHaveLength(1);
    expect(game.getBuildingManager().getBuilding(barracks.id)?.productionQueue).toHaveLength(0);
  });

  it("pauses without losing progress when a tick charge cannot be paid, then resumes", () => {
    const definition = createDefaultMatchDefinition();
    definition.players[0].startingCredits = 0;
    const game = new Game(definition);
    const barracks = game.getBuildingManager().createBuilding(BUILDING_TYPES.BARRACKS, 30, 48, "player_1");
    queue(game, barracks.id, [{ unitType: UNIT_TYPES.RIFLEMAN, count: 1 }]);

    game.start();
    game.tickUpdate();
    const paused = game.getBuildingManager().getBuilding(barracks.id)?.productionProgress;
    expect(paused).toMatchObject({
      remainingTicks: getUnitProductionTicks(UNIT_TYPES.RIFLEMAN),
      paidCredits: 0,
      status: "waiting_for_credits",
    });

    const worker = game.getUnitManager().getUnitsByPlayer("player_1")[0];
    const hq = game.getBuildingManager().getBuildingsByPlayer("player_1").find((building) => building.type === BUILDING_TYPES.HQ)!;
    worker.x = hq.x + 2;
    worker.y = hq.y;
    worker.carryingCredits = getUnitCost(UNIT_TYPES.RIFLEMAN);
    game.tickUpdate();
    game.stop();

    expect(game.getBuildingManager().getBuilding(barracks.id)?.productionProgress).toMatchObject({
      remainingTicks: getUnitProductionTicks(UNIT_TYPES.RIFLEMAN) - 1,
      status: "producing",
    });
  });

  it("refunds paid progress when an active order is cancelled", () => {
    const game = new Game();
    const barracks = game.getBuildingManager().createBuilding(BUILDING_TYPES.BARRACKS, 30, 48, "player_1");
    queue(game, barracks.id, [{ unitType: UNIT_TYPES.RIFLEMAN, count: 4 }]);
    game.start();
    game.tickUpdate();
    game.tickUpdate();
    game.stop();

    const progress = game.getBuildingManager().getBuilding(barracks.id)?.productionProgress;
    expect(progress?.paidCredits).toBeGreaterThan(0);
    const creditsBeforeCancel = game.getState().players[0].resources.credits;
    const orderId = game.getBuildingManager().getBuilding(barracks.id)!.productionQueue[0].orderId;
    game.queueCommand({
      id: "cancel_active",
      type: "cancel_production",
      productionOrderIds: [orderId],
      playerId: "player_1",
    });
    game.processCommands();

    expect(game.getState().players[0].resources.credits).toBe(creditsBeforeCancel + progress!.paidCredits);
    expect(game.getBuildingManager().getBuilding(barracks.id)?.productionQueue).toHaveLength(0);
    expect((game.getCommandResults().at(-1)?.data as CommandResultData).type).toBe(RESULT_TYPES.PRODUCTION_CANCELLED);
  });

  it("refunds active paid progress and clears all orders when a building is destroyed", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const barracks = world.createBuilding(BUILDING_TYPES.BARRACKS, 30, 48, "player_1");
    world.buildings.enqueueProduction(barracks, [
      { unitType: UNIT_TYPES.RIFLEMAN, count: 3 },
      { unitType: UNIT_TYPES.ROCKET_SOLDIER, count: 2 },
    ]);
    new ProductionSystem().step(world);
    const paid = barracks.productionProgress!.paidCredits;
    const creditsBeforeDestroy = world.getPlayerState("player_1")!.resources.credits;

    expect(world.destroyEntity(barracks.id)).toBe(true);
    expect(world.getPlayerState("player_1")!.resources.credits).toBe(creditsBeforeDestroy + paid);
    expect(barracks.productionQueue).toHaveLength(0);
    expect(barracks.productionProgress).toBeUndefined();
  });

  it("enforces the 100-pending limit independently for each unit type", () => {
    const game = new Game();
    const barracks = game.getBuildingManager().createBuilding(BUILDING_TYPES.BARRACKS, 30, 48, "player_1");
    queue(game, barracks.id, [
      { unitType: UNIT_TYPES.RIFLEMAN, count: 100 },
      { unitType: UNIT_TYPES.ROCKET_SOLDIER, count: 100 },
    ]);
    expect((game.getCommandResults().at(-1)?.data as CommandResultData).result_code).toBe(RESULT_CODES.OK);

    queue(game, barracks.id, [{ unitType: UNIT_TYPES.RIFLEMAN, count: 1 }], "overflow");
    expect((game.getCommandResults().at(-1)?.data as CommandResultData).result_code).toBe(RESULT_CODES.ERR_INVALID_BUILDING);
    expect(game.getBuildingManager().getBuilding(barracks.id)?.productionQueue).toHaveLength(2);
  });

  it("finishes the active T3 unit, then pauses later units until the tech center is rebuilt", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    world.createBuilding(BUILDING_TYPES.BARRACKS, 24, 48, "player_1");
    const factory = world.createBuilding(BUILDING_TYPES.WAR_FACTORY, 32, 48, "player_1");
    const techCenter = world.createBuilding(BUILDING_TYPES.TECH_CENTER, 40, 48, "player_1");
    world.buildings.enqueueProduction(factory, [{ unitType: UNIT_TYPES.HEAVY_TANK, count: 2 }]);
    const production = new ProductionSystem();

    production.step(world);
    expect(factory.productionProgress).toMatchObject({ status: "producing" });
    world.destroyEntity(techCenter.id);
    for (let tick = 1; tick < getUnitProductionTicks(UNIT_TYPES.HEAVY_TANK); tick++) production.step(world);

    expect(world.units.getUnitsByPlayer("player_1").filter((unit) => unit.type === UNIT_TYPES.HEAVY_TANK)).toHaveLength(1);
    production.step(world);
    expect(factory.productionProgress).toMatchObject({
      status: "waiting_for_prerequisite",
      paidCredits: 0,
      missingPrerequisites: [BUILDING_TYPES.TECH_CENTER],
    });

    world.createBuilding(BUILDING_TYPES.TECH_CENTER, 40, 48, "player_1");
    production.step(world);
    expect(factory.productionProgress).toMatchObject({
      status: "producing",
      remainingTicks: getUnitProductionTicks(UNIT_TYPES.HEAVY_TANK) - 1,
    });
  });
});
