import { describe, expect, it } from "vitest";
import { createLiveStateProjectionDelta, createLiveStateSnapshot } from "@llmcraft/record";
import type { GameState } from "@llmcraft/shared";

function createState(tick: number, x: number, logs = 0): GameState {
  return {
    tick,
    players: [{
      id: "player_1",
      resources: { credits: 500 },
      units: [{
        id: "unit_1",
        type: "worker",
        x,
        y: 4,
        hp: 50,
        maxHp: 50,
        state: "moving",
        playerId: "player_1",
        exists: true,
        attackRange: 0,
        carryingCredits: 20,
        carryCapacity: 100,
        path: Array.from({ length: 400 }, (_, index) => ({ x: index, y: 4 })),
        pathTarget: { x: 400, y: 4 },
        nextAttackTick: tick + 10,
      }],
      buildings: [{
        id: "building_1",
        type: "machine_gun_turret",
        x: 2,
        y: 2,
        hp: 380,
        maxHp: 380,
        playerId: "player_1",
        exists: true,
        heading: Math.PI / 4,
        rallyPoint: { x: 10, y: 10, mode: "move" },
        productionQueue: [{ orderId: "order_1", unitType: "worker", count: 1, remainingCount: 1 }],
      }],
    }],
    tiles: Array.from({ length: 32 }, (_, y) => Array.from({ length: 32 }, (_, x) => ({
      x,
      y,
      type: "empty" as const,
    }))),
    winner: null,
    logs: Array.from({ length: logs }, (_, index) => ({
      tick: index,
      type: "game_started" as const,
      message: `log-${index}`,
      data: undefined,
      meta: {
        level: "info" as const,
        owner: "system_0" as const,
        feedbackTarget: "none" as const,
        displayTarget: "frontend" as const,
      },
    })),
  };
}

describe("live state projection", () => {
  it("omits historical, static, and server-only fields", () => {
    const snapshot = createLiveStateSnapshot(createState(1, 3, 500));
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("logs");
    expect(serialized).not.toContain("tiles");
    expect(serialized).not.toContain("path");
    expect(serialized).not.toContain("productionQueue");
    expect(serialized).not.toContain("rallyPoint");
    expect(snapshot.players[0]?.buildings[0]?.heading).toBe(Math.PI / 4);
    expect(serialized.length).toBeLessThan(2_000);
  });

  it("keeps delta size tied to changes rather than match history", () => {
    const previous = createLiveStateSnapshot(createState(1, 3, 0));
    const current = createLiveStateSnapshot(createState(2, 4, 5_000));
    const delta = createLiveStateProjectionDelta(previous, current);

    expect(delta.players[0]?.unitUpserts).toHaveLength(1);
    expect(JSON.stringify(delta)).not.toContain("logs");
    expect(JSON.stringify(delta)).not.toContain("tiles");
    expect(JSON.stringify(delta).length).toBeLessThan(2_000);
  });

  it("emits a building upsert when only its turret heading changes", () => {
    const previousState = createState(1, 3, 0);
    const currentState = createState(2, 3, 0);
    currentState.players[0]!.buildings[0]!.heading = Math.PI / 2;

    const delta = createLiveStateProjectionDelta(
      createLiveStateSnapshot(previousState),
      createLiveStateSnapshot(currentState),
    );

    expect(delta.players[0]?.buildingUpserts).toEqual([
      expect.objectContaining({ id: "building_1", heading: Math.PI / 2 }),
    ]);
  });
});
