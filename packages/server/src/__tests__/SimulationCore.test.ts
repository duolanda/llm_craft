import { describe, expect, it } from "vitest";
import { BUILDING_TYPES, UNIT_TYPES } from "@llmcraft/shared";
import { createDefaultMatchDefinition } from "../MatchDefinition";
import { SimulationCore, type SimulationSystems } from "../SimulationCore";
import { WorldState } from "../WorldState";

function createRecordingSystems(phases: string[]): SimulationSystems {
  return {
    movement: {
      step: () => {
        phases.push("movement");
        return [{
          type: "unit_destroyed",
          playerId: "player_2",
          unitId: "unit_crushed",
          unitType: UNIT_TYPES.WORKER,
        }];
      },
    },
    projectiles: { step: () => { phases.push("projectiles"); return []; } },
    economy: {
      step: () => {
        phases.push("economy");
        return [{
          type: "resource_gathered",
          playerId: "player_1",
          unitId: "unit_1",
          amount: 10,
          carryingCredits: 10,
        }];
      },
    },
    harvestOrders: { step: () => { phases.push("harvest_orders"); } },
    combat: { step: () => { phases.push("combat"); } },
    construction: {
      step: () => {
        phases.push("construction");
        return [{
          type: "building_completed",
          playerId: "player_1",
          buildingId: "building_1",
          buildingType: BUILDING_TYPES.BARRACKS,
          workerId: "unit_1",
        }];
      },
    },
    production: {
      step: () => {
        phases.push("production");
        return [{
          type: "unit_spawned",
          playerId: "player_1",
          buildingId: "building_1",
          unitId: "unit_2",
          unitType: UNIT_TYPES.SOLDIER,
        }];
      },
    },
    victory: { step: () => { phases.push("victory"); return null; } },
  };
}

describe("SimulationCore", () => {
  it("owns the stable synchronous rule-system order and returns structured outcomes", () => {
    const phases: string[] = [];
    const world = new WorldState(createDefaultMatchDefinition());
    world.tick = 7;

    const result = new SimulationCore(createRecordingSystems(phases)).step(world);

    expect(result).toEqual({
      advanced: true,
      tick: 7,
      matchEnded: false,
      events: [
        expect.objectContaining({ type: "unit_destroyed" }),
        expect.objectContaining({ type: "resource_gathered" }),
        expect.objectContaining({ type: "building_completed" }),
        expect.objectContaining({ type: "unit_spawned" }),
      ],
    });
    expect(phases).toEqual([
      "movement",
      "projectiles",
      "economy",
      "harvest_orders",
      "combat",
      "construction",
      "production",
      "victory",
    ]);
    expect(world.tick).toBe(7);
  });

  it("reports a deterministic victory outcome without owning lifecycle or clock state", () => {
    const phases: string[] = [];
    const systems = createRecordingSystems(phases);
    systems.victory = {
      step: () => ({
        type: "player_eliminated",
        winnerId: "player_1",
        loserId: "player_2",
      }),
    };
    const world = new WorldState(createDefaultMatchDefinition());

    expect(new SimulationCore(systems).step(world)).toMatchObject({
      advanced: true,
      tick: 0,
      matchEnded: true,
      events: [
        expect.objectContaining({ type: "unit_destroyed" }),
        expect.objectContaining({ type: "resource_gathered" }),
        expect.objectContaining({ type: "building_completed" }),
        expect.objectContaining({ type: "unit_spawned" }),
        {
          type: "player_eliminated",
          winnerId: "player_1",
          loserId: "player_2",
        },
      ],
    });
    expect(world.tick).toBe(0);
  });

  it("propagates a system failure and does not execute later phases", () => {
    const phases: string[] = [];
    const systems = createRecordingSystems(phases);
    systems.construction = {
      step: () => {
        phases.push("construction");
        throw new Error("construction failed");
      },
    };
    const world = new WorldState(createDefaultMatchDefinition());

    expect(() => new SimulationCore(systems).step(world)).toThrow("construction failed");
    expect(phases).toEqual([
      "movement",
      "projectiles",
      "economy",
      "harvest_orders",
      "combat",
      "construction",
    ]);
  });
});
