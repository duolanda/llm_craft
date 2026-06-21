import {
  PlayerId,
  Building,
  BuildingType,
  UnitType,
  canBuildingProduce,
  getBuildingFootprintCells,
  getDistanceToBuildingFootprint,
  getBuildingStats,
  getUnitProductionTicks,
} from "@llmcraft/shared";

export interface ProductionCompletion {
  buildingId: string;
  unitType: UnitType;
}

export class BuildingManager {
  private buildings: Map<string, Building> = new Map();
  private idCounter = 0;

  createBuilding(
    type: BuildingType,
    x: number,
    y: number,
    playerId: PlayerId
  ): Building {
    const stats = getBuildingStats(type);
    const building: Building = {
      id: `building_${++this.idCounter}`,
      type,
      x,
      y,
      hp: stats.hp,
      maxHp: stats.hp,
      my: true,
      playerId,
      exists: true,
      productionQueue: [],
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

  spawnUnit(building: Building, unitType: UnitType): boolean {
    if (!building.exists) {
      return false;
    }

    building.productionQueue.push(unitType);
    return true;
  }

  canProduce(building: Building, unitType: UnitType): boolean {
    return canBuildingProduce(building.type, unitType);
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
      building.exists = false;
      return true; // Building destroyed
    }

    return false; // Building still alive
  }

  processProductionQueues(): Map<PlayerId, ProductionCompletion[]> {
    const completedUnits = new Map<PlayerId, ProductionCompletion[]>();

    for (const building of this.buildings.values()) {
      if (building.exists && building.productionQueue.length > 0) {
        const queuedType = building.productionQueue[0];
        if (!queuedType) {
          continue;
        }
        if (!building.productionProgress || building.productionProgress.unitType !== queuedType) {
          const totalTicks = getUnitProductionTicks(queuedType);
          building.productionProgress = { unitType: queuedType, remainingTicks: totalTicks, totalTicks };
        }
        building.productionProgress.remainingTicks -= 1;
        if (building.productionProgress.remainingTicks <= 0) {
          const completedType = building.productionQueue.shift();
          building.productionProgress = undefined;
          if (!completedType) {
            continue;
          }
          const playerCompleted = completedUnits.get(building.playerId) || [];
          playerCompleted.push({ buildingId: building.id, unitType: completedType });
          completedUnits.set(building.playerId, playerCompleted);
        }
      } else if (building.productionProgress) {
        building.productionProgress = undefined;
      }
    }

    return completedUnits;
  }
}
