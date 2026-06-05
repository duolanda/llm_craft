import { describe, expect, it } from "vitest";
import { DEFAULT_MAP_LAYOUT, MAP_WIDTH } from "@llmcraft/shared";
import { createLLMProvider } from "../createLLMProvider";

describe("BenchmarkCPUProvider", () => {
  it.each(["random", "rush"] as const)("emits tool-driven decisions for %s strategy", async (strategy) => {
    const provider = createLLMProvider({
      providerType: "builtin-cpu",
      strategy,
    });

    const result = await provider.runAgent(
      {
        playerId: "player_2",
        tick: 0,
        tickIntervalMs: 500,
        summary: "benchmark cpu provider test",
      },
      {
        tools: [],
        executeTool: async () => ({ effect: "action" as const, result: { ok: true } }),
        getRuntimeState: () => ({
          myState: {
            credits: 400,
            hq: { id: "hq-1", ...DEFAULT_MAP_LAYOUT.player2Hq },
            buildings: [],
          },
          myUnits: [
            {
              id: "worker-1",
              type: "worker",
              ...DEFAULT_MAP_LAYOUT.player2Workers[0],
              carryingCredits: 0,
              carryCapacity: 10,
              state: "idle",
            },
          ],
          mapState: {
            width: MAP_WIDTH,
            units: [],
            buildings: [{ id: "enemy-hq", ...DEFAULT_MAP_LAYOUT.player1Hq, hp: 1000, maxHp: 1000, relation: "enemy", type: "hq" }],
          },
          activePlans: null,
          recentEvents: null,
        }),
      }
    );

    expect(result.metrics.modelRequests).toBe(1);
    expect(result.toolCalls.length).toBeGreaterThan(0);
  });

  it("uses Phase 2 combat roles in rush strategy", async () => {
    const provider = createLLMProvider({
      providerType: "builtin-cpu",
      strategy: "rush",
    });

    const result = await provider.runAgent(
      {
        playerId: "player_2",
        tick: 20,
        tickIntervalMs: 500,
        summary: "phase 2 cpu provider test",
      },
      {
        tools: [],
        executeTool: async () => ({ effect: "action" as const, result: { ok: true } }),
        getRuntimeState: () => ({
          myState: {
            credits: 400,
            hq: { id: "hq-1", ...DEFAULT_MAP_LAYOUT.player2Hq },
            buildings: [
              { id: "barracks-1", type: "barracks", x: DEFAULT_MAP_LAYOUT.player2Hq.x - 2, y: DEFAULT_MAP_LAYOUT.player2Hq.y, productionQueue: [] },
              { id: "war-factory-1", type: "war_factory", x: DEFAULT_MAP_LAYOUT.player2Hq.x - 2, y: DEFAULT_MAP_LAYOUT.player2Hq.y - 2, productionQueue: [] },
            ],
          },
          myUnits: [
            { id: "worker-1", type: "worker", ...DEFAULT_MAP_LAYOUT.player2Workers[0], carryingCredits: 0, carryCapacity: 10, state: "idle" },
            { id: "rifleman-1", type: "rifleman", x: DEFAULT_MAP_LAYOUT.player2Hq.x - 4, y: DEFAULT_MAP_LAYOUT.player2Hq.y, attackRange: 2, state: "idle" },
            { id: "rocket-1", type: "rocket_soldier", x: DEFAULT_MAP_LAYOUT.player2Hq.x - 4, y: DEFAULT_MAP_LAYOUT.player2Hq.y - 1, attackRange: 3, state: "idle" },
            { id: "tank-1", type: "light_tank", x: DEFAULT_MAP_LAYOUT.player2Hq.x - 3, y: DEFAULT_MAP_LAYOUT.player2Hq.y - 2, attackRange: 2, state: "idle" },
          ],
          mapState: {
            width: MAP_WIDTH,
            units: [{ id: "enemy-tank", type: "light_tank", x: DEFAULT_MAP_LAYOUT.player2Hq.x - 6, y: DEFAULT_MAP_LAYOUT.player2Hq.y, relation: "enemy", attackRange: 2 }],
            buildings: [{ id: "enemy-hq", ...DEFAULT_MAP_LAYOUT.player1Hq, hp: 1000, maxHp: 1000, relation: "enemy", type: "hq" }],
          },
          activePlans: null,
          recentEvents: null,
        }),
      }
    );

    expect(result.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "spawn_unit",
          args: expect.objectContaining({ buildingId: "barracks-1", unitType: "rocket_soldier" }),
        }),
        expect.objectContaining({
          toolName: "spawn_unit",
          args: expect.objectContaining({ buildingId: "war-factory-1", unitType: "light_tank" }),
        }),
        expect.objectContaining({
          toolName: "attack",
          args: expect.objectContaining({ unitId: "rocket-1", targetId: "enemy-tank" }),
        }),
        expect.objectContaining({
          toolName: "attack",
          args: expect.objectContaining({ unitId: "tank-1", targetId: "enemy-hq" }),
        }),
      ])
    );
  });
});
