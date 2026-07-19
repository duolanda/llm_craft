import { BUILDING_TYPES, LOG_TYPES, UNIT_TYPES, type PlayerId } from "@llmcraft/shared";
import { Game } from "../src/Game";
import { executeAgentTool } from "../src/agent/AgentTools";
import { GameAgentBridge } from "../src/agent/GameAgentBridge";
import { runBuiltinCPUStrategy } from "../src/benchmark/BuiltinCPUStrategy";

const TICKS = Number(process.env.STRATEGIC_SMOKE_TICKS ?? 360);
async function main(): Promise<void> {
const game = new Game();
const bridges = new Map<PlayerId, GameAgentBridge>([
  ["player_1", new GameAgentBridge(game, "player_1")],
  ["player_2", new GameAgentBridge(game, "player_2")],
]);

let peakCombinedCombatUnits = 0;
let peakActiveFronts = 0;
let slowestTickMs = 0;
const peakInfrastructure = new Map<PlayerId, { refineries: number; barracks: number; warFactories: number }>([
  ["player_1", { refineries: 0, barracks: 0, warFactories: 0 }],
  ["player_2", { refineries: 0, barracks: 0, warFactories: 0 }],
]);

function combatUnits(playerId: PlayerId) {
  return game.getUnitManager().getUnitsByPlayer(playerId).filter((unit) => unit.type !== UNIT_TYPES.WORKER);
}

function countActiveFronts(): number {
  const activeBands = new Set<number>();
  for (const playerId of ["player_1", "player_2"] as const) {
    for (const unit of combatUnits(playerId)) {
      if (unit.order?.type !== "attack_move" && unit.order?.type !== "attack") continue;
      const targetY = unit.order.targetY ?? unit.y;
      activeBands.add(targetY < 34 ? 0 : targetY > 62 ? 2 : 1);
    }
  }
  return activeBands.size;
}

async function runCpu(playerId: PlayerId): Promise<void> {
  const bridge = bridges.get(playerId)!;
  await runBuiltinCPUStrategy({
    strategy: "rush",
    runtime: {
      myState: bridge.getMyState().result,
      myUnits: bridge.getMyUnits().result,
      mapState: bridge.getMapState().result,
    },
    callTool: (toolName, args) => executeAgentTool(bridge, toolName, args).result,
  });
}

function benchmarkScale(combinedUnits: number): { combinedUnits: number; maxTickMs: number; orderedUnits: number; missingUnitIds: string[] } {
  const benchmarkGame = new Game();
  const perSide = Math.floor(combinedUnits / 2);
  const positionFor = (index: number, playerOne: boolean) => {
    const front = index % 3;
    const withinFront = Math.floor(index / 3);
    return {
      x: playerOne ? 22 + Math.floor(withinFront / 10) * 2 : 121 - Math.floor(withinFront / 10) * 2,
      y: [20, 48, 76][front] + (withinFront % 10) * 2 - 9,
    };
  };
  const playerOneIds = Array.from({ length: perSide }, (_, index) => {
    const position = positionFor(index, true);
    return benchmarkGame.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, position.x, position.y, "player_1").id;
  });
  const playerTwoIds = Array.from({ length: perSide }, (_, index) => {
    const position = positionFor(index, false);
    return benchmarkGame.getUnitManager().createUnit(UNIT_TYPES.SOLDIER, position.x, position.y, "player_2").id;
  });
  const playerOneBridge = new GameAgentBridge(benchmarkGame, "player_1");
  const playerTwoBridge = new GameAgentBridge(benchmarkGame, "player_2");
  playerOneBridge.attackMoveGroup(playerOneIds, { x: 55, y: 48 }, "line");
  playerTwoBridge.attackMoveGroup(playerTwoIds, { x: 88, y: 48 }, "line");
  benchmarkGame.start();
  let maxTickMs = 0;
  const orderedUnitIds = new Set<string>();
  for (let tick = 0; tick < Math.ceil(combinedUnits / 4) + 2; tick++) {
    const startedAt = performance.now();
    benchmarkGame.tickUpdate();
    maxTickMs = Math.max(maxTickMs, performance.now() - startedAt);
    for (const unitId of [...playerOneIds, ...playerTwoIds]) {
      if (benchmarkGame.getUnitManager().getUnit(unitId)?.order?.type === "attack_move") orderedUnitIds.add(unitId);
    }
  }
  benchmarkGame.stop();
  const orderedUnits = orderedUnitIds.size;
  const missingUnitIds = [...playerOneIds, ...playerTwoIds].filter((unitId) => !orderedUnitIds.has(unitId));
  return { combinedUnits, maxTickMs: Number(maxTickMs.toFixed(2)), orderedUnits, missingUnitIds };
}

