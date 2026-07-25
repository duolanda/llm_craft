import type { PlayerId, UnitType } from "@llmcraft/shared";
import type { WorldUnit } from "../WorldUnit";
import type { CollisionShape } from "./CollisionShape";
import { getMovementProfile } from "./MovementProfile";

export function getDefaultUnitHeading(playerId: PlayerId): number {
  return playerId === "player_1" ? 0 : Math.PI;
}

export function getUnitHeading(unit: WorldUnit): number {
  return unit.heading ?? getDefaultUnitHeading(unit.playerId);
}

export function getHeadingToward(
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  fallback: number,
): number {
  const dx = targetX - startX;
  const dy = targetY - startY;
  return Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dy, dx) : fallback;
}

export function createUnitCollisionShape(
  type: UnitType,
  x: number,
  y: number,
  heading: number,
): CollisionShape {
  const collisionShape = getMovementProfile(type).collisionShape;
  return collisionShape.kind === "circle"
    ? { kind: "circle", x, y, radius: collisionShape.radius }
    : {
        kind: "obb",
        x,
        y,
        heading,
        halfLength: collisionShape.halfLength,
        halfWidth: collisionShape.halfWidth,
      };
}

export function getUnitCollisionShape(
  unit: WorldUnit,
  x = unit.x,
  y = unit.y,
  heading = getUnitHeading(unit),
): CollisionShape {
  return createUnitCollisionShape(unit.type, x, y, heading);
}
