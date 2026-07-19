import { describe, expect, it } from "vitest";
import { BUILDING_TYPES, UNIT_TYPES, type Command } from "@llmcraft/shared";
import { Game } from "../Game";
import { hashAuthoritativeStateV2 } from "../AuthoritativeStateHash";

function runFixedScenario(): string[] {
  const game = new Game();
  const playerId = "player_1" as const;
  const workerId = game.getUnitManager().getUnitsByPlayer(playerId)[0]!.id;
  const hqId = game
    .getBuildingManager()
    .getBuildingsByPlayer(playerId)
    .find((building) => building.type === BUILDING_TYPES.HQ)!.id;
  const hashes: string[] = [];
  let commandSequence = 0;
  const queue = (command: Omit<Command, "id" | "playerId">): void => {
    game.queueCommand({
      id: `determinism_${++commandSequence}`,
      playerId,
      ...command,
    });
  };

  game.start();
  try {
    for (let tick = 0; tick < 40; tick++) {
      if (tick === 0) {
        queue({ type: "move", unitId: workerId, position: { x: 23, y: 45 } });
      }
      if (tick === 8) {
        queue({
          type: "build",
          unitId: workerId,
          buildingType: BUILDING_TYPES.BARRACKS,
          position: { x: 26, y: 48 },
        });
      }
      if (tick === 24) {
        const barracksId = game
          .getBuildingManager()
          .getBuildingsByPlayer(playerId)
          .find((building) => building.type === BUILDING_TYPES.BARRACKS)!.id;
        queue({ type: "spawn", buildingId: barracksId, unitType: UNIT_TYPES.RIFLEMAN });
      }
      if (tick === 32) {
        const riflemanId = game
          .getUnitManager()
          .getUnitsByPlayer(playerId)
          .find((unit) => unit.type === UNIT_TYPES.RIFLEMAN)!.id;
        queue({ type: "attack_move", unitId: riflemanId, position: { x: 40, y: 48 } });
      }

      game.tickUpdate();
      hashes.push(hashAuthoritativeStateV2(
        game.getState(),
        game.getDeterministicRngState(),
      ).hash);
    }
  } finally {
    game.stop();
  }

  expect(hqId).toBe("building_1");
  return hashes;
}

describe("Game deterministic baseline", () => {
  it("produces identical per-tick authoritative state hashes for fixed input", () => {
    const firstRun = runFixedScenario();
    const secondRun = runFixedScenario();

    expect(secondRun).toEqual(firstRun);
    expect(firstRun).toHaveLength(40);
    expect(firstRun.at(-1)).toBe("ae3e3e12e33bea6cfc5411cdf298f7ebffb07644952df0642f0c0ca4811fd30b");
  });
});
