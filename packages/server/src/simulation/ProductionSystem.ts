import {
  MAP_HEIGHT,
  MAP_WIDTH,
  RESULT_CODES,
  TILE_TYPES,
  UNIT_TYPES,
  getDefaultAttackMovePriority,
  getBuildingFootprint,
  getUnitCost,
  getUnitLimit,
  getUnitProductionTicks,
  unitCanAttack,
  type Building,
  type PlayerId,
  type UnitType,
} from "@llmcraft/shared";
import { WorldState } from "../WorldState";
import { HarvestOrderSystem } from "./HarvestOrderSystem";

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
  constructor(private readonly harvestOrders = new HarvestOrderSystem()) {}

  step(world: WorldState): ProductionEvent[] {
    const events: ProductionEvent[] = [];
    for (const spawnBuilding of world.buildings.getAllBuildings()) {
      if (spawnBuilding.constructionProgress) continue;
      const order = spawnBuilding.productionQueue[0];
      if (!order) {
        if (spawnBuilding.productionProgress) {
          spawnBuilding.productionProgress = undefined;
          world.markChanged();
        }
        continue;
      }

      let progress = spawnBuilding.productionProgress;
      if (!progress || progress.orderId !== order.orderId || progress.unitType !== order.unitType) {
        const totalTicks = getUnitProductionTicks(order.unitType);
        const missingPrerequisites = world.buildings.getMissingProductionPrerequisites(
          spawnBuilding.playerId,
          order.unitType,
        );
        progress = {
          orderId: order.orderId,
          unitType: order.unitType,
          remainingTicks: totalTicks,
          totalTicks,
          paidCredits: 0,
          totalCost: getUnitCost(order.unitType),
          status: missingPrerequisites.length > 0 ? "waiting_for_prerequisite" : "producing",
          ...(missingPrerequisites.length > 0 ? { missingPrerequisites } : {}),
        };
        spawnBuilding.productionProgress = progress;
        world.markChanged();
      }

      if (progress.status === "waiting_for_prerequisite") {
        const missingPrerequisites = world.buildings.getMissingProductionPrerequisites(
          spawnBuilding.playerId,
          order.unitType,
        );
        if (missingPrerequisites.length > 0) {
          if (JSON.stringify(progress.missingPrerequisites) !== JSON.stringify(missingPrerequisites)) {
            progress.missingPrerequisites = missingPrerequisites;
            world.markChanged();
          }
          continue;
        }
        progress.status = "producing";
        delete progress.missingPrerequisites;
        world.markChanged();
      }

      const unitLimit = getUnitLimit(order.unitType);
      const livingUnitCount = world.units.getUnitsByPlayer(spawnBuilding.playerId)
        .filter((unit) => unit.type === order.unitType)
        .length;
      if (unitLimit !== undefined && livingUnitCount >= unitLimit) {
        if (progress.status !== "waiting_for_unit_limit") {
          progress.status = "waiting_for_unit_limit";
          world.markChanged();
        }
        continue;
      }
      if (progress.status === "waiting_for_unit_limit") {
        const missingPrerequisites = progress.paidCredits === 0
          ? world.buildings.getMissingProductionPrerequisites(spawnBuilding.playerId, order.unitType)
          : [];
        if (missingPrerequisites.length > 0) {
          progress.status = "waiting_for_prerequisite";
          progress.missingPrerequisites = missingPrerequisites;
          world.markChanged();
          continue;
        }
        progress.status = "producing";
        world.markChanged();
      }

      if (progress.remainingTicks > 0) {
        const elapsedTicks = progress.totalTicks - progress.remainingTicks;
        const nextElapsedTicks = elapsedTicks + 1;
        const paidAfterTick = Math.floor(progress.totalCost * nextElapsedTicks / progress.totalTicks);
        const tickCharge = paidAfterTick - progress.paidCredits;
        const player = world.getPlayerState(spawnBuilding.playerId);
        if (!player || player.resources.credits < tickCharge) {
          if (progress.status !== "waiting_for_credits") {
            progress.status = "waiting_for_credits";
            world.markChanged();
          }
          continue;
        }
        player.resources.credits -= tickCharge;
        progress.paidCredits += tickCharge;
        progress.remainingTicks -= 1;
        progress.status = "producing";
        world.markChanged();
      }

      if (progress.remainingTicks > 0) continue;

      const spawnPosition = this.findEmptySpawnPosition(world, spawnBuilding, order.unitType);
      if (!spawnPosition) {
        const alreadyWaiting = progress.status === "waiting_for_spawn";
        progress.status = "waiting_for_spawn";
        if (!alreadyWaiting) {
          world.markChanged();
          events.push({
            type: "unit_spawn_failed",
            playerId: spawnBuilding.playerId,
            buildingId: spawnBuilding.id,
            unitType: order.unitType,
            reason: "no_empty_position",
          });
        }
        continue;
      }

      const unit = world.createUnit(order.unitType, spawnPosition.x, spawnPosition.y, spawnBuilding.playerId);
      if (spawnBuilding.rallyPoint) {
          const result = world.units.setMoveTarget(
            unit,
            spawnBuilding.rallyPoint.x,
            spawnBuilding.rallyPoint.y,
            world.tiles,
            world.buildings.getOccupiedPositions(),
            spawnBuilding.rallyPoint.mode === "attack_move" && unitCanAttack(unit.type),
          );
          if (
            result === RESULT_CODES.OK
            && spawnBuilding.rallyPoint.mode === "attack_move"
            && unitCanAttack(unit.type)
          ) {
            unit.order = {
              type: "attack_move",
              targetX: unit.pathTarget?.x ?? spawnBuilding.rallyPoint.x,
              targetY: unit.pathTarget?.y ?? spawnBuilding.rallyPoint.y,
              targetPriority: getDefaultAttackMovePriority(unit.type),
            };
          }
      } else if (unit.type === UNIT_TYPES.WORKER) {
        this.harvestOrders.assignDefaultHarvestOrder(world, unit);
      }
      order.remainingCount -= 1;
      if (order.remainingCount <= 0) {
        spawnBuilding.productionQueue.shift();
      }
      spawnBuilding.productionProgress = undefined;
      world.markChanged();
      events.push({
        type: "unit_spawned",
        playerId: spawnBuilding.playerId,
        buildingId: spawnBuilding.id,
        unitId: unit.id,
        unitType: order.unitType,
      });
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
