import { TileType, TILE_TYPES, MAP_WIDTH, MAP_HEIGHT, DEFAULT_MAP_LAYOUT } from "@llmcraft/shared";

export class MapGenerator {
  static generate(): TileType[][] {
    const tiles: TileType[][] = [];

    // Initialize empty map
    for (let y = 0; y < MAP_HEIGHT; y++) {
      tiles[y] = [];
      for (let x = 0; x < MAP_WIDTH; x++) {
        tiles[y][x] = TILE_TYPES.EMPTY;
      }
    }

    for (const pos of DEFAULT_MAP_LAYOUT.resources) {
      tiles[pos.y][pos.x] = TILE_TYPES.RESOURCE;
    }

    return tiles;
  }

  static isWalkable(tiles: TileType[][], x: number, y: number): boolean {
    // Check bounds
    if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
      return false;
    }

    // Check if tile is walkable (not obstacle)
    return tiles[y][x] !== TILE_TYPES.OBSTACLE;
  }
}
