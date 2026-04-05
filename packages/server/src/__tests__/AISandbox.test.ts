import { describe, expect, it } from "vitest";
import { AISandbox } from "../AISandbox";
import { AIStatePackageBuilder } from "../AIStatePackageBuilder";
import { Game } from "../Game";

describe("AISandbox", () => {
  it("should swallow sandbox runtime errors and return no commands", async () => {
    const game = new Game();
    const state = game.getState();
    const aiState = AIStatePackageBuilder.build("player_1", state);
    const sandbox = new AISandbox("player_1");

    const result = await sandbox.executeCode("throw new Error('boom')", aiState);

    expect(result.commands).toEqual([]);
    expect(result.errorMessage).toContain("boom");
  });

  it("should expose aiFeedbackSinceLastCall in the sandbox globals", async () => {
    const game = new Game();
    game.addAIFeedback("player_1", "execution", "error", "last round failed");
    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game);
    const sandbox = new AISandbox("player_1");

    const result = await sandbox.executeCode(
      "if (aiFeedbackSinceLastCall.length > 0) { me.soldiers[0].holdPosition(); }",
      aiState
    );

    expect(result.errorMessage).toBeUndefined();
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe("hold");
  });
});
