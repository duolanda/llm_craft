import { describe, expect, it } from "vitest";
import {
  BUILDING_STATS,
  BUILDING_TYPES,
  UNIT_STATS,
  UNIT_TYPES,
  canBuildingProduce,
  getAttackDamageAgainstBuilding,
  getAttackDamageAgainstUnit,
  getBuildingCost,
  getBuildingStats,
  getDefaultAttackMovePriority,
  getProductionOptions,
  getUnitCost,
  getUnitStats,
  getBuildingVisionRange,
  getUnitVisionRange,
  unitCanAttack,
} from "@llmcraft/shared";

describe("default ruleset", () => {
  it("keeps compatibility stats aligned with ruleset unit definitions", () => {
    expect(getUnitStats(UNIT_TYPES.WORKER)).toEqual(UNIT_STATS.worker);
    expect(getUnitStats(UNIT_TYPES.SOLDIER)).toEqual(UNIT_STATS.soldier);
    expect(getUnitStats(UNIT_TYPES.RIFLEMAN)).toEqual(UNIT_STATS.rifleman);
    expect(getUnitStats(UNIT_TYPES.ROCKET_SOLDIER)).toEqual(UNIT_STATS.rocket_soldier);
    expect(getUnitStats(UNIT_TYPES.LIGHT_TANK)).toEqual(UNIT_STATS.light_tank);
    expect(getUnitCost(UNIT_TYPES.WORKER)).toBe(50);
    expect(getUnitCost(UNIT_TYPES.SOLDIER)).toBe(80);
    expect(getUnitCost(UNIT_TYPES.RIFLEMAN)).toBe(90);
    expect(getUnitCost(UNIT_TYPES.ROCKET_SOLDIER)).toBe(140);
    expect(getUnitCost(UNIT_TYPES.LIGHT_TANK)).toBe(300);
    expect(unitCanAttack(UNIT_TYPES.WORKER)).toBe(false);
    expect(unitCanAttack(UNIT_TYPES.SOLDIER)).toBe(true);
    expect(unitCanAttack(UNIT_TYPES.RIFLEMAN)).toBe(true);
    expect(unitCanAttack(UNIT_TYPES.ROCKET_SOLDIER)).toBe(true);
    expect(unitCanAttack(UNIT_TYPES.LIGHT_TANK)).toBe(true);
  });

  it("defines vision ranges for units and buildings", () => {
    expect(getUnitVisionRange(UNIT_TYPES.WORKER)).toBe(5);
    expect(getUnitVisionRange(UNIT_TYPES.RIFLEMAN)).toBe(6);
    expect(getUnitVisionRange(UNIT_TYPES.ROCKET_SOLDIER)).toBe(6);
    expect(getUnitVisionRange(UNIT_TYPES.LIGHT_TANK)).toBe(7);
    expect(getBuildingVisionRange(BUILDING_TYPES.HQ)).toBe(8);
    expect(getBuildingVisionRange(BUILDING_TYPES.BARRACKS)).toBe(6);
  });

  it("applies armor-based damage modifiers", () => {
    expect(getAttackDamageAgainstUnit(UNIT_TYPES.SOLDIER, UNIT_TYPES.SOLDIER)).toBe(12);
    expect(getAttackDamageAgainstUnit(UNIT_TYPES.RIFLEMAN, UNIT_TYPES.WORKER)).toBe(17);
    expect(getAttackDamageAgainstUnit(UNIT_TYPES.RIFLEMAN, UNIT_TYPES.LIGHT_TANK)).toBe(6);
    expect(getAttackDamageAgainstUnit(UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.LIGHT_TANK)).toBe(48);
    expect(getAttackDamageAgainstBuilding(UNIT_TYPES.ROCKET_SOLDIER, BUILDING_TYPES.HQ)).toBe(24);
    expect(getAttackDamageAgainstBuilding(UNIT_TYPES.LIGHT_TANK, BUILDING_TYPES.BARRACKS)).toBe(36);
  });

  it("keeps the large-map HQ time-to-kill above a reaction window", () => {
    const hqHp = getBuildingStats(BUILDING_TYPES.HQ).hp;
    const singleTankTicksToKillHQ = Math.ceil(hqHp / getAttackDamageAgainstBuilding(UNIT_TYPES.LIGHT_TANK, BUILDING_TYPES.HQ));
    const fourRocketTicksToKillHQ = Math.ceil(hqHp / (getAttackDamageAgainstBuilding(UNIT_TYPES.ROCKET_SOLDIER, BUILDING_TYPES.HQ) * 4));

    expect(singleTankTicksToKillHQ).toBeGreaterThanOrEqual(36);
    expect(fourRocketTicksToKillHQ).toBeGreaterThanOrEqual(14);
  });

  it("uses role-aware default attack target priorities", () => {
    expect(getDefaultAttackMovePriority(UNIT_TYPES.RIFLEMAN).slice(0, 4)).toEqual([
      UNIT_TYPES.RIFLEMAN,
      UNIT_TYPES.ROCKET_SOLDIER,
      UNIT_TYPES.SOLDIER,
      UNIT_TYPES.WORKER,
    ]);
    expect(getDefaultAttackMovePriority(UNIT_TYPES.ROCKET_SOLDIER).slice(0, 3)).toEqual([
      UNIT_TYPES.LIGHT_TANK,
      BUILDING_TYPES.WAR_FACTORY,
      BUILDING_TYPES.HQ,
    ]);
    expect(getDefaultAttackMovePriority(UNIT_TYPES.LIGHT_TANK).slice(0, 3)).toEqual([
      BUILDING_TYPES.HQ,
      BUILDING_TYPES.WAR_FACTORY,
      BUILDING_TYPES.BARRACKS,
    ]);
  });

  it("keeps compatibility stats aligned with ruleset building definitions", () => {
    expect(getBuildingStats(BUILDING_TYPES.HQ)).toMatchObject(BUILDING_STATS.hq);
    expect(getBuildingStats(BUILDING_TYPES.BARRACKS)).toMatchObject(BUILDING_STATS.barracks);
    expect(getBuildingStats(BUILDING_TYPES.WAR_FACTORY)).toMatchObject(BUILDING_STATS.war_factory);
    expect(getBuildingCost(BUILDING_TYPES.HQ)).toBe(0);
    expect(getBuildingCost(BUILDING_TYPES.BARRACKS)).toBe(120);
    expect(getBuildingCost(BUILDING_TYPES.WAR_FACTORY)).toBe(220);
  });

  it("centralizes current production rules in the default ruleset", () => {
    expect(getProductionOptions(BUILDING_TYPES.HQ)).toEqual([UNIT_TYPES.WORKER]);
    expect(getProductionOptions(BUILDING_TYPES.BARRACKS)).toEqual([
      UNIT_TYPES.SOLDIER,
      UNIT_TYPES.RIFLEMAN,
      UNIT_TYPES.ROCKET_SOLDIER,
    ]);
    expect(getProductionOptions(BUILDING_TYPES.WAR_FACTORY)).toEqual([UNIT_TYPES.LIGHT_TANK]);
    expect(canBuildingProduce(BUILDING_TYPES.HQ, UNIT_TYPES.WORKER)).toBe(true);
    expect(canBuildingProduce(BUILDING_TYPES.HQ, UNIT_TYPES.SOLDIER)).toBe(false);
    expect(canBuildingProduce(BUILDING_TYPES.BARRACKS, UNIT_TYPES.SOLDIER)).toBe(true);
    expect(canBuildingProduce(BUILDING_TYPES.BARRACKS, UNIT_TYPES.RIFLEMAN)).toBe(true);
    expect(canBuildingProduce(BUILDING_TYPES.BARRACKS, UNIT_TYPES.ROCKET_SOLDIER)).toBe(true);
    expect(canBuildingProduce(BUILDING_TYPES.BARRACKS, UNIT_TYPES.LIGHT_TANK)).toBe(false);
    expect(canBuildingProduce(BUILDING_TYPES.WAR_FACTORY, UNIT_TYPES.LIGHT_TANK)).toBe(true);
    expect(canBuildingProduce(BUILDING_TYPES.BARRACKS, UNIT_TYPES.WORKER)).toBe(false);
  });
});
