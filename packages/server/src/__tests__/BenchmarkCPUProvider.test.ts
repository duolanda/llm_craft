import { describe, expect, it, vi } from "vitest";
import { AISandbox } from "../AISandbox";
import { AIStatePackageBuilder } from "../AIStatePackageBuilder";
import { Game } from "../Game";
import { createLLMProvider } from "../createLLMProvider";
import { buildCPUCode } from "../benchmark/cpuStrategies";

describe("BenchmarkCPUProvider", () => {
  it.each(["random", "rush"] as const)("generates executable sandbox code for %s strategy", async (strategy) => {
    const game = new Game();
    const aiState = AIStatePackageBuilder.build("player_2", game.getState(), game);
    const provider = createLLMProvider({
      providerType: "builtin-cpu",
      strategy,
    });
    const sandbox = new AISandbox("player_2");

    const generated = await provider.generateCode({
      mode: "full",
      tick: aiState.tick,
      tickIntervalMs: 500,
      summary: "benchmark cpu provider test",
      state: aiState,
      delta: null,
    });
    const execution = await sandbox.executeCode(generated.code, aiState);

    expect(generated.code.length).toBeGreaterThan(0);
    expect(execution.errorMessage).toBeUndefined();
    expect(execution.commands.length).toBeGreaterThan(0);
  });

  it("random strategy selects from bounded logical plans", () => {
    const game = new Game();
    const aiState = AIStatePackageBuilder.build("player_2", game.getState(), game);
    const code = buildCPUCode("random", {
      mode: "full",
      tick: aiState.tick,
      tickIntervalMs: 500,
      summary: "random plan test",
      state: aiState,
      delta: null,
    });

    expect(code).toContain("const enemyHQ");
    expect(
      code.includes("build('barracks'")
      || code.includes("spawnUnit('worker')")
      || code.includes("spawnUnit('soldier')")
      || code.includes("moveTo({ x: enemyHQ.x, y: enemyHQ.y })")
      || code.includes("resourceTiles")
    ).toBe(true);
  });

  it("random attack-hq branch falls back to spawning soldiers when barracks exist but soldiers do not", () => {
    const game = new Game();
    const aiState = AIStatePackageBuilder.build("player_2", game.getState(), game);
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const code = buildCPUCode("random", {
      mode: "full",
      tick: aiState.tick,
      tickIntervalMs: 500,
      summary: "random attack fallback test",
      state: {
        ...aiState,
        my: {
          ...aiState.my,
          units: [
            ...aiState.my.units.filter((unit) => unit.type === "worker"),
            ...aiState.my.units
              .filter((unit) => unit.type === "worker")
              .map((unit, index) => ({ ...unit, id: `${unit.id}-clone-${index}` })),
          ],
          buildings: [
            ...aiState.my.buildings,
            {
              id: "barracks-test",
              x: 4,
              y: 10,
              exists: true,
              type: "barracks",
              hp: 250,
              maxHp: 250,
              my: true,
              playerId: "player_2",
              productionQueue: [],
            },
          ],
          resources: {
            credits: aiState.unitStats.soldier.cost,
          },
        },
      },
      delta: null,
    });

    expect(code).toContain("if (me.soldiers.length === 0");
    expect(code).toContain("barracks.spawnUnit('soldier')");
  });

  it("rush strategy prioritizes threats around HQ before resuming push", () => {
    const game = new Game();
    const aiState = AIStatePackageBuilder.build("player_2", game.getState(), game);
    const code = buildCPUCode("rush", {
      mode: "full",
      tick: aiState.tick,
      tickIntervalMs: 500,
      summary: "rush pressure test",
      state: aiState,
      delta: null,
    });

    expect(code).toContain("pressuredEnemies");
  });
});
