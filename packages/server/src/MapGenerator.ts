import { TileType, TILE_TYPES, MAP_WIDTH, MAP_HEIGHT } from "@llmcraft/shared";

export class MapGenerator {
  static generate(): TileType[][] {
    const tiles: TileType[][] = [];
    const centerX = Math.floor(MAP_WIDTH / 2);
    const centerY = Math.floor(MAP_HEIGHT / 2);
    const edgeInset = 2;

    // Initialize empty map
    for (let y = 0; y < MAP_HEIGHT; y++) {
      tiles[y] = [];
      for (let x = 0; x < MAP_WIDTH; x++) {
        tiles[y][x] = TILE_TYPES.EMPTY;
      }
    }

    // Place obstacles at four corners
    const cornerObstacles = [
      { x: 5, y: 5 },
      { x: MAP_WIDTH - 6, y: 5 },
      { x: 5, y: MAP_HEIGHT - 6 },
      { x: MAP_WIDTH - 6, y: MAP_HEIGHT - 6 },
    ];
    for (const pos of cornerObstacles) {
      tiles[pos.y][pos.x] = TILE_TYPES.OBSTACLE;
    }

    // Place central vertical obstacles
    for (let y = centerY - 2; y <= centerY + 2; y++) {
      tiles[y][centerX] = TILE_TYPES.OBSTACLE;
    }

    // Place resource points at edges
    const resourcePoints = [
      { x: edgeInset, y: centerY - 3 },
      { x: edgeInset, y: centerY + 3 },
      { x: MAP_WIDTH - edgeInset - 1, y: centerY - 3 },
      { x: MAP_WIDTH - edgeInset - 1, y: centerY + 3 },
      { x: centerX - 3, y: edgeInset },
      { x: centerX + 3, y: edgeInset },
      { x: centerX - 3, y: MAP_HEIGHT - edgeInset - 1 },
      { x: centerX + 3, y: MAP_HEIGHT - edgeInset - 1 },
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
