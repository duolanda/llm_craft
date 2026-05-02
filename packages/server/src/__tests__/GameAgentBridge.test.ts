import { describe, expect, it } from "vitest";
import { Game } from "../Game";
import { GameAgentBridge } from "../agent/GameAgentBridge";
import { TILE_TYPES, UNIT_TYPES } from "@llmcraft/shared";

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
      asciiMap: string;
      units: Array<Record<string, unknown>>;
      buildings: Array<Record<string, unknown>>;
      cells?: Array<Record<string, unknown>>;
    };

    expect(mapState.tick).toBe(0);
    expect(mapState.asciiMap.split("\n")).toHaveLength(21);
    expect(mapState.asciiMap).toContain("...w......#......W...");
    expect(mapState.asciiMap).toContain("..h.......#.......H..");
    expect(mapState.asciiMap).toContain("...w......#......W...");
    expect(mapState).not.toHaveProperty("legend");
    expect(mapState.cells).toBeUndefined();
    expect(mapState.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          x: 17,
          y: 9,
          id: "unit_3",
          type: "worker",
          hp: 50,
          maxHp: 50,
          state: "idle",
          relation: "self",
        }),
        expect.objectContaining({
          x: 3,
          y: 9,
          id: "unit_1",
          type: "worker",
          hp: 50,
          maxHp: 50,
          state: "idle",
          relation: "enemy",
        }),
      ])
    );
    expect(mapState.buildings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 18, y: 10, type: "hq", relation: "self" }),
        expect.objectContaining({ x: 2, y: 10, type: "hq", relation: "enemy" }),
      ])
    );
    expect(mapState.units[0]).not.toHaveProperty("my");
    expect(mapState.units[0]).not.toHaveProperty("playerId");
    expect(mapState.units[0]).not.toHaveProperty("carryingCredits");
    expect(mapState.units[0]).not.toHaveProperty("attackRange");
  });

  it("queues attack-move commands with unit-only target priority by default", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const soldier = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");

    const result = bridge.attackMoveUnit(soldier.id, { x: 18, y: 10 });

    expect(result.result).toMatchObject({ ok: true });
    expect(bridge.takeIssuedCommands()).toEqual([
      expect.objectContaining({
        type: "attack_move",
        unitId: soldier.id,
        position: { x: 18, y: 10 },
        targetPriority: ["soldier", "worker"],
      }),
    ]);
    game.stop();
  });

  it("queues high-level attack as movement until the target is in range", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const attacker = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 8, 5, "player_2");

    bridge.getMapState();
    const result = bridge.attackTarget(attacker.id, target.id);

    expect(result.result).toMatchObject({ ok: true, mode: "move_to_target" });
    expect(bridge.takeIssuedCommands()).toEqual([
      expect.objectContaining({
        type: "move",
        unitId: attacker.id,
        position: { x: 8, y: 5 },
      }),
    ]);

    attacker.x = 7;
    attacker.y = 5;
    expect(bridge.advancePlans()).toEqual([
      expect.objectContaining({
        type: "attack",
        unitId: attacker.id,
        targetId: target.id,
      }),
    ]);
    game.stop();
  });

  it("moves to a remembered target position when the attack target has died", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const attacker = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 5, 5, "player_1");
    const target = game.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, 8, 5, "player_2");

    bridge.getMapState();
    game.getUnitManager().removeUnit(target.id);

    const result = bridge.attackTarget(attacker.id, target.id);

    expect(result.result).toMatchObject({ ok: true, mode: "move_to_last_seen" });
    expect(bridge.takeIssuedCommands()).toEqual([
      expect.objectContaining({
        type: "move",
        unitId: attacker.id,
        position: { x: 8, y: 5 },
      }),
    ]);
    expect(bridge.advancePlans()).toEqual([]);
    game.stop();
  });

  it("returns detailed map cells only when requested", () => {
    const bridge = new GameAgentBridge(new Game(), "player_2");

    const result = bridge.getMapState({ includeCells: true });
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
            x: 17,
            y: 9,
            relation: "self",
          }),
        }),
      ])
    );
  });

  it("queues built-in harvest loops for workers", () => {
    const game = new Game();
    game.start();
    const bridge = new GameAgentBridge(game, "player_1");
    const worker = game.getState().players[0].units.find((unit) => unit.type === "worker")!;

    const result = bridge.startHarvestLoop(worker.id, { x: 2, y: 7 });

    expect(result.result).toMatchObject({ ok: true });
    expect(bridge.takeIssuedCommands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "harvest_loop",
          unitId: worker.id,
          position: { x: 2, y: 7 },
        }),
      ])
    );

    game.tickUpdate();
    game.stop();

    const updatedWorker = game.getState().players[0].units.find((unit) => unit.id === worker.id)!;
    expect(updatedWorker.intent).toMatchObject({
      type: "harvest_loop",
      targetX: 2,
      targetY: 7,
    });
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
