/**
 * Integration test for CLI Control Plane.
 * Tests the full pipeline: Game -> ControlSessionManager -> control responses.
 * No API keys, no WebSocket, no server process needed.
 */
import { describe, it, expect } from "vitest";
import {
  BUILDING_TYPES,
  DEFAULT_MAP_LAYOUT,
  MAP_HEIGHT,
  MAP_WIDTH,
  TILE_TYPES,
  UNIT_TYPES,
} from "@llmcraft/shared";
import { Game } from "../Game";
import { GameAgentBridge } from "../agent/GameAgentBridge";
import { ControlSessionManager, executeControlTool, buildControlResponse } from "../ControlHandler";
import { ControlPlaneMatch } from "../control/ControlPlaneMatch";

describe("CLI Control Plane Integration", () => {
  it("smoke-tests the OpenRA map baseline through control tools", () => {
    const match = new ControlPlaneMatch({ cpuStrategy: "rush" });
    match.join("player_1");
    match.join("player_2");

    const game = match.getGame();
    const bridge = match.getBridge("player_1");
    const manager = new ControlSessionManager();
    const session = manager.create(bridge, "openra-baseline-smoke", "player_1");

    const mapResult = executeControlTool(session.bridge, "get_map_state", {
      includeCells: true,
      includeEmptyTiles: false,
    });
    const mapData = mapResult.result as Record<string, unknown>;
    const cells = mapData.cells as Array<Record<string, unknown>>;
    const buildings = mapData.buildings as Array<Record<string, unknown>>;
    const resources = mapData.resources as Array<Record<string, unknown>>;

    expect(MAP_WIDTH).toBe(144);
    expect(MAP_HEIGHT).toBe(96);
    expect(mapData).not.toHaveProperty("asciiMap");
    expect(mapData).not.toHaveProperty("fogOfWar");
    expect(buildings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: BUILDING_TYPES.HQ,
          relation: "self",
          x: DEFAULT_MAP_LAYOUT.player1Hq.x,
          y: DEFAULT_MAP_LAYOUT.player1Hq.y,
        }),
      ])
    );
    expect(buildings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: BUILDING_TYPES.HQ,
          relation: "enemy",
          x: DEFAULT_MAP_LAYOUT.player2Hq.x,
          y: DEFAULT_MAP_LAYOUT.player2Hq.y,
        }),
      ])
    );
    expect(cells).toEqual(
      expect.arrayContaining(DEFAULT_MAP_LAYOUT.resources.slice(0, 2).map((position) =>
        expect.objectContaining({ ...position, tile: TILE_TYPES.RESOURCE, resourceRemaining: 5000 })
      ))
    );
    expect(resources).toEqual(
      expect.arrayContaining(DEFAULT_MAP_LAYOUT.resources.slice(0, 2).map((position) =>
        expect.objectContaining({ ...position, remaining: 5000 })
      ))
    );

    const unitsResult = executeControlTool(session.bridge, "get_my_units", {});
    const unitsData = unitsResult.result as Record<string, unknown>;
    const workers = (unitsData.units as Array<Record<string, unknown>>).filter((unit) => unit.type === UNIT_TYPES.WORKER);
    expect(workers).toEqual(
      expect.arrayContaining(DEFAULT_MAP_LAYOUT.player1Workers.map((position) => expect.objectContaining(position)))
    );

    const harvestResult = executeControlTool(session.bridge, "start_harvest_loop", {
      unitId: workers[0].id,
    });
    expect(buildControlResponse(harvestResult).ok).toBe(true);

    const buildSite = { x: DEFAULT_MAP_LAYOUT.player1Hq.x + 16, y: DEFAULT_MAP_LAYOUT.player1Hq.y };
    const builder = game.getUnitManager().getUnit(String(workers[1].id))!;
    builder.x = buildSite.x - 3;
    builder.y = buildSite.y;
    const buildResult = executeControlTool(session.bridge, "build_structure", {
      unitId: workers[1].id,
      buildingType: BUILDING_TYPES.BARRACKS,
      x: buildSite.x,
      y: buildSite.y,
    });
    expect(buildControlResponse(buildResult).ok).toBe(true);

    game.tickUpdate();
    match.advancePlans();
    game.tickUpdate();
    match.stop();

    const updatedPlayer = game.getState().players[0];
    expect(updatedPlayer.buildings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: BUILDING_TYPES.BARRACKS,
          x: buildSite.x,
          y: buildSite.y,
        }),
      ])
    );
    expect(updatedPlayer.units.find((unit) => unit.id === workers[0].id)?.intent).toMatchObject({
      type: "harvest_loop",
    });
  });

  it("spreads duplicate move targets through control tools", () => {
    const game = new Game();
    game.start();
    const manager = new ControlSessionManager();
    const session = manager.create(new GameAgentBridge(game, "player_1"), "movement-reservation-smoke", "player_1");
    const unit1 = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 8, 12, "player_1");
    const unit2 = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 8, 14, "player_1");
    const target = { x: 12, y: 12 };

    const result1 = executeControlTool(session.bridge, "move_unit", {
      unitId: unit1.id,
      x: target.x,
      y: target.y,
    });
    const result2 = executeControlTool(session.bridge, "move_unit", {
      unitId: unit2.id,
      x: target.x,
      y: target.y,
    });
    game.processCommands();
    game.stop();

    expect(buildControlResponse(result1).ok).toBe(true);
    expect(buildControlResponse(result2).ok).toBe(true);
    expect(unit1.pathTarget).toEqual(target);
    expect(unit2.pathTarget).toBeDefined();
    expect(unit2.pathTarget).not.toEqual(target);
  });

  it("creates a session and reads state", () => {
    const game = new Game();
    game.start();
    const manager = new ControlSessionManager();
    const session = manager.create(new GameAgentBridge(game, "player_1"), "test-game", "player_1");

    expect(session.id).toMatch(/^cs_/);
    expect(session.playerId).toBe("player_1");
    expect(session.gameId).toBe("test-game");

    // Simulate CLI calling get_my_units via control endpoint
    const result = executeControlTool(session.bridge, "get_my_units", {});
    const response = buildControlResponse(result);

    expect(response.ok).toBe(true);
    expect(response.kind).toBe("state");
    expect(response.data).toBeDefined();

    const data = response.data as Record<string, unknown>;
    const units = data.units as Array<Record<string, unknown>>;
    expect(units.length).toBeGreaterThan(0);
    expect(units[0].type).toBe("worker");
  });

  it("queues a move command through control endpoint", () => {
    const game = new Game();
    game.start();
    const manager = new ControlSessionManager();
    const session = manager.create(new GameAgentBridge(game, "player_1"), "test-game", "player_1");

    // Get first worker
    const readResult = executeControlTool(session.bridge, "get_my_units", {});
    const readData = readResult.result as Record<string, unknown>;
    const units = readData.units as Array<Record<string, unknown>>;
    const workerId = units[0].id as string;

    // Move it
    const result = executeControlTool(session.bridge, "move_unit", {
      unitId: workerId,
      x: 5,
      y: 8,
    });
    const response = buildControlResponse(result);

    expect(response.ok).toBe(true);
    expect(response.tick).toBeTypeOf("number");
    expect(response.warnings).toBeUndefined();
  });

  it("keeps recent read tracking across control tool calls", () => {
    const game = new Game();
    game.start();
    const manager = new ControlSessionManager();
    const session = manager.create(new GameAgentBridge(game, "player_1"), "test-game", "player_1");

    const readResult = executeControlTool(session.bridge, "get_my_units", {});
    const readData = readResult.result as Record<string, unknown>;
    const units = readData.units as Array<Record<string, unknown>>;
    const workerId = units[0].id as string;

    const actionResult = executeControlTool(session.bridge, "move_unit", {
      unitId: workerId,
      x: 5,
      y: 8,
    });
    const actionResponse = buildControlResponse(actionResult);

    expect(actionResponse.ok).toBe(true);
    expect(actionResponse.warnings).toBeUndefined();
  });

  it("returns error for unknown tool", () => {
    const game = new Game();
    game.start();
    const manager = new ControlSessionManager();
    const session = manager.create(new GameAgentBridge(game, "player_1"), "test-game", "player_1");

    const result = executeControlTool(session.bridge, "nonexistent_tool", {});
    const response = buildControlResponse(result);

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBeDefined();
  });

  it("filters units by type locally (simulates CLI selector)", () => {
    const game = new Game();
    game.start();
    const manager = new ControlSessionManager();
    const session = manager.create(new GameAgentBridge(game, "player_1"), "test-game", "player_1");

    const result = executeControlTool(session.bridge, "get_my_units", {});
    const data = result.result as Record<string, unknown>;
    const allUnits = data.units as Array<Record<string, unknown>>;

    // Simulate CLI's local --type filter
    const workers = allUnits.filter((u) => u.type === "worker");
    expect(workers.length).toBeGreaterThan(0);
    workers.forEach((w) => expect(w.type).toBe("worker"));
  });

  it("supports gather command", () => {
    const game = new Game();
    game.start();
    const manager = new ControlSessionManager();
    const session = manager.create(new GameAgentBridge(game, "player_1"), "test-game", "player_1");

    const readResult = executeControlTool(session.bridge, "get_my_units", {});
    const readData = readResult.result as Record<string, unknown>;
    const units = readData.units as Array<Record<string, unknown>>;
    const workerId = units.find((unit) => unit.type === "worker")?.id as string;

    const result = executeControlTool(session.bridge, "start_harvest_loop", { unitId: workerId });
    const response = buildControlResponse(result);

    expect(response.ok).toBe(true);
  });

  it("enemies shows opponent units inside vision", () => {
    const game = new Game();
    game.start();
    game.getUnitManager().createUnit(
      UNIT_TYPES.SOLDIER,
      DEFAULT_MAP_LAYOUT.player1Hq.x + 5,
      DEFAULT_MAP_LAYOUT.player1Hq.y,
      "player_2"
    );
    const manager = new ControlSessionManager();
    const session = manager.create(new GameAgentBridge(game, "player_1"), "test-game", "player_1");

    const result = executeControlTool(session.bridge, "get_map_state", {
      includeCells: false,
      includeEmptyTiles: false,
    });
    const data = result.result as Record<string, unknown>;
    const units = data.units as Array<Record<string, unknown>>;

    const enemies = units.filter((u) => u.relation === "enemy");
    expect(enemies.length).toBeGreaterThan(0);
  });

  it("shares durable player control state across sessions", () => {
    const match = new ControlPlaneMatch();
    const manager = new ControlSessionManager();
    const sessionA = manager.create(match.getBridge("player_1"), "test-game", "player_1");
    const sessionB = manager.create(match.getBridge("player_1"), "test-game", "player_1");
    const worker = match.getGame().getState().players[0].units.find((unit) => unit.type === "worker")!;

    const result = executeControlTool(sessionA.bridge, "orchestrate_plan", {
      unitIds: [worker.id],
      steps: [{ call: "start_harvest_loop", args: { unitId: "$unitId" } }],
    });

    expect(result.result).toMatchObject({ ok: true });
    expect(sessionB.bridge.getActivePlans()).toHaveLength(1);
  });

  it("advances control-plane orchestration plans into game commands", () => {
    const match = new ControlPlaneMatch();
    match.join("player_1");
    match.join("player_2");
    const game = match.getGame();
    const bridge = match.getBridge("player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === "worker")!;

    const result = bridge.orchestratePlan({
      unitIds: [worker.id],
      steps: [{ call: "start_harvest_loop", args: { unitId: "$unitId" } }],
    });
    expect(result.result).toMatchObject({ ok: true });

    match.advancePlans();
    game.tickUpdate();
    match.stop();

    const updatedWorker = game.getState().players[0].units.find((unit) => unit.id === worker.id)!;
    expect(updatedWorker.intent).toMatchObject({ type: "harvest_loop" });
  });
});
