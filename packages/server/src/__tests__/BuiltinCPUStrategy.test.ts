import { describe, expect, it } from "vitest";
import { BUILDING_TYPES, type PlayerId } from "@llmcraft/shared";
import { Game } from "../Game";
import { executeAgentTool } from "../agent/AgentTools";
import { GameplayController } from "../controller/GameplayController";
import { runBuiltinCPUStrategy } from "../benchmark/BuiltinCPUStrategy";

describe("BuiltinCPUStrategy", () => {
  it.each(["player_1", "player_2"] as const)(
    "moves a %s builder into range before establishing a barracks",
    async (playerId: PlayerId) => {
      const game = new Game();
      const gameplayController = new GameplayController(game, playerId);
      let observedBuilderMove = false;

      game.start();
      try {
        for (let tick = 0; tick < 80; tick++) {
          if (tick % 5 === 0) {
            const toolNames: string[] = [];
            await runBuiltinCPUStrategy({
              strategy: "rush",
              runtime: {
                myState: gameplayController.getMyState().result,
                myUnits: gameplayController.getMyUnits().result,
                mapState: gameplayController.getMapState({ includeCells: false }).result,
              },
              callTool: (toolName, args) => {
                toolNames.push(toolName);
                return executeAgentTool(gameplayController, toolName, args).result;
              },
            });
            observedBuilderMove ||= toolNames.includes("move_unit");
          }
          game.tickUpdate();
        }
      } finally {
        game.stop();
      }

      const barracks = game
        .getBuildingManager()
        .getBuildingsByPlayer(playerId)
        .find((building) => building.type === BUILDING_TYPES.BARRACKS);

      expect(observedBuilderMove).toBe(true);
      expect(barracks).toBeDefined();
      expect(barracks?.constructionProgress).toBeUndefined();
    },
  );
});
