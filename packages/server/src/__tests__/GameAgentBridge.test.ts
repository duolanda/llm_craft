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
    expect(result.result).toMatchObject({
      tick: expect.any(Number),
      warning: expect.objectContaining({ type: "no_recent_read" }),
    });
    expect(bridge.takeIssuedCommands()).toHaveLength(1);

    game.tickUpdate();

    const updatedWorker = game.getState().players[0].units.find((unit) => unit.id === worker.id)!;
    expect(updatedWorker.x).toBe(2);
    expect(updatedWorker.y).toBe(9);
  });

  it("returns immediate validation errors for stale unit ids before queueing actions", () => {
    const game = new Game();
    const bridge = new GameAgentBridge(game, "player_1");

    const result = bridge.moveUnit("missing_unit", { x: 2, y: 7 });

    expect(result.result).toMatchObject({
      tick: 0,
      ok: false,
      error: "invalid_unit",
    });
    expect(bridge.takeIssuedCommands()).toHaveLength(0);
  });

  it("adds a stale-read warning to actions when the last read is old", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === "worker")!;

    bridge.getMyUnits();
    for (let i = 0; i < 11; i++) {
      game.tickUpdate();
    }

    const result = bridge.moveUnit(worker.id, { x: 2, y: 7 });
    game.stop();

    expect(result.result).toMatchObject({
      tick: 11,
      ok: true,
      warning: expect.objectContaining({
        type: "state_stale",
        lastReadTick: 0,
        currentTick: 11,
        ageTicks: 11,
        staleAfterTicks: 10,
      }),
    });
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
      tick: number;
      cells: Array<Record<string, unknown>>;
    };

    expect(mapState.tick).toBe(0);
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

  it("returns controllable units with the read tick", () => {
    const bridge = new GameAgentBridge(new Game(), "player_1");

    const result = bridge.getMyUnits();
    const myUnits = result.result as { tick: number; units: Array<Record<string, unknown>> };

    expect(myUnits.tick).toBe(0);
    expect(myUnits.units).toHaveLength(2);
    expect(myUnits.units[0]).toHaveProperty("hasActivePlan", false);
  });
});
