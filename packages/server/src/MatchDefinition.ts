import {
  BUILDING_TYPES,
  DEFAULT_MAP_LAYOUT,
  DEFAULT_RULESET,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_IDS,
  TICK_INTERVAL_MS,
  UNIT_TYPES,
  type MatchDefinition,
} from "@llmcraft/shared";

export type {
  MapDefinition,
  MapPlayerStart,
  MatchDefinition,
  MatchPlayerDefinition,
} from "@llmcraft/shared";

export function createDefaultMatchDefinition(): MatchDefinition {
  return {
    rulesetId: DEFAULT_RULESET.id,
    tickIntervalMs: TICK_INTERVAL_MS,
    map: {
      id: "standard",
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      resources: DEFAULT_MAP_LAYOUT.resources.map((position) => ({ ...position })),
      obstacles: [],
      playerStarts: [
        {
          playerId: PLAYER_IDS.PLAYER_1,
          buildings: [{
            type: BUILDING_TYPES.HQ,
            position: { ...DEFAULT_MAP_LAYOUT.player1Hq },
          }],
          units: DEFAULT_MAP_LAYOUT.player1Workers.map((position) => ({
            type: UNIT_TYPES.WORKER,
            position: { ...position },
          })),
        },
        {
          playerId: PLAYER_IDS.PLAYER_2,
          buildings: [{
            type: BUILDING_TYPES.HQ,
            position: { ...DEFAULT_MAP_LAYOUT.player2Hq },
          }],
          units: DEFAULT_MAP_LAYOUT.player2Workers.map((position) => ({
            type: UNIT_TYPES.WORKER,
            position: { ...position },
          })),
        },
      ],
    },
    players: [
      {
        id: PLAYER_IDS.PLAYER_1,
        startingCredits: 800,
      },
      {
        id: PLAYER_IDS.PLAYER_2,
        startingCredits: 800,
      },
    ],
    victoryCondition: { type: "eliminate_all_buildings" },
  };
}

export function validateMatchDefinition(definition: MatchDefinition): void {
  if (definition.map.width !== MAP_WIDTH || definition.map.height !== MAP_HEIGHT) {
    throw new Error(`Current SimulationCore requires a ${MAP_WIDTH}x${MAP_HEIGHT} map.`);
  }
  if (definition.rulesetId !== DEFAULT_RULESET.id) {
    throw new Error(`Unsupported ruleset: ${definition.rulesetId}`);
  }
  if (definition.map.id !== "standard") {
    throw new Error(`Unsupported map: ${definition.map.id}`);
  }
  if (definition.victoryCondition.type !== "eliminate_all_buildings") {
    throw new Error(`Unsupported victory condition: ${definition.victoryCondition.type}`);
  }
  if (!Number.isFinite(definition.tickIntervalMs) || definition.tickIntervalMs <= 0) {
    throw new Error("MatchDefinition tickIntervalMs must be positive.");
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
    && JSON.stringify(definition.map.obstacles) === JSON.stringify(defaultDefinition.map.obstacles)
    && JSON.stringify(definition.map.playerStarts) === JSON.stringify(defaultDefinition.map.playerStarts);
  if (!hasDefaultScenarioLayout) {
    throw new Error(
      "Current standard map requires its HQ, unit, resource, and obstacle layout.",
    );
  }
}
