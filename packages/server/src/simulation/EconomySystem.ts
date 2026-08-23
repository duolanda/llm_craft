import {
  ECONOMY_RULES,
  TILE_TYPES,
  UNIT_STATES,
  UNIT_TYPES,
  type PlayerId,
} from "@llmcraft/shared";
import { WorldState } from "../WorldState";
import {
  isResourceDeliveryBuilding,
  isWithinDeliveryRange,
  isWithinResourceGatherRange,
  isWorkerConstructing,
} from "./EconomyRules";

export type EconomyEvent =
  | {
      type: "resource_gathered";
      playerId: PlayerId;
      unitId: string;
      amount: number;
      carryingCredits: number;
    }
  | {
      type: "credits_delivered";
      playerId: PlayerId;
      unitId: string;
      buildingId: string;
      amount: number;
      credits: number;
    };

export class EconomySystem {
  step(world: WorldState): EconomyEvent[] {
    const events: EconomyEvent[] = [];
    for (const playerId of world.getPlayerIds()) {
      const player = world.getPlayerState(playerId)!;
      const deliveryBuildings = world.buildings
        .getBuildingsByPlayer(player.id)
        .filter(isResourceDeliveryBuilding);
      if (deliveryBuildings.length === 0) continue;

      for (const unit of world.units.getUnitsByPlayer(player.id)) {
        if (unit.type !== UNIT_TYPES.WORKER || !unit.exists || isWorkerConstructing(unit)) continue;

        const preserveHarvestLoop = unit.order?.type === "harvest_loop" ? unit.order : null;
        const resourceCell = this.getGatherableResourceCell(world, unit);
        const deliveryBuilding = deliveryBuildings
          .filter((building) => isWithinDeliveryRange(world, unit, building))
          .sort((left, right) =>
            world.buildings.getDistanceToBuilding(left, unit.x, unit.y) -
            world.buildings.getDistanceToBuilding(right, unit.x, unit.y)
          )[0];
        let economyActionTaken = false;

        if (resourceCell && unit.carryingCredits < unit.carryCapacity) {
          const resourceKey = `${resourceCell.x},${resourceCell.y}`;
          const depositRemaining = world.resourceRemaining.get(resourceKey) ?? 0;
          const gatheredCredits = Math.min(
            ECONOMY_RULES.WORKER_GATHER_RATE,
            unit.carryCapacity - unit.carryingCredits,
            depositRemaining,
          );
          if (gatheredCredits > 0) {
            unit.carryingCredits += gatheredCredits;
            world.setResourceRemaining(resourceCell.x, resourceCell.y, depositRemaining - gatheredCredits);
            unit.state = UNIT_STATES.GATHERING;
            unit.order = preserveHarvestLoop ?? { type: "gather", targetX: resourceCell.x, targetY: resourceCell.y };
            events.push({
              type: "resource_gathered",
              playerId,
              unitId: unit.id,
              amount: gatheredCredits,
              carryingCredits: unit.carryingCredits,
            });
            economyActionTaken = true;
          }
        }

        if (deliveryBuilding && unit.carryingCredits > 0) {
          const deliveredCredits = unit.carryingCredits;
          player.resources.credits += deliveredCredits;
          unit.carryingCredits = 0;
          unit.state = UNIT_STATES.IDLE;
          unit.order = preserveHarvestLoop ?? {
            type: "deposit",
            targetX: deliveryBuilding.x,
            targetY: deliveryBuilding.y,
            targetId: deliveryBuilding.id,
          };
          world.markChanged();
          events.push({
            type: "credits_delivered",
            playerId,
            unitId: unit.id,
            buildingId: deliveryBuilding.id,
            amount: deliveredCredits,
            credits: player.resources.credits,
          });
          economyActionTaken = true;
        }

        if (
          !economyActionTaken
          && !unit.path?.length
          && unit.state === UNIT_STATES.GATHERING
          && (!resourceCell || unit.carryingCredits >= unit.carryCapacity)
        ) {
          unit.state = UNIT_STATES.IDLE;
        }
      }
    }
    return events;
  }

  private getGatherableResourceCell(
    world: WorldState,
    unit: { x: number; y: number; order?: { type: string; targetX?: number; targetY?: number } },
  ): { x: number; y: number } | null {
    if (
      unit.order?.type === "harvest_loop"
      && unit.order.targetX !== undefined
      && unit.order.targetY !== undefined
    ) {
      const assigned = { x: unit.order.targetX, y: unit.order.targetY };
      if (
        world.tiles[assigned.y]?.[assigned.x] === TILE_TYPES.RESOURCE
        && (world.resourceRemaining.get(`${assigned.x},${assigned.y}`) ?? 0) > 0
        && isWithinResourceGatherRange(unit, assigned)
      ) {
        return assigned;
      }
    }

    const nearest = this.getNearestCell(world, unit);
    return world.tiles[nearest.y]?.[nearest.x] === TILE_TYPES.RESOURCE
      && (world.resourceRemaining.get(`${nearest.x},${nearest.y}`) ?? 0) > 0
      ? nearest
      : null;
  }

  private getNearestCell(world: WorldState, position: { x: number; y: number }): { x: number; y: number } {
    const height = world.tiles.length;
    const width = world.tiles[0]?.length ?? 0;
    return {
      x: Math.max(0, Math.min(width - 1, Math.round(position.x))),
      y: Math.max(0, Math.min(height - 1, Math.round(position.y))),
    };
  }
}
