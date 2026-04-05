import { beforeEach, describe, expect, it } from "vitest";
import { Game } from "../Game";
import { BUILDING_TYPES, RESULT_CODES, UNIT_TYPES } from "@llmcraft/shared";

describe("Game", () => {
  let game: Game;

  beforeEach(() => {
    game = new Game();
  });

  it("initializes each player with one HQ, two workers and credits", () => {
    const state = game.getState();
    const [player1, player2] = state.players;

    expect(player1.buildings.filter((b) => b.type === BUILDING_TYPES.HQ)).toHaveLength(1);
    expect(player2.buildings.filter((b) => b.type === BUILDING_TYPES.HQ)).toHaveLength(1);
    expect(player1.units.filter((u) => u.type === UNIT_TYPES.WORKER)).toHaveLength(2);
    expect(player2.units.filter((u) => u.type === UNIT_TYPES.WORKER)).toHaveLength(2);
    expect(player1.units.filter((u) => u.type === UNIT_TYPES.SOLDIER)).toHaveLength(0);
    expect(player1.resources.credits).toBe(200);
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

    expect(game.getState().players[0].resources.credits).toBe(150);
    expect(game.getCommandResults().at(-1)?.success).toBe(true);
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

    expect(game.getCommandResults().at(-1)?.result).toBe(RESULT_CODES.ERR_INVALID_BUILDING);
    expect(game.getState().players[0].resources.credits).toBe(200);
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
    expect(state.players[0].resources.credits).toBe(80);
    expect(game.getCommandResults().at(-1)?.success).toBe(true);
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

    expect(game.getCommandResults().at(-1)?.result).toBe(RESULT_CODES.ERR_POSITION_OCCUPIED);
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

    expect(game.getCommandResults().at(-1)?.success).toBe(false);
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

  it("keeps worker attack range at zero and soldier attack range at one", () => {
    const unitManager = game.getUnitManager();
    const worker = unitManager.createUnit(UNIT_TYPES.WORKER, 5, 5, "player_1");
    const soldier = unitManager.createUnit(UNIT_TYPES.SOLDIER, 6, 5, "player_1");

    expect(worker.attackRange).toBe(0);
    expect(soldier.attackRange).toBe(1);
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
    expect(lastResult?.command.id).toBe("spawn_worker");
    expect(lastResult?.tick).toBe(game.getTick());
  });

  it("lets workers gather on resource tiles and deliver credits near HQ", () => {
    const worker = game
      .getState()
      .players[0]
      .units.find((u) => u.type === UNIT_TYPES.WORKER)!;
    const runtimeWorker = game.getUnitManager().getUnit(worker.id)!;

    runtimeWorker.x = 2;
    runtimeWorker.y = 8;

    game.start();
    game.tickUpdate();

    expect(game.getState().players[0].resources.credits).toBe(200);
    expect(runtimeWorker.carryingCredits).toBe(10);
    expect(runtimeWorker.state).toBe("gathering");

    runtimeWorker.x = 3;
    runtimeWorker.y = 10;

    game.tickUpdate();
    game.stop();

    expect(game.getState().players[0].resources.credits).toBe(210);
    expect(runtimeWorker.carryingCredits).toBe(0);
    expect(runtimeWorker.state).toBe("idle");
  });
});
