import { TileType, TILE_TYPES } from "@llmcraft/shared";

export interface MapGenerationDefinition {
  width: number;
  height: number;
  resources: ReadonlyArray<{ x: number; y: number }>;
  obstacles: ReadonlyArray<{ x: number; y: number }>;
}

export class MapGenerator {
  static generate(definition: MapGenerationDefinition): TileType[][] {
    const tiles: TileType[][] = [];

    // Initialize empty map
    for (let y = 0; y < definition.height; y++) {
      tiles[y] = [];
      for (let x = 0; x < definition.width; x++) {
        tiles[y][x] = TILE_TYPES.EMPTY;
      }
    }

    for (const pos of definition.resources) {
      tiles[pos.y][pos.x] = TILE_TYPES.RESOURCE;
    }
    for (const pos of definition.obstacles) {
      tiles[pos.y][pos.x] = TILE_TYPES.OBSTACLE;
    }

    return tiles;
  }

  static isWalkable(tiles: TileType[][], x: number, y: number): boolean {
    // Check bounds
    if (x < 0 || y < 0 || y >= tiles.length || x >= (tiles[y]?.length ?? 0)) {
      return false;
    }

    // Check if tile is walkable (not obstacle)
    return tiles[y][x] !== TILE_TYPES.OBSTACLE;
  }
}
