import {
  BUILDING_TYPES,
  DEFAULT_RULESET,
  UNIT_TYPES,
} from "./constants.js";
import type {
  ArmorType,
  AttackTargetType,
  BuildingType,
  GameRuleset,
  RulesetBuildingDefinition,
  RulesetUnitDefinition,
  RulesetWeaponDefinition,
  UnitType,
} from "./constants.js";

export const ALL_UNIT_TYPES = Object.values(UNIT_TYPES) as UnitType[];
export const ALL_BUILDING_TYPES = Object.values(BUILDING_TYPES) as BuildingType[];

const STANDARD_RETIRED_PRODUCTION_UNIT_TYPES = new Set<UnitType>([
  UNIT_TYPES.SOLDIER,
]);

export function isUnitType(value: unknown): value is UnitType {
  return typeof value === "string" && (ALL_UNIT_TYPES as string[]).includes(value);
}

export function isBuildingType(value: unknown): value is BuildingType {
  return typeof value === "string" && (ALL_BUILDING_TYPES as string[]).includes(value);
}

export function isBuildableBuildingType(value: unknown): value is Exclude<BuildingType, "hq"> {
  return isBuildingType(value) && value !== BUILDING_TYPES.HQ;
}

export function getUnitStats(unitType: UnitType, ruleset: GameRuleset = DEFAULT_RULESET): RulesetUnitDefinition {
  return ruleset.units[unitType];
}

export function getBuildingStats(
  buildingType: BuildingType,
  ruleset: GameRuleset = DEFAULT_RULESET,
): RulesetBuildingDefinition {
  return ruleset.buildings[buildingType];
}

export function getUnitCost(unitType: UnitType, ruleset: GameRuleset = DEFAULT_RULESET): number {
  return getUnitStats(unitType, ruleset).cost;
}

export function getUnitProductionTicks(unitType: UnitType, ruleset: GameRuleset = DEFAULT_RULESET): number {
  return getUnitStats(unitType, ruleset).productionTicks;
}

export function getBuildingCost(buildingType: BuildingType, ruleset: GameRuleset = DEFAULT_RULESET): number {
  return getBuildingStats(buildingType, ruleset).cost;
}

export function getBuildingConstructionTicks(buildingType: BuildingType, ruleset: GameRuleset = DEFAULT_RULESET): number {
  return getBuildingStats(buildingType, ruleset).constructionTicks;
}

export function getUnitVisionRange(unitType: UnitType, ruleset: GameRuleset = DEFAULT_RULESET): number {
  return getUnitStats(unitType, ruleset).visionRange;
}

export function getBuildingVisionRange(buildingType: BuildingType, ruleset: GameRuleset = DEFAULT_RULESET): number {
  return getBuildingStats(buildingType, ruleset).visionRange;
}

export function getBuildingFootprint(
  buildingType: BuildingType,
  ruleset: GameRuleset = DEFAULT_RULESET,
): { width: number; height: number } {
  return getBuildingStats(buildingType, ruleset).footprint;
}

export function getBuildingFootprintCells(
  buildingType: BuildingType,
  centerX: number,
  centerY: number,
  ruleset: GameRuleset = DEFAULT_RULESET,
): Array<{ x: number; y: number }> {
  const { width, height } = getBuildingFootprint(buildingType, ruleset);
  const minX = centerX - Math.floor(width / 2);
  const minY = centerY - Math.floor(height / 2);
  return Array.from({ length: width * height }, (_, index) => ({
    x: minX + (index % width),
    y: minY + Math.floor(index / width),
  }));
}

export function getDistanceToBuildingFootprint(
  buildingType: BuildingType,
  centerX: number,
  centerY: number,
  x: number,
  y: number,
  ruleset: GameRuleset = DEFAULT_RULESET,
): number {
  const { width, height } = getBuildingFootprint(buildingType, ruleset);
  const halfWidth = Math.floor(width / 2);
  const halfHeight = Math.floor(height / 2);
  return Math.max(Math.max(0, Math.abs(x - centerX) - halfWidth), Math.max(0, Math.abs(y - centerY) - halfHeight));
}

export function getProductionOptions(
  buildingType: BuildingType,
  ruleset: GameRuleset = DEFAULT_RULESET,
): UnitType[] {
  const produces = getBuildingStats(buildingType, ruleset).produces;
  return ruleset.id === DEFAULT_RULESET.id
    ? produces.filter((unitType) => !STANDARD_RETIRED_PRODUCTION_UNIT_TYPES.has(unitType))
    : [...produces];
}

export function getRetiredProductionUnitTypes(
  ruleset: GameRuleset = DEFAULT_RULESET,
): UnitType[] {
  return ruleset.id === DEFAULT_RULESET.id
    ? [...STANDARD_RETIRED_PRODUCTION_UNIT_TYPES]
    : [];
}

export function canBuildingProduce(
  buildingType: BuildingType,
  unitType: UnitType,
  ruleset: GameRuleset = DEFAULT_RULESET,
): boolean {
  return getProductionOptions(buildingType, ruleset).includes(unitType);
}

export function unitCanAttack(unitType: UnitType, ruleset: GameRuleset = DEFAULT_RULESET): boolean {
  return getUnitWeapon(unitType, ruleset).damage > 0;
}

export function getUnitArmor(unitType: UnitType, ruleset: GameRuleset = DEFAULT_RULESET): ArmorType {
  return getUnitStats(unitType, ruleset).armor;
}

