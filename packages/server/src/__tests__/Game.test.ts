import { beforeEach, describe, expect, it } from "vitest";
import { Game } from "../Game";
import { BUILDING_TYPES, MAP_HEIGHT, MAP_WIDTH, RESULT_CODES, TILE_TYPES, UNIT_STATS, UNIT_TYPES, RESULT_TYPES, BUILDING_STATS, calculateDamage, CommandResultData } from "@llmcraft/shared";

describe("Game", () => {
  let game: Game;

  beforeEach(() => {
    game = new Game();
  });

  it("initializes each player with one HQ, two workers and credits", () => {
    const state = game.getState();
    const [player1, player2] = state.players;
    const centerY = Math.floor(MAP_HEIGHT / 2);

    expect(player1.buildings.filter((b) => b.type === BUILDING_TYPES.HQ)).toHaveLength(1);
    expect(player2.buildings.filter((b) => b.type === BUILDING_TYPES.HQ)).toHaveLength(1);
    expect(player1.units.filter((u) => u.type === UNIT_TYPES.WORKER)).toHaveLength(2);
    expect(player2.units.filter((u) => u.type === UNIT_TYPES.WORKER)).toHaveLength(2);
    expect(player1.units.filter((u) => u.type === UNIT_TYPES.SOLDIER)).toHaveLength(0);
    expect(player1.resources.credits).toBe(400);
    expect(player1.buildings.find((b) => b.type === BUILDING_TYPES.HQ)).toMatchObject({ x: 2, y: centerY });
    expect(player2.buildings.find((b) => b.type === BUILDING_TYPES.HQ)).toMatchObject({ x: MAP_WIDTH - 3, y: centerY });
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

    expect(game.getState().players[0].resources.credits).toBe(350);
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
    expect(game.getState().players[0].resources.credits).toBe(400);
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
      position: { x: 4, y: 10 },
      playerId: "player_1",
    });

    game.processCommands();

    const state = game.getState();
    expect(state.players[0].buildings.filter((b) => b.type === BUILDING_TYPES.BARRACKS)).toHaveLength(1);
    expect(state.players[0].resources.credits).toBe(280);
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
      position: { x: 2, y: 10 },
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
      position: { x: 3, y: 10 },
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
      position: { x: 4, y: 10 },
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
    game.tickUpdate();
    game.stop();

    expect(game.getState().players[0].units.filter((u) => u.type === UNIT_TYPES.SOLDIER)).toHaveLength(1);
  });

  it("spawns tanks and demolishers from barracks", () => {
    const worker = game
      .getState()
      .players[0]
      .units.find((u) => u.type === UNIT_TYPES.WORKER)!;

    game.queueCommand({
      id: "build_barracks",
      type: "build",
      unitId: worker.id,
      buildingType: BUILDING_TYPES.BARRACKS,
      position: { x: 4, y: 10 },
      playerId: "player_1",
    });
    game.processCommands();

    const barracks = game
      .getState()
      .players[0]
      .buildings.find((b) => b.type === BUILDING_TYPES.BARRACKS)!;

    game.queueCommand({
      id: "spawn_tank",
      type: "spawn",
      buildingId: barracks.id,
      unitType: UNIT_TYPES.TANK,
      playerId: "player_1",
    });
    game.queueCommand({
      id: "spawn_demolisher",
      type: "spawn",
      buildingId: barracks.id,
      unitType: UNIT_TYPES.DEMOLISHER,
      playerId: "player_1",
    });
    game.processCommands();
    game.start();
    game.tickUpdate();
    game.tickUpdate();
    game.stop();

    expect(game.getState().players[0].units.filter((u) => u.type === UNIT_TYPES.TANK)).toHaveLength(1);
    expect(game.getState().players[0].units.filter((u) => u.type === UNIT_TYPES.DEMOLISHER)).toHaveLength(1);
  });

  it("keeps worker unable to attack and soldier attack range at one", () => {
    const unitManager = game.getUnitManager();
    const worker = unitManager.createUnit(UNIT_TYPES.WORKER, 5, 5, "player_1");
    const soldier = unitManager.createUnit(UNIT_TYPES.SOLDIER, 6, 5, "player_1");

    expect(UNIT_STATS.worker.attack).toBe(0);
    expect(worker.attackRange).toBe(0);
    expect(soldier.attackRange).toBe(1);
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
    const expectedDamage = calculateDamage(UNIT_STATS.soldier, BUILDING_STATS[BUILDING_TYPES.BARRACKS].armorType);

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

  it("keeps re-evaluating attack_in_range on later ticks", () => {
    const unitManager = game.getUnitManager();
    const buildingManager = game.getBuildingManager();
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const enemyWorker = unitManager.createUnit(UNIT_TYPES.WORKER, 4, 5, "player_2");
    const enemyHq = buildingManager.createBuilding(BUILDING_TYPES.HQ, 6, 6, "player_2");
    const expectedDamage = calculateDamage(UNIT_STATS.soldier, BUILDING_STATS[BUILDING_TYPES.HQ].armorType);

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

    expect(attacker.intent?.type).toBe("hold");
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
    const attacker = unitManager.createUnit(UNIT_TYPES.SOLDIER, enemyHq.x - 1, enemyHq.y, "player_1");

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

    expect(attacker.x).toBe(enemyHq.x - 1);
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
      position: { x: 18, y: 10 },
      playerId: "player_1",
    });

    game.processCommands();

    const result = game.getCommandResults().at(-1)!;
    const feedback = game.getAIFeedback("player_1").at(-1)!;
    const feedbackData = feedback.data as Record<string, unknown>;
    const runtimeWorker = game.getUnitManager().getUnit(worker.id)!;

    expect((result.data as CommandResultData).result_code).toBe(RESULT_CODES.OK);
    expect(runtimeWorker.pathTarget).toBeDefined();
    expect(runtimeWorker.pathTarget).not.toEqual({ x: 18, y: 10 });
    expect(feedbackData?.type).toBe("move_adjusted");
    expect((feedbackData?.result_data as any)?.requestedX).toBe(18);
    expect((feedbackData?.result_data as any)?.requestedY).toBe(10);
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

    runtimeWorker.x = 2;
    runtimeWorker.y = 7;

    game.start();
    game.tickUpdate();

    expect(game.getState().players[0].resources.credits).toBe(400);
    expect(runtimeWorker.carryingCredits).toBe(10);
    expect(runtimeWorker.state).toBe("gathering");

    runtimeWorker.x = 3;
    runtimeWorker.y = 10;

    game.tickUpdate();
    game.stop();

    expect(game.getState().players[0].resources.credits).toBe(410);
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

    runtimeWorker.x = 2;
    runtimeWorker.y = 7;

    game.queueCommand({
      id: "worker_harvest_loop",
      type: "harvest_loop",
      unitId: worker.id,
      position: { x: 2, y: 7 },
      playerId: "player_1",
    });
    game.processCommands();

    expect(runtimeWorker.intent?.type).toBe("harvest_loop");

    game.start();
    for (let i = 0; i < 12; i++) {
      game.tickUpdate();
    }
    game.stop();

    expect(game.getState().players[0].resources.credits).toBe(500);
    expect(runtimeWorker.carryingCredits).toBe(0);
    expect(runtimeWorker.intent?.type).toBe("harvest_loop");
    expect(runtimeWorker.intent).toMatchObject({ targetX: 2, targetY: 7 });
  });

  it("harvest_loop auto-picks the nearest resource by Chebyshev distance", () => {
    const worker = game
      .getState()
      .players[0]
      .units.find((u) => u.type === UNIT_TYPES.WORKER)!;
    const runtimeWorker = game.getUnitManager().getUnit(worker.id)!;

    runtimeWorker.x = 0;
    runtimeWorker.y = 1;

    game.queueCommand({
      id: "worker_harvest_loop_auto_pick",
      type: "harvest_loop",
      unitId: worker.id,
      playerId: "player_1",
    });
    game.processCommands();

    expect(runtimeWorker.intent).toMatchObject({
      type: "harvest_loop",
      targetX: 2,
      targetY: 7,
    });
    expect(((game.getCommandResults().at(-1)?.data as CommandResultData)?.result_data as { targetX: number; targetY: number })).toMatchObject({
      targetX: 2,
      targetY: 7,
    });
  });

  it("keeps snapshot history without mutating earlier snapshots", () => {
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
    expect(updatedSnapshots.length).toBe(3);
    expect(initialSnapshot.tick).toBe(0);
    expect(initialSnapshot.state.players[0].units[0].x).toBe(3);
    expect(initialSnapshot.state.players[0].units[0].y).toBe(9);
    expect(updatedSnapshots[0].state.players[0].units[0].x).toBe(3);
    expect(updatedSnapshots[2].state.players[0].units[0].x).toBe(9);
  });

  it("keeps more than 1000 snapshots for recording", () => {
    game.start();
    for (let i = 0; i < 1001; i++) {
      game.tickUpdate();
    }
    game.stop();

    expect(game.getSnapshots().length).toBe(1002);
  });
});
