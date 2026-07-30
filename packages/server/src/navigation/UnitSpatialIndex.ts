import type { WorldUnit } from "../WorldUnit";

const BUCKET_SIZE = 2;

function bucketCoordinate(value: number): number {
  return Math.floor(value / BUCKET_SIZE);
}

function bucketKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Small deterministic broad-phase index for local unit interactions. */
export class UnitSpatialIndex {
  private readonly buckets = new Map<string, Set<WorldUnit>>();

  constructor(units: readonly WorldUnit[]) {
    for (const unit of units) this.add(unit);
  }

  add(unit: WorldUnit): void {
    const key = bucketKey(bucketCoordinate(unit.x), bucketCoordinate(unit.y));
    const bucket = this.buckets.get(key) ?? new Set<WorldUnit>();
    bucket.add(unit);
    this.buckets.set(key, bucket);
  }

  remove(unit: WorldUnit): void {
    const key = bucketKey(bucketCoordinate(unit.x), bucketCoordinate(unit.y));
    const bucket = this.buckets.get(key);
    bucket?.delete(unit);
    if (bucket?.size === 0) this.buckets.delete(key);
  }

  query(x: number, y: number, radius: number): WorldUnit[] {
    const minX = bucketCoordinate(x - radius);
    const maxX = bucketCoordinate(x + radius);
    const minY = bucketCoordinate(y - radius);
    const maxY = bucketCoordinate(y + radius);
    const result: WorldUnit[] = [];
    for (let bucketY = minY; bucketY <= maxY; bucketY++) {
      for (let bucketX = minX; bucketX <= maxX; bucketX++) {
        for (const unit of this.buckets.get(bucketKey(bucketX, bucketY)) ?? []) {
          result.push(unit);
        }
      }
    }
    return result;
  }
}
