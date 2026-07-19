import { RESULT_CODES, TILE_TYPES, UNIT_TYPES } from "@llmcraft/shared";
import { WorldState } from "../WorldState";
import type { WorldUnit } from "../WorldUnit";
import {
  getDeliveryRange,
  isResourceDeliveryBuilding,
  isWithinDeliveryRange,
} from "./EconomyRules";

export class HarvestOrderSystem {
  step(world: WorldState): void {
    for (const worker of world.units.getAllUnits()) {
      if (!worker.exists || worker.order?.type !== "harvest_loop" || worker.type !== UNIT_TYPES.WORKER) continue;

      const harvestOrder = worker.order;
      const deliveryBuilding = world.buildings
        .getBuildingsByPlayer(worker.playerId)
        .filter(isResourceDeliveryBuilding)
        .sort((left, right) =>
          world.buildings.getDistanceToBuilding(left, worker.x, worker.y) -
          world.buildings.getDistanceToBuilding(right, worker.x, worker.y)
        )[0];
      if (!deliveryBuilding) continue;

      const resourceTarget = this.resolveResourceTarget(world, worker, {
        x: harvestOrder.targetX ?? worker.x,
        y: harvestOrder.targetY ?? worker.y,
      });
      if (!resourceTarget) continue;

      worker.order = { type: "harvest_loop", targetX: resourceTarget.x, targetY: resourceTarget.y };

      if (worker.carryingCredits >= worker.carryCapacity) {
        if (
          !isWithinDeliveryRange(world, worker, deliveryBuilding)
          && !this.isPathingIntoDeliveryRange(world, worker, deliveryBuilding)
        ) {
          const blockedPositions = world.buildings.getOccupiedPositions();
          if (
            world.units.setMoveTarget(
              worker,
              deliveryBuilding.x,
              deliveryBuilding.y,
              world.tiles,
              blockedPositions,
            ) === RESULT_CODES.OK
          ) {
            worker.order = { type: "harvest_loop", targetX: resourceTarget.x, targetY: resourceTarget.y };
          }
        }
        continue;
      }

      const onResourceTile = this.isNearPosition(worker, resourceTarget);
      const pathingToResource =
        worker.pathTarget?.x === resourceTarget.x
        && worker.pathTarget?.y === resourceTarget.y;
      if (onResourceTile || pathingToResource) continue;

      const blockedPositions = world.buildings.getOccupiedPositions();
      if (
        world.units.setMoveTarget(
          worker,
          resourceTarget.x,
          resourceTarget.y,
          world.tiles,
          blockedPositions,
        ) === RESULT_CODES.OK
      ) {
        worker.order = { type: "harvest_loop", targetX: resourceTarget.x, targetY: resourceTarget.y };
      }
    }
  }

  resolveResourceTarget(
    world: WorldState,
    worker: WorldUnit,
    requestedPosition?: { x: number; y: number },
  ): { x: number; y: number } | null {
    const height = world.tiles.length;
    const width = world.tiles[0]?.length ?? 0;
    if (
      requestedPosition
      && requestedPosition.x >= 0
      && requestedPosition.x < width
      && requestedPosition.y >= 0
      && requestedPosition.y < height
      && world.tiles[requestedPosition.y][requestedPosition.x] === TILE_TYPES.RESOURCE
    ) {
      return requestedPosition;
    }
    if (requestedPosition) return null;

    const assignedHarvesters = new Map<string, number>();
    for (const unit of world.units.getUnitsByPlayer(worker.playerId)) {
      if (unit.id === worker.id || unit.type !== UNIT_TYPES.WORKER || unit.order?.type !== "harvest_loop") continue;
      const targetX = unit.order.targetX;
      const targetY = unit.order.targetY;
      if (targetX === undefined || targetY === undefined) continue;
      const key = `${targetX},${targetY}`;
      assignedHarvesters.set(key, (assignedHarvesters.get(key) ?? 0) + 1);
    }

    let best: { x: number; y: number; distance: number; assignedHarvesters: number; score: number } | null = null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (world.tiles[y][x] !== TILE_TYPES.RESOURCE || (world.resourceRemaining.get(`${x},${y}`) ?? 0) <= 0) continue;
        const distance = Math.max(Math.abs(worker.x - x), Math.abs(worker.y - y));
        const assigned = assignedHarvesters.get(`${x},${y}`) ?? 0;
        const score = distance + assigned * 4;
        if (
          !best
          || score < best.score
          || (score === best.score
            && (assigned < best.assignedHarvesters
              || (assigned === best.assignedHarvesters
                && (distance < best.distance
                  || (distance === best.distance && (y < best.y || (y === best.y && x < best.x)))))))
        ) {
          best = { x, y, distance, assignedHarvesters: assigned, score };
        }
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  private isPathingIntoDeliveryRange(
    world: WorldState,
    unit: WorldUnit,
    building: Parameters<typeof getDeliveryRange>[0],
  ): boolean {
    return Boolean(
      unit.pathTarget
      && world.buildings.getDistanceToBuilding(building, unit.pathTarget.x, unit.pathTarget.y) <= getDeliveryRange(building)
    );
  }

  private isNearPosition(
    position: { x: number; y: number },
    target: { x: number; y: number },
    tolerance = 0.35,
  ): boolean {
    return Math.max(Math.abs(position.x - target.x), Math.abs(position.y - target.y)) <= tolerance;
  }
}
