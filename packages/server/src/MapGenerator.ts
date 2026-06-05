import { TileType, TILE_TYPES, MAP_WIDTH, MAP_HEIGHT, DEFAULT_MAP_LAYOUT } from "@llmcraft/shared";

export class MapGenerator {
  static generate(): TileType[][] {
    const tiles: TileType[][] = [];
    const centerX = DEFAULT_MAP_LAYOUT.centerX;
    const centerY = DEFAULT_MAP_LAYOUT.centerY;

    // Initialize empty map
    for (let y = 0; y < MAP_HEIGHT; y++) {
      tiles[y] = [];
      for (let x = 0; x < MAP_WIDTH; x++) {
        tiles[y][x] = TILE_TYPES.EMPTY;
      }
    }

    const obstaclePoints = [
      { x: 8, y: 6 },
      { x: 8, y: 18 },
      { x: MAP_WIDTH - 9, y: 6 },
      { x: MAP_WIDTH - 9, y: 18 },
      { x: centerX, y: centerY - 7 },
      { x: centerX, y: centerY - 6 },
      { x: centerX, y: centerY - 5 },
      { x: centerX - 1, y: centerY - 4 },
      { x: centerX + 1, y: centerY + 4 },
      { x: centerX, y: centerY + 5 },
      { x: centerX, y: centerY + 6 },
      { x: centerX, y: centerY + 7 },
    ];
    for (const pos of obstaclePoints) {
      if (pos.x >= 0 && pos.x < MAP_WIDTH && pos.y >= 0 && pos.y < MAP_HEIGHT) {
        tiles[pos.y][pos.x] = TILE_TYPES.OBSTACLE;
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
