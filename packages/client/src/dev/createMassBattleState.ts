import {
  ActiveProjectile,
  BUILDING_STATS,
  BUILDING_TYPES,
  DEFAULT_MAP_LAYOUT,
  ECONOMY_RULES,
  GameState,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_IDS,
  Player,
  PROJECTILE_TYPES,
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
  UNIT_TYPES.ROCKET_SOLDIER,
  UNIT_TYPES.COMMANDO,
  UNIT_TYPES.LIGHT_TANK,
  UNIT_TYPES.FLAME_TANK,
  UNIT_TYPES.HEAVY_TANK,
];

const ANIMATION_LAB_FX_PAIRS = [
  {
    sourceId: `${PLAYER_IDS.PLAYER_1}_lab_fx_source_flame`,
    targetId: `${PLAYER_IDS.PLAYER_2}_lab_fx_target_flame_rifle`,
    sourceType: UNIT_TYPES.FLAME_TANK,
    targetType: UNIT_TYPES.RIFLEMAN,
    y: 33,
  },
  {
    sourceId: `${PLAYER_IDS.PLAYER_1}_lab_fx_source_rifle`,
    targetId: `${PLAYER_IDS.PLAYER_2}_lab_fx_target_rifle`,
    sourceType: UNIT_TYPES.RIFLEMAN,
    targetType: UNIT_TYPES.RIFLEMAN,
    y: 39,
  },
  {
    sourceId: `${PLAYER_IDS.PLAYER_1}_lab_fx_source_rocket`,
    targetId: `${PLAYER_IDS.PLAYER_2}_lab_fx_target_rocket_tank`,
    sourceType: UNIT_TYPES.ROCKET_SOLDIER,
    targetType: UNIT_TYPES.LIGHT_TANK,
    y: 47,
  },
  {
    sourceId: `${PLAYER_IDS.PLAYER_1}_lab_fx_source_tank`,
    targetId: `${PLAYER_IDS.PLAYER_2}_lab_fx_target_tank`,
    sourceType: UNIT_TYPES.LIGHT_TANK,
    targetType: UNIT_TYPES.LIGHT_TANK,
    y: 53,
  },
] as const;

const ANIMATION_LAB_FX_SOURCE_X = 63;
const ANIMATION_LAB_FX_TARGET_X = 81;

