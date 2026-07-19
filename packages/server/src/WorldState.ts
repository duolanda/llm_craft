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
import { DeterministicRng } from "./DeterministicRng";
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
  readonly rng: DeterministicRng;
  readonly entities: EntityRegistry;
  tiles: TileType[][];
  resourceRemaining = new Map<string, number>();
  tileView: Tile[][];
  projectiles: ActiveProjectile[] = [];
  projectileCounter = 0;
  winner: PlayerId | null = null;
  private readonly playerStates: WorldPlayerState[];

  constructor(private readonly definition: MatchDefinition) {
    this.rng = new DeterministicRng(definition.seed);
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

    for (const player of definition.players) {
      this.createBuilding(BUILDING_TYPES.HQ, player.hq.x, player.hq.y, player.id);
      for (const workerPosition of player.workers) {
        this.createUnit(UNIT_TYPES.WORKER, workerPosition.x, workerPosition.y, player.id);
      }
    }
  }

  createUnit(type: UnitType, x: number, y: number, playerId: PlayerId): WorldUnit {
    const unit = this.entities.createUnit(type, x, y, playerId);
    this.markChanged();
    this.entities.assertInvariants();
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
    this.entities.assertInvariants();
    return building;
  }

  destroyEntity(id: string): boolean {
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
        productionQueue: [...building.productionQueue],
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

  restorePlayerCredits(playerCredits: ReadonlyArray<readonly [PlayerId, number]>): void {
    const creditsByPlayer = new Map(playerCredits);
    for (const player of this.playerStates) {
      const credits = creditsByPlayer.get(player.id);
      if (credits !== undefined) {
        player.resources.credits = credits;
      }
    }
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

  assertInvariants(): void {
    this.entities.assertInvariants();
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