game.start();
for (let index = 0; index < TICKS && !game.getWinner(); index++) {
  if (index % 5 === 0) {
    await runCpu("player_1");
    await runCpu("player_2");
  }
  const startedAt = performance.now();
  game.tickUpdate();
  slowestTickMs = Math.max(slowestTickMs, performance.now() - startedAt);
  peakCombinedCombatUnits = Math.max(
    peakCombinedCombatUnits,
    combatUnits("player_1").length + combatUnits("player_2").length,
  );
  peakActiveFronts = Math.max(peakActiveFronts, countActiveFronts());
  for (const player of game.getAgentReadState().players) {
    const peak = peakInfrastructure.get(player.id)!;
    peak.refineries = Math.max(peak.refineries, player.buildings.filter((building) => building.type === BUILDING_TYPES.REFINERY).length);
    peak.barracks = Math.max(peak.barracks, player.buildings.filter((building) => building.type === BUILDING_TYPES.BARRACKS).length);
    peak.warFactories = Math.max(peak.warFactories, player.buildings.filter((building) => building.type === BUILDING_TYPES.WAR_FACTORY).length);
  }
}
game.stop();

const state = game.getState();
const scaleBenchmarks = [40, 80, 160].map(benchmarkScale);
const commandFailureCounts = new Map<string, number>();
for (const log of game.getCommandResults()) {
  if (log.type !== LOG_TYPES.COMMAND_RESULT || log.data.result_code >= 0) continue;
  const key = `${log.meta.owner}:${log.data.type}`;
  commandFailureCounts.set(key, (commandFailureCounts.get(key) ?? 0) + 1);
}
const summary = {
  ticks: game.getTick(),
  winner: game.getWinner(),
  peakCombinedCombatUnits,
  peakActiveFronts,
  slowestTickMs: Number(slowestTickMs.toFixed(2)),
  players: state.players.map((player) => ({
    playerId: player.id,
    credits: player.resources.credits,
    combatUnits: player.units.filter((unit) => unit.type !== UNIT_TYPES.WORKER).length,
    workers: player.units.filter((unit) => unit.type === UNIT_TYPES.WORKER).length,
    workerStates: player.units
      .filter((unit) => unit.type === UNIT_TYPES.WORKER)
      .map((unit) => ({ id: unit.id, x: unit.x, y: unit.y, state: unit.state, intent: unit.intent })),
    refineries: player.buildings.filter((building) => building.type === BUILDING_TYPES.REFINERY).length,
    barracks: player.buildings.filter((building) => building.type === BUILDING_TYPES.BARRACKS).length,
    warFactories: player.buildings.filter((building) => building.type === BUILDING_TYPES.WAR_FACTORY).length,
    peakInfrastructure: peakInfrastructure.get(player.id),
  })),
  commandFailureCounts: Object.fromEntries([...commandFailureCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  scaleBenchmarks,
};

console.log(JSON.stringify(summary, null, 2));
if (peakCombinedCombatUnits < 40) throw new Error(`Expected at least 40 combined combat units, got ${peakCombinedCombatUnits}`);
if (peakActiveFronts < 2) throw new Error(`Expected at least two active fronts, got ${peakActiveFronts}`);
if (summary.players.some((player) => !player.peakInfrastructure || player.peakInfrastructure.refineries < 1 || player.peakInfrastructure.barracks < 1 || player.peakInfrastructure.warFactories < 1)) {
  throw new Error("Both CPUs must establish refinery, barracks, and war factory infrastructure.");
}
if (scaleBenchmarks.some((benchmark) => benchmark.orderedUnits !== benchmark.combinedUnits)) {
  throw new Error("Every unit in the 40/80/160 scale benchmarks must retain a group attack-move order.");
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
