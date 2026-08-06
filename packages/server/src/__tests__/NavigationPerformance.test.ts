import { performance } from "node:perf_hooks";
import {
  BUILDING_TYPES,
  RESULT_TYPES,
  type Command,
  UNIT_TYPES,
} from "@llmcraft/shared";
import { describe, expect, it } from "vitest";
import { Game } from "../Game";
import { PathFinder, type NavigationField } from "../PathFinder";

describe("navigation performance", () => {
  it("keeps equally near goal candidates reachable across disconnected islands", () => {
    const navigation: NavigationField = {
      width: 5,
      height: 1,
      passable: Uint8Array.from([1, 1, 0, 1, 1]),
      domains: Int32Array.from([0, 0, -1, 1, 1]),
      domainCount: 2,
    };

    const integration = PathFinder.buildIntegrationField(navigation, 2, 0, 1);

    expect(integration?.projectedGoalCount).toBe(2);
    expect(PathFinder.getStartIntegrationDistance(integration!, 0, 0)).toBeGreaterThanOrEqual(0);
    expect(PathFinder.getStartIntegrationDistance(integration!, 4, 0)).toBeGreaterThanOrEqual(0);
  });

  it("keeps a trapped-tank attack-move batch inside one simulation tick budget", () => {
    const game = new Game();
    const buildings = game.getBuildingManager();
    const units = game.getUnitManager();

    // Reproduces the player_2 production corridor from
    // match-2026-08-06T14-55-08-134Z-9e6493f9.match.json. The two tanks at
    // x=109 cannot clear the inflated static footprints on either side.
    buildings.createBuilding(BUILDING_TYPES.BARRACKS, 120, 48, "player_2");
    buildings.createBuilding(BUILDING_TYPES.WAR_FACTORY, 114, 48, "player_2");
    buildings.createBuilding(BUILDING_TYPES.BARRACKS, 106, 48, "player_2");
    const trappedTanks = [
      units.createUnit(UNIT_TYPES.LIGHT_TANK, 109, 46, "player_2"),
      units.createUnit(UNIT_TYPES.LIGHT_TANK, 109, 48, "player_2"),
    ];
    const mobileUnits = Array.from({ length: 20 }, (_, index) => (
      units.createUnit(
        UNIT_TYPES.SOLDIER,
        78 + (index % 5) * 2,
        34 + Math.floor(index / 5) * 4,
        "player_2",
      )
    ));
    const commands: Command[] = [...mobileUnits, ...trappedTanks].map((unit, index) => ({
      id: `record-regression-attack-move-${index}`,
      type: "attack_move",
      playerId: "player_2",
      unitId: unit.id,
      position: { x: 50, y: 48 },
    }));

    game.start();
    const startedAt = performance.now();
    const result = game.advanceSimulationTick([{ actorId: "player_2", commands }]);
    const elapsedMs = performance.now() - startedAt;

    expect(result).not.toBeNull();
    const outcomes = result!.commandOutcomes;
    expect(outcomes).toHaveLength(commands.length);
    expect(outcomes.filter((outcome) => outcome.resultType === RESULT_TYPES.MOVE_BLOCKED)).toHaveLength(2);
    expect(trappedTanks.every((tank) => tank.pathTarget === undefined)).toBe(true);
    expect(mobileUnits.some((unit) => unit.pathTarget !== undefined)).toBe(true);
    expect(elapsedMs).toBeLessThan(500);

    const firstSearchStats = units.getNavigationCacheStats();
    expect(firstSearchStats).toEqual({
      navigationFieldBuilds: 2,
      integrationFieldBuilds: 2,
      integrationFieldEntries: 2,
    });

    const repeatedCommands = commands.map((command, index) => ({
      ...command,
      id: `record-regression-repeat-${index}`,
    }));
    const repeatedStartedAt = performance.now();
    const repeated = game.advanceSimulationTick([{ actorId: "player_2", commands: repeatedCommands }]);
    const repeatedElapsedMs = performance.now() - repeatedStartedAt;
    expect(repeated?.commandOutcomes.filter(
      (outcome) => outcome.resultType === RESULT_TYPES.MOVE_BLOCKED,
    )).toHaveLength(2);
    expect(units.getNavigationCacheStats()).toEqual(firstSearchStats);
    expect(repeatedElapsedMs).toBeLessThan(500);

    buildings.createBuilding(BUILDING_TYPES.BARRACKS, 90, 70, "player_2");
    const afterTopologyChange = game.advanceSimulationTick([{
      actorId: "player_2",
      commands: [{
        ...repeatedCommands[0]!,
        id: "record-regression-after-topology-change",
      }],
    }]);
    expect(afterTopologyChange).not.toBeNull();
    expect(units.getNavigationCacheStats()).toEqual({
      navigationFieldBuilds: firstSearchStats.navigationFieldBuilds + 1,
      integrationFieldBuilds: firstSearchStats.integrationFieldBuilds + 1,
      integrationFieldEntries: 1,
    });
  }, 10_000);

  it("bounds cached integration fields during a long match", () => {
    const game = new Game();
    const units = game.getUnitManager();
    const soldier = units.createUnit(UNIT_TYPES.SOLDIER, 72, 48, "player_1");
    const commands: Command[] = Array.from({ length: 70 }, (_, index) => ({
      id: `bounded-navigation-cache-${index}`,
      type: "move",
      playerId: "player_1",
      unitId: soldier.id,
      position: {
        x: 20 + (index % 35),
        y: 20 + Math.floor(index / 35) * 20,
      },
    }));

    game.start();
    const result = game.advanceSimulationTick([{ actorId: "player_1", commands }]);

    expect(result?.commandOutcomes).toHaveLength(commands.length);
    expect(units.getNavigationCacheStats()).toEqual({
      navigationFieldBuilds: 1,
      integrationFieldBuilds: 70,
      integrationFieldEntries: 64,
    });
  }, 10_000);
});
