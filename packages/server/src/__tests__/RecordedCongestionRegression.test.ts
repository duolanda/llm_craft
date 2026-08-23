import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  LOG_TYPES,
  RESULT_CODES,
  UNIT_TYPES,
  type UnitType,
} from "@llmcraft/shared";
import { Game } from "../Game";
import { PathFinder } from "../PathFinder";
import { getCollisionManifold } from "../navigation/CollisionShape";
import { getMovementProfile } from "../navigation/MovementProfile";
import { getUnitCollisionShape } from "../navigation/UnitCollision";

/**
 * Compact regression fixture derived from player_2 at tick 1088 of:
 * match-2026-08-22T12-47-33-267Z-cbb2c6d9.match.json
 *
 * It preserves the production-building wall, unit types, continuous positions,
 * headings, shared mineral assignments and westbound orders that reproduced the
 * live traffic jam. The Match Record itself is deliberately not loaded so this
 * remains a small, deterministic test rather than a 15 MB replay dependency.
 */
const RECORDED_BUILDINGS = [
  { type: BUILDING_TYPES.WAR_FACTORY, x: 110, y: 48 },
  { type: BUILDING_TYPES.BARRACKS, x: 117, y: 48 },
  { type: BUILDING_TYPES.MACHINE_GUN_TURRET, x: 121, y: 48 },
] as const;

interface WorkerSeed {
  x: number;
  y: number;
  heading: number;
  resource: { x: number; y: number };
}

const RECORDED_WORKERS: readonly WorkerSeed[] = [
  { x: 111.56706000711785, y: 51.93564935984711, heading: 3.0285948774655673, resource: { x: 109, y: 61 } },
  { x: 112, y: 56, heading: Math.PI / 2, resource: { x: 112, y: 57 } },
  { x: 112.45863796004677, y: 51.77999019444447, heading: 3.781643723974379, resource: { x: 112, y: 57 } },
  { x: 120, y: 44, heading: Math.PI, resource: { x: 112, y: 35 } },
  { x: 117, y: 44, heading: Math.PI, resource: { x: 112, y: 35 } },
  { x: 109, y: 40, heading: -Math.PI / 2, resource: { x: 109, y: 39 } },
  { x: 111.51834164962595, y: 53.3926678369977, heading: -2.601359054181182, resource: { x: 109, y: 61 } },
  { x: 109.86295517871557, y: 44.16082817040649, heading: -1.7645059851334637, resource: { x: 109, y: 39 } },
  { x: 112.39740309000948, y: 53.602902764370185, heading: -2.2589562270441266, resource: { x: 96, y: 74 } },
  { x: 110.16444656468256, y: 43.316571810634464, heading: -3.4274004878291837, resource: { x: 96, y: 18 } },
  { x: 113.01071252457967, y: 52.95929512522681, heading: 4.175296467731115, resource: { x: 96, y: 74 } },
  { x: 97, y: 18.097228071428134, heading: -Math.PI / 2, resource: { x: 96, y: 18 } },
];

interface CombatSeed {
  type: UnitType;
  x: number;
  y: number;
  heading: number;
  target: { x: number; y: number };
}

const RECORDED_COMBAT_UNITS: readonly CombatSeed[] = [
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 109.26560839887502, y: 45.035480439286985, heading: -3.6433350102648303, target: { x: 68, y: 47 } },
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 110.27523112815008, y: 44.98900525543007, heading: 3.1329711010661128, target: { x: 69, y: 48 } },
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 110.76589203945503, y: 44.02081743204713, heading: -2.5546350541244847, target: { x: 70, y: 49 } },
  { type: UNIT_TYPES.LIGHT_TANK, x: 108.3312356635875, y: 43.58090414042018, heading: -1.0794136090411954, target: { x: 68, y: 51 } },
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 111.25696202299109, y: 44.851081408490316, heading: 3.5896844613270376, target: { x: 69, y: 49 } },
  { type: UNIT_TYPES.LIGHT_TANK, x: 110.91242109173069, y: 40.53077694748264, heading: 1.6591036196019837, target: { x: 68, y: 45 } },
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 111.95777177682784, y: 44.184587160210434, heading: 0.6400112954846677, target: { x: 66, y: 49 } },
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 110.67504303383045, y: 42.56960944885355, heading: 3.658776855064099, target: { x: 70, y: 48 } },
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 110.96857968412627, y: 50.990187944340065, heading: 3.131462645506491, target: { x: 71, y: 49 } },
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 114.0498327979356, y: 45.399417495053456, heading: -4.181752666489732, target: { x: 69, y: 47 } },
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 112.15273629782533, y: 52.647035454033436, heading: 3.409592065017698, target: { x: 68, y: 48 } },
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 112.97215750075252, y: 51.04043971005462, heading: -3.1000187226323823, target: { x: 67, y: 49 } },
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 111.92919191999404, y: 51.00592440408617, heading: -2.0215039214198374, target: { x: 70, y: 50 } },
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 114.03483399410814, y: 46.36200534419779, heading: -1.5539298231055485, target: { x: 67, y: 47 } },
  { type: UNIT_TYPES.ROCKET_SOLDIER, x: 114.03253278987609, y: 48.03971386870705, heading: 1.5444691498248029, target: { x: 66, y: 48 } },
];

