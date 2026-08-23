import { RESULT_CODES, TILE_TYPES, UNIT_TYPES } from "@llmcraft/shared";
import { WorldState } from "../WorldState";
import type { WorldUnit } from "../WorldUnit";
import {
  getDeliveryRange,
  isResourceDeliveryBuilding,
  isWithinDeliveryRange,
  isWithinResourceGatherRange,
} from "./EconomyRules";

const MAX_HARVESTERS_PER_RESOURCE = 2;

export class HarvestOrderSystem {
  assignDefaultHarvestOrder(world: WorldState, worker: WorldUnit): boolean {
    if (
      !worker.exists
      || worker.type !== UNIT_TYPES.WORKER
      || worker.order
      || worker.constructingBuildingId
    ) {
      return false;
    }

    const hasDeliveryBuilding = world.buildings
      .getBuildingsByPlayer(worker.playerId)
      .some(isResourceDeliveryBuilding);
    if (!hasDeliveryBuilding) return false;

    const resourceTarget = this.resolveResourceTarget(world, worker);
    if (!resourceTarget) return false;

    worker.order = {
      type: "harvest_loop",
      targetX: resourceTarget.x,
      targetY: resourceTarget.y,
    };
    world.markChanged();
    return true;
  }

  assignDefaultHarvestOrders(world: WorldState): void {
    for (const worker of world.units.getAllUnits()) {
      this.assignDefaultHarvestOrder(world, worker);
    }
  }

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
      }, true);
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

      const onResourceTile = isWithinResourceGatherRange(worker, resourceTarget);
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
    allowAutomaticFallback = false,
  ): { x: number; y: number } | null {
    const height = world.tiles.length;
    const width = world.tiles[0]?.length ?? 0;
    const assignedHarvesters = new Map<string, number>();
    for (const unit of world.units.getUnitsByPlayer(worker.playerId)) {
      if (unit.id === worker.id || unit.type !== UNIT_TYPES.WORKER || unit.order?.type !== "harvest_loop") continue;
      const targetX = unit.order.targetX;
      const targetY = unit.order.targetY;
      if (targetX === undefined || targetY === undefined) continue;
      const key = `${targetX},${targetY}`;
      assignedHarvesters.set(key, (assignedHarvesters.get(key) ?? 0) + 1);
    }

    const requestedResource = Boolean(
      requestedPosition
      && requestedPosition.x >= 0
      && requestedPosition.x < width
      && requestedPosition.y >= 0
      && requestedPosition.y < height
      && world.tiles[requestedPosition.y][requestedPosition.x] === TILE_TYPES.RESOURCE
      && (world.resourceRemaining.get(`${requestedPosition.x},${requestedPosition.y}`) ?? 0) > 0
    );
    if (requestedResource && requestedPosition) {
      const assigned = assignedHarvesters.get(`${requestedPosition.x},${requestedPosition.y}`) ?? 0;
      if (assigned < MAX_HARVESTERS_PER_RESOURCE) return requestedPosition;
      // Two workers may use distinct edge approaches; further assignments
      // would saturate the interaction area. Fall through to another route.
    } else if (requestedPosition && !allowAutomaticFallback) {
      return null;
    }

    const deliveryBuildings = world.buildings
      .getBuildingsByPlayer(worker.playerId)
      .filter(isResourceDeliveryBuilding);
    let best: {
      x: number;
      y: number;
      workerDistance: number;
      deliveryDistance: number;
      assignedHarvesters: number;
      score: number;
    } | null = null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (world.tiles[y][x] !== TILE_TYPES.RESOURCE || (world.resourceRemaining.get(`${x},${y}`) ?? 0) <= 0) continue;
        const workerDistance = Math.max(Math.abs(worker.x - x), Math.abs(worker.y - y));
        const deliveryDistance = deliveryBuildings.length > 0
          ? Math.min(...deliveryBuildings.map((building) =>
            Math.max(0, world.buildings.getDistanceToBuilding(building, x, y) - getDeliveryRange(building))
          ))
          : workerDistance;
        const assigned = assignedHarvesters.get(`${x},${y}`) ?? 0;
        if (assigned >= MAX_HARVESTERS_PER_RESOURCE) continue;
        // A harvest loop pays the mine-to-dropoff route repeatedly. Initial worker travel
        // matters, but should not send idle workers to a remote unassigned deposit while
        // several closer routes still have room to operate.
        const score = deliveryDistance * 2 + Math.ceil(workerDistance / 4) + assigned * 4;
        if (
          !best
          || score < best.score
          || (score === best.score
            && (assigned < best.assignedHarvesters
              || (assigned === best.assignedHarvesters
                && (deliveryDistance < best.deliveryDistance
                  || (deliveryDistance === best.deliveryDistance
                    && (workerDistance < best.workerDistance
                      || (workerDistance === best.workerDistance && (y < best.y || (y === best.y && x < best.x)))))))))
        ) {
          best = { x, y, workerDistance, deliveryDistance, assignedHarvesters: assigned, score };
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

}
