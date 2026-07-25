import { TILE_TYPES, type TileType } from "@llmcraft/shared";
import {
  createCellShape,
  getCollisionManifold,
  getShapeBounds,
  type CollisionShape,
} from "./CollisionShape";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Tests a circular locomotion footprint against map edges and blocked cells. */
export function isDiscBlockedByGrid(
  x: number,
  y: number,
  radius: number,
  tiles: TileType[][],
  blockedPositions?: ReadonlySet<string>,
): boolean {
  const height = tiles.length;
  const width = tiles[0]?.length ?? 0;
  if (width === 0 || height === 0) return true;
  if (
    x - radius < -0.5
    || x + radius > width - 0.5
    || y - radius < -0.5
    || y + radius > height - 0.5
  ) {
    return true;
  }

  const minCellX = Math.max(0, Math.floor(x - radius - 0.5));
  const maxCellX = Math.min(width - 1, Math.ceil(x + radius + 0.5));
  const minCellY = Math.max(0, Math.floor(y - radius - 0.5));
  const maxCellY = Math.min(height - 1, Math.ceil(y + radius + 0.5));
  const radiusSquared = radius * radius;

  for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      const blocked = tiles[cellY][cellX] === TILE_TYPES.OBSTACLE
        || Boolean(blockedPositions?.has(`${cellX},${cellY}`));
      if (!blocked) continue;
      const closestX = clamp(x, cellX - 0.5, cellX + 0.5);
      const closestY = clamp(y, cellY - 0.5, cellY + 0.5);
      const dx = x - closestX;
      const dy = y - closestY;
      if (dx * dx + dy * dy < radiusSquared) return true;
    }
  }
  return false;
}

/** Exact Circle/OBB test used by local movement, spawn and separation. */
export function isShapeBlockedByGrid(
  shape: CollisionShape,
  tiles: TileType[][],
  blockedPositions?: ReadonlySet<string>,
): boolean {
  const height = tiles.length;
  const width = tiles[0]?.length ?? 0;
  if (width === 0 || height === 0) return true;
  const bounds = getShapeBounds(shape);
  if (
    bounds.minX < -0.5
    || bounds.maxX > width - 0.5
    || bounds.minY < -0.5
    || bounds.maxY > height - 0.5
  ) {
    return true;
  }

  const minCellX = Math.max(0, Math.floor(bounds.minX - 0.5));
  const maxCellX = Math.min(width - 1, Math.ceil(bounds.maxX + 0.5));
  const minCellY = Math.max(0, Math.floor(bounds.minY - 0.5));
  const maxCellY = Math.min(height - 1, Math.ceil(bounds.maxY + 0.5));
  for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      const blocked = tiles[cellY][cellX] === TILE_TYPES.OBSTACLE
        || Boolean(blockedPositions?.has(`${cellX},${cellY}`));
      if (blocked && getCollisionManifold(shape, createCellShape(cellX, cellY))) return true;
    }
  }
  return false;
}
