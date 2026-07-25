import { describe, expect, it } from "vitest";
import { Game } from "../Game";
import { GameplayController } from "../controller/GameplayController";
import { BuiltinCPUController } from "../controller/BuiltinCPUController";
import { createAgentSession, createLLMProvider } from "../createLLMProvider";

describe("BuiltinCPUController", () => {
  it("emits auditable built-in CPU commands through the DecisionController boundary", async () => {
    const game = new Game();
    game.start();
    const controller = new BuiltinCPUController(
      "player_1",
      { providerType: "builtin-cpu", strategy: "rush" },
      new GameplayController(game, "player_1"),
    );

    const result = await controller.run(
      { playerId: "player_1", tick: 0, tickIntervalMs: 500, summary: "test" },
      { runContext: { turnId: "turn-1", controllerId: "cpu:player_1" } },
    );

    expect(controller.getDescriptor().kind).toBe("cpu");
    expect(result.metrics.modelRequests).toBe(0);
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.commands.every((command) => command.provenance?.controllerId === "cpu:player_1")).toBe(true);
  });

  it("cannot be constructed through model provider/session factories", () => {
    const config = { providerType: "builtin-cpu", strategy: "rush" } as const;
    expect(() => createAgentSession(config)).toThrow(/not an AgentSession/);
    expect(() => createLLMProvider(config)).toThrow(/not an LLM provider/);
  });
});
