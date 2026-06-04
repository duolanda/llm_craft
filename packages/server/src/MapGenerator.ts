import { TileType, TILE_TYPES, MAP_WIDTH, MAP_HEIGHT } from "@llmcraft/shared";

export class MapGenerator {
  static generate(width = MAP_WIDTH, height = MAP_HEIGHT): TileType[][] {
    const tiles: TileType[][] = [];
    const centerX = Math.floor(width / 2);
    const centerY = Math.floor(height / 2);
    const edgeInset = 2;

    // Initialize empty map
    for (let y = 0; y < height; y++) {
      tiles[y] = [];
      for (let x = 0; x < width; x++) {
        tiles[y][x] = TILE_TYPES.EMPTY;
      }
    }

    // Place obstacles at four corners
    const cornerObstacles = [
      { x: 5, y: 5 },
      { x: width - 6, y: 5 },
      { x: 5, y: height - 6 },
      { x: width - 6, y: height - 6 },
    ].filter((pos) => pos.x > 0 && pos.x < width - 1 && pos.y > 0 && pos.y < height - 1);
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
      { x: width - edgeInset - 1, y: centerY - 3 },
      { x: width - edgeInset - 1, y: centerY + 3 },
      { x: centerX - 3, y: edgeInset },
      { x: centerX + 3, y: edgeInset },
      { x: centerX - 3, y: height - edgeInset - 1 },
      { x: centerX + 3, y: height - edgeInset - 1 },
    ].filter((pos) => pos.x >= 0 && pos.x < width && pos.y >= 0 && pos.y < height);
    for (const pos of resourcePoints) {
      tiles[pos.y][pos.x] = TILE_TYPES.RESOURCE;
    }

    return tiles;
  }

  static isWalkable(tiles: TileType[][], x: number, y: number): boolean {
    const height = tiles.length;
    const width = tiles[0]?.length ?? 0;
    // Check bounds
    if (x < 0 || x >= width || y < 0 || y >= height) {
      return false;
    }

    // Check if tile is walkable (not obstacle)
    return tiles[y][x] !== TILE_TYPES.OBSTACLE;
  }
}
