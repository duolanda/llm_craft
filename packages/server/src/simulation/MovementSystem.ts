import { WorldState } from "../WorldState";

const MAX_BLOCKED_REPATHS_PER_TICK = 4;

export class MovementSystem {
  step(world: WorldState): void {
    const blockedPositions = world.buildings.getOccupiedPositions();
    const repathBudget = { remaining: MAX_BLOCKED_REPATHS_PER_TICK };
    for (const unit of world.units.getAllUnits()) {
      world.units.processPathMovement(unit, world.tiles, blockedPositions, repathBudget);
    }
    world.units.resolveUnitSeparation(world.tiles, blockedPositions);
  }
}
