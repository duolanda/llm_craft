import { describe, expect, it } from "vitest";
import { Game } from "../Game";
import { GameAgentBridge } from "../agent/GameAgentBridge";
import { BuiltinTestController } from "../controller/BuiltinTestController";
import { createAgentSession, createLLMProvider } from "../createLLMProvider";

describe("BuiltinTestController", () => {
  it("is a deterministic Controller and emits auditable test commands", async () => {
    const game = new Game();
    game.start();
    const controller = new BuiltinTestController(
      "player_1",
      { providerType: "builtin-cpu", strategy: "rush" },
      new GameAgentBridge(game, "player_1"),
    );

    const result = await controller.run(
      { playerId: "player_1", tick: 0, tickIntervalMs: 500, summary: "test" },
      { traceContext: { turnId: "turn-1", controllerId: "test:player_1" } },
    );

    expect(controller.getDescriptor().kind).toBe("test");
    expect(result.metrics.modelRequests).toBe(0);
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.commands.every((command) => command.provenance?.controllerId === "test:player_1")).toBe(true);
  });

  it("cannot be constructed through model provider/session factories", () => {
    const config = { providerType: "builtin-cpu", strategy: "rush" } as const;
    expect(() => createAgentSession(config)).toThrow(/not an AgentSession/);
    expect(() => createLLMProvider(config)).toThrow(/not an LLM provider/);
  });
});
