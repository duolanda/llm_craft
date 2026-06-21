import { TileType, TILE_TYPES, MAP_WIDTH, MAP_HEIGHT, DEFAULT_MAP_LAYOUT } from "@llmcraft/shared";

export class MapGenerator {
  static generate(): TileType[][] {
    const tiles: TileType[][] = [];
    const centerX = DEFAULT_MAP_LAYOUT.centerX;
    const centerY = DEFAULT_MAP_LAYOUT.centerY;
    const protectedZones = [
      { ...DEFAULT_MAP_LAYOUT.player1Hq, radius: 7 },
      { ...DEFAULT_MAP_LAYOUT.player2Hq, radius: 7 },
      ...DEFAULT_MAP_LAYOUT.player1Workers.map((position) => ({ ...position, radius: 2 })),
      ...DEFAULT_MAP_LAYOUT.player2Workers.map((position) => ({ ...position, radius: 2 })),
      ...DEFAULT_MAP_LAYOUT.resources.map((position) => ({ ...position, radius: 2 })),
    ];

    // Initialize empty map
    for (let y = 0; y < MAP_HEIGHT; y++) {
      tiles[y] = [];
      for (let x = 0; x < MAP_WIDTH; x++) {
        tiles[y][x] = TILE_TYPES.EMPTY;
      }
    }

    const isProtected = (x: number, y: number): boolean => protectedZones.some(
      (zone) => Math.max(Math.abs(x - zone.x), Math.abs(y - zone.y)) <= zone.radius
    );

    const markObstacle = (x: number, y: number): void => {
      if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT || isProtected(x, y)) {
        return;
      }
      tiles[y][x] = TILE_TYPES.OBSTACLE;
    };

    const noise = (x: number, y: number, salt: number): number => {
      const value = Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453;
      return value - Math.floor(value);
    };

    const addRockField = (
      originX: number,
      originY: number,
      radiusX: number,
      radiusY: number,
      density: number,
      salt: number,
    ): void => {
      for (let dy = -radiusY; dy <= radiusY; dy++) {
        for (let dx = -radiusX; dx <= radiusX; dx++) {
          const normalizedDistance = (dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY);
          if (normalizedDistance > 1) {
            continue;
          }

          const centerBias = (1 - normalizedDistance) * 0.22;
          if (noise(originX + dx, originY + dy, salt) + centerBias >= 1 - density) {
            markObstacle(originX + dx, originY + dy);
          }
        }
      }
    };

    // Two broken ridgelines split the battlefield into north, center and south fronts.
    // Wide gaps around x=36/72/108 keep the fronts connected for flanking manoeuvres.
    const rockFields = [
      { x: 23, y: 34, radiusX: 14, radiusY: 5, density: 0.56, salt: 1 },
      { x: 52, y: 34, radiusX: 10, radiusY: 5, density: 0.52, salt: 2 },
      { x: 91, y: 34, radiusX: 10, radiusY: 5, density: 0.52, salt: 3 },
      { x: 120, y: 34, radiusX: 14, radiusY: 5, density: 0.56, salt: 4 },
      { x: 23, y: 62, radiusX: 14, radiusY: 5, density: 0.56, salt: 5 },
      { x: 52, y: 62, radiusX: 10, radiusY: 5, density: 0.52, salt: 6 },
      { x: 91, y: 62, radiusX: 10, radiusY: 5, density: 0.52, salt: 7 },
      { x: 120, y: 62, radiusX: 14, radiusY: 5, density: 0.56, salt: 8 },
      { x: centerX, y: 9, radiusX: 22, radiusY: 3, density: 0.42, salt: 9 },
      { x: centerX, y: MAP_HEIGHT - 10, radiusX: 22, radiusY: 3, density: 0.42, salt: 10 },
    ];

    for (const field of rockFields) {
      addRockField(field.x, field.y, field.radiusX, field.radiusY, field.density, field.salt);
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