export function getBuildingArmor(buildingType: BuildingType, ruleset: GameRuleset = DEFAULT_RULESET): ArmorType {
  return getBuildingStats(buildingType, ruleset).armor;
}

export function getUnitWeapon(unitType: UnitType, ruleset: GameRuleset = DEFAULT_RULESET): RulesetWeaponDefinition {
  const stats = getUnitStats(unitType, ruleset);
  return stats.weapon ?? {
    damage: stats.attack,
    range: stats.attackRange,
    reloadTicks: 1,
    projectileType: "instant",
    projectileSpeed: 99,
    damageModifiers: stats.damageModifiers,
  };
}

export function getAttackDamage(attackerType: UnitType, targetArmor: ArmorType, ruleset: GameRuleset = DEFAULT_RULESET): number {
  const weapon = getUnitWeapon(attackerType, ruleset);
  const modifier = weapon.damageModifiers?.[targetArmor] ?? getUnitStats(attackerType, ruleset).damageModifiers?.[targetArmor] ?? 1;
  return Math.max(0, Math.round(weapon.damage * modifier));
}

export function getAttackDamageAgainstUnit(
  attackerType: UnitType,
  targetType: UnitType,
  ruleset: GameRuleset = DEFAULT_RULESET,
): number {
  return getAttackDamage(attackerType, getUnitArmor(targetType, ruleset), ruleset);
}

export function getAttackDamageAgainstBuilding(
  attackerType: UnitType,
  targetType: BuildingType,
  ruleset: GameRuleset = DEFAULT_RULESET,
): number {
  return getAttackDamage(attackerType, getBuildingArmor(targetType, ruleset), ruleset);
}

export function getCombatUnitTypes(ruleset: GameRuleset = DEFAULT_RULESET): UnitType[] {
  return ALL_UNIT_TYPES.filter((unitType) => unitCanAttack(unitType, ruleset));
}

export function getDefaultAttackMovePriority(
  attackerType?: UnitType,
  ruleset: GameRuleset = DEFAULT_RULESET,
): AttackTargetType[] {
  switch (attackerType) {
    case UNIT_TYPES.RIFLEMAN:
      return getUnitWeapon(attackerType, ruleset).targetPriority ?? [
        UNIT_TYPES.RIFLEMAN,
        UNIT_TYPES.ROCKET_SOLDIER,
        UNIT_TYPES.SOLDIER,
        UNIT_TYPES.WORKER,
        UNIT_TYPES.LIGHT_TANK,
        BUILDING_TYPES.HQ,
        BUILDING_TYPES.BARRACKS,
        BUILDING_TYPES.REFINERY,
        BUILDING_TYPES.WAR_FACTORY,
      ];
    case UNIT_TYPES.ROCKET_SOLDIER:
      return getUnitWeapon(attackerType, ruleset).targetPriority ?? [
        UNIT_TYPES.LIGHT_TANK,
        BUILDING_TYPES.WAR_FACTORY,
        BUILDING_TYPES.HQ,
        BUILDING_TYPES.BARRACKS,
        BUILDING_TYPES.REFINERY,
        UNIT_TYPES.ROCKET_SOLDIER,
        UNIT_TYPES.RIFLEMAN,
        UNIT_TYPES.SOLDIER,
        UNIT_TYPES.WORKER,
      ];
    case UNIT_TYPES.LIGHT_TANK:
      return getUnitWeapon(attackerType, ruleset).targetPriority ?? [
        UNIT_TYPES.LIGHT_TANK,
        UNIT_TYPES.ROCKET_SOLDIER,
        UNIT_TYPES.RIFLEMAN,
        UNIT_TYPES.SOLDIER,
        UNIT_TYPES.WORKER,
        BUILDING_TYPES.WAR_FACTORY,
        BUILDING_TYPES.HQ,
        BUILDING_TYPES.BARRACKS,
        BUILDING_TYPES.REFINERY,
      ];
    case UNIT_TYPES.SOLDIER:
      return getUnitWeapon(attackerType, ruleset).targetPriority ?? [
        UNIT_TYPES.RIFLEMAN,
        UNIT_TYPES.ROCKET_SOLDIER,
        UNIT_TYPES.SOLDIER,
        UNIT_TYPES.WORKER,
        UNIT_TYPES.LIGHT_TANK,
        BUILDING_TYPES.HQ,
        BUILDING_TYPES.WAR_FACTORY,
        BUILDING_TYPES.BARRACKS,
        BUILDING_TYPES.REFINERY,
      ];
    default:
      return [
        BUILDING_TYPES.HQ,
        UNIT_TYPES.LIGHT_TANK,
        UNIT_TYPES.ROCKET_SOLDIER,
        UNIT_TYPES.RIFLEMAN,
        UNIT_TYPES.SOLDIER,
        UNIT_TYPES.WORKER,
        BUILDING_TYPES.WAR_FACTORY,
        BUILDING_TYPES.BARRACKS,
        BUILDING_TYPES.REFINERY,
      ];
  }
}

export function getProducerBuildingType(unitType: UnitType, ruleset: GameRuleset = DEFAULT_RULESET): BuildingType | null {
  return ALL_BUILDING_TYPES.find((buildingType) => canBuildingProduce(buildingType, unitType, ruleset)) ?? null;
}
