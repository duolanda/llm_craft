/**
 * Integration test for CLI Control Plane.
 * Tests the full pipeline: Game -> ControlSessionManager -> control responses.
 * No API keys, no WebSocket, no server process needed.
 */
import { describe, it, expect } from "vitest";
import { Game } from "../Game";
import { ControlSessionManager, executeControlTool, buildControlResponse } from "../ControlHandler";

describe("CLI Control Plane Integration", () => {
  it("creates a session and reads state", () => {
    const game = new Game();
    game.start();
    const manager = new ControlSessionManager();
    const session = manager.create(game, "test-game", "player_1");

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
    const session = manager.create(game, "test-game", "player_1");

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
  });

  it("returns error for unknown tool", () => {
    const game = new Game();
    game.start();
    const manager = new ControlSessionManager();
    const session = manager.create(game, "test-game", "player_1");

    const result = executeControlTool(session.bridge, "nonexistent_tool", {});
    const response = buildControlResponse(result);

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBeDefined();
  });

  it("filters units by type locally (simulates CLI selector)", () => {
    const game = new Game();
    game.start();
    const manager = new ControlSessionManager();
    const session = manager.create(game, "test-game", "player_1");

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
    const session = manager.create(game, "test-game", "player_1");

    const result = executeControlTool(session.bridge, "start_harvest_loop", {});
    const response = buildControlControlResponse(result);

    expect(response.ok).toBe(true);
  });

  it("enemies shows opponent units", () => {
    const game = new Game();
    game.start();
    const manager = new ControlSessionManager();
    const session = manager.create(game, "test-game", "player_1");

    const result = executeControlTool(session.bridge, "get_map_state", {
      includeCells: false,
      includeEmptyTiles: false,
    });
    const data = result.result as Record<string, unknown>;
    const units = data.units as Array<Record<string, unknown>>;

    // There should be enemy units (player_2's units)
    const enemies = units.filter((u) => u.relation === "enemy");
    expect(enemies.length).toBeGreaterThan(0);
  });
});