interface ScenarioResult {
  commandCodes: number[];
  combatProgress: number[];
  combatWestOfFactory: number;
  workersWithEconomyProgress: string[];
  workersThatDelivered: string[];
  overlappingPairs: string[];
  finalCredits: number;
  finalPositions: Array<{ id: string; x: number; y: number }>;
}

function runRecordedCongestionScenario(tickCount: number): ScenarioResult {
  const game = new Game();
  const units = game.getUnitManager();
  const buildings = game.getBuildingManager();
  for (const unit of units.getAllUnits()) units.removeUnit(unit.id);
  for (const building of RECORDED_BUILDINGS) {
    buildings.createBuilding(building.type, building.x, building.y, "player_2");
  }

  const workers = RECORDED_WORKERS.map((seed) => {
    const worker = units.createUnit(UNIT_TYPES.WORKER, seed.x, seed.y, "player_2");
    worker.heading = seed.heading;
    game.queueCommand({
      id: `recorded_harvest_${worker.id}`,
      type: "harvest_loop",
      playerId: "player_2",
      unitId: worker.id,
      position: seed.resource,
    });
    return worker;
  });
  const combatUnits = RECORDED_COMBAT_UNITS.map((seed) => {
    const unit = units.createUnit(seed.type, seed.x, seed.y, "player_2");
    unit.heading = seed.heading;
    game.queueCommand({
      id: `recorded_attack_move_${unit.id}`,
      type: "attack_move",
      playerId: "player_2",
      unitId: unit.id,
      position: seed.target,
    });
    return unit;
  });
  const starts = new Map(combatUnits.map((unit) => [unit.id, { x: unit.x, y: unit.y }]));

  const occupied = buildings.getOccupiedPositions();
  const tiles = game.getState().tiles.map((row) => row.map((tile) => tile.type));
  for (const [index, unit] of combatUnits.entries()) {
    const target = RECORDED_COMBAT_UNITS[index]!.target;
    expect(PathFinder.findPath(
      Math.round(unit.x),
      Math.round(unit.y),
      target.x,
      target.y,
      tiles,
      occupied,
      getMovementProfile(unit.type).navigationRadius,
    ).length).toBeGreaterThan(0);
  }

  game.start();
  for (let tick = 0; tick < tickCount; tick++) game.tickUpdate();
  game.stop();

  const commandCodes = game.getCommandResults().map((log) =>
    (log.data as { result_code: number }).result_code
  );
  const state = game.getState();
  const workersWithEconomyProgress = [...new Set(state.logs.flatMap((log) => {
    if (log.type !== LOG_TYPES.RESOURCE_GATHERED && log.type !== LOG_TYPES.CREDITS_DELIVERED) return [];
    const unitId = (log.data as { unitId?: string } | undefined)?.unitId;
    return unitId && workers.some((worker) => worker.id === unitId) ? [unitId] : [];
  }))].sort();
  const workersThatDelivered = [...new Set(state.logs.flatMap((log) => {
    if (log.type !== LOG_TYPES.CREDITS_DELIVERED) return [];
    const unitId = (log.data as { unitId?: string } | undefined)?.unitId;
    return unitId && workers.some((worker) => worker.id === unitId) ? [unitId] : [];
  }))].sort();
  const living = units.getAllUnits();
  const overlappingPairs: string[] = [];
  for (let leftIndex = 0; leftIndex < living.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < living.length; rightIndex++) {
      if (getCollisionManifold(
        getUnitCollisionShape(living[leftIndex]!),
        getUnitCollisionShape(living[rightIndex]!),
      )) {
        overlappingPairs.push(`${living[leftIndex]!.id}:${living[rightIndex]!.id}`);
      }
    }
  }

  return {
    commandCodes,
    combatProgress: combatUnits.map((unit) => starts.get(unit.id)!.x - unit.x),
    combatWestOfFactory: combatUnits.filter((unit) => unit.x < 104).length,
    workersWithEconomyProgress,
    workersThatDelivered,
    overlappingPairs,
    finalCredits: state.players.find((player) => player.id === "player_2")!.resources.credits,
    finalPositions: [...workers, ...combatUnits].map((unit) => ({
      id: unit.id,
      x: Number(unit.x.toFixed(6)),
      y: Number(unit.y.toFixed(6)),
    })),
  };
}

describe("recorded mixed-unit congestion regression", () => {
  it("routes the recorded base crowd around a statically passable production wall", () => {
    const result = runRecordedCongestionScenario(120);

    expect(result.commandCodes.every((code) => code === RESULT_CODES.OK)).toBe(true);
    expect(result.combatWestOfFactory).toBe(RECORDED_COMBAT_UNITS.length);
    expect(result.combatProgress.every((progress) => progress > 20)).toBe(true);
    expect(result.workersWithEconomyProgress).toHaveLength(RECORDED_WORKERS.length);
    expect(result.workersThatDelivered.length).toBeGreaterThanOrEqual(10);
    expect(result.finalCredits).toBeGreaterThan(800);
    expect(result.overlappingPairs).toEqual([]);
  }, 10_000);

  it("resolves the replay-derived congestion deterministically", () => {
    const first = runRecordedCongestionScenario(80);
    const second = runRecordedCongestionScenario(80);

    expect(second).toEqual(first);
  }, 10_000);
});
