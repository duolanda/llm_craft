import { describe, expect, it } from "vitest";
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
            credits: 200,
            hq: { id: "hq-1", x: 18, y: 10 },
            buildings: [],
          },
          myUnits: [
            { id: "worker-1", type: "worker", x: 17, y: 9, carryingCredits: 0, carryCapacity: 10, state: "idle" },
          ],
          mapState: {
            width: 21,
            units: [],
            buildings: [{ id: "enemy-hq", x: 2, y: 10, hp: 1000, maxHp: 1000, relation: "enemy", type: "hq" }],
          },
          activePlans: null,
          recentEvents: null,
        }),
      }
    );

    expect(result.metrics.modelRequests).toBe(1);
    expect(result.toolCalls.length).toBeGreaterThan(0);
  });
});
