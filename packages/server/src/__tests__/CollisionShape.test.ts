import { describe, expect, it } from "vitest";
import { TILE_TYPES, UNIT_TYPES, type TileType } from "@llmcraft/shared";
import {
  getCollisionManifold,
  type CircleShape,
  type ObbShape,
} from "../navigation/CollisionShape";
import { isShapeBlockedByGrid } from "../navigation/NavigationGrid";
import { createUnitCollisionShape } from "../navigation/UnitCollision";

function obb(
  x: number,
  y: number,
  halfLength: number,
  halfWidth: number,
  heading = 0,
): ObbShape {
  return { kind: "obb", x, y, halfLength, halfWidth, heading };
}

function circle(x: number, y: number, radius: number): CircleShape {
  return { kind: "circle", x, y, radius };
}

describe("collision shapes", () => {
  it("treats touching circles as contact rather than penetration", () => {
    expect(getCollisionManifold(circle(0, 0, 0.5), circle(1, 0, 0.5))).toBeNull();
    expect(getCollisionManifold(circle(0, 0, 0.5), circle(0.9, 0, 0.5))).toMatchObject({
      normalX: 1,
      normalY: 0,
      depth: expect.closeTo(0.1),
    });
  });

  it("uses a tank's shorter side footprint instead of its bounding circle", () => {
    const left = createUnitCollisionShape(UNIT_TYPES.LIGHT_TANK, 0, 0, 0);
    const sideBySide = createUnitCollisionShape(UNIT_TYPES.LIGHT_TANK, 0, 2, 0);
    const endToEnd = createUnitCollisionShape(UNIT_TYPES.LIGHT_TANK, 2, 0, 0);

    expect(getCollisionManifold(left, sideBySide)).toBeNull();
    expect(getCollisionManifold(left, endToEnd)).not.toBeNull();
  });

  it("detects perpendicular and rotated OBB intersections with a separating axis", () => {
    const horizontal = obb(0, 0, 1.5, 0.5);
    const perpendicular = obb(1.2, 0, 1.5, 0.5, Math.PI / 2);
    const manifold = getCollisionManifold(horizontal, perpendicular);

    expect(manifold).not.toBeNull();
    expect(manifold!.depth).toBeGreaterThan(0);
    expect(Math.hypot(manifold!.normalX, manifold!.normalY)).toBeCloseTo(1);
  });

  it("tests infantry circles exactly against a tank hull", () => {
    const tank = createUnitCollisionShape(UNIT_TYPES.LIGHT_TANK, 10, 10, 0);
    const clearAtSide = createUnitCollisionShape(UNIT_TYPES.SOLDIER, 10, 11.5, 0);
    const collidingAtNose = createUnitCollisionShape(UNIT_TYPES.SOLDIER, 11.7, 10, 0);

    expect(getCollisionManifold(tank, clearAtSide)).toBeNull();
    expect(getCollisionManifold(tank, collidingAtNose)).not.toBeNull();
  });

  it("uses the rotated OBB when checking blocked terrain cells", () => {
    const tiles: TileType[][] = Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, () => TILE_TYPES.EMPTY),
    );
    tiles[4][6] = TILE_TYPES.OBSTACLE;

    expect(isShapeBlockedByGrid(obb(4, 4, 1.48, 0.98, 0), tiles)).toBe(false);
    expect(isShapeBlockedByGrid(obb(4, 4, 1.48, 0.98, Math.PI / 4), tiles)).toBe(true);
  });
});
