import {
  PlayerId,
  Building,
  BuildingType,
  ProductionBatchRequest,
  ProductionOrder,
  UnitType,
  canBuildingProduce,
  getBuildingFootprintCells,
  getBuildingPrerequisites,
  getBuildingStats,
  getBuildingWeapon,
  getDistanceToBuildingFootprint,
  getUnitPrerequisites,
} from "@llmcraft/shared";

export const MAX_PENDING_PRODUCTION_PER_UNIT_TYPE = 100;

export interface ProductionCancellation {
  cancelledOrderIds: string[];
  refundCredits: number;
}

export class BuildingManager {
  private buildings: Map<string, Building> = new Map();
  private idCounter = 0;
  private productionOrderCounter = 0;

  /** @internal Authoritative runtime creation goes through EntityRegistry/WorldState. */
  createBuilding(
    type: BuildingType,
    x: number,
    y: number,
    playerId: PlayerId,
    options?: { constructionProgress?: Building["constructionProgress"] }
  ): Building {
    const stats = getBuildingStats(type);
    const building: Building = {
      id: `building_${++this.idCounter}`,
      type,
      x,
      y,
      hp: stats.hp,
      maxHp: stats.hp,
      playerId,
      exists: true,
      ...(getBuildingWeapon(type) ? { heading: playerId === "player_1" ? 0 : Math.PI } : {}),
      productionQueue: [],
      constructionProgress: options?.constructionProgress,
    };
    this.buildings.set(building.id, building);
    return building;
  }

  getBuilding(id: string): Building | undefined {
    return this.buildings.get(id);
  }

  getBuildingsByPlayer(playerId: PlayerId): Building[] {
    return Array.from(this.buildings.values()).filter(
      (b) => b.playerId === playerId && b.exists
    );
  }

  getAllBuildings(): Building[] {
    return Array.from(this.buildings.values()).filter((b) => b.exists);
  }

  iterateStoredBuildings(): IterableIterator<Building> {
    return this.buildings.values();
  }

  /** @internal Authoritative runtime destruction goes through EntityRegistry/WorldState. */
  removeBuilding(id: string): boolean {
    const building = this.buildings.get(id);
    if (!building) return false;
    building.exists = false;
    return true;
  }

  hasBuildingAt(x: number, y: number, excludeBuildingId?: string): boolean {
    for (const building of this.buildings.values()) {
      if (!building.exists) continue;
      if (excludeBuildingId && building.id === excludeBuildingId) continue;
      if (getBuildingFootprintCells(building.type, building.x, building.y).some((cell) => cell.x === x && cell.y === y)) return true;
    }
    return false;
  }

  getOccupiedPositions(excludeBuildingId?: string): Set<string> {
    const positions = new Set<string>();
    for (const building of this.buildings.values()) {
      if (!building.exists) continue;
      if (excludeBuildingId && building.id === excludeBuildingId) continue;
      for (const cell of getBuildingFootprintCells(building.type, building.x, building.y)) {
        positions.add(`${cell.x},${cell.y}`);
      }
    }
    return positions;
  }

  enqueueProduction(building: Building, requests: readonly ProductionBatchRequest[]): ProductionOrder[] {
    if (!building.exists || building.constructionProgress) {
      return [];
    }

    const orders = requests.map((request) => ({
      orderId: `production_${++this.productionOrderCounter}`,
      unitType: request.unitType,
      count: request.count,
      remainingCount: request.count,
    }));
    building.productionQueue.push(...orders);
    return orders;
  }

  getPendingCount(building: Building, unitType: UnitType): number {
    return building.productionQueue.reduce(
      (total, order) => total + (order.unitType === unitType ? order.remainingCount : 0),
      0,
    );
  }

  cancelProduction(building: Building, orderIds?: ReadonlySet<string>): ProductionCancellation {
    const cancelAll = orderIds === undefined;
    const cancelledOrderIds = building.productionQueue
      .filter((order) => cancelAll || orderIds.has(order.orderId))
      .map((order) => order.orderId);
    if (cancelledOrderIds.length === 0) {
      return { cancelledOrderIds: [], refundCredits: 0 };
    }

    const cancelled = new Set(cancelledOrderIds);
    const activeCancelled = Boolean(
      building.productionProgress && cancelled.has(building.productionProgress.orderId),
    );
    const refundCredits = activeCancelled ? building.productionProgress?.paidCredits ?? 0 : 0;
    building.productionQueue = building.productionQueue.filter((order) => !cancelled.has(order.orderId));
    if (activeCancelled) {
      building.productionProgress = undefined;
    }
    return { cancelledOrderIds, refundCredits };
  }

  canProduce(building: Building, unitType: UnitType): boolean {
    return building.exists
      && !building.constructionProgress
      && canBuildingProduce(building.type, unitType)
      && this.getMissingProductionPrerequisites(building.playerId, unitType).length === 0;
  }

  getMissingBuildingPrerequisites(playerId: PlayerId, buildingType: BuildingType): BuildingType[] {
    return this.getMissingPrerequisites(playerId, getBuildingPrerequisites(buildingType));
  }

  getMissingProductionPrerequisites(playerId: PlayerId, unitType: UnitType): BuildingType[] {
    return this.getMissingPrerequisites(playerId, getUnitPrerequisites(unitType));
  }

  private getMissingPrerequisites(playerId: PlayerId, required: readonly BuildingType[]): BuildingType[] {
    if (required.length === 0) return [];
    const completedTypes = new Set(
      this.getBuildingsByPlayer(playerId)
        .filter((building) => !building.constructionProgress)
        .map((building) => building.type),
    );
    return required.filter((buildingType) => !completedTypes.has(buildingType));
  }

  getDistanceToBuilding(building: Building, x: number, y: number): number {
    return getDistanceToBuildingFootprint(building.type, building.x, building.y, x, y);
  }

  takeDamage(building: Building, damage: number): boolean {
    if (!building.exists) {
      return false;
    }

    building.hp -= damage;

    if (building.hp <= 0) {
      building.hp = 0;
      return true; // Building destroyed
    }

    return false; // Building still alive
  }

}
