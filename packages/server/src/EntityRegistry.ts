import type {
  Building,
  BuildingType,
  PlayerId,
  UnitType,
} from "@llmcraft/shared";
import { BuildingManager } from "./BuildingManager";
import { UnitManager } from "./UnitManager";
import type { WorldUnit } from "./WorldUnit";

export type WorldEntityRef =
  | { kind: "unit"; entity: WorldUnit }
  | { kind: "building"; entity: Building };

/** Cross-entity identity and lifecycle lookup for the authoritative world. */
export class EntityRegistry {
  constructor(
    private readonly units: UnitManager,
    private readonly buildings: BuildingManager,
    private readonly playerIds: ReadonlySet<PlayerId>,
  ) {}

  createUnit(type: UnitType, x: number, y: number, playerId: PlayerId): WorldUnit {
    this.assertKnownPlayer(playerId);
    return this.units.createUnit(type, x, y, playerId);
  }

  createBuilding(
    type: BuildingType,
    x: number,
    y: number,
    playerId: PlayerId,
    options?: { constructionProgress?: Building["constructionProgress"] },
  ): Building {
    this.assertKnownPlayer(playerId);
    return this.buildings.createBuilding(type, x, y, playerId, options);
  }

  resolve(id: string, options: { includeDestroyed?: boolean } = {}): WorldEntityRef | undefined {
    const unit = this.units.getUnit(id);
    const building = this.buildings.getBuilding(id);
    if (unit && building) {
      throw new Error(`Duplicate entity id across registries: ${id}`);
    }
    const ref: WorldEntityRef | undefined = unit
      ? { kind: "unit", entity: unit }
      : building
        ? { kind: "building", entity: building }
        : undefined;
    if (!ref || (!options.includeDestroyed && !ref.entity.exists)) {
      return undefined;
    }
    return ref;
  }

  destroy(id: string): WorldEntityRef | undefined {
    const ref = this.resolve(id, { includeDestroyed: true });
    if (!ref || !ref.entity.exists) return undefined;
    ref.entity.hp = 0;
    if (ref.kind === "unit") {
      this.units.removeUnit(id);
    } else {
      this.buildings.removeBuilding(id);
    }
    return ref;
  }

  private assertKnownPlayer(playerId: PlayerId): void {
    if (!this.playerIds.has(playerId)) {
      throw new Error(`Cannot create entity for unknown player: ${playerId}`);
    }
  }
}
