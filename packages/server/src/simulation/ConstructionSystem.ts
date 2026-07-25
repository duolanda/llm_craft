import { UNIT_STATES, type BuildingType, type PlayerId } from "@llmcraft/shared";
import { WorldState } from "../WorldState";

export type ConstructionEvent =
  | {
      type: "building_completed";
      playerId: PlayerId;
      buildingId: string;
      buildingType: BuildingType;
      workerId: string;
    }
  | {
      type: "building_cancelled";
      playerId: PlayerId;
      buildingId: string;
      buildingType: BuildingType;
      workerId: string;
      reason: "worker_missing";
    };

export class ConstructionSystem {
  step(world: WorldState): ConstructionEvent[] {
    const events: ConstructionEvent[] = [];
    for (const building of world.buildings.getAllBuildings()) {
      const construction = building.constructionProgress;
      if (!construction) continue;

      const worker = world.units.getUnit(construction.workerId);
      if (!worker || !worker.exists || worker.constructingBuildingId !== building.id) {
        world.destroyEntity(building.id);
        events.push({
          type: "building_cancelled",
          playerId: building.playerId,
          buildingId: building.id,
          buildingType: building.type,
          workerId: construction.workerId,
          reason: "worker_missing",
        });
        continue;
      }

      world.units.clearPath(worker);
      worker.state = UNIT_STATES.BUILDING;
      worker.order = { type: "build", targetX: building.x, targetY: building.y, targetId: building.id };

      construction.remainingTicks -= 1;
      if (construction.remainingTicks > 0) continue;

      const resumeWorkerOrder = construction.resumeWorkerOrder;
      building.constructionProgress = undefined;
      worker.constructingBuildingId = undefined;
      worker.state = UNIT_STATES.IDLE;
      worker.order = resumeWorkerOrder ? structuredClone(resumeWorkerOrder) : undefined;
      events.push({
        type: "building_completed",
        playerId: building.playerId,
        buildingId: building.id,
        buildingType: building.type,
        workerId: worker.id,
      });
    }
    return events;
  }
}
