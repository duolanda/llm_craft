import { describe, expect, it } from "vitest";
import { AIStatePackageBuilder } from "../AIStatePackageBuilder";
import { Game } from "../Game";

describe("AIStatePackageBuilder", () => {
  it("should include AI feedback for the requesting player", () => {
    const game = new Game();
    game.addAIFeedback("player_1", "execution", "error", "ReferenceError: foo is not defined", {
      code: "execution_error",
      meta: { hint: "Check variable names." },
    });

    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game);

    expect(aiState.aiFeedbackSinceLastCall).toHaveLength(1);
    expect(aiState.aiFeedbackSinceLastCall[0].message).toContain("ReferenceError");
    expect(aiState.aiFeedbackSinceLastCall[0].phase).toBe("execution");
    expect(aiState.aiFeedbackSinceLastCall[0].code).toBe("execution_error");
    expect(aiState.aiFeedbackSinceLastCall[0].meta?.hint).toBe("Check variable names.");
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

  it("builds a delta prompt payload after the first full payload", () => {
    const game = new Game();
    const fullState = AIStatePackageBuilder.build("player_1", game.getState(), game);
    const fullPayload = AIStatePackageBuilder.buildPromptPayload(fullState, null, true);

    game.queueCommand({
      id: "build_barracks",
      type: "build",
      unitId: game.getState().players[0].units[0].id,
      buildingType: "barracks",
      position: { x: 4, y: 10 },
      playerId: "player_1",
    });
    game.processCommands();

    const nextState = AIStatePackageBuilder.build("player_1", game.getState(), game);
    const deltaPayload = AIStatePackageBuilder.buildPromptPayload(nextState, fullState, false);

    expect(fullPayload.mode).toBe("full");
    expect(deltaPayload.mode).toBe("delta");
    expect(deltaPayload.delta?.creditsChanged).toBe(-120);
    expect(deltaPayload.delta?.myBuildingChanges.some((change) => change.change === "created")).toBe(true);
  });

  it("includes economy rules, building stats and worker cargo state", () => {
    const game = new Game();
    const worker = game.getState().players[0].units[0];
    const runtimeWorker = game.getUnitManager().getUnit(worker.id)!;
    runtimeWorker.carryingCredits = 30;

    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game);

    expect(aiState.buildingStats.barracks.cost).toBe(120);
    expect(aiState.economy.workerGatherRate).toBe(10);
    expect(aiState.my.units[0]).toHaveProperty("carryingCredits", 30);
    expect(aiState.my.units[0]).toHaveProperty("carryCapacity", 100);
  });

  it("filters events and feedback by the last successful AI tick", () => {
    const game = new Game();
    game.start();
    const baselineTick = game.getTick();

    game.addAIFeedback("player_1", "execution", "warning", "old warning");
    game.tickUpdate();
    game.addAIFeedback("player_1", "execution", "error", "new error");

    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game, baselineTick);

    expect(aiState.eventsSinceLastCall.every((log) => log.tick > baselineTick)).toBe(true);
    expect(aiState.aiFeedbackSinceLastCall).toHaveLength(1);
    expect(aiState.aiFeedbackSinceLastCall[0].message).toContain("new error");
    game.stop();
  });

  it("adds an HQ-under-attack alert to full payloads when the HQ is already damaged", () => {
    const game = new Game();
    const hq = game.getBuildingManager().getBuildingsByPlayer("player_1").find((building) => building.type === "hq")!;
    game.getBuildingManager().takeDamage(hq, 100);

    const aiState = AIStatePackageBuilder.build("player_1", game.getState(), game);
    const payload = AIStatePackageBuilder.buildPromptPayload(aiState, null, true);

    expect(payload.summary).toContain("Alert: our HQ is under attack.");
  });

  it("adds an HQ-under-attack alert to delta payloads when the HQ loses hp", () => {
    const game = new Game();
    const previous = AIStatePackageBuilder.build("player_1", game.getState(), game);
    const hq = game.getBuildingManager().getBuildingsByPlayer("player_1").find((building) => building.type === "hq")!;
    game.getBuildingManager().takeDamage(hq, 100);

    const current = AIStatePackageBuilder.build("player_1", game.getState(), game);
    const payload = AIStatePackageBuilder.buildPromptPayload(current, previous, false);

    expect(payload.summary).toContain("Alert: our HQ is under attack.");
  });
});
