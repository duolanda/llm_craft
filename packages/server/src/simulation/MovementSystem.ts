import { WorldState } from "../WorldState";

export class MovementSystem {
  step(world: WorldState): void {
    const blockedPositions = world.buildings.getOccupiedPositions();
    for (const unit of world.units.getAllUnits()) {
      world.units.processPathMovement(unit, world.tiles, blockedPositions);
    }
    world.units.resolveUnitSeparation(world.tiles, blockedPositions);
  }
}
