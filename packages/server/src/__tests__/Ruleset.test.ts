import { describe, expect, it } from "vitest";
import {
  BUILDING_STATS,
  BUILDING_TYPES,
  ENTITY_GEOMETRY,
  UNIT_STATS,
  UNIT_TYPES,
  canBuildingProduce,
  getAttackDamageAgainstBuilding,
  getAttackDamageAgainstUnit,
  getAttackSourceWeaponAgainstArmor,
  getBuildingCost,
  getBuildingFootprint,
  getBuildingStats,
  getDefaultAttackMovePriority,
  getProductionOptions,
  getRetiredProductionUnitTypes,
  getUnitCost,
  getUnitStats,
  getUnitProductionTicks,
  getUnitLimit,
  getUnitWeapon,
  getBuildingVisionRange,
  getBuildingPrerequisites,
  getBuildingWeapon,
  getUnitPrerequisites,
  getUnitVisionRange,
  unitCanAttack,
} from "@llmcraft/shared";

describe("default ruleset", () => {
  it("keeps canonical building model bodies aligned with gameplay footprints", () => {
    for (const buildingType of Object.values(BUILDING_TYPES)) {
      expect(ENTITY_GEOMETRY.buildingBodies[buildingType]).toEqual(getBuildingFootprint(buildingType));
    }
  });

  it("keeps convenience stats aligned with ruleset unit definitions", () => {
    expect(getUnitStats(UNIT_TYPES.WORKER)).toEqual(UNIT_STATS.worker);
    expect(getUnitStats(UNIT_TYPES.SOLDIER)).toEqual(UNIT_STATS.soldier);
    expect(getUnitStats(UNIT_TYPES.RIFLEMAN)).toEqual(UNIT_STATS.rifleman);
    expect(getUnitStats(UNIT_TYPES.ROCKET_SOLDIER)).toEqual(UNIT_STATS.rocket_soldier);
    expect(getUnitStats(UNIT_TYPES.COMMANDO)).toEqual(UNIT_STATS.commando);
    expect(getUnitStats(UNIT_TYPES.LIGHT_TANK)).toEqual(UNIT_STATS.light_tank);
    expect(getUnitStats(UNIT_TYPES.FLAME_TANK)).toEqual(UNIT_STATS.flame_tank);
    expect(getUnitStats(UNIT_TYPES.HEAVY_TANK)).toEqual(UNIT_STATS.heavy_tank);
    expect(getUnitCost(UNIT_TYPES.WORKER)).toBe(50);
    expect(getUnitCost(UNIT_TYPES.SOLDIER)).toBe(55);
    expect(getUnitCost(UNIT_TYPES.RIFLEMAN)).toBe(70);
    expect(getUnitCost(UNIT_TYPES.ROCKET_SOLDIER)).toBe(110);
    expect(getUnitCost(UNIT_TYPES.COMMANDO)).toBe(600);
    expect(getUnitCost(UNIT_TYPES.LIGHT_TANK)).toBe(240);
    expect(getUnitCost(UNIT_TYPES.FLAME_TANK)).toBe(320);
    expect(unitCanAttack(UNIT_TYPES.WORKER)).toBe(false);
    expect(unitCanAttack(UNIT_TYPES.SOLDIER)).toBe(true);
    expect(unitCanAttack(UNIT_TYPES.RIFLEMAN)).toBe(true);
    expect(unitCanAttack(UNIT_TYPES.ROCKET_SOLDIER)).toBe(true);
    expect(unitCanAttack(UNIT_TYPES.COMMANDO)).toBe(true);
    expect(unitCanAttack(UNIT_TYPES.LIGHT_TANK)).toBe(true);
    expect(unitCanAttack(UNIT_TYPES.FLAME_TANK)).toBe(true);
    expect(getUnitProductionTicks(UNIT_TYPES.SOLDIER)).toBe(4);
    expect(getUnitProductionTicks(UNIT_TYPES.LIGHT_TANK)).toBe(14);
    expect(getUnitProductionTicks(UNIT_TYPES.FLAME_TANK)).toBe(18);
    expect(getUnitProductionTicks(UNIT_TYPES.COMMANDO)).toBe(24);
    expect(getUnitLimit(UNIT_TYPES.COMMANDO)).toBe(1);
  });

  it("defines vision ranges for units and buildings", () => {
    expect(getUnitVisionRange(UNIT_TYPES.WORKER)).toBe(5);
    expect(getUnitVisionRange(UNIT_TYPES.RIFLEMAN)).toBe(7);
    expect(getUnitVisionRange(UNIT_TYPES.ROCKET_SOLDIER)).toBe(7);
    expect(getUnitVisionRange(UNIT_TYPES.COMMANDO)).toBe(10);
    expect(getUnitVisionRange(UNIT_TYPES.LIGHT_TANK)).toBe(7);
    expect(getUnitVisionRange(UNIT_TYPES.FLAME_TANK)).toBe(7);
    expect(getBuildingVisionRange(BUILDING_TYPES.HQ)).toBe(8);
    expect(getBuildingVisionRange(BUILDING_TYPES.BARRACKS)).toBe(6);
    expect(getBuildingVisionRange(BUILDING_TYPES.REFINERY)).toBe(6);
  });

  it("applies armor-based damage modifiers", () => {
    expect(getAttackDamageAgainstUnit(UNIT_TYPES.SOLDIER, UNIT_TYPES.SOLDIER)).toBe(10);
    expect(getAttackDamageAgainstUnit(UNIT_TYPES.RIFLEMAN, UNIT_TYPES.WORKER)).toBe(13);
    expect(getAttackDamageAgainstUnit(UNIT_TYPES.RIFLEMAN, UNIT_TYPES.LIGHT_TANK)).toBe(2);
    expect(getAttackDamageAgainstUnit(UNIT_TYPES.ROCKET_SOLDIER, UNIT_TYPES.LIGHT_TANK)).toBe(77);
    expect(getAttackDamageAgainstBuilding(UNIT_TYPES.ROCKET_SOLDIER, BUILDING_TYPES.HQ)).toBe(31);
    expect(getAttackDamageAgainstBuilding(UNIT_TYPES.LIGHT_TANK, BUILDING_TYPES.BARRACKS)).toBe(38);
    expect(getUnitStats(UNIT_TYPES.FLAME_TANK).hp).toBe(getUnitStats(UNIT_TYPES.LIGHT_TANK).hp);
    expect(getUnitWeapon(UNIT_TYPES.FLAME_TANK)).toMatchObject({
      range: 3,
      windupTicks: 2,
      continuousFire: { damageIntervalTicks: 1 },
      projectileType: "flame",
    });
    expect(getAttackDamageAgainstUnit(UNIT_TYPES.FLAME_TANK, UNIT_TYPES.RIFLEMAN)).toBe(12);
    expect(getAttackDamageAgainstUnit(UNIT_TYPES.FLAME_TANK, UNIT_TYPES.LIGHT_TANK)).toBe(1);
    expect(getAttackDamageAgainstBuilding(UNIT_TYPES.FLAME_TANK, BUILDING_TYPES.HQ)).toBe(10);
    expect(getAttackDamageAgainstUnit(BUILDING_TYPES.MACHINE_GUN_TURRET, UNIT_TYPES.FLAME_TANK)).toBe(1);
    expect(getAttackDamageAgainstUnit(BUILDING_TYPES.ANTI_TANK_TURRET, UNIT_TYPES.FLAME_TANK)).toBe(102);
    expect(getAttackDamageAgainstUnit(UNIT_TYPES.COMMANDO, UNIT_TYPES.LIGHT_TANK)).toBe(0);
    expect(getAttackSourceWeaponAgainstArmor(UNIT_TYPES.COMMANDO, "infantry")).toMatchObject({
      range: 7,
      projectileType: "bullet",
      instantKill: true,
    });
    expect(getAttackSourceWeaponAgainstArmor(UNIT_TYPES.COMMANDO, "structure")).toMatchObject({
      range: 1,
      projectileType: "demolition",
      instantKill: true,
    });
  });

  it("makes flame tanks a resource-efficient specialist instead of a main battle tank upgrade", () => {
    const flameCost = getUnitCost(UNIT_TYPES.FLAME_TANK);
    const lightCost = getUnitCost(UNIT_TYPES.LIGHT_TANK);
    const sustainedDamagePerCredit = (
      attacker: typeof UNIT_TYPES.FLAME_TANK | typeof UNIT_TYPES.LIGHT_TANK,
      target: typeof UNIT_TYPES.RIFLEMAN | typeof UNIT_TYPES.LIGHT_TANK,
    ) => getAttackDamageAgainstUnit(attacker, target)
      / getUnitWeapon(attacker).reloadTicks
      / getUnitCost(attacker);

    expect(sustainedDamagePerCredit(UNIT_TYPES.FLAME_TANK, UNIT_TYPES.RIFLEMAN))
      .toBeGreaterThan(sustainedDamagePerCredit(UNIT_TYPES.LIGHT_TANK, UNIT_TYPES.RIFLEMAN));
    expect(sustainedDamagePerCredit(UNIT_TYPES.FLAME_TANK, UNIT_TYPES.LIGHT_TANK))
      .toBeLessThan(sustainedDamagePerCredit(UNIT_TYPES.LIGHT_TANK, UNIT_TYPES.LIGHT_TANK) / 5);
    expect(getAttackDamageAgainstBuilding(UNIT_TYPES.FLAME_TANK, BUILDING_TYPES.HQ)
      / getUnitWeapon(UNIT_TYPES.FLAME_TANK).reloadTicks / flameCost)
      .toBeGreaterThan(getAttackDamageAgainstBuilding(UNIT_TYPES.LIGHT_TANK, BUILDING_TYPES.HQ)
        / getUnitWeapon(UNIT_TYPES.LIGHT_TANK).reloadTicks / lightCost);
  });

  it("keeps the large-map HQ time-to-kill above a reaction window after reload timing", () => {
    const hqHp = getBuildingStats(BUILDING_TYPES.HQ).hp;
    const singleTankReloadTicksToKillHQ =
      Math.ceil(hqHp / getAttackDamageAgainstBuilding(UNIT_TYPES.LIGHT_TANK, BUILDING_TYPES.HQ)) *
      getUnitWeapon(UNIT_TYPES.LIGHT_TANK).reloadTicks;
    const fourRocketReloadTicksToKillHQ =
      Math.ceil(hqHp / (getAttackDamageAgainstBuilding(UNIT_TYPES.ROCKET_SOLDIER, BUILDING_TYPES.HQ) * 4)) *
      getUnitWeapon(UNIT_TYPES.ROCKET_SOLDIER).reloadTicks;

    expect(singleTankReloadTicksToKillHQ).toBeGreaterThanOrEqual(180);
    expect(fourRocketReloadTicksToKillHQ).toBeGreaterThanOrEqual(80);
  });

  it("uses role-aware default attack target priorities", () => {
    expect(getDefaultAttackMovePriority(UNIT_TYPES.RIFLEMAN).slice(0, 4)).toEqual([
      UNIT_TYPES.COMMANDO,
      UNIT_TYPES.ROCKET_SOLDIER,
      UNIT_TYPES.RIFLEMAN,
      UNIT_TYPES.SOLDIER,
    ]);
    expect(getDefaultAttackMovePriority(UNIT_TYPES.ROCKET_SOLDIER).slice(0, 3)).toEqual([
      UNIT_TYPES.HEAVY_TANK,
      UNIT_TYPES.LIGHT_TANK,
      UNIT_TYPES.FLAME_TANK,
    ]);
    expect(getDefaultAttackMovePriority(UNIT_TYPES.LIGHT_TANK).slice(0, 3)).toEqual([
      UNIT_TYPES.HEAVY_TANK,
      UNIT_TYPES.LIGHT_TANK,
      UNIT_TYPES.FLAME_TANK,
    ]);
  });

  it("keeps convenience stats aligned with ruleset building definitions", () => {
    expect(getBuildingStats(BUILDING_TYPES.HQ)).toMatchObject(BUILDING_STATS.hq);
    expect(getBuildingStats(BUILDING_TYPES.BARRACKS)).toMatchObject(BUILDING_STATS.barracks);
    expect(getBuildingStats(BUILDING_TYPES.WAR_FACTORY)).toMatchObject(BUILDING_STATS.war_factory);
    expect(getBuildingStats(BUILDING_TYPES.REFINERY)).toMatchObject(BUILDING_STATS.refinery);
    expect(getBuildingStats(BUILDING_TYPES.TECH_CENTER)).toMatchObject(BUILDING_STATS.tech_center);
    expect(getBuildingCost(BUILDING_TYPES.HQ)).toBe(0);
    expect(getBuildingCost(BUILDING_TYPES.BARRACKS)).toBe(120);
    expect(getBuildingCost(BUILDING_TYPES.WAR_FACTORY)).toBe(220);
    expect(getBuildingCost(BUILDING_TYPES.REFINERY)).toBe(300);
  });

  it("centralizes current production rules in the default ruleset", () => {
    expect(getProductionOptions(BUILDING_TYPES.HQ)).toEqual([UNIT_TYPES.WORKER]);
    expect(getProductionOptions(BUILDING_TYPES.BARRACKS)).toEqual([
      UNIT_TYPES.RIFLEMAN,
      UNIT_TYPES.ROCKET_SOLDIER,
      UNIT_TYPES.COMMANDO,
    ]);
    expect(getProductionOptions(BUILDING_TYPES.WAR_FACTORY)).toEqual([
      UNIT_TYPES.LIGHT_TANK,
      UNIT_TYPES.FLAME_TANK,
      UNIT_TYPES.HEAVY_TANK,
    ]);
    expect(getProductionOptions(BUILDING_TYPES.REFINERY)).toEqual([]);
    expect(canBuildingProduce(BUILDING_TYPES.HQ, UNIT_TYPES.WORKER)).toBe(true);
    expect(canBuildingProduce(BUILDING_TYPES.HQ, UNIT_TYPES.SOLDIER)).toBe(false);
    expect(canBuildingProduce(BUILDING_TYPES.BARRACKS, UNIT_TYPES.SOLDIER)).toBe(false);
    expect(canBuildingProduce(BUILDING_TYPES.BARRACKS, UNIT_TYPES.RIFLEMAN)).toBe(true);
    expect(canBuildingProduce(BUILDING_TYPES.BARRACKS, UNIT_TYPES.ROCKET_SOLDIER)).toBe(true);
    expect(canBuildingProduce(BUILDING_TYPES.BARRACKS, UNIT_TYPES.COMMANDO)).toBe(true);
    expect(canBuildingProduce(BUILDING_TYPES.BARRACKS, UNIT_TYPES.LIGHT_TANK)).toBe(false);
    expect(canBuildingProduce(BUILDING_TYPES.WAR_FACTORY, UNIT_TYPES.LIGHT_TANK)).toBe(true);
    expect(canBuildingProduce(BUILDING_TYPES.WAR_FACTORY, UNIT_TYPES.FLAME_TANK)).toBe(true);
    expect(canBuildingProduce(BUILDING_TYPES.BARRACKS, UNIT_TYPES.WORKER)).toBe(false);
    expect(getRetiredProductionUnitTypes()).toEqual([UNIT_TYPES.SOLDIER]);
  });

  it("defines building-gated T2/T3 progression and defensive weapons", () => {
    expect(getBuildingPrerequisites(BUILDING_TYPES.WAR_FACTORY)).toEqual([BUILDING_TYPES.BARRACKS]);
    expect(getBuildingPrerequisites(BUILDING_TYPES.TECH_CENTER)).toEqual([BUILDING_TYPES.WAR_FACTORY]);
    expect(getUnitPrerequisites(UNIT_TYPES.LIGHT_TANK)).toEqual([]);
    expect(getUnitPrerequisites(UNIT_TYPES.FLAME_TANK)).toEqual([]);
    expect(getUnitPrerequisites(UNIT_TYPES.HEAVY_TANK)).toEqual([BUILDING_TYPES.TECH_CENTER]);
    expect(getUnitPrerequisites(UNIT_TYPES.COMMANDO)).toEqual([BUILDING_TYPES.TECH_CENTER]);
    expect(getBuildingWeapon(BUILDING_TYPES.MACHINE_GUN_TURRET)).toMatchObject({
      projectileType: "bullet",
      range: 7,
    });
    expect(getBuildingWeapon(BUILDING_TYPES.ANTI_TANK_TURRET)).toMatchObject({
      projectileType: "shell",
      range: 9,
    });
  });
});
