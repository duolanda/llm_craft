import { beforeEach, describe, expect, it } from "vitest";
import { Game } from "../Game";
import { MapGenerator } from "../MapGenerator";
import { PathFinder } from "../PathFinder";
import {
  BUILDING_TYPES,
  MAP_HEIGHT,
  MAP_WIDTH,
  RESULT_CODES,
  TILE_TYPES,
  UNIT_STATS,
  UNIT_TYPES,
  RESULT_TYPES,
  CommandResultData,
  DEFAULT_MAP_LAYOUT,
  getAttackDamageAgainstBuilding,
  getAttackDamageAgainstUnit,
  getUnitProductionTicks,
  LOG_TYPES,
} from "@llmcraft/shared";

describe("Game", () => {
  let game: Game;
  const player1BuildSite = { x: DEFAULT_MAP_LAYOUT.player1Hq.x + 16, y: DEFAULT_MAP_LAYOUT.player1Hq.y };

  beforeEach(() => {
    game = new Game();
  });

  it("initializes each player with one HQ, four workers and expansion credits", () => {
    const state = game.getState();
    const [player1, player2] = state.players;

    expect(player1.buildings.filter((b) => b.type === BUILDING_TYPES.HQ)).toHaveLength(1);
    expect(player2.buildings.filter((b) => b.type === BUILDING_TYPES.HQ)).toHaveLength(1);
    expect(player1.units.filter((u) => u.type === UNIT_TYPES.WORKER)).toHaveLength(4);
    expect(player2.units.filter((u) => u.type === UNIT_TYPES.WORKER)).toHaveLength(4);
    expect(player1.units.filter((u) => u.type === UNIT_TYPES.SOLDIER)).toHaveLength(0);
    expect(player1.resources.credits).toBe(800);
    expect(player1.buildings.find((b) => b.type === BUILDING_TYPES.HQ)).toMatchObject(DEFAULT_MAP_LAYOUT.player1Hq);
    expect(player2.buildings.find((b) => b.type === BUILDING_TYPES.HQ)).toMatchObject(DEFAULT_MAP_LAYOUT.player2Hq);
    expect(player1.units.filter((u) => u.type === UNIT_TYPES.WORKER)).toEqual(
      expect.arrayContaining(DEFAULT_MAP_LAYOUT.player1Workers.map((position) => expect.objectContaining(position)))
    );
    expect(player2.units.filter((u) => u.type === UNIT_TYPES.WORKER)).toEqual(
      expect.arrayContaining(DEFAULT_MAP_LAYOUT.player2Workers.map((position) => expect.objectContaining(position)))
    );
  });

  it("uses the three-front strategic map baseline", () => {
    expect(MAP_WIDTH).toBe(144);
    expect(MAP_HEIGHT).toBe(96);
    expect(DEFAULT_MAP_LAYOUT.player2Hq.x - DEFAULT_MAP_LAYOUT.player1Hq.x).toBeGreaterThanOrEqual(110);

    const state = game.getState();
    const resourceTiles = state.tiles.flat().filter((tile) => tile.type === TILE_TYPES.RESOURCE);
    expect(resourceTiles).toEqual(
      expect.arrayContaining(DEFAULT_MAP_LAYOUT.resources.map((position) => expect.objectContaining(position)))
    );
  });

  it("keeps north, center and south fronts connected through cross-lane gaps", () => {
    const tiles = MapGenerator.generate();
    expect(PathFinder.findPath(20, 20, 123, 20, tiles).length).toBeGreaterThan(0);
    expect(PathFinder.findPath(20, 48, 123, 48, tiles).length).toBeGreaterThan(0);
    expect(PathFinder.findPath(20, 76, 123, 76, tiles).length).toBeGreaterThan(0);
    expect(PathFinder.findPath(72, 20, 72, 76, tiles).length).toBeGreaterThan(0);
  });

  it("keeps resource tiles outside the HQ delivery ring", () => {
    const state = game.getState();

    for (const player of state.players) {
      const hq = player.buildings.find((b) => b.type === BUILDING_TYPES.HQ)!;
      for (let y = hq.y - 1; y <= hq.y + 1; y++) {
        for (let x = hq.x - 1; x <= hq.x + 1; x++) {
          if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
            continue;
          }
          expect(state.tiles[y][x].type).not.toBe(TILE_TYPES.RESOURCE);
        }
      }
    }
  });

  it("allows HQ to spawn workers and deducts credits", () => {
    const state = game.getState();
    const player1 = state.players[0];
    const hq = player1.buildings.find((b) => b.type === BUILDING_TYPES.HQ);

    game.queueCommand({
      id: "spawn_worker",
      type: "spawn",
      buildingId: hq!.id,
      unitType: UNIT_TYPES.WORKER,
      playerId: "player_1",
    });

    game.processCommands();

    expect(game.getState().players[0].resources.credits).toBe(750);
    expect((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_code).toBe(RESULT_CODES.OK);
  });

  it("rejects spawning soldiers directly from HQ", () => {
    const state = game.getState();
    const player1 = state.players[0];
    const hq = player1.buildings.find((b) => b.type === BUILDING_TYPES.HQ);

    game.queueCommand({
      id: "spawn_soldier_from_hq",
      type: "spawn",
      buildingId: hq!.id,
      unitType: UNIT_TYPES.SOLDIER,
      playerId: "player_1",
    });

    game.processCommands();

    expect((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_code).toBe(RESULT_CODES.ERR_INVALID_BUILDING);
    expect(game.getState().players[0].resources.credits).toBe(800);
  });

  it("allows a worker to build a barracks on a valid tile", () => {
    const worker = game
      .getState()
      .players[0]
      .units.find((u) => u.type === UNIT_TYPES.WORKER)!;

    game.queueCommand({
      id: "build_barracks",
      type: "build",
      unitId: worker.id,
      buildingType: BUILDING_TYPES.BARRACKS,
      position: player1BuildSite,
      playerId: "player_1",
    });

    game.processCommands();

    const state = game.getState();
    expect(state.players[0].buildings.filter((b) => b.type === BUILDING_TYPES.BARRACKS)).toHaveLength(1);
    expect(state.players[0].resources.credits).toBe(680);
    expect((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_code).toBe(RESULT_CODES.OK);
  });

  it("rejects building on an occupied tile", () => {
    const worker = game
      .getState()
      .players[0]
      .units.find((u) => u.type === UNIT_TYPES.WORKER)!;

    game.queueCommand({
      id: "build_on_hq",
      type: "build",
      unitId: worker.id,
      buildingType: BUILDING_TYPES.BARRACKS,
      position: DEFAULT_MAP_LAYOUT.player1Hq,
      playerId: "player_1",
    });

    game.processCommands();

    expect((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_code).toBe(RESULT_CODES.ERR_POSITION_OCCUPIED);
  });

  it("rejects building a barracks adjacent to HQ", () => {
    const worker = game
      .getState()
      .players[0]
      .units.find((u) => u.type === UNIT_TYPES.WORKER)!;

    game.queueCommand({
      id: "build_next_to_hq",
      type: "build",
      unitId: worker.id,
      buildingType: BUILDING_TYPES.BARRACKS,
      position: { x: DEFAULT_MAP_LAYOUT.player1Hq.x + 1, y: DEFAULT_MAP_LAYOUT.player1Hq.y },
      playerId: "player_1",
    });

    game.processCommands();

    expect((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_code).toBe(RESULT_CODES.ERR_POSITION_OCCUPIED);
    const feedbackData = game.getAIFeedback("player_1").at(-1)?.data as CommandResultData;
    expect(feedbackData?.type).toBe(RESULT_TYPES.BUILD_INVALID_POSITION);
    expect((feedbackData?.result_data as any)?.type).toBe("build_too_close_to_hq");
  });

  it("requires barracks before soldiers can be queued", () => {
    const player1 = game.getState().players[0];
    const hq = player1.buildings.find((b) => b.type === BUILDING_TYPES.HQ)!;

    game.queueCommand({
      id: "soldier_without_barracks",
      type: "spawn",
      buildingId: hq.id,
      unitType: UNIT_TYPES.SOLDIER,
      playerId: "player_1",
    });

    game.processCommands();

    expect((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_code).toBe(RESULT_CODES.ERR_INVALID_BUILDING);
    expect(game.getState().players[0].units.filter((u) => u.type === UNIT_TYPES.SOLDIER)).toHaveLength(0);
  });

  it("spawns a soldier from barracks after it is built", () => {
    const worker = game
      .getState()
      .players[0]
      .units.find((u) => u.type === UNIT_TYPES.WORKER)!;

    game.queueCommand({
      id: "build_barracks",
      type: "build",
      unitId: worker.id,
      buildingType: BUILDING_TYPES.BARRACKS,
      position: player1BuildSite,
      playerId: "player_1",
    });
    game.processCommands();

    const barracks = game
      .getState()
      .players[0]
      .buildings.find((b) => b.type === BUILDING_TYPES.BARRACKS)!;

    game.queueCommand({
      id: "spawn_soldier",
      type: "spawn",
      buildingId: barracks.id,
      unitType: UNIT_TYPES.SOLDIER,
      playerId: "player_1",
    });
    game.processCommands();
    game.start();
    for (let tick = 0; tick < getUnitProductionTicks(UNIT_TYPES.SOLDIER); tick++) {
      game.tickUpdate();
    }
    game.stop();

    expect(game.getState().players[0].units.filter((u) => u.type === UNIT_TYPES.SOLDIER)).toHaveLength(1);
  });

  it("allows workers to build a war factory", () => {
    const worker = game
      .getState()
      .players[0]
      .units.find((u) => u.type === UNIT_TYPES.WORKER)!;

    game.queueCommand({
      id: "build_war_factory",
      type: "build",
      unitId: worker.id,
      buildingType: BUILDING_TYPES.WAR_FACTORY,
      position: player1BuildSite,
      playerId: "player_1",
    });
    game.processCommands();

    const state = game.getState();
    expect(state.players[0].buildings.filter((b) => b.type === BUILDING_TYPES.WAR_FACTORY)).toHaveLength(1);
    expect(state.players[0].resources.credits).toBe(580);
    expect((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_code).toBe(RESULT_CODES.OK);
  });

  it("allows workers to build a refinery for forward resource delivery", () => {
    const worker = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.WORKER)!;
    game.queueCommand({
      id: "build_refinery",
      type: "build",
      unitId: worker.id,
      buildingType: BUILDING_TYPES.REFINERY,
      position: player1BuildSite,
      playerId: "player_1",
    });
    game.processCommands();

    const state = game.getState();
    expect(state.players[0].buildings.filter((building) => building.type === BUILDING_TYPES.REFINERY)).toHaveLength(1);
    expect(state.players[0].resources.credits).toBe(500);
  });

  it("spawns light tanks near the war factory that produced them", () => {
    const warFactory = game.getBuildingManager().createBuilding(
      BUILDING_TYPES.WAR_FACTORY,
      player1BuildSite.x,
      player1BuildSite.y,
      "player_1"
    );

    game.queueCommand({
      id: "spawn_light_tank",
      type: "spawn",
      buildingId: warFactory.id,
      unitType: UNIT_TYPES.LIGHT_TANK,
      playerId: "player_1",
    });
    game.processCommands();
    game.start();
    for (let tick = 0; tick < getUnitProductionTicks(UNIT_TYPES.LIGHT_TANK); tick++) {
      game.tickUpdate();
    }
    game.stop();

    const tank = game.getState().players[0].units.find((unit) => unit.type === UNIT_TYPES.LIGHT_TANK);
    expect(tank).toBeDefined();
    expect(game.getBuildingManager().getDistanceToBuilding(warFactory, tank!.x, tank!.y)).toBe(1);
  });

  it("keeps worker unable to attack and applies large-map OpenRA-lite combat ranges", () => {
    const unitManager = game.getUnitManager();
    const worker = unitManager.createUnit(UNIT_TYPES.WORKER, 5, 5, "player_1");
    const soldier = unitManager.createUnit(UNIT_TYPES.SOLDIER, 6, 5, "player_1");
    const rifleman = unitManager.createUnit(UNIT_TYPES.RIFLEMAN, 7, 5, "player_1");
    const rocketSoldier = unitManager.createUnit(UNIT_TYPES.ROCKET_SOLDIER, 8, 5, "player_1");
    const lightTank = unitManager.createUnit(UNIT_TYPES.LIGHT_TANK, 9, 5, "player_1");

    expect(UNIT_STATS.worker.attack).toBe(0);
    expect(worker.attackRange).toBe(0);
    expect(soldier.attackRange).toBe(1);
    expect(rifleman.attackRange).toBe(3);
    expect(rocketSoldier.attackRange).toBe(4);
    expect(lightTank.attackRange).toBe(3);
  });

  it("allows soldiers to attack diagonally adjacent targets", () => {
    const unitManager = game.getUnitManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = unitManager.createUnit(UNIT_TYPES.SOLDIER, 6, 6, "player_2");
    const expectedDamage = UNIT_STATS.soldier.attack;

    game.queueCommand({
      id: "diag_attack_unit",
      type: "attack",
      unitId: attacker.id,
      targetId: target.id,
      playerId: "player_1",
    });

    game.processCommands();

    expect((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_code).toBe(RESULT_CODES.OK);
    expect(target.hp).toBe(target.maxHp - expectedDamage);
  });

  it("allows soldiers to attack diagonally adjacent buildings", () => {
    const unitManager = game.getUnitManager();
    const buildingManager = game.getBuildingManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = buildingManager.createBuilding(BUILDING_TYPES.BARRACKS, 6, 6, "player_2");
    const expectedDamage = UNIT_STATS.soldier.attack;

    game.queueCommand({
      id: "diag_attack_building",
      type: "attack",
      unitId: attacker.id,
      targetId: target.id,
      playerId: "player_1",
    });

    game.processCommands();

    expect((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_code).toBe(RESULT_CODES.OK);
    expect(target.hp).toBe(target.maxHp - expectedDamage);
  });

  it("applies infantry and anti-armor damage modifiers to unit targets", () => {
    const unitManager = game.getUnitManager();
    const rifleman = unitManager.createUnit(UNIT_TYPES.RIFLEMAN, 5, 5, "player_1");
    const rocketSoldier = unitManager.createUnit(UNIT_TYPES.ROCKET_SOLDIER, 5, 7, "player_1");
    const tank = unitManager.createUnit(UNIT_TYPES.LIGHT_TANK, 7, 5, "player_2");

    game.queueCommand({
      id: "rifleman_vs_tank",
      type: "attack",
      unitId: rifleman.id,
      targetId: tank.id,
      playerId: "player_1",
    });
    game.queueCommand({
      id: "rocket_vs_tank",
      type: "attack",
      unitId: rocketSoldier.id,
      targetId: tank.id,
      playerId: "player_1",
    });

    game.processCommands();

    expect(tank.hp).toBe(tank.maxHp - 6 - 48);
  });

  it("applies heavy damage modifiers to structure targets", () => {
    const unitManager = game.getUnitManager();
    const buildingManager = game.getBuildingManager();
    const tank = unitManager.createUnit(UNIT_TYPES.LIGHT_TANK, 5, 5, "player_1");
    const barracks = buildingManager.createBuilding(BUILDING_TYPES.BARRACKS, 7, 5, "player_2");

    game.queueCommand({
      id: "tank_vs_structure",
      type: "attack",
      unitId: tank.id,
      targetId: barracks.id,
      playerId: "player_1",
    });

    game.processCommands();

    expect(barracks.hp).toBe(barracks.maxHp - 36);
  });

  it("keeps attacking every tick after a successful attack command", () => {
    const unitManager = game.getUnitManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = unitManager.createUnit(UNIT_TYPES.SOLDIER, 6, 5, "player_2");
    const expectedDamage = UNIT_STATS.soldier.attack;

    game.queueCommand({
      id: "sustain_attack",
      type: "attack",
      unitId: attacker.id,
      targetId: target.id,
      playerId: "player_1",
    });

    game.start();
    game.tickUpdate();
    expect(target.hp).toBe(target.maxHp - expectedDamage);

    game.tickUpdate();
    game.stop();

    expect(target.hp).toBe(target.maxHp - expectedDamage * 2);
  });

  it("lets idle combat units retaliate when attacked by an enemy unit", () => {
    const unitManager = game.getUnitManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const defender = unitManager.createUnit(UNIT_TYPES.SOLDIER, 6, 5, "player_2");
    const expectedDamage = UNIT_STATS.soldier.attack;

    game.queueCommand({
      id: "retaliation_attack",
      type: "attack",
      unitId: attacker.id,
      targetId: defender.id,
      playerId: "player_1",
    });

    game.processCommands();

    expect(defender.hp).toBe(defender.maxHp - expectedDamage);
    expect(attacker.hp).toBe(attacker.maxHp - expectedDamage);
    expect(defender.intent).toMatchObject({ type: "attack", targetId: attacker.id });
  });

  it("does not retaliate with units that have no attack", () => {
    const unitManager = game.getUnitManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const worker = unitManager.createUnit(UNIT_TYPES.WORKER, 6, 5, "player_2");

    game.queueCommand({
      id: "worker_no_retaliation",
      type: "attack",
      unitId: attacker.id,
      targetId: worker.id,
      playerId: "player_1",
    });

    game.processCommands();

    expect(worker.hp).toBe(worker.maxHp - UNIT_STATS.soldier.attack);
    expect(attacker.hp).toBe(attacker.maxHp);
  });

  it("does not interrupt moving combat units for retaliation", () => {
    const unitManager = game.getUnitManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const defender = unitManager.createUnit(UNIT_TYPES.SOLDIER, 6, 5, "player_2");

    game.queueCommand({
      id: "defender_move_before_retaliation",
      type: "move",
      unitId: defender.id,
      position: { x: 8, y: 5 },
      playerId: "player_2",
    });
    game.processCommands();

    game.queueCommand({
      id: "moving_unit_no_retaliation",
      type: "attack",
      unitId: attacker.id,
      targetId: defender.id,
      playerId: "player_1",
    });
    game.processCommands();

    expect(defender.hp).toBe(defender.maxHp - UNIT_STATS.soldier.attack);
    expect(attacker.hp).toBe(attacker.maxHp);
    expect(defender.intent).toMatchObject({ type: "move", targetX: 8, targetY: 5 });
  });

  it("keeps re-evaluating attack_in_range on later ticks", () => {
    const unitManager = game.getUnitManager();
    const buildingManager = game.getBuildingManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const enemyWorker = unitManager.createUnit(UNIT_TYPES.WORKER, 4, 5, "player_2");
    const enemyHq = buildingManager.createBuilding(BUILDING_TYPES.HQ, 6, 6, "player_2");
    const expectedDamage = UNIT_STATS.soldier.attack;

    game.queueCommand({
      id: "sustain_attack_in_range",
      type: "attack_in_range",
      unitId: attacker.id,
      targetPriority: [BUILDING_TYPES.HQ, UNIT_TYPES.WORKER],
      playerId: "player_1",
    });

    game.start();
    game.tickUpdate();
    expect(enemyHq.hp).toBe(enemyHq.maxHp - expectedDamage);

    game.tickUpdate();
    game.stop();

    expect(enemyHq.hp).toBe(enemyHq.maxHp - expectedDamage * 2);
    expect(enemyWorker.hp).toBe(enemyWorker.maxHp);
  });

  it("attack_in_range prioritizes requested targets at execution time", () => {
    const unitManager = game.getUnitManager();
    const buildingManager = game.getBuildingManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const enemyWorker = unitManager.createUnit(UNIT_TYPES.WORKER, 4, 5, "player_2");
    const enemyHq = buildingManager.createBuilding(BUILDING_TYPES.HQ, 6, 6, "player_2");

    game.queueCommand({
      id: "attack_in_range_priority",
      type: "attack_in_range",
      unitId: attacker.id,
      targetPriority: [BUILDING_TYPES.HQ, UNIT_TYPES.WORKER],
      playerId: "player_1",
    });

    game.processCommands();

    expect((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_code).toBe(RESULT_CODES.OK);
    expect(enemyHq.hp).toBeLessThan(enemyHq.maxHp);
    expect(enemyWorker.hp).toBe(enemyWorker.maxHp);
  });

  it("uses role-aware default targets for light tanks", () => {
    const unitManager = game.getUnitManager();
    const buildingManager = game.getBuildingManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.LIGHT_TANK, 5, 5, "player_1");
    const enemySoldier = unitManager.createUnit(UNIT_TYPES.SOLDIER, 4, 5, "player_2");
    const enemyHq = buildingManager.createBuilding(BUILDING_TYPES.HQ, 6, 6, "player_2");

    game.queueCommand({
      id: "light_tank_role_priority",
      type: "attack_in_range",
      unitId: attacker.id,
      playerId: "player_1",
    });

    game.processCommands();

    expect(enemyHq.hp).toBe(enemyHq.maxHp - getAttackDamageAgainstBuilding(UNIT_TYPES.LIGHT_TANK, BUILDING_TYPES.HQ));
    expect(enemySoldier.hp).toBe(enemySoldier.maxHp);
  });

  it("uses role-aware default targets for rocket soldiers", () => {
    const unitManager = game.getUnitManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.ROCKET_SOLDIER, 5, 5, "player_1");
    const enemyRifleman = unitManager.createUnit(UNIT_TYPES.RIFLEMAN, 4, 5, "player_2");
    const enemyTank = unitManager.createUnit(UNIT_TYPES.LIGHT_TANK, 6, 5, "player_2");

    game.queueCommand({
      id: "rocket_soldier_role_priority",
      type: "attack_in_range",
      unitId: attacker.id,
      playerId: "player_1",
    });

    game.processCommands();

    expect(enemyTank.hp).toBe(enemyTank.maxHp - getAttackDamageAgainstUnit(UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.LIGHT_TANK));
    expect(enemyRifleman.hp).toBe(enemyRifleman.maxHp);
  });

  it("uses role-aware default targets for riflemen", () => {
    const unitManager = game.getUnitManager();
    const buildingManager = game.getBuildingManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.RIFLEMAN, 5, 5, "player_1");
    const enemyRifleman = unitManager.createUnit(UNIT_TYPES.RIFLEMAN, 4, 5, "player_2");
    const enemyTank = unitManager.createUnit(UNIT_TYPES.LIGHT_TANK, 6, 5, "player_2");
    const enemyHq = buildingManager.createBuilding(BUILDING_TYPES.HQ, 6, 6, "player_2");

    game.queueCommand({
      id: "rifleman_role_priority",
      type: "attack_in_range",
      unitId: attacker.id,
      playerId: "player_1",
    });

    game.processCommands();

    expect(enemyRifleman.hp).toBe(enemyRifleman.maxHp - getAttackDamageAgainstUnit(UNIT_TYPES.RIFLEMAN, UNIT_TYPES.RIFLEMAN));
    expect(enemyTank.hp).toBe(enemyTank.maxHp);
    expect(enemyHq.hp).toBe(enemyHq.maxHp);
  });

  it("attack_in_range does not fall back to buildings when priority is explicit", () => {
    const unitManager = game.getUnitManager();
    const buildingManager = game.getBuildingManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const enemyHq = buildingManager.createBuilding(BUILDING_TYPES.HQ, 6, 6, "player_2");

    game.queueCommand({
      id: "attack_in_range_unit_only_priority",
      type: "attack_in_range",
      unitId: attacker.id,
      targetPriority: [UNIT_TYPES.WORKER],
      playerId: "player_1",
    });

    game.processCommands();

    expect((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_code).toBe(RESULT_CODES.ERR_NOT_IN_RANGE);
    expect(enemyHq.hp).toBe(enemyHq.maxHp);
  });

  it("attack_in_range fails cleanly when nothing is in range", () => {
    const unitManager = game.getUnitManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    unitManager.createUnit(UNIT_TYPES.WORKER, 8, 8, "player_2");

    game.queueCommand({
      id: "attack_in_range_miss",
      type: "attack_in_range",
      unitId: attacker.id,
      targetPriority: [UNIT_TYPES.WORKER],
      playerId: "player_1",
    });

    game.processCommands();

    expect((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_code).toBe(RESULT_CODES.ERR_NOT_IN_RANGE);
    expect((game.getAIFeedback("player_1").at(-1)?.data as Record<string, unknown>)?.type).toBe("attack_no_target_in_range");
  });

  it("attack_move engages enemies before reaching the destination until overridden", () => {
    const unitManager = game.getUnitManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = unitManager.createUnit(UNIT_TYPES.SOLDIER, 7, 5, "player_2");

    game.queueCommand({
      id: "attack_move_push",
      type: "attack_move",
      unitId: attacker.id,
      position: { x: 9, y: 5 },
      targetPriority: [UNIT_TYPES.SOLDIER],
      playerId: "player_1",
    });

    game.start();
    game.tickUpdate();
    expect(attacker.intent?.type).toBe("attack_move");
    expect(attacker.x).toBe(6);
    expect(target.hp).toBe(target.maxHp - UNIT_STATS.soldier.attack);

    game.tickUpdate();
    expect(attacker.intent?.type).toBe("attack_move");
    expect(attacker.x).toBe(6);
    expect(target.hp).toBe(target.maxHp - UNIT_STATS.soldier.attack * 2);

    game.queueCommand({
      id: "override_attack_move",
      type: "hold",
      unitId: attacker.id,
      playerId: "player_1",
    });
    game.tickUpdate();
    game.stop();

    expect(attacker.intent?.type).not.toBe("attack_move");
  });

  it("attack_move detects enemies in vision, closes to range, and preserves the army destination", () => {
    const unitManager = game.getUnitManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = unitManager.createUnit(UNIT_TYPES.SOLDIER, 10, 5, "player_2");

    game.queueCommand({
      id: "attack_move_vision_acquisition",
      type: "attack_move",
      unitId: attacker.id,
      position: { x: 30, y: 5 },
      targetPriority: [UNIT_TYPES.SOLDIER],
      playerId: "player_1",
    });

    game.start();
    game.tickUpdate();
    expect(attacker.intent).toMatchObject({ type: "attack_move", targetX: 30, targetY: 5, targetId: target.id });
    expect(target.hp).toBe(target.maxHp);
    for (let tick = 0; tick < 4; tick++) game.tickUpdate();
    game.stop();

    expect(target.hp).toBeLessThan(target.maxHp);
    expect(attacker.intent).toMatchObject({ type: "attack_move", targetX: 30, targetY: 5 });
  });

  it("attack_move stops auto-attacking after reaching its destination", () => {
    const unitManager = game.getUnitManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = unitManager.createUnit(UNIT_TYPES.SOLDIER, 7, 5, "player_2");

    game.queueCommand({
      id: "attack_move_to_stop",
      type: "attack_move",
      unitId: attacker.id,
      position: { x: 6, y: 5 },
      targetPriority: [UNIT_TYPES.SOLDIER],
      playerId: "player_1",
    });

    game.start();
    game.tickUpdate();
    game.tickUpdate();
    game.stop();

    expect(attacker.x).toBe(6);
    expect(attacker.intent?.type).toBe("hold");
    expect(target.hp).toBe(target.maxHp);
  });

  it("attack_move ends when a blocked requested target resolves to the unit's current tile", () => {
    const unitManager = game.getUnitManager();
    const enemyHq = game.getState().players[1].buildings.find((building) => building.type === BUILDING_TYPES.HQ)!;
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, enemyHq.x - 4, enemyHq.y, "player_1");

    game.queueCommand({
      id: "attack_move_to_blocked_hq_from_adjacent_tile",
      type: "attack_move",
      unitId: attacker.id,
      position: { x: enemyHq.x, y: enemyHq.y },
      targetPriority: [UNIT_TYPES.SOLDIER],
      playerId: "player_1",
    });

    game.start();
    game.tickUpdate();
    game.stop();

    expect(attacker.x).toBe(enemyHq.x - 4);
    expect(attacker.y).toBe(enemyHq.y);
    expect(attacker.intent?.type).toBe("hold");
    expect(attacker.intent).not.toMatchObject({
      type: "attack_move",
      targetX: enemyHq.x,
      targetY: enemyHq.y,
    });
  });

  it("adjusts move targets to a nearby reachable tile when the requested tile is blocked", () => {
    const worker = game.getState().players[0].units.find((u) => u.type === UNIT_TYPES.WORKER)!;

    game.queueCommand({
      id: "move_to_enemy_hq_tile",
      type: "move",
      unitId: worker.id,
      position: DEFAULT_MAP_LAYOUT.player2Hq,
      playerId: "player_1",
    });

    game.processCommands();

    const result = game.getCommandResults().at(-1)!;
    const feedback = game.getAIFeedback("player_1").at(-1)!;
    const feedbackData = feedback.data as Record<string, unknown>;
    const runtimeWorker = game.getUnitManager().getUnit(worker.id)!;

    expect((result.data as CommandResultData).result_code).toBe(RESULT_CODES.OK);
    expect(runtimeWorker.pathTarget).toBeDefined();
    expect(runtimeWorker.pathTarget).not.toEqual(DEFAULT_MAP_LAYOUT.player2Hq);
    expect(feedbackData?.type).toBe("move_adjusted");
    expect((feedbackData?.result_data as any)?.requestedX).toBe(DEFAULT_MAP_LAYOUT.player2Hq.x);
    expect((feedbackData?.result_data as any)?.requestedY).toBe(DEFAULT_MAP_LAYOUT.player2Hq.y);
  });

  it("reserves path targets so multiple units moving to one tile spread out", () => {
    const unitManager = game.getUnitManager();
    const unit1 = unitManager.createUnit(UNIT_TYPES.SOLDIER, 8, 12, "player_1");
    const unit2 = unitManager.createUnit(UNIT_TYPES.SOLDIER, 8, 14, "player_1");
    const target = { x: 12, y: 12 };

    game.queueCommand({
      id: "move_unit_1_to_shared_target",
      type: "move",
      unitId: unit1.id,
      position: target,
      playerId: "player_1",
    });
    game.queueCommand({
      id: "move_unit_2_to_shared_target",
      type: "move",
      unitId: unit2.id,
      position: target,
      playerId: "player_1",
    });
    game.processCommands();

    expect(unit1.pathTarget).toEqual(target);
    expect(unit2.pathTarget).toBeDefined();
    expect(unit2.pathTarget).not.toEqual(target);
  });

  it("reserves path targets for grouped attack-move orders near blocked HQ targets", () => {
    const unitManager = game.getUnitManager();
    const enemyHq = game.getState().players[1].buildings.find((building) => building.type === BUILDING_TYPES.HQ)!;
    const unit1 = unitManager.createUnit(UNIT_TYPES.SOLDIER, 8, enemyHq.y - 1, "player_1");
    const unit2 = unitManager.createUnit(UNIT_TYPES.RIFLEMAN, 8, enemyHq.y + 1, "player_1");

    game.queueCommand({
      id: "attack_move_unit_1_to_hq",
      type: "attack_move",
      unitId: unit1.id,
      position: { x: enemyHq.x, y: enemyHq.y },
      playerId: "player_1",
    });
    game.queueCommand({
      id: "attack_move_unit_2_to_hq",
      type: "attack_move",
      unitId: unit2.id,
      position: { x: enemyHq.x, y: enemyHq.y },
      playerId: "player_1",
    });
    game.processCommands();

    expect(unit1.pathTarget).toBeDefined();
    expect(unit2.pathTarget).toBeDefined();
    expect(unit1.pathTarget).not.toEqual(unit2.pathTarget);
    expect(unit1.intent?.type).toBe("attack_move");
    expect(unit2.intent?.type).toBe("attack_move");
  });

  it("records command results for saved game records", () => {
    const state = game.getState();
    const hq = state.players[0].buildings.find((b) => b.type === BUILDING_TYPES.HQ)!;

    game.queueCommand({
      id: "spawn_worker",
      type: "spawn",
      buildingId: hq.id,
      unitType: UNIT_TYPES.WORKER,
      playerId: "player_1",
    });
    game.processCommands();

    const lastResult = game.getCommandResults().at(-1);
    expect((lastResult?.data as CommandResultData)?.command.id).toBe("spawn_worker");
    expect(lastResult?.tick).toBe(game.getTick());
  });

  it("lets workers gather on resource tiles and deliver credits near HQ", () => {
    const worker = game
      .getState()
      .players[0]
      .units.find((u) => u.type === UNIT_TYPES.WORKER)!;
    const runtimeWorker = game.getUnitManager().getUnit(worker.id)!;

    runtimeWorker.x = DEFAULT_MAP_LAYOUT.resources[0].x;
    runtimeWorker.y = DEFAULT_MAP_LAYOUT.resources[0].y;

    game.start();
    game.tickUpdate();

    expect(game.getState().players[0].resources.credits).toBe(800);
    expect(runtimeWorker.carryingCredits).toBe(10);
    expect(runtimeWorker.state).toBe("gathering");

    runtimeWorker.x = DEFAULT_MAP_LAYOUT.player1Hq.x + 1;
    runtimeWorker.y = DEFAULT_MAP_LAYOUT.player1Hq.y;

    game.tickUpdate();
    game.stop();

    expect(game.getState().players[0].resources.credits).toBe(810);
    expect(runtimeWorker.carryingCredits).toBe(0);
    expect(runtimeWorker.state).toBe("idle");
  });

  it("marks a unit idle after it finishes a move path", () => {
    const worker = game
      .getState()
      .players[0]
      .units.find((u) => u.type === UNIT_TYPES.WORKER)!;
    const runtimeWorker = game.getUnitManager().getUnit(worker.id)!;

    game.queueCommand({
      id: "move_worker_once",
      type: "move",
      unitId: worker.id,
      position: { x: worker.x + 1, y: worker.y },
      playerId: "player_1",
    });
    game.processCommands();

    expect(runtimeWorker.intent).toMatchObject({ type: "move", targetX: worker.x + 1, targetY: worker.y });

    game.start();
    game.tickUpdate();
    game.stop();

    expect(runtimeWorker.x).toBe(worker.x + 1);
    expect(runtimeWorker.y).toBe(worker.y);
    expect(runtimeWorker.state).toBe("idle");
    expect(runtimeWorker.intent).toBeUndefined();
    expect(runtimeWorker.path).toBeUndefined();
    expect(runtimeWorker.pathTarget).toBeUndefined();
  });

  it("harvest_loop keeps a worker shuttling between resource and HQ", () => {
    const worker = game
      .getState()
      .players[0]
      .units.find((u) => u.type === UNIT_TYPES.WORKER)!;
    const runtimeWorker = game.getUnitManager().getUnit(worker.id)!;

    runtimeWorker.x = DEFAULT_MAP_LAYOUT.resources[0].x;
    runtimeWorker.y = DEFAULT_MAP_LAYOUT.resources[0].y;

    game.queueCommand({
      id: "worker_harvest_loop",
      type: "harvest_loop",
      unitId: worker.id,
      position: DEFAULT_MAP_LAYOUT.resources[0],
      playerId: "player_1",
    });
    game.processCommands();

    expect(runtimeWorker.intent?.type).toBe("harvest_loop");

    game.start();
    for (let i = 0; i < 40 && game.getState().players[0].resources.credits === 800; i++) {
      game.tickUpdate();
    }
    game.stop();

    expect(game.getState().players[0].resources.credits).toBe(900);
    expect(runtimeWorker.carryingCredits).toBe(0);
    expect(runtimeWorker.intent?.type).toBe("harvest_loop");
    expect(runtimeWorker.intent).toMatchObject({
      targetX: DEFAULT_MAP_LAYOUT.resources[0].x,
      targetY: DEFAULT_MAP_LAYOUT.resources[0].y,
    });
  });

  it("harvest_loop auto-picks the nearest resource by Chebyshev distance", () => {
    const worker = game
      .getState()
      .players[0]
      .units.find((u) => u.type === UNIT_TYPES.WORKER)!;
    const runtimeWorker = game.getUnitManager().getUnit(worker.id)!;

    runtimeWorker.x = 0;
    runtimeWorker.y = DEFAULT_MAP_LAYOUT.resources[0].y;

    game.queueCommand({
      id: "worker_harvest_loop_auto_pick",
      type: "harvest_loop",
      unitId: worker.id,
      playerId: "player_1",
    });
    game.processCommands();

    expect(runtimeWorker.intent).toMatchObject({
      type: "harvest_loop",
      targetX: DEFAULT_MAP_LAYOUT.resources[0].x,
      targetY: DEFAULT_MAP_LAYOUT.resources[0].y,
    });
    expect(((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_data as { targetX: number; targetY: number })).toMatchObject({
      targetX: DEFAULT_MAP_LAYOUT.resources[0].x,
      targetY: DEFAULT_MAP_LAYOUT.resources[0].y,
    });
  });

  it("delivers carried resources to the nearest refinery footprint", () => {
    const worker = game.getUnitManager().getUnitsByPlayer("player_1")[0];
    const refinery = game.getBuildingManager().createBuilding(BUILDING_TYPES.REFINERY, 44, 18, "player_1");
    worker.x = 47;
    worker.y = 19;
    worker.carryingCredits = 100;

    game.start();
    game.tickUpdate();
    game.stop();

    expect(game.getBuildingManager().getDistanceToBuilding(refinery, worker.x, worker.y)).toBe(1);
    expect(game.getState().players[0].resources.credits).toBe(900);
    expect(worker.carryingCredits).toBe(0);
  });

  it("harvest_loop auto-picks less saturated nearby resources", () => {
    const workers = game
      .getState()
      .players[0]
      .units.filter((u) => u.type === UNIT_TYPES.WORKER);
    const [worker1, worker2] = workers;
    const runtimeWorker1 = game.getUnitManager().getUnit(worker1.id)!;
    const runtimeWorker2 = game.getUnitManager().getUnit(worker2.id)!;

    runtimeWorker1.x = DEFAULT_MAP_LAYOUT.player1Hq.x + 1;
    runtimeWorker1.y = DEFAULT_MAP_LAYOUT.player1Hq.y;
    runtimeWorker2.x = DEFAULT_MAP_LAYOUT.player1Hq.x + 1;
    runtimeWorker2.y = DEFAULT_MAP_LAYOUT.player1Hq.y;

    game.queueCommand({
      id: "worker_1_auto_harvest",
      type: "harvest_loop",
      unitId: worker1.id,
      playerId: "player_1",
    });
    game.queueCommand({
      id: "worker_2_auto_harvest",
      type: "harvest_loop",
      unitId: worker2.id,
      playerId: "player_1",
    });
    game.processCommands();

    const assignedTargets = new Set([
      `${runtimeWorker1.intent?.targetX},${runtimeWorker1.intent?.targetY}`,
      `${runtimeWorker2.intent?.targetX},${runtimeWorker2.intent?.targetY}`,
    ]);

    expect(assignedTargets.size).toBe(2);
    for (const target of assignedTargets) {
      expect(DEFAULT_MAP_LAYOUT.resources.some((position) => `${position.x},${position.y}` === target)).toBe(true);
    }
  });

  it("depletes finite resource deposits and turns exhausted tiles into open ground", () => {
    const resource = DEFAULT_MAP_LAYOUT.resources[0];
    const worker = game.getUnitManager().getUnitsByPlayer("player_1")[0];
    worker.x = resource.x;
    worker.y = resource.y;
    (game as unknown as { resourceRemaining: Map<string, number> }).resourceRemaining.set(`${resource.x},${resource.y}`, 10);

    game.start();
    game.tickUpdate();
    game.stop();

    const tile = game.getState().tiles[resource.y][resource.x];
    expect(worker.carryingCredits).toBe(10);
    expect(tile.type).toBe(TILE_TYPES.EMPTY);
    expect(tile.resourceRemaining).toBeUndefined();
  });

  it("keeps immutable initial/latest snapshots and records intermediate tick deltas", () => {
    game.start();
    game.tickUpdate();
    const snapshots = game.getSnapshots();
    const initialSnapshot = snapshots[0];

    const workerId = initialSnapshot.state.players[0].units[0].id;
    const runtimeWorker = game.getUnitManager().getUnit(workerId)!;
    runtimeWorker.x = 9;
    runtimeWorker.y = 9;

    game.tickUpdate();
    game.stop();

    const updatedSnapshots = game.getSnapshots();
    expect(updatedSnapshots.length).toBe(2);
    expect(game.getTickDeltas()).toHaveLength(2);
    expect(initialSnapshot.tick).toBe(0);
    expect(initialSnapshot.state.players[0].units[0].x).toBe(DEFAULT_MAP_LAYOUT.player1Workers[0].x);
    expect(initialSnapshot.state.players[0].units[0].y).toBe(DEFAULT_MAP_LAYOUT.player1Workers[0].y);
    expect(updatedSnapshots[0].state.players[0].units[0].x).toBe(DEFAULT_MAP_LAYOUT.player1Workers[0].x);
    expect(updatedSnapshots[1].state.players[0].units[0].x).toBe(9);
    expect(game.getTickDeltas()[1]?.players[0]?.units).toContainEqual(
      expect.objectContaining({ id: workerId, change: "moved", x: 9, y: 9 }),
    );
  });

  it("keeps full snapshots bounded while preserving more than 1000 recording deltas", () => {
    game.start();
    for (let i = 0; i < 1001; i++) {
      game.tickUpdate();
    }
    game.stop();

    expect(game.getSnapshots()).toHaveLength(2);
    expect(game.getTickDeltas()).toHaveLength(1001);
  });

  it("preserves command results after the live log window is trimmed", () => {
    for (let index = 0; index < 1200; index += 1) {
      game.addLog(LOG_TYPES.COMMAND_RESULT, `result-${index}`, {
        command: {
          id: `command-${index}`,
          type: "hold",
          unitId: "unit-1",
          playerId: "player_1",
        },
        result_code: RESULT_CODES.OK,
        type: RESULT_TYPES.HOLD_SUCCESS,
        result_data: { unitId: "unit-1" },
      });
    }

    expect(game.getState().logs.length).toBeLessThan(1200);
    expect(game.getCommandResults()).toHaveLength(1200);
    expect((game.getCommandResults()[0]?.data as CommandResultData).command.id).toBe("command-0");
    expect((game.getCommandResults().at(-1)?.data as CommandResultData).command.id).toBe("command-1199");
  });
});