const ANIMATION_LAB_FX_PROJECTILES = [
  {
    id: "lab_bullet",
    projectileType: PROJECTILE_TYPES.BULLET,
    periodTicks: 4,
    flightTicks: 2,
    sourceX: ANIMATION_LAB_FX_SOURCE_X + 0.62,
    targetX: ANIMATION_LAB_FX_TARGET_X - 0.35,
    y: ANIMATION_LAB_FX_PAIRS[1].y,
    offsetTicks: 0,
  },
  {
    id: "lab_rocket",
    projectileType: PROJECTILE_TYPES.ROCKET,
    periodTicks: 9,
    flightTicks: 5,
    sourceX: ANIMATION_LAB_FX_SOURCE_X + 0.68,
    targetX: ANIMATION_LAB_FX_TARGET_X - 0.52,
    y: ANIMATION_LAB_FX_PAIRS[2].y,
    offsetTicks: 2,
  },
  {
    id: "lab_shell",
    projectileType: PROJECTILE_TYPES.SHELL,
    periodTicks: 10,
    flightTicks: 6,
    sourceX: ANIMATION_LAB_FX_SOURCE_X + 0.92,
    targetX: ANIMATION_LAB_FX_TARGET_X - 0.72,
    y: ANIMATION_LAB_FX_PAIRS[3].y,
    offsetTicks: 5,
  },
] as const;

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
        { type: BUILDING_TYPES.MACHINE_GUN_TURRET, x: 40, y: 39 },
        { type: BUILDING_TYPES.ANTI_TANK_TURRET, x: 40, y: 57 },
        { type: BUILDING_TYPES.TECH_CENTER, x: 27, y: 63 },
      ]
    : [
        { type: BUILDING_TYPES.HQ, ...DEFAULT_MAP_LAYOUT.player2Hq },
        { type: BUILDING_TYPES.BARRACKS, x: 118, y: 55 },
        { type: BUILDING_TYPES.WAR_FACTORY, x: 113, y: 48 },
        { type: BUILDING_TYPES.REFINERY, x: 99, y: 18 },
        { type: BUILDING_TYPES.MACHINE_GUN_TURRET, x: 103, y: 57 },
        { type: BUILDING_TYPES.ANTI_TANK_TURRET, x: 103, y: 39 },
        { type: BUILDING_TYPES.TECH_CENTER, x: 116, y: 33 },
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
        playerId,
        exists: true,
        ...(
          building.type === BUILDING_TYPES.MACHINE_GUN_TURRET
          || building.type === BUILDING_TYPES.ANTI_TANK_TURRET
            ? { heading: playerOne ? Math.PI / 4 : -3 * Math.PI / 4 }
            : {}
        ),
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
  options: Partial<Pick<Unit, "state" | "intent" | "lastAttackTick" | "carryingCredits" | "attackWindup" | "attackStream">> = {},
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
    playerId,
    exists: true,
    attackRange: stats.attackRange,
    carryingCredits: options.carryingCredits ?? 0,
    carryCapacity: type === UNIT_TYPES.WORKER ? ECONOMY_RULES.WORKER_CARRY_CAPACITY : 0,
    intent: options.intent,
    lastAttackTick: options.lastAttackTick,
    attackWindup: options.attackWindup,
    attackStream: options.attackStream,
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
        { type: BUILDING_TYPES.MACHINE_GUN_TURRET, x: 56, y: 28 },
        { type: BUILDING_TYPES.ANTI_TANK_TURRET, x: 56, y: 68 },
      ]
    : [
        { type: BUILDING_TYPES.HQ, x: 98, y: 48 },
        { type: BUILDING_TYPES.REFINERY, x: 94, y: 35 },
        { type: BUILDING_TYPES.BARRACKS, x: 94, y: 61 },
        { type: BUILDING_TYPES.BARRACKS, x: 78, y: 48 },
        { type: BUILDING_TYPES.MACHINE_GUN_TURRET, x: 88, y: 68 },
        { type: BUILDING_TYPES.ANTI_TANK_TURRET, x: 88, y: 28 },
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
      ...(playerOne ? [
        createAnimationLabUnit(playerId, `${playerId}_lab_commando`, UNIT_TYPES.COMMANDO, 74, 48, {
          state: UNIT_STATES.ATTACKING,
          intent: {
            type: "attack",
            targetId: `${PLAYER_IDS.PLAYER_2}_lab_building_3`,
            targetX: 78,
            targetY: 48,
          },
          lastAttackTick: tick,
        }),
      ] : []),
      ...createAnimationLabFxRangeUnits(playerId),
    ],
    buildings: buildingLayout.map((building, index) => {
      const stats = BUILDING_STATS[building.type];
      return {
        id: `${playerId}_lab_building_${index}`,
        ...building,
        hp: stats.hp,
        maxHp: stats.hp,
        playerId,
        exists: true,
        ...(
          building.type === BUILDING_TYPES.MACHINE_GUN_TURRET
          || building.type === BUILDING_TYPES.ANTI_TANK_TURRET
            ? { heading: tick * 0.08 + (playerOne ? 0 : Math.PI) }
            : {}
        ),
        productionQueue: [],
      };
    }),
  };
}

