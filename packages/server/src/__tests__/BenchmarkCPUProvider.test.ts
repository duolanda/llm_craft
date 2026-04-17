import { afterEach, describe, expect, it, vi } from "vitest";
import { AISandbox } from "../AISandbox";
import { AIStatePackageBuilder } from "../AIStatePackageBuilder";
import { Game } from "../Game";
import { createLLMProvider } from "../createLLMProvider";
import { buildCPUCode } from "../benchmark/cpuStrategies";

describe("BenchmarkCPUProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
      || code.includes("// plan: attack")
      || code.includes("moveTo({ x: enemyHQ.x, y: enemyHQ.y })")
      || code.includes("resourceTiles")
    ).toBe(true);
  });

  it("random mine branch keeps attack out of the generated script", () => {
    const game = new Game();
    const aiState = AIStatePackageBuilder.build("player_2", game.getState(), game);
    vi.spyOn(Math, "random").mockReturnValue(0);

    const code = buildCPUCode("random", {
      mode: "full",
      tick: aiState.tick,
      tickIntervalMs: 500,
      summary: "random mine plan test",
      state: {
        ...aiState,
        my: {
          ...aiState.my,
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
        },
      },
      delta: null,
    });

    expect(code).toContain("// plan: mine");
    expect(code).not.toContain("attackInRange(");
  });

  it("random attack branch falls back to spawning soldiers when barracks exist but soldiers do not", () => {
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

    expect(code).toContain("// plan: attack");
    expect(code).toContain("// attack-roll: hit");
    expect(code).toContain("if (me.soldiers.length === 0");
    expect(code).toContain("barracks.spawnUnit('soldier')");
  });

  it("random attack branch surfaces a missed attack roll in the header", () => {
    const game = new Game();
    const aiState = AIStatePackageBuilder.build("player_2", game.getState(), game);
    const randomSpy = vi.spyOn(Math, "random");
    randomSpy.mockReturnValueOnce(0.99);
    randomSpy.mockReturnValueOnce(0.5);

    const code = buildCPUCode("random", {
      mode: "full",
      tick: aiState.tick,
      tickIntervalMs: 500,
      summary: "random attack miss test",
      state: {
        ...aiState,
        my: {
          ...aiState.my,
          units: [
            ...aiState.my.units,
            {
              id: "soldier-test",
              x: 6,
              y: 10,
              exists: true,
              type: "soldier",
              hp: 100,
              maxHp: 100,
              state: "idle",
              my: true,
              playerId: "player_2",
              attackRange: 1,
              carryingCredits: 0,
              carryCapacity: 0,
            },
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
        },
      },
      delta: null,
    });

    expect(code).toContain("// plan: attack");
    expect(code).toContain("// attack-roll: miss");
    expect(code).not.toContain("attackInRange(['hq', 'soldier', 'worker', 'barracks'])");
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
