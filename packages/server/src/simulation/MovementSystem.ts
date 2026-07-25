import { WorldState } from "../WorldState";

export class MovementSystem {
  step(world: WorldState): void {
    const blockedPositions = world.buildings.getOccupiedPositions();
    world.units.processAllPathMovement(world.tiles, blockedPositions);
    world.units.resolveUnitSeparation(world.tiles, blockedPositions);
  }
}
