import { ENTITY_GEOMETRY, type UnitType, UNIT_TYPES } from "@llmcraft/shared";

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
  /** Unit types this mover may pass through by crushing during committed movement. */
  crushes?: readonly UnitType[];
}

function createMovementProfile(
  type: UnitType,
  avoidancePriority: number,
  crushes?: readonly UnitType[],
): MovementProfile {
  const body = ENTITY_GEOMETRY.unitBodies[type];
  const collisionShape: MovementProfile["collisionShape"] = body.shape === "circle"
    ? { kind: "circle", radius: body.radius }
    : { kind: "obb", halfLength: body.length / 2, halfWidth: body.width / 2 };
  const navigationRadius = collisionShape.kind === "circle"
    ? collisionShape.radius
    : Math.hypot(collisionShape.halfLength, collisionShape.halfWidth);
  return {
    collisionShape,
    navigationRadius,
    avoidancePriority,
    locomotionLayer: "ground",
    ...(crushes ? { crushes } : {}),
  };
}

const MOVEMENT_PROFILES: Record<UnitType, MovementProfile> = {
  // Radii match the rendered body footprint in simulation-cell units. Weapons
  // and barrels may overhang, but torsos and vehicle hulls must not interpenetrate.
  [UNIT_TYPES.WORKER]: createMovementProfile(UNIT_TYPES.WORKER, 10),
  [UNIT_TYPES.SOLDIER]: createMovementProfile(UNIT_TYPES.SOLDIER, 20),
  [UNIT_TYPES.RIFLEMAN]: createMovementProfile(UNIT_TYPES.RIFLEMAN, 20),
  [UNIT_TYPES.ROCKET_SOLDIER]: createMovementProfile(UNIT_TYPES.ROCKET_SOLDIER, 20),
  [UNIT_TYPES.COMMANDO]: createMovementProfile(UNIT_TYPES.COMMANDO, 22),
  [UNIT_TYPES.LIGHT_TANK]: createMovementProfile(
    UNIT_TYPES.LIGHT_TANK,
    30,
    [UNIT_TYPES.WORKER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.ROCKET_SOLDIER],
  ),
  [UNIT_TYPES.FLAME_TANK]: createMovementProfile(
    UNIT_TYPES.FLAME_TANK,
    30,
    [UNIT_TYPES.WORKER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.ROCKET_SOLDIER],
  ),
  [UNIT_TYPES.HEAVY_TANK]: createMovementProfile(
    UNIT_TYPES.HEAVY_TANK,
    40,
    [UNIT_TYPES.WORKER, UNIT_TYPES.RIFLEMAN, UNIT_TYPES.ROCKET_SOLDIER],
  ),
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

export function getMaximumCollisionBoundingRadius(): number {
  return Math.max(...Object.values(MOVEMENT_PROFILES).map((profile) => {
    const shape = profile.collisionShape;
    return shape.kind === "circle" ? shape.radius : Math.hypot(shape.halfLength, shape.halfWidth);
  }));
}

export function canCrushUnit(moverType: UnitType, targetType: UnitType): boolean {
  return getMovementProfile(moverType).crushes?.includes(targetType) ?? false;
}
