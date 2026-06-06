import {
  ArmorType,
  AttackTargetType,
  BUILDING_TYPES,
  BuildingType,
  DEFAULT_RULESET,
  GameRuleset,
  RulesetBuildingDefinition,
  RulesetUnitDefinition,
  UNIT_TYPES,
  UnitType,
} from "./constants";

export const ALL_UNIT_TYPES = Object.values(UNIT_TYPES) as UnitType[];
export const ALL_BUILDING_TYPES = Object.values(BUILDING_TYPES) as BuildingType[];

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

export function getBuildingCost(buildingType: BuildingType, ruleset: GameRuleset = DEFAULT_RULESET): number {
  return getBuildingStats(buildingType, ruleset).cost;
}

export function getUnitVisionRange(unitType: UnitType, ruleset: GameRuleset = DEFAULT_RULESET): number {
  return getUnitStats(unitType, ruleset).visionRange;
}

export function getBuildingVisionRange(buildingType: BuildingType, ruleset: GameRuleset = DEFAULT_RULESET): number {
  return getBuildingStats(buildingType, ruleset).visionRange;
}

export function getProductionOptions(
  buildingType: BuildingType,
  ruleset: GameRuleset = DEFAULT_RULESET,
): UnitType[] {
  return [...getBuildingStats(buildingType, ruleset).produces];
}

export function canBuildingProduce(
  buildingType: BuildingType,
  unitType: UnitType,
  ruleset: GameRuleset = DEFAULT_RULESET,
): boolean {
  return getBuildingStats(buildingType, ruleset).produces.includes(unitType);
}

export function unitCanAttack(unitType: UnitType, ruleset: GameRuleset = DEFAULT_RULESET): boolean {
  return getUnitStats(unitType, ruleset).attack > 0;
}

export function getUnitArmor(unitType: UnitType, ruleset: GameRuleset = DEFAULT_RULESET): ArmorType {
  return getUnitStats(unitType, ruleset).armor;
}

export function getBuildingArmor(buildingType: BuildingType, ruleset: GameRuleset = DEFAULT_RULESET): ArmorType {
  return getBuildingStats(buildingType, ruleset).armor;
}

export function getAttackDamage(attackerType: UnitType, targetArmor: ArmorType, ruleset: GameRuleset = DEFAULT_RULESET): number {
  const attackerStats = getUnitStats(attackerType, ruleset);
  const modifier = attackerStats.damageModifiers?.[targetArmor] ?? 1;
  return Math.max(0, Math.round(attackerStats.attack * modifier));
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
      return [
        UNIT_TYPES.RIFLEMAN,
        UNIT_TYPES.ROCKET_SOLDIER,
        UNIT_TYPES.SOLDIER,
        UNIT_TYPES.WORKER,
        UNIT_TYPES.LIGHT_TANK,
        BUILDING_TYPES.HQ,
        BUILDING_TYPES.BARRACKS,
        BUILDING_TYPES.WAR_FACTORY,
      ];
    case UNIT_TYPES.ROCKET_SOLDIER:
      return [
        UNIT_TYPES.LIGHT_TANK,
        BUILDING_TYPES.WAR_FACTORY,
        BUILDING_TYPES.HQ,
        BUILDING_TYPES.BARRACKS,
        UNIT_TYPES.ROCKET_SOLDIER,
        UNIT_TYPES.RIFLEMAN,
        UNIT_TYPES.SOLDIER,
        UNIT_TYPES.WORKER,
      ];
    case UNIT_TYPES.LIGHT_TANK:
      return [
        BUILDING_TYPES.HQ,
        BUILDING_TYPES.WAR_FACTORY,
        BUILDING_TYPES.BARRACKS,
        UNIT_TYPES.LIGHT_TANK,
        UNIT_TYPES.ROCKET_SOLDIER,
        UNIT_TYPES.RIFLEMAN,
        UNIT_TYPES.SOLDIER,
        UNIT_TYPES.WORKER,
      ];
    case UNIT_TYPES.SOLDIER:
      return [
        UNIT_TYPES.RIFLEMAN,
        UNIT_TYPES.ROCKET_SOLDIER,
        UNIT_TYPES.SOLDIER,
        UNIT_TYPES.WORKER,
        UNIT_TYPES.LIGHT_TANK,
        BUILDING_TYPES.HQ,
        BUILDING_TYPES.WAR_FACTORY,
        BUILDING_TYPES.BARRACKS,
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
      ];
  }
}

export function getProducerBuildingType(unitType: UnitType, ruleset: GameRuleset = DEFAULT_RULESET): BuildingType | null {
  return ALL_BUILDING_TYPES.find((buildingType) => canBuildingProduce(buildingType, unitType, ruleset)) ?? null;
}