function createAnimationLabFxRangeUnits(
  playerId: typeof PLAYER_IDS.PLAYER_1 | typeof PLAYER_IDS.PLAYER_2,
): Unit[] {
  const playerOne = playerId === PLAYER_IDS.PLAYER_1;
  return playerOne
    ? ANIMATION_LAB_FX_PAIRS.map((pair) =>
        createAnimationLabUnit(playerId, pair.sourceId, pair.sourceType, ANIMATION_LAB_FX_SOURCE_X, pair.y, {
          state: UNIT_STATES.ATTACKING,
          intent: {
            type: "attack",
            targetId: pair.targetId,
            targetX: pair.sourceType === UNIT_TYPES.FLAME_TANK
              ? ANIMATION_LAB_FX_SOURCE_X + 3
              : ANIMATION_LAB_FX_TARGET_X,
            targetY: pair.y,
          },
          attackStream: pair.sourceType === UNIT_TYPES.FLAME_TANK
            ? { targetId: pair.targetId, startedTick: 0 }
            : undefined,
        }))
    : ANIMATION_LAB_FX_PAIRS.map((pair) =>
        createAnimationLabUnit(
          playerId,
          pair.targetId,
          pair.targetType,
          pair.sourceType === UNIT_TYPES.FLAME_TANK ? ANIMATION_LAB_FX_SOURCE_X + 3 : ANIMATION_LAB_FX_TARGET_X,
          pair.y,
          {
            state: UNIT_STATES.IDLE,
            intent: {
              type: "attack",
              targetId: pair.sourceId,
              targetX: ANIMATION_LAB_FX_SOURCE_X,
              targetY: pair.y,
            },
          },
        ));
}

function createAnimationLabProjectile(
  id: string,
  projectileType: ActiveProjectile["projectileType"],
  tick: number,
  periodTicks: number,
  flightTicks: number,
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  offsetTicks = 0,
): ActiveProjectile | null {
  const localTick = tick + offsetTicks;
  const ageTicks = ((localTick % periodTicks) + periodTicks) % periodTicks;
  if (ageTicks >= flightTicks) {
    return null;
  }

  const launchedTick = tick - ageTicks;
  const progress = ageTicks / Math.max(1, flightTicks);
  return {
    id: `${id}_${launchedTick}`,
    playerId: PLAYER_IDS.PLAYER_1,
    attackerId: `${PLAYER_IDS.PLAYER_1}_lab_projectile_source`,
    attackerType: projectileType === PROJECTILE_TYPES.ROCKET
      ? UNIT_TYPES.ROCKET_SOLDIER
      : projectileType === PROJECTILE_TYPES.FLAME
        ? UNIT_TYPES.FLAME_TANK
        : UNIT_TYPES.LIGHT_TANK,
    projectileType,
    x: startX + (targetX - startX) * progress,
    y: startY + (targetY - startY) * progress,
    startX,
    startY,
    targetX,
    targetY,
    launchedTick,
    impactTick: launchedTick + flightTicks,
    splashRadius: projectileType === PROJECTILE_TYPES.BULLET ? undefined : 1,
  };
}

export function createAnimationLabState(tick: number, mode: "implemented" | "preview" = "implemented"): GameState {
  const resourcePositions = new Set(DEFAULT_MAP_LAYOUT.resources.map((position) => `${position.x},${position.y}`));
  const labProjectiles = mode === "implemented"
    ? ANIMATION_LAB_FX_PROJECTILES
        .map((projectile) =>
          createAnimationLabProjectile(
            projectile.id,
            projectile.projectileType,
            tick,
            projectile.periodTicks,
            projectile.flightTicks,
            projectile.sourceX,
            projectile.y,
            projectile.targetX,
            projectile.y,
            projectile.offsetTicks,
          ))
        .filter((projectile): projectile is ActiveProjectile => projectile !== null)
    : [];
  if (mode === "implemented") {
    labProjectiles.push({
      id: `lab_demolition_${tick}`,
      playerId: PLAYER_IDS.PLAYER_1,
      attackerId: `${PLAYER_IDS.PLAYER_1}_lab_commando`,
      attackerType: UNIT_TYPES.COMMANDO,
      projectileType: PROJECTILE_TYPES.DEMOLITION,
      x: 74,
      y: 48,
      startX: 74,
      startY: 48,
      targetX: 78,
      targetY: 48,
      launchedTick: tick,
      impactTick: tick + 1,
      targetId: `${PLAYER_IDS.PLAYER_2}_lab_building_3`,
      targetKind: "building",
    });
  }

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
    projectiles: labProjectiles,
  };
}
