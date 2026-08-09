import type { PlayerId, UnitType } from "@llmcraft/shared";
import { WorldState } from "../WorldState";
import { canCrushUnit } from "../navigation/MovementProfile";

export type MovementEvent = {
  type: "unit_destroyed";
  playerId: PlayerId;
  unitId: string;
  unitType: UnitType;
};

export class MovementSystem {
  step(world: WorldState): MovementEvent[] {
    const events: MovementEvent[] = [];
    const blockedPositions = world.buildings.getOccupiedPositions();
    world.units.processAllPathMovement(world.tiles, blockedPositions, {
      canPassThrough: (mover, other) =>
        mover.playerId !== other.playerId && canCrushUnit(mover.type, other.type),
      onPassThrough: (_mover, other) => {
        if (!world.destroyEntity(other.id)) return;
        events.push({
          type: "unit_destroyed",
          playerId: other.playerId,
          unitId: other.id,
          unitType: other.type,
        });
      },
    });
    world.units.resolveUnitSeparation(world.tiles, blockedPositions);
    return events;
  }
}
