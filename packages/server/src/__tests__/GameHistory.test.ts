import { describe, expect, it } from "vitest";
import { BUILDING_TYPES, UNIT_STATES, UNIT_TYPES, type Building, type GameSnapshot, type Unit } from "@llmcraft/shared";
import { buildTickDelta } from "../GameHistory";

function tank(heading: number): Unit {
  return {
    id: "tank_1",
    type: UNIT_TYPES.LIGHT_TANK,
    x: 10,
    y: 10,
    hp: 240,
    maxHp: 240,
    state: UNIT_STATES.IDLE,
    playerId: "player_1",
    exists: true,
    attackRange: 4,
    carryingCredits: 0,
    carryCapacity: 0,
    heading,
  };
}

function snapshot(tick: number, units: Unit[], buildings: Building[] = []): GameSnapshot {
  return {
    tick,
    aiOutputs: {},
    state: {
      tick,
      winner: null,
      logs: [],
      tiles: [],
      players: [
        { id: "player_1", units, buildings, resources: { credits: 0 } },
        { id: "player_2", units: [], buildings: [], resources: { credits: 0 } },
      ],
    },
  };
}

describe("tick history", () => {
  it("records authoritative heading changes even when the unit does not translate", () => {
    const delta = buildTickDelta(snapshot(1, [tank(0)]), snapshot(2, [tank(Math.PI / 2)]));

    expect(delta.players[0].units).toEqual([
      expect.objectContaining({
        id: "tank_1",
        change: "updated",
        heading: Math.PI / 2,
      }),
    ]);
  });

  it("records rally-point updates for replay projection", () => {
    const barracks: Building = {
      id: "building_1",
      type: BUILDING_TYPES.BARRACKS,
      x: 30,
      y: 48,
      hp: 450,
      maxHp: 450,
      playerId: "player_1",
      exists: true,
      productionQueue: [],
    };
    const withRally = { ...barracks, rallyPoint: { x: 45, y: 48, mode: "move" as const } };

    const delta = buildTickDelta(snapshot(1, [], [barracks]), snapshot(2, [], [withRally]));

    expect(delta.players[0].buildings).toEqual([
      expect.objectContaining({
        id: barracks.id,
        change: "updated",
        rallyPoint: withRally.rallyPoint,
      }),
    ]);
  });
});
