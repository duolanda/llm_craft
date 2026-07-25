import {
  MAP_HEIGHT,
  MAP_WIDTH,
  TILE_TYPES,
  getBuildingFootprint,
  type Building,
  type PlayerId,
  type UnitType,
} from "@llmcraft/shared";
import { WorldState } from "../WorldState";

export type ProductionEvent =
  | {
      type: "unit_spawned";
      playerId: PlayerId;
      buildingId: string;
      unitId: string;
      unitType: UnitType;
    }
  | {
      type: "unit_spawn_failed";
      playerId: PlayerId;
      buildingId: string;
      unitType: UnitType;
      reason: "no_empty_position";
    };

export class ProductionSystem {
  step(world: WorldState): ProductionEvent[] {
    const events: ProductionEvent[] = [];
    const completedUnits = world.buildings.processProductionQueues();
    for (const [playerId, completions] of completedUnits) {
      for (const completion of completions) {
        const spawnBuilding = world.buildings.getBuilding(completion.buildingId);
        if (!spawnBuilding?.exists) continue;

        const spawnPosition = this.findEmptySpawnPosition(world, spawnBuilding, completion.unitType);
        if (!spawnPosition) {
          events.push({
            type: "unit_spawn_failed",
            playerId,
            buildingId: completion.buildingId,
            unitType: completion.unitType,
            reason: "no_empty_position",
          });
          continue;
        }

        const unit = world.createUnit(completion.unitType, spawnPosition.x, spawnPosition.y, playerId);
        events.push({
          type: "unit_spawned",
          playerId,
          buildingId: completion.buildingId,
          unitId: unit.id,
          unitType: completion.unitType,
        });
      }
    }
    world.units.resolveUnitSeparation(world.tiles, world.buildings.getOccupiedPositions());
    return events;
  }

  private findEmptySpawnPosition(
    world: WorldState,
    building: Building,
    unitType: UnitType,
  ): { x: number; y: number } | null {
    const footprint = getBuildingFootprint(building.type);
    const halfWidth = Math.floor(footprint.width / 2);
    const halfHeight = Math.floor(footprint.height / 2);
    for (let distance = 1; distance <= 4; distance++) {
      for (let dx = -halfWidth - distance; dx <= halfWidth + distance; dx++) {
        for (let dy = -halfHeight - distance; dy <= halfHeight + distance; dy++) {
          if (world.buildings.getDistanceToBuilding(building, building.x + dx, building.y + dy) !== distance) continue;
          const x = building.x + dx;
          const y = building.y + dy;
          if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) continue;
          if (world.tiles[y][x] === TILE_TYPES.OBSTACLE) continue;
          if (
            world.units.canPlaceUnitAt(
              unitType,
              x,
              y,
              world.tiles,
              world.buildings.getOccupiedPositions(),
            )
          ) {
            return { x, y };
          }
        }
      }
    }
    return null;
  }
}
