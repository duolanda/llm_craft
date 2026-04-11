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
      "if (aiFeedbackSinceLastCall.length > 0) { me.workers[0].holdPosition(); }",
      aiState
    );

    expect(result.errorMessage).toBeUndefined();
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe("hold");
  });

  it("should expose buildingStats and economy in the sandbox globals", async () => {
    const game = new Game();
    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game);
    const sandbox = new AISandbox("player_1");

    const result = await sandbox.executeCode(
      "if (buildingStats.barracks.cost === 120 && economy.workerGatherRate === 10) { me.workers[0].holdPosition(); }",
      aiState
    );

    expect(result.errorMessage).toBeUndefined();
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe("hold");
  });

  it("should expose enemies as enemy units only and keep buildings in enemyBuildings", async () => {
    const game = new Game();
    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game);
    const sandbox = new AISandbox("player_1");

    const result = await sandbox.executeCode(
      "if (enemies.every(e => e.type !== 'hq' && e.type !== 'barracks') && enemyBuildings.some(b => b.type === 'hq')) { me.workers[0].holdPosition(); }",
      aiState
    );

    expect(result.errorMessage).toBeUndefined();
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe("hold");
  });

  it("should return plain command payloads that can be recorded safely", async () => {
    const game = new Game();
    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game);
    const sandbox = new AISandbox("player_1");

    const result = await sandbox.executeCode(
      "me.workers[0].moveTo({ x: enemyBuildings[0].x, y: enemyBuildings[0].y });",
      aiState
    );

    expect(result.errorMessage).toBeUndefined();
    expect(result.commands).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(result.commands[0]))).toMatchObject({
      type: "move",
      position: { x: 18, y: 10 },
      playerId: "player_1",
    });
  });

  it("should expose attackInRange and keep priority payloads serializable", async () => {
    const game = new Game();
    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game);
    const sandbox = new AISandbox("player_1");

    const result = await sandbox.executeCode(
      "me.workers[0].attackInRange(['hq', 'worker']);",
      aiState
    );

    expect(result.errorMessage).toBeUndefined();
    expect(result.commands).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(result.commands[0]))).toMatchObject({
      type: "attack_in_range",
      targetPriority: ["hq", "worker"],
      playerId: "player_1",
    });
  });

  it("distinguishes parent watchdog timeouts from VM execution timeouts", async () => {
    const game = new Game();
    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game);
    const sandbox = new AISandbox("player_1");

    const vmTimeoutResult = await sandbox.executeCode("while (true) {}", aiState);

    expect(vmTimeoutResult.errorType).toBe("vm_timeout");
    expect(vmTimeoutResult.errorMessage).toContain("Sandbox vm timeout after 200ms");
  });
});
