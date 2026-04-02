import { describe, it, expect, beforeEach } from "vitest";
import { Game } from "../Game";
import {
  UNIT_TYPES,
  BUILDING_TYPES,
  RESULT_CODES,
  UNIT_STATES,
} from "@llmcraft/shared";

describe("Game", () => {
  let game: Game;

  beforeEach(() => {
    game = new Game();
  });

  it("should initialize with 2 players", () => {
    const state = game.getState();
    expect(state.players).toHaveLength(2);
  });

  it("should initialize player with correct units", () => {
    const state = game.getState();
    expect(state.players[0].units).toHaveLength(3);
    expect(
      state.players[0].units.filter((u) => u.type === "worker")
    ).toHaveLength(2);
    expect(
      state.players[0].units.filter((u) => u.type === "soldier")
    ).toHaveLength(1);
  });

  it("soldier should have attackRange of 1", () => {
    const state = game.getState();
    const soldier = state.players[0].units.find((u) => u.type === "soldier");
    expect(soldier?.attackRange).toBe(1);
  });

  it("worker should have attackRange of 0", () => {
    const state = game.getState();
    const worker = state.players[0].units.find((u) => u.type === "worker");
    expect(worker?.attackRange).toBe(0);
  });

  it("should reject attack when out of range", () => {
    // Get player_1's soldier at (4,10) and player_2's soldier at (15,10)
    const unitManager = game.getUnitManager();
    const player1Soldier = unitManager
      .getAllUnits()
      .find((u) => u.playerId === "player_1" && u.type === "soldier");
    const player2Soldier = unitManager
      .getAllUnits()
      .find((u) => u.playerId === "player_2" && u.type === "soldier");

    expect(player1Soldier).toBeDefined();
    expect(player2Soldier).toBeDefined();

    // Verify positions: distance should be 11, which is > attackRange of 1
    const distance = Math.sqrt(
      Math.pow(player1Soldier!.x - player2Soldier!.x, 2) +
        Math.pow(player1Soldier!.y - player2Soldier!.y, 2)
    );
    expect(distance).toBeGreaterThan(1);

    // Attack should fail with ERR_NOT_IN_RANGE
    const result = unitManager.attackUnit(player1Soldier!, player2Soldier!);
    expect(result).toBe(RESULT_CODES.ERR_NOT_IN_RANGE);
  });

  it("should allow attack when in range", () => {
    const unitManager = game.getUnitManager();

    // Create two soldiers close to each other
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 6, "player_2");

    // Distance is 1, which is within attackRange of 1
    const result = unitManager.attackUnit(attacker, target);
    expect(result).toBe(RESULT_CODES.OK);
    expect(target.hp).toBeLessThan(target.maxHp);
  });

  it("should reject attack on same team", () => {
    const unitManager = game.getUnitManager();

    // Create two soldiers from same player
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 6, "player_1");

    const result = unitManager.attackUnit(attacker, target);
    expect(result).toBe(RESULT_CODES.ERR_INVALID_TARGET);
  });

  it("should reject attack by worker (attackRange=0)", () => {
    const unitManager = game.getUnitManager();

    // Create worker and enemy soldier adjacent to each other
    const worker = unitManager.createUnit(UNIT_TYPES.WORKER, 5, 5, "player_1");
    const enemy = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 6, "player_2");

    // Worker has attackRange of 0, so even adjacent target is out of range
    const result = unitManager.attackUnit(worker, enemy);
    expect(result).toBe(RESULT_CODES.ERR_NOT_IN_RANGE);
  });

  it("should process spawn command with sufficient energy", () => {
    const state = game.getState();
    const player1 = state.players[0];
    const initialEnergy = player1.resources.energy;

    // Get player_1's HQ
    const hq = player1.buildings.find((b) => b.type === BUILDING_TYPES.HQ);
    expect(hq).toBeDefined();

    // Queue spawn command
    game.queueCommand({
      id: "cmd_1",
      type: "spawn",
      buildingId: hq!.id,
      unitType: UNIT_TYPES.WORKER,
      playerId: "player_1",
    });

    // Process commands
    game.processCommands();

    // Energy should be deducted
    const newState = game.getState();
    expect(newState.players[0].resources.energy).toBe(initialEnergy - 50);
  });

  it("should reject spawn command with insufficient energy", () => {
    const state = game.getState();
    const player1 = state.players[0];

    // Set energy to 0
    player1.resources.energy = 0;

    // Get player_1's HQ
    const hq = player1.buildings.find((b) => b.type === BUILDING_TYPES.HQ);
    expect(hq).toBeDefined();

    // Queue spawn command
    game.queueCommand({
      id: "cmd_1",
      type: "spawn",
      buildingId: hq!.id,
      unitType: UNIT_TYPES.WORKER,
      playerId: "player_1",
    });

    // Process commands
    game.processCommands();

    // Energy should remain 0
    const newState = game.getState();
    expect(newState.players[0].resources.energy).toBe(0);
  });

  it("should detect win condition when HQ is destroyed", () => {
    const buildingManager = game.getBuildingManager();
    const player1Buildings = buildingManager.getBuildingsByPlayer("player_1");
    const hq = player1Buildings.find((b) => b.type === BUILDING_TYPES.HQ);

    expect(hq).toBeDefined();

    // Destroy the HQ
    buildingManager.takeDamage(hq!, 9999);

    // Check win condition
    const hasWinner = game.checkWinCondition();
    expect(hasWinner).toBe(true);
    expect(game.getWinner()).toBe("player_2");
  });

  it("should initialize with correct map layout", () => {
    const state = game.getState();

    // Check obstacles at corners
    expect(state.tiles[5][5].type).toBe("obstacle");
    expect(state.tiles[5][14].type).toBe("obstacle");
    expect(state.tiles[14][5].type).toBe("obstacle");
    expect(state.tiles[14][14].type).toBe("obstacle");

    // Check central cross
    expect(state.tiles[8][10].type).toBe("obstacle");
    expect(state.tiles[9][10].type).toBe("obstacle");
    expect(state.tiles[10][10].type).toBe("obstacle");
    expect(state.tiles[11][10].type).toBe("obstacle");

    // Check resource points
    expect(state.tiles[8][2].type).toBe("resource");
    expect(state.tiles[11][2].type).toBe("resource");
    expect(state.tiles[8][17].type).toBe("resource");
    expect(state.tiles[11][17].type).toBe("resource");
  });

  it("should move unit correctly", () => {
    const unitManager = game.getUnitManager();
    const unit = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");

    const result = unitManager.moveUnit(unit, 6, 6);
    expect(result).toBe(RESULT_CODES.OK);
    expect(unit.x).toBe(6);
    expect(unit.y).toBe(6);
    expect(unit.state).toBe(UNIT_STATES.MOVING);
  });

  it("should hold position correctly", () => {
    const unitManager = game.getUnitManager();
    const unit = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");

    // First move the unit
    unitManager.moveUnit(unit, 6, 6);
    expect(unit.state).toBe(UNIT_STATES.MOVING);

    // Then hold position
    const result = unitManager.holdPosition(unit);
    expect(result).toBe(RESULT_CODES.OK);
    expect(unit.state).toBe(UNIT_STATES.IDLE);
  });

  it("should calculate energy production correctly", () => {
    const buildingManager = game.getBuildingManager();

    // Initially no generators
    const initialProduction = buildingManager.getEnergyProduction("player_1");
    expect(initialProduction).toBe(0);

    // Add a generator
    buildingManager.createBuilding(BUILDING_TYPES.GENERATOR, 3, 3, "player_1");
    const productionWithOne = buildingManager.getEnergyProduction("player_1");
    expect(productionWithOne).toBe(5);

    // Add another generator
    buildingManager.createBuilding(BUILDING_TYPES.GENERATOR, 4, 4, "player_1");
    const productionWithTwo = buildingManager.getEnergyProduction("player_1");
    expect(productionWithTwo).toBe(10);
  });

  it("should remove unit with soft delete", () => {
    const unitManager = game.getUnitManager();
    const unit = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");

    expect(unit.exists).toBe(true);

    unitManager.removeUnit(unit.id);

    expect(unit.exists).toBe(false);
    // Unit should still be retrievable but marked as not existing
    expect(unitManager.getUnit(unit.id)).toBeDefined();
    expect(unitManager.getUnit(unit.id)?.exists).toBe(false);
  });

  it("should detect unit collision when moving", () => {
    const unitManager = game.getUnitManager();
    const unit1 = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const unit2 = unitManager.createUnit(UNIT_TYPES.SOLDIER, 6, 6, "player_2");

    // Try to move unit1 to unit2's position
    const result = unitManager.moveUnit(unit1, 6, 6);
    expect(result).toBe(RESULT_CODES.ERR_POSITION_OCCUPIED);
    expect(unit1.x).toBe(5); // Position should not change
    expect(unit1.y).toBe(5);
  });

  it("should allow moving to own previous position", () => {
    const unitManager = game.getUnitManager();
    const unit = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");

    // Move to new position
    const result1 = unitManager.moveUnit(unit, 6, 6);
    expect(result1).toBe(RESULT_CODES.OK);

    // Create another unit at the original position
    const unit2 = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_2");

    // Try to move back to original position (now occupied)
    const result2 = unitManager.moveUnit(unit, 5, 5);
    expect(result2).toBe(RESULT_CODES.ERR_POSITION_OCCUPIED);
  });

  it("should hasUnitAt return correct result", () => {
    const unitManager = game.getUnitManager();
    const unit = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");

    expect(unitManager.hasUnitAt(5, 5)).toBe(true);
    expect(unitManager.hasUnitAt(5, 5, unit.id)).toBe(false); // Exclude self
    expect(unitManager.hasUnitAt(6, 6)).toBe(false);
  });
});
