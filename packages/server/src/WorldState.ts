import {
  BUILDING_TYPES,
  ECONOMY_RULES,
  TILE_TYPES,
  UNIT_TYPES,
  type ActiveProjectile,
  type Building,
  type BuildingType,
  type Player,
  type PlayerId,
  type Tile,
  type TileType,
  type UnitType,
} from "@llmcraft/shared";
import { BuildingManager } from "./BuildingManager";
import { EntityRegistry } from "./EntityRegistry";
import type { MatchDefinition } from "./MatchDefinition";
import { MapGenerator } from "./MapGenerator";
import { UnitManager } from "./UnitManager";
import type { WorldUnit } from "./WorldUnit";

export interface WorldPlayerState {
  id: PlayerId;
  resources: Player["resources"];
}

/**
 * Mutable, serializable authority for one simulation.
 *
 * Logs, snapshots, controllers and wall-clock lifecycle intentionally live
 * outside this object. Unit and building collections are owned only by their
 * registries; Player views are composed projections rather than a second copy.
 */
export class WorldState {
  tick = 0;
  revision = 0;
  readonly units = new UnitManager();
  readonly buildings = new BuildingManager();
  readonly entities: EntityRegistry;
  tiles: TileType[][];
  resourceRemaining = new Map<string, number>();
  tileView: Tile[][];
  projectiles: ActiveProjectile[] = [];
  projectileCounter = 0;
  winner: PlayerId | null = null;
  private readonly playerStates: WorldPlayerState[];

  constructor(private readonly definition: MatchDefinition) {
    this.entities = new EntityRegistry(
      this.units,
      this.buildings,
      new Set(definition.players.map((player) => player.id)),
    );
    this.tiles = MapGenerator.generate(definition.map);
    for (const position of definition.map.resources) {
      this.resourceRemaining.set(
        `${position.x},${position.y}`,
        ECONOMY_RULES.RESOURCE_DEPOSIT_CAPACITY,
      );
    }
    this.tileView = this.createTileView();
    this.playerStates = definition.players.map((player) => ({
      id: player.id,
      resources: { credits: player.startingCredits },
    }));

    for (const start of definition.map.playerStarts) {
      for (const building of start.buildings) {
        this.createBuilding(
          building.type,
          building.position.x,
          building.position.y,
          start.playerId,
        );
      }
      for (const unit of start.units) {
        this.createUnit(
          unit.type,
          unit.position.x,
          unit.position.y,
          start.playerId,
        );
      }
    }
  }

  createUnit(type: UnitType, x: number, y: number, playerId: PlayerId): WorldUnit {
    const unit = this.entities.createUnit(type, x, y, playerId);
    this.markChanged();
    return unit;
  }

  createBuilding(
    type: BuildingType,
    x: number,
    y: number,
    playerId: PlayerId,
    options?: { constructionProgress?: Building["constructionProgress"] },
  ): Building {
    const building = this.entities.createBuilding(type, x, y, playerId, options);
    this.markChanged();
    return building;
  }

  destroyEntity(id: string): boolean {
    const entity = this.entities.resolve(id);
    if (entity?.kind === "building") {
      const cancellation = this.buildings.cancelProduction(entity.entity);
      const owner = this.getPlayerState(entity.entity.playerId);
      if (owner && cancellation.refundCredits > 0) {
        owner.resources.credits += cancellation.refundCredits;
      }
    }
    const destroyed = this.entities.destroy(id) !== undefined;
    if (destroyed) this.markChanged();
    return destroyed;
  }

  markChanged(): void {
    this.revision++;
  }

  get players(): Player[] {
    return this.playerStates.map((player) => ({
      id: player.id,
      resources: { ...player.resources },
      units: this.units.getUnitsByPlayer(player.id).map((worldUnit) => {
        const { order, ...unit } = worldUnit;
        return {
          ...unit,
          intent: order ? { ...order } : undefined,
          path: unit.path?.map((position) => ({ ...position })),
          pathTarget: unit.pathTarget ? { ...unit.pathTarget } : undefined,
        };
      }),
      buildings: this.buildings.getBuildingsByPlayer(player.id).map((building) => ({
        ...building,
        rallyPoint: building.rallyPoint ? { ...building.rallyPoint } : undefined,
        productionQueue: building.productionQueue.map((order) => ({ ...order })),
        productionProgress: building.productionProgress ? { ...building.productionProgress } : undefined,
        constructionProgress: building.constructionProgress ? { ...building.constructionProgress } : undefined,
      })),
    }));
  }

  getPlayerState(playerId: PlayerId): WorldPlayerState | undefined {
    return this.playerStates.find((player) => player.id === playerId);
  }

  getPlayerIds(): PlayerId[] {
    return this.playerStates.map((player) => player.id);
  }

  getPlayerCredits(): Array<[PlayerId, number]> {
    return this.playerStates.map((player) => [player.id, player.resources.credits]);
  }

  setResourceRemaining(x: number, y: number, remaining: number): void {
    this.resourceRemaining.set(`${x},${y}`, remaining);
    if (remaining <= 0) {
      this.tiles[y][x] = TILE_TYPES.EMPTY;
    }
    const currentTile = this.tileView[y]?.[x];
    if (!currentTile) return;

    const nextTile: Tile = remaining <= 0
      ? { x, y, type: TILE_TYPES.EMPTY }
      : { ...currentTile, resourceRemaining: remaining };
    const nextRow = [...this.tileView[y]];
    nextRow[x] = nextTile;
    const nextTileView = [...this.tileView];
    nextTileView[y] = nextRow;
    this.tileView = nextTileView;
    this.markChanged();
  }

  rebuildMapProjection(): void {
    this.tiles = MapGenerator.generate(this.definition.map);
    for (const [resourceKey, remaining] of this.resourceRemaining) {
      if (remaining > 0) continue;
      const [x, y] = resourceKey.split(",").map(Number);
      if (this.tiles[y]?.[x] === TILE_TYPES.RESOURCE) {
        this.tiles[y][x] = TILE_TYPES.EMPTY;
      }
    }
    this.tileView = this.createTileView();
  }

  private createTileView(): Tile[][] {
    const tiles: Tile[][] = [];
    for (let y = 0; y < this.definition.map.height; y++) {
      tiles[y] = [];
      for (let x = 0; x < this.definition.map.width; x++) {
        tiles[y][x] = {
          x,
          y,
          type: this.tiles[y][x],
          ...(this.tiles[y][x] === TILE_TYPES.RESOURCE
            ? { resourceRemaining: this.resourceRemaining.get(`${x},${y}`) ?? 0 }
            : {}),
        };
      }
    }
    return tiles;
  }
}
