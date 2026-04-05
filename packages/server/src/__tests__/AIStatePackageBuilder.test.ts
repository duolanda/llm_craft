import { describe, expect, it } from "vitest";
import { AIStatePackageBuilder } from "../AIStatePackageBuilder";
import { Game } from "../Game";

describe("AIStatePackageBuilder", () => {
  it("should include AI feedback for the requesting player", () => {
    const game = new Game();
    game.addAIFeedback("player_1", "execution", "error", "ReferenceError: foo is not defined");

    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game);

    expect(aiState.aiFeedbackSinceLastCall).toHaveLength(1);
    expect(aiState.aiFeedbackSinceLastCall[0].message).toContain("ReferenceError");
    expect(aiState.aiFeedbackSinceLastCall[0].phase).toBe("execution");
  });

  it("should not leak another player's AI feedback", () => {
    const game = new Game();
    game.addAIFeedback("player_2", "execution", "error", "player_2 failed");

    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game);

    expect(aiState.aiFeedbackSinceLastCall).toEqual([]);
  });

  it("should expose enemy units under enemies", () => {
    const game = new Game();

    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game);

    expect(Array.isArray(aiState.enemies)).toBe(true);
    expect(aiState.enemies.length).toBeGreaterThan(0);
    expect(aiState.enemies[0]).toHaveProperty("id");
    expect(aiState.enemies[0]).toHaveProperty("type");
  });
});
