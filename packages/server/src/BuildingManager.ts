import {
  PlayerId,
  Building,
  BuildingType,
  UnitType,
  canBuildingProduce,
  getBuildingStats,
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
      if (building.x === x && building.y === y) return true;
    }
    return false;
  }

  getOccupiedPositions(excludeBuildingId?: string): Set<string> {
    const positions = new Set<string>();
    for (const building of this.buildings.values()) {
      if (!building.exists) continue;
      if (excludeBuildingId && building.id === excludeBuildingId) continue;
      positions.add(`${building.x},${building.y}`);
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
        // For simplicity, complete the first unit in queue each tick
        const completedType = building.productionQueue.shift();
        if (completedType) {
          const playerCompleted = completedUnits.get(building.playerId) || [];
          playerCompleted.push({ buildingId: building.id, unitType: completedType });
          completedUnits.set(building.playerId, playerCompleted);
        }
      }
    }

    return completedUnits;
  }
}
