import { describe, expect, it, vi } from "vitest";
import { BUILDING_TYPES, UNIT_TYPES, type CPUStrategyType, type PlayerId } from "@llmcraft/shared";
import { Game } from "../Game";
import { executeAgentTool } from "../agent/AgentTools";
import { GameplayController } from "../controller/GameplayController";
import { runBuiltinCPUStrategy } from "../benchmark/BuiltinCPUStrategy";

describe("BuiltinCPUStrategy", () => {
  it.each(["random", "rush"] as const)(
    "%s continues attacking remaining buildings after the enemy HQ is destroyed",
    async (strategy: CPUStrategyType) => {
      const combatUnitCount = 1;
      const combatUnits = Array.from({ length: combatUnitCount }, (_, index) => ({
        id: `soldier-${index + 1}`,
        type: UNIT_TYPES.SOLDIER,
        x: 100 + index,
        y: 48,
        attackRange: 1,
        state: "idle",
        relation: "self",
      }));
      const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
      const random = vi.spyOn(Math, "random").mockReturnValue(0.999);

      try {
        await runBuiltinCPUStrategy({
          strategy,
          runtime: {
            myState: {
              credits: 0,
              hq: { id: "my-hq", type: BUILDING_TYPES.HQ, x: 14, y: 48 },
              buildings: [{ id: "my-hq", type: BUILDING_TYPES.HQ, x: 14, y: 48 }],
            },
            myUnits: { units: combatUnits },
            mapState: {
              width: 144,
              height: 96,
              units: combatUnits,
              buildings: [
                { id: "enemy-refinery", type: BUILDING_TYPES.REFINERY, x: 99, y: 18, relation: "enemy" },
              ],
              resources: [],
            },
          },
          callTool: (toolName, args) => {
            calls.push({ toolName, args });
          },
        });
      } finally {
        random.mockRestore();
      }

      expect(calls).toContainEqual({
        toolName: "attack",
        args: { unitId: "soldier-1", targetId: "enemy-refinery" },
      });
    },
  );

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
