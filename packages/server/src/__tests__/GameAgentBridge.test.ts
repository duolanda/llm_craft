import { describe, expect, it } from "vitest";
import { Game } from "../Game";
import { GameAgentBridge } from "../agent/GameAgentBridge";
import { TILE_TYPES } from "@llmcraft/shared";

describe("GameAgentBridge", () => {
  it("queues action commands into the game immediately", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === "worker")!;

    const result = bridge.moveUnit(worker.id, { x: 2, y: 7 });

    expect(result.result).toMatchObject({ ok: true });
    expect(bridge.takeIssuedCommands()).toHaveLength(1);

    game.tickUpdate();

    const updatedWorker = game.getState().players[0].units.find((unit) => unit.id === worker.id)!;
    expect(updatedWorker.x).toBe(2);
    expect(updatedWorker.y).toBe(9);
  });

  it("returns an immediate validation error for barracks positions adjacent to HQ", () => {
    const bridge = new GameAgentBridge(new Game(), "player_2");

    const result = bridge.buildStructure("unit_4", "barracks", { x: 17, y: 10 });

    expect(result.result).toMatchObject({
      ok: false,
      error: "invalid_build_position",
    });
    expect((result.result as { hint: string }).hint).toContain("Leave at least one empty tile around HQ");
    expect((result.result as { hint: string }).hint).toContain("(16, 10)");
    expect(bridge.takeIssuedCommands()).toHaveLength(0);
  });

  it("rejects legacy orchestrate_plan steps instead of registering a stuck plan", () => {
    const bridge = new GameAgentBridge(new Game(), "player_2");

    const result = bridge.orchestratePlan({
      unitIds: ["unit_3"],
      steps: [{ type: "move_to_resource" }] as any,
    });

    expect(result.result).toMatchObject({
      ok: false,
      error: "invalid_plan",
    });
    expect((result.result as { hint: string }).hint).toContain("new { do: ... } format");
    expect(bridge.getActivePlans()).toHaveLength(0);
  });

  it("rejects plans that target buildings instead of units", () => {
    const bridge = new GameAgentBridge(new Game(), "player_2");

    const result = bridge.orchestratePlan({
      unitIds: ["building_2"],
      steps: [{ do: "hold_position" }],
    });

    expect(result.result).toMatchObject({
      ok: false,
      error: "invalid_plan",
    });
    expect((result.result as { hint: string }).hint).toContain("friendly units");
    expect(bridge.getActivePlans()).toHaveLength(0);
  });

  it("returns a slim battlefield view from get_map_state by default", () => {
    const bridge = new GameAgentBridge(new Game(), "player_2");

    const result = bridge.getMapState();
    const mapState = result.result as {
      cells: Array<Record<string, unknown>>;
    };

    expect(mapState.cells.length).toBeGreaterThan(0);
    expect(mapState.cells.some((cell) => cell.tile === TILE_TYPES.RESOURCE)).toBe(true);
    expect(mapState.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          x: 17,
          y: 9,
          tile: "empty",
          unit: expect.objectContaining({
            id: "unit_3",
            type: "worker",
            hp: 50,
            state: "idle",
            relation: "self",
          }),
        }),
        expect.objectContaining({
          x: 3,
          y: 9,
          tile: "empty",
          unit: expect.objectContaining({
            id: "unit_1",
            type: "worker",
            hp: 50,
            state: "idle",
            relation: "enemy",
          }),
        }),
      ])
    );
    const occupiedCell = mapState.cells.find((cell) => cell.unit) as { unit: Record<string, unknown> } | undefined;
    expect(occupiedCell?.unit).not.toHaveProperty("my");
    expect(occupiedCell?.unit).not.toHaveProperty("playerId");
    expect(occupiedCell?.unit).not.toHaveProperty("carryingCredits");
    expect(occupiedCell?.unit).not.toHaveProperty("attackRange");
  });
});
