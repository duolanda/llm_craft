import { describe, expect, it } from "vitest";
import { TILE_TYPES, UNIT_TYPES } from "@llmcraft/shared";
import { createDefaultMatchDefinition } from "../MatchDefinition";
import { WorldState } from "../WorldState";

describe("WorldState", () => {
  it("keeps entity registries authoritative and composes Player projections", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const oldProjection = world.players[0];
    const created = world.createUnit(UNIT_TYPES.SOLDIER, 30, 48, "player_1");

    expect(oldProjection.units.some((unit) => unit.id === created.id)).toBe(false);
    expect(world.players[0].units.some((unit) => unit.id === created.id)).toBe(true);

    oldProjection.units.length = 0;
    expect(world.units.getUnitsByPlayer("player_1")).toHaveLength(5);
  });

  it("updates authoritative resource state and its tile projection together", () => {
    const definition = createDefaultMatchDefinition();
    const world = new WorldState(definition);
    const resource = definition.map.resources[0];

    world.setResourceRemaining(resource.x, resource.y, 0);

    expect(world.resourceRemaining.get(`${resource.x},${resource.y}`)).toBe(0);
    expect(world.tiles[resource.y][resource.x]).toBe(TILE_TYPES.EMPTY);
    expect(world.tileView[resource.y][resource.x]).toMatchObject({
      type: TILE_TYPES.EMPTY,
      x: resource.x,
      y: resource.y,
    });
  });

  it("resolves cross-type entity identity and rejects duplicate IDs", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const projectedUnit = world.players[0].units[0];
    const projectedBuilding = world.players[0].buildings[0];
    const unit = world.units.getUnit(projectedUnit.id)!;
    const building = world.buildings.getBuilding(projectedBuilding.id)!;

    expect(world.entities.resolve(unit.id)).toEqual({ kind: "unit", entity: unit });
    expect(world.entities.resolve(building.id)).toEqual({ kind: "building", entity: building });

    unit.exists = false;
    expect(world.entities.resolve(unit.id)).toBeUndefined();
    expect(world.entities.resolve(unit.id, { includeDestroyed: true })).toEqual({ kind: "unit", entity: unit });

    unit.id = building.id;
    expect(() => world.assertInvariants()).toThrow(/Duplicate or empty entity id/);
  });

  it("uses one destroyed-entity lifecycle across units and buildings", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const unit = world.createUnit(UNIT_TYPES.SOLDIER, 30, 48, "player_1");

    expect(world.destroyEntity(unit.id)).toBe(true);
    expect(world.entities.resolve(unit.id)).toBeUndefined();
    expect(world.entities.resolve(unit.id, { includeDestroyed: true })?.entity).toMatchObject({
      exists: false,
      hp: 0,
    });
    expect(world.destroyEntity(unit.id)).toBe(false);
  });

  it("owns a seeded random stream that can be transactionally restored", () => {
    const definition = createDefaultMatchDefinition();
    definition.seed = 1234;
    const world = new WorldState(definition);
    const checkpoint = world.rng.createCheckpoint();
    const expected = [world.rng.nextUint32(), world.rng.nextUint32()];

    world.rng.nextUint32();
    world.rng.restoreCheckpoint(checkpoint);

    expect([world.rng.nextUint32(), world.rng.nextUint32()]).toEqual(expected);
  });

  it("rejects unknown ownership before mutating an entity store", () => {
    const world = new WorldState(createDefaultMatchDefinition());
    const before = Array.from(world.units.iterateStoredUnits()).length;

    expect(() => world.createUnit(UNIT_TYPES.SOLDIER, 30, 48, "unknown" as "player_1")).toThrow(
      /unknown player/,
    );
    expect(Array.from(world.units.iterateStoredUnits())).toHaveLength(before);
  });
});
