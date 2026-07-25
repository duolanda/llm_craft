import {
  BUILDING_TYPES,
  ECONOMY_RULES,
  UNIT_TYPES,
  type Building,
  type Unit,
} from "@llmcraft/shared";
import { WorldState } from "../WorldState";

export function isWorkerConstructing(unit: Pick<Unit, "type" | "constructingBuildingId">): boolean {
  return unit.type === UNIT_TYPES.WORKER && Boolean(unit.constructingBuildingId);
}

export function isResourceDeliveryBuilding(building: Building): boolean {
  return building.exists
    && !building.constructionProgress
    && (building.type === BUILDING_TYPES.HQ || building.type === BUILDING_TYPES.REFINERY);
}

export function getDeliveryRange(building: Building): number {
  return building.type === BUILDING_TYPES.REFINERY
    ? ECONOMY_RULES.REFINERY_DELIVERY_RANGE
    : ECONOMY_RULES.HQ_DELIVERY_RANGE;
}

export function isWithinDeliveryRange(
  world: WorldState,
  unit: Pick<Unit, "x" | "y">,
  building: Building,
): boolean {
  return world.buildings.getDistanceToBuilding(building, unit.x, unit.y) <= getDeliveryRange(building);
}
