import { type UnitType, UNIT_TYPES } from "@llmcraft/shared";

/**
 * Physical movement properties owned by the simulation.
 *
 * Path finding uses a conservative navigation radius; local avoidance uses
 * the exact collision shape and priority. Future interactions such as crushing belong here as an explicit
 * policy between movement profiles, rather than as a special case in A*.
 */
export interface MovementProfile {
  collisionShape:
    | { kind: "circle"; radius: number }
    | { kind: "obb"; halfLength: number; halfWidth: number };
  navigationRadius: number;
  avoidancePriority: number;
  locomotionLayer: "ground";
}

const MOVEMENT_PROFILES: Record<UnitType, MovementProfile> = {
  // Radii match the rendered body footprint in simulation-cell units. Weapons
  // and barrels may overhang, but torsos and vehicle hulls must not interpenetrate.
  [UNIT_TYPES.WORKER]: {
    collisionShape: { kind: "circle", radius: 0.44 },
    navigationRadius: 0.44,
    avoidancePriority: 10,
    locomotionLayer: "ground",
  },
  [UNIT_TYPES.SOLDIER]: {
    collisionShape: { kind: "circle", radius: 0.45 },
    navigationRadius: 0.45,
    avoidancePriority: 20,
    locomotionLayer: "ground",
  },
  [UNIT_TYPES.RIFLEMAN]: {
    collisionShape: { kind: "circle", radius: 0.45 },
    navigationRadius: 0.45,
    avoidancePriority: 20,
    locomotionLayer: "ground",
  },
  [UNIT_TYPES.ROCKET_SOLDIER]: {
    collisionShape: { kind: "circle", radius: 0.46 },
    navigationRadius: 0.46,
    avoidancePriority: 20,
    locomotionLayer: "ground",
  },
  [UNIT_TYPES.LIGHT_TANK]: {
    // Rendered hull footprint is approximately 3.07 × 2.06 cells.
    // Leave a small visual tolerance while excluding turret/barrel overhang.
    collisionShape: { kind: "obb", halfLength: 1.48, halfWidth: 0.98 },
    // Global grid search is orientation-free, so use the circumscribed radius.
    // Exact OBB checks recover the useful free space during local movement.
    navigationRadius: Math.hypot(1.48, 0.98),
    avoidancePriority: 30,
    locomotionLayer: "ground",
  },
};

export function getMovementProfile(type: UnitType): MovementProfile {
  return MOVEMENT_PROFILES[type];
}

export function getCollisionBoundingRadius(type: UnitType): number {
  const shape = getMovementProfile(type).collisionShape;
  return shape.kind === "circle"
    ? shape.radius
    : Math.hypot(shape.halfLength, shape.halfWidth);
}
