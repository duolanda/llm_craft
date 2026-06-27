import {
  BUILDING_STATS,
  BUILDING_TYPES,
  DEFAULT_MAP_LAYOUT,
  ECONOMY_RULES,
  GameState,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_IDS,
  Player,
  TILE_TYPES,
  UNIT_STATES,
  UNIT_STATS,
  UNIT_TYPES,
  Unit,
  UnitType,
} from "@llmcraft/shared";

const FORMATION_COLUMNS = 10;
const FORMATION_ROWS = 6;

const FORMATION_TYPES: UnitType[] = [
  UNIT_TYPES.SOLDIER,
  UNIT_TYPES.RIFLEMAN,
  UNIT_TYPES.RIFLEMAN,
  UNIT_TYPES.ROCKET_SOLDIER,
  UNIT_TYPES.LIGHT_TANK,
];

function createFormationUnit(
  playerId: typeof PLAYER_IDS.PLAYER_1 | typeof PLAYER_IDS.PLAYER_2,
  index: number,
): Unit {
  const front = index % 3;
  const frontIndex = Math.floor(index / 3);
  const column = frontIndex % FORMATION_COLUMNS;
  const row = Math.floor(frontIndex / FORMATION_COLUMNS);
  const type = FORMATION_TYPES[(column + row * 2) % FORMATION_TYPES.length];
  const stats = UNIT_STATS[type];
  const playerOne = playerId === PLAYER_IDS.PLAYER_1;
  const frontY = [20, 48, 76][front];
  const x = playerOne ? 58 - row * 2 : 85 + row * 2;
  const y = frontY + Math.round((column - (FORMATION_COLUMNS - 1) / 2) * 1.7);
  const attacking = index % 3 !== 0;
  const enemyId = playerOne ? PLAYER_IDS.PLAYER_2 : PLAYER_IDS.PLAYER_1;
  const enemyX = playerOne ? 85 + row * 2 : 58 - row * 2;

  return {
    id: `showcase_${playerId}_${index}`,
    type,
    x,
    y,
    hp: stats.hp,
    maxHp: stats.hp,
    state: attacking ? "attacking" : "moving",
    my: playerOne,
    playerId,
    exists: true,
    attackRange: stats.attackRange,
    carryingCredits: 0,
    carryCapacity: 0,
    intent: attacking
      ? {
          type: "attack",
          targetId: `showcase_${enemyId}_${index}`,
          targetX: enemyX,
          targetY: y,
        }
      : {
          type: "attack_move",
          targetX: playerOne ? 104 : 39,
          targetY: frontY,
        },
    lastAttackTick: attacking ? 999 : undefined,
  };
}

function createShowcasePlayer(
  playerId: typeof PLAYER_IDS.PLAYER_1 | typeof PLAYER_IDS.PLAYER_2,
  unitCount: number,
): Player {
  const playerOne = playerId === PLAYER_IDS.PLAYER_1;
  const buildingLayout = playerOne
    ? [
        { type: BUILDING_TYPES.HQ, ...DEFAULT_MAP_LAYOUT.player1Hq },
        { type: BUILDING_TYPES.BARRACKS, x: 25, y: 41 },
        { type: BUILDING_TYPES.WAR_FACTORY, x: 30, y: 48 },
        { type: BUILDING_TYPES.REFINERY, x: 44, y: 18 },
      ]
    : [
        { type: BUILDING_TYPES.HQ, ...DEFAULT_MAP_LAYOUT.player2Hq },
        { type: BUILDING_TYPES.BARRACKS, x: 118, y: 55 },
        { type: BUILDING_TYPES.WAR_FACTORY, x: 113, y: 48 },
        { type: BUILDING_TYPES.REFINERY, x: 99, y: 18 },
      ];

  return {
    id: playerId,
    resources: { credits: 8000 },
    units: Array.from(
      { length: unitCount },
      (_, index) => createFormationUnit(playerId, index),
    ),
    buildings: buildingLayout.map((building, index) => {
      const stats = BUILDING_STATS[building.type];
      return {
        id: `showcase_${playerId}_building_${index}`,
        ...building,
        hp: stats.hp,
        maxHp: stats.hp,
        my: playerOne,
        playerId,
        exists: true,
        productionQueue: [],
      };
    }),
  };
}

function createShowcaseSource(unitCount: number): GameState {
  const resourcePositions = new Set(DEFAULT_MAP_LAYOUT.resources.map((position) => `${position.x},${position.y}`));

  return {
    tick: 999,
    players: [
      createShowcasePlayer(PLAYER_IDS.PLAYER_1, unitCount),
      createShowcasePlayer(PLAYER_IDS.PLAYER_2, unitCount),
    ],
    tiles: Array.from({ length: MAP_HEIGHT }, (_, y) =>
      Array.from({ length: MAP_WIDTH }, (_, x) => ({
        x,
        y,
        type: resourcePositions.has(`${x},${y}`) ? TILE_TYPES.RESOURCE : TILE_TYPES.EMPTY,
        ...(resourcePositions.has(`${x},${y}`) ? { resourceRemaining: ECONOMY_RULES.RESOURCE_DEPOSIT_CAPACITY } : {}),
      })),
    ),
    winner: null,
    logs: [],
  };
}

export function createMassBattleState(
  source: GameState | null,
  unitCount = FORMATION_COLUMNS * FORMATION_ROWS,
): GameState {
  const showcaseSource = source ?? createShowcaseSource(unitCount);
  return {
    ...showcaseSource,
    tick: Math.max(showcaseSource.tick, 999),
    players: showcaseSource.players.map((player) => ({
      ...player,
      units: Array.from(
        { length: unitCount },
        (_, index) => createFormationUnit(player.id, index),
      ),
    })),
  };
}

