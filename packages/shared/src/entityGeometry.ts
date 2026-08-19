import geometrySpec from "./entity-geometry.json" with { type: "json" };
import type { BuildingType, UnitType } from "./constants.js";

export type UnitBodyGeometry =
  | { shape: "circle"; radius: number }
  | { shape: "obb"; length: number; width: number };

export interface BuildingBodyGeometry {
  width: number;
  height: number;
}

export interface EntityGeometrySpec {
  coordinateUnit: "simulation_cell";
  unitBodies: Record<UnitType, UnitBodyGeometry>;
  buildingBodies: Record<BuildingType, BuildingBodyGeometry>;
}

/**
 * Canonical physical dimensions for simulation collision and shipped model bodies.
 * Decorative overhangs such as barrels, antennas, and exhaust fixtures are excluded.
 */
export const ENTITY_GEOMETRY = geometrySpec as EntityGeometrySpec;
