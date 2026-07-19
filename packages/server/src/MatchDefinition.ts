import {
  DEFAULT_MAP_LAYOUT,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_IDS,
  TICK_INTERVAL_MS,
  type MatchDefinition,
  type MatchDefinitionV2,
} from "@llmcraft/shared";
import { DEFAULT_COMMAND_BUDGET_POLICY } from "./CommandBudget";

export type { MatchDefinition, MatchDefinitionV1, MatchDefinitionV2, MatchPlayerDefinition } from "@llmcraft/shared";

export function createDefaultMatchDefinition(): MatchDefinitionV2 {
  return {
    definitionVersion: 2,
    rulesetId: "default-v1",
    scenarioId: "default-144x96-v1",
    seed: 0,
    tickIntervalMs: TICK_INTERVAL_MS,
    map: {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      resources: DEFAULT_MAP_LAYOUT.resources.map((position) => ({ ...position })),
    },
    players: [
      {
        id: PLAYER_IDS.PLAYER_1,
        startingCredits: 800,
        hq: { ...DEFAULT_MAP_LAYOUT.player1Hq },
        workers: DEFAULT_MAP_LAYOUT.player1Workers.map((position) => ({ ...position })),
      },
      {
        id: PLAYER_IDS.PLAYER_2,
        startingCredits: 800,
        hq: { ...DEFAULT_MAP_LAYOUT.player2Hq },
        workers: DEFAULT_MAP_LAYOUT.player2Workers.map((position) => ({ ...position })),
      },
    ],
    victoryCondition: { type: "eliminate_all_buildings" },
    rules: {
      schemaVersion: 1,
      commandBudget: { ...DEFAULT_COMMAND_BUDGET_POLICY },
    },
  };
}

export function validateMatchDefinition(definition: MatchDefinition): void {
  if (definition.definitionVersion !== 1 && definition.definitionVersion !== 2) {
    throw new Error(
      `Unsupported MatchDefinition version: ${(definition as { definitionVersion?: unknown }).definitionVersion}`,
    );
  }
  if (definition.map.width !== MAP_WIDTH || definition.map.height !== MAP_HEIGHT) {
    throw new Error(`Current SimulationCore requires a ${MAP_WIDTH}x${MAP_HEIGHT} map.`);
  }
  if (definition.rulesetId !== "default-v1") {
    throw new Error(`Unsupported ruleset: ${definition.rulesetId}`);
  }
  if (definition.scenarioId !== "default-144x96-v1") {
    throw new Error(`Unsupported scenario: ${definition.scenarioId}`);
  }
  if (definition.victoryCondition.type !== "eliminate_all_buildings") {
    throw new Error(`Unsupported victory condition: ${definition.victoryCondition.type}`);
  }
  if (!Number.isInteger(definition.seed)) {
    throw new Error("MatchDefinition seed must be an integer.");
  }
  if (!Number.isFinite(definition.tickIntervalMs) || definition.tickIntervalMs <= 0) {
    throw new Error("MatchDefinition tickIntervalMs must be positive.");
  }
  if (definition.definitionVersion === 2) {
    if (definition.rules.schemaVersion !== 1) {
      throw new Error(`Unsupported MatchDefinition rules version: ${definition.rules.schemaVersion}`);
    }
    const { maxCommandsPerActorPerTick, maxPathCommandsPerTick } = definition.rules.commandBudget;
    if (!Number.isSafeInteger(maxCommandsPerActorPerTick) || maxCommandsPerActorPerTick <= 0) {
      throw new Error("MatchDefinition command budget must allow a positive integer number of commands per actor per tick.");
    }
    if (!Number.isSafeInteger(maxPathCommandsPerTick) || maxPathCommandsPerTick < 0) {
      throw new Error("MatchDefinition path budget must be a non-negative integer.");
    }
  }
  const playerIds = definition.players.map((player) => player.id);
  if (playerIds[0] !== PLAYER_IDS.PLAYER_1 || playerIds[1] !== PLAYER_IDS.PLAYER_2) {
    throw new Error("Current SimulationCore requires player_1 and player_2 in stable order.");
  }
  for (const player of definition.players) {
    if (!Number.isFinite(player.startingCredits) || player.startingCredits < 0) {
      throw new Error(`Invalid starting credits for ${player.id}.`);
    }
  }

  const defaultDefinition = createDefaultMatchDefinition();
  const hasDefaultScenarioLayout =
    JSON.stringify(definition.map.resources) === JSON.stringify(defaultDefinition.map.resources)
    && JSON.stringify(definition.players.map(({ id, hq, workers }) => ({ id, hq, workers })))
      === JSON.stringify(defaultDefinition.players.map(({ id, hq, workers }) => ({ id, hq, workers })));
  if (!hasDefaultScenarioLayout) {
    throw new Error(
      "Current default-144x96-v1 scenario requires its versioned HQ, worker, and resource layout.",
    );
  }
}
