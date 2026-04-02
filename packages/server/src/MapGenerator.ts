import { TileType, TILE_TYPES, MAP_WIDTH, MAP_HEIGHT } from "@llmcraft/shared";

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

    // Place obstacles at four corners: (5,5), (14,5), (5,14), (14,14)
    const cornerObstacles = [
      { x: 5, y: 5 },
      { x: 14, y: 5 },
      { x: 5, y: 14 },
      { x: 14, y: 14 },
    ];
    for (const pos of cornerObstacles) {
      tiles[pos.y][pos.x] = TILE_TYPES.OBSTACLE;
    }

    // Place central cross obstacles: (10, 8-11)
    for (let y = 8; y <= 11; y++) {
      tiles[y][10] = TILE_TYPES.OBSTACLE;
    }

    // Place resource points at edges
    const resourcePoints = [
      { x: 2, y: 8 },
      { x: 2, y: 11 },
      { x: 17, y: 8 },
      { x: 17, y: 11 },
      { x: 8, y: 2 },
      { x: 11, y: 2 },
      { x: 8, y: 17 },
      { x: 11, y: 17 },
    ];
    for (const pos of resourcePoints) {
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