function createAnimationLabUnit(
  playerId: typeof PLAYER_IDS.PLAYER_1 | typeof PLAYER_IDS.PLAYER_2,
  id: string,
  type: UnitType,
  x: number,
  y: number,
  options: Partial<Pick<Unit, "state" | "intent" | "lastAttackTick" | "carryingCredits">> = {},
): Unit {
  const stats = UNIT_STATS[type];
  return {
    id,
    type,
    x,
    y,
    hp: stats.hp,
    maxHp: stats.hp,
    state: options.state ?? UNIT_STATES.IDLE,
    my: playerId === PLAYER_IDS.PLAYER_1,
    playerId,
    exists: true,
    attackRange: stats.attackRange,
    carryingCredits: options.carryingCredits ?? 0,
    carryCapacity: type === UNIT_TYPES.WORKER ? ECONOMY_RULES.WORKER_CARRY_CAPACITY : 0,
    intent: options.intent,
    lastAttackTick: options.lastAttackTick,
  };
}

function createAnimationLabPlayer(
  playerId: typeof PLAYER_IDS.PLAYER_1 | typeof PLAYER_IDS.PLAYER_2,
  tick: number,
): Player {
  const playerOne = playerId === PLAYER_IDS.PLAYER_1;
  const direction = playerOne ? 1 : -1;
  const baseX = playerOne ? 58 : 86;
  const targetX = baseX + direction * 10;
  const walkPhase = (tick % 24) / 24;
  const patrolX = baseX + direction * (7 + Math.sin(walkPhase * Math.PI * 2) * 4);
  const enemyId = playerOne ? PLAYER_IDS.PLAYER_2 : PLAYER_IDS.PLAYER_1;
  const buildingLayout = playerOne
    ? [
        { type: BUILDING_TYPES.HQ, x: 46, y: 48 },
        { type: BUILDING_TYPES.REFINERY, x: 50, y: 35 },
        { type: BUILDING_TYPES.BARRACKS, x: 50, y: 61 },
      ]
    : [
        { type: BUILDING_TYPES.HQ, x: 98, y: 48 },
        { type: BUILDING_TYPES.REFINERY, x: 94, y: 35 },
        { type: BUILDING_TYPES.BARRACKS, x: 94, y: 61 },
      ];

  return {
    id: playerId,
    resources: { credits: 8000 },
    units: [
      createAnimationLabUnit(playerId, `${playerId}_lab_worker_gather`, UNIT_TYPES.WORKER, baseX, 35, {
        state: UNIT_STATES.GATHERING,
        intent: { type: "harvest_loop", targetX: baseX + direction * 3, targetY: 35 },
      }),
      createAnimationLabUnit(playerId, `${playerId}_lab_worker_deposit`, UNIT_TYPES.WORKER, baseX - direction * 4, 39, {
        state: UNIT_STATES.GATHERING,
        carryingCredits: 80,
        intent: { type: "deposit", targetX: playerOne ? 14 : 129, targetY: 48 },
      }),
      createAnimationLabUnit(playerId, `${playerId}_lab_worker_walk`, UNIT_TYPES.WORKER, patrolX, 44, {
        state: UNIT_STATES.MOVING,
        intent: { type: "move", targetX, targetY: 44 },
      }),
      createAnimationLabUnit(playerId, `${playerId}_lab_rifle_walk`, UNIT_TYPES.RIFLEMAN, patrolX, 53, {
        state: UNIT_STATES.MOVING,
        intent: { type: "attack_move", targetX, targetY: 53 },
      }),
      createAnimationLabUnit(playerId, `${playerId}_lab_rocket_fire`, UNIT_TYPES.ROCKET_SOLDIER, baseX + direction * 8, 58, {
        state: UNIT_STATES.ATTACKING,
        intent: { type: "attack", targetId: `${enemyId}_lab_tank`, targetX: baseX + direction * 34, targetY: 58 },
        lastAttackTick: tick,
      }),
      createAnimationLabUnit(playerId, `${playerId}_lab_tank`, UNIT_TYPES.LIGHT_TANK, baseX + direction * 9, playerOne ? 46 : 50, {
        state: UNIT_STATES.MOVING,
        intent: { type: "attack_move", targetX, targetY: playerOne ? 46 : 50 },
      }),
    ],
    buildings: buildingLayout.map((building, index) => {
      const stats = BUILDING_STATS[building.type];
      return {
        id: `${playerId}_lab_building_${index}`,
        ...building,
        hp: stats.hp,
        maxHp: stats.hp,
        my: playerOne,
        playerId,
        exists: true,
        productionQueue: [],
      };
    }),
  };
}

export function createAnimationLabState(tick: number): GameState {
  const resourcePositions = new Set(DEFAULT_MAP_LAYOUT.resources.map((position) => `${position.x},${position.y}`));
  return {
    tick,
    players: [
      createAnimationLabPlayer(PLAYER_IDS.PLAYER_1, tick),
      createAnimationLabPlayer(PLAYER_IDS.PLAYER_2, tick),
    ],
    tiles: Array.from({ length: MAP_HEIGHT }, (_, y) =>
      Array.from({ length: MAP_WIDTH }, (_, x) => ({
        x,
        y,
        type: resourcePositions.has(`${x},${y}`) ? TILE_TYPES.RESOURCE : TILE_TYPES.EMPTY,
        ...(resourcePositions.has(`${x},${y}`) ? { resourceRemaining: ECONOMY_RULES.RESOURCE_DEPOSIT_CAPACITY } : {}),
      })),
    ),
    winner: null,
    logs: [],
  };
}
