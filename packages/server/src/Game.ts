import {
  Unit,
  UnitIntent,
  AttackTargetType,
  Building,
  BuildingType,
  Player,
  PlayerId,
  GameLog,
  Command,
  GameSnapshot,
  TickDeltaRecord,
  GameState,
  Tile,
  TileType,
  ResultCode,
  TILE_TYPES,
  UNIT_TYPES,
  BUILDING_TYPES,
  UNIT_STATES,
  RESULT_CODES,
  ECONOMY_RULES,
  getAttackDamageAgainstBuilding,
  getDefaultAttackMovePriority,
  getBuildingCost as getRulesetBuildingCost,
  getBuildingFootprint,
  getBuildingFootprintCells,
  getUnitCost as getRulesetUnitCost,
  getUnitVisionRange,
  isBuildableBuildingType,
  isBuildingType,
  isUnitType,
  unitCanAttack,
  TICK_INTERVAL_MS,
  MAP_WIDTH,
  MAP_HEIGHT,
  DEFAULT_MAP_LAYOUT,
  LOG_TYPES,
  LogType,
  defaultLogMeta,
  LOG_LEVELS,
  LogLevel,
  ActorId,
  AI_FEEDBACK_TARGETS,
  AIFeedbackTarget,
  LogDisplayTarget,
  GameLogDataMap,
  RESULT_TYPES
} from "@llmcraft/shared";
import { buildTickDelta } from "./GameHistory";
import { performance } from "node:perf_hooks";
import { gzipSync, gunzipSync } from "node:zlib";
import { MapGenerator } from "./MapGenerator";
import { UnitManager } from "./UnitManager";
import { BuildingManager } from "./BuildingManager";

type AttackIntent = {
  type: "attack";
  targetId?: string;
  targetX?: number;
  targetY?: number;
  targetPriority?: AttackTargetType[];
};

type AttackMoveIntent = {
  type: "attack_move";
  targetX?: number;
  targetY?: number;
  targetId?: string;
  targetPriority?: AttackTargetType[];
};

type HarvestLoopIntent = {
  type: "harvest_loop";
  targetX?: number;
  targetY?: number;
  targetId?: string;
};

type RuntimeUnit = Omit<Unit, "intent" | "lastAttackTick"> & {
  intent?: UnitIntent | AttackIntent | AttackMoveIntent | HarvestLoopIntent;
  lastAttackTick?: number;
};

export interface AgentReadState {
  tick: number;
  players: Player[];
  tiles: Tile[][];
  winner: PlayerId | null;
}

const STARTING_CREDITS = 800;
const TICK_LAG_WARNING_MS = TICK_INTERVAL_MS * 1.8;
const TICK_DURATION_WARNING_MS = 250;
const SNAPSHOT_DURATION_WARNING_MS = 100;
const PERF_WARNING_THROTTLE_MS = 2000;
const MAX_PATH_COMMANDS_PER_TICK = 4;
const MAX_PURSUIT_PATHS_PER_TICK = 4;
const MAX_BLOCKED_REPATHS_PER_TICK = 4;
const TICK_DELTA_CHUNK_SIZE = 100;

export class Game {
  private tick = 0;
  private unitManager = new UnitManager();
  private buildingManager = new BuildingManager();
  private tiles: TileType[][] = [];
  private resourceRemaining = new Map<string, number>();
  private tileView: Tile[][] = [];
  private players: Player[] = [];
  private logs: GameLog[] = [];
  private pendingSnapshotLogs: GameLog[] = [];
  private commandQueue: Command[] = [];
  private initialSnapshot: GameSnapshot | null = null;
  private latestSnapshot: GameSnapshot | null = null;
  private tickDeltaBuffer: TickDeltaRecord[] = [];
  private tickDeltaChunks: string[] = [];
  private aiOutputs: Record<string, string> = {};
  private winner: PlayerId | null = null;
  private isRunning = false;
  private tickInterval: NodeJS.Timeout | null = null;
  private lastTickStartTimeMs: number | null = null;
  private lastTickLagWarningAtMs = 0;
  private lastTickDurationWarningAtMs = 0;

  constructor() {
    this.initializeGame();
  }

  private initializeGame(): void {
    // 1. Generate map
    this.tiles = MapGenerator.generate();
    this.resourceRemaining.clear();
    for (const position of DEFAULT_MAP_LAYOUT.resources) {
      this.resourceRemaining.set(`${position.x},${position.y}`, ECONOMY_RULES.RESOURCE_DEPOSIT_CAPACITY);
    }
    this.tileView = this.createTileView();

    // 2. Create two players
    this.players = [
      {
        id: "player_1",
        units: [],
        buildings: [],
        resources: { credits: STARTING_CREDITS },
      },
      {
        id: "player_2",
        units: [],
        buildings: [],
        resources: { credits: STARTING_CREDITS },
      },
    ];

    // 3. Place HQ
    this.buildingManager.createBuilding(
      BUILDING_TYPES.HQ,
      DEFAULT_MAP_LAYOUT.player1Hq.x,
      DEFAULT_MAP_LAYOUT.player1Hq.y,
      "player_1"
    );
    this.buildingManager.createBuilding(
      BUILDING_TYPES.HQ,
      DEFAULT_MAP_LAYOUT.player2Hq.x,
      DEFAULT_MAP_LAYOUT.player2Hq.y,
      "player_2"
    );

    // 4. Place initial units: 2 workers for each player
    for (const workerPosition of DEFAULT_MAP_LAYOUT.player1Workers) {
      this.unitManager.createUnit(UNIT_TYPES.WORKER, workerPosition.x, workerPosition.y, "player_1");
    }

    for (const workerPosition of DEFAULT_MAP_LAYOUT.player2Workers) {
      this.unitManager.createUnit(UNIT_TYPES.WORKER, workerPosition.x, workerPosition.y, "player_2");
    }

    this.addLog(LOG_TYPES.GAME_INIT, "Game initialized successfully");
    this.saveSnapshot();
  }

  getState(): GameState {
    this.refreshPlayerCollections();

    return this.cloneValue({
      tick: this.tick,
      players: this.players,
      tiles: this.tileView,
      winner: this.winner,
      logs: this.logs,
    });
  }

  getAgentReadState(): AgentReadState {
    this.refreshPlayerCollections();
    return {
      tick: this.tick,
      players: this.players,
      tiles: this.tileView,
      winner: this.winner,
    };
  }

  private refreshPlayerCollections(): void {
    for (const player of this.players) {
      player.units = this.unitManager.getUnitsByPlayer(player.id);
      player.buildings = this.buildingManager.getBuildingsByPlayer(player.id);
    }
  }

  private createTileView(): Tile[][] {
    const tiles: Tile[][] = [];
    for (let y = 0; y < MAP_HEIGHT; y++) {
      tiles[y] = [];
      for (let x = 0; x < MAP_WIDTH; x++) {
        tiles[y][x] = {
          x,
          y,
          type: this.tiles[y][x],
          ...(this.tiles[y][x] === TILE_TYPES.RESOURCE
            ? { resourceRemaining: this.resourceRemaining.get(`${x},${y}`) ?? 0 }
            : {}),
        };
      }
    }
    return tiles;
  }

  queueCommand(command: Command): void {
    this.commandQueue.push(this.normalizeCommand(command));
  }

  processCommands(): void {
    const pendingCommands = this.commandQueue;
    this.commandQueue = [];
    let remainingPathCommands = MAX_PATH_COMMANDS_PER_TICK;
    for (const command of pendingCommands) {
      const requiresPath = command.type === "move" || command.type === "attack_move" || command.type === "harvest_loop";
      if (requiresPath && remainingPathCommands <= 0) {
        this.commandQueue.push(command);
        continue;
      }
      if (requiresPath) remainingPathCommands -= 1;
      try {
        this.processCommand(command);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.addLog(LOG_TYPES.COMMAND_RESULT, `Command processing crashed for ${command.type}`, {
          command,
          result_code: RESULT_CODES.ERR_INVALID_TARGET,
          type: RESULT_TYPES.COMMAND_CRASHED,
          result_data: { error: errorMessage },
        }, {
          owner: command.playerId,
          feedbackTarget: command.playerId,
          level: LOG_LEVELS.ERROR,
        });
        console.error("命令处理异常:", error, command);
      }
    }
  }

  private processCommand(command: Command): void {
    switch (command.type) {
      case "move": {
        if (command.unitId && command.position) {
          const unit = this.unitManager.getUnit(command.unitId);
          if (unit && unit.playerId === command.playerId) {
            const blockedPositions = this.buildingManager.getOccupiedPositions();
            // 使用寻路移动：设置目标，让系统每 tick 自动沿路径移动
            const result: ResultCode = this.unitManager.setMoveTarget(
              unit,
              command.position.x,
              command.position.y,
              this.tiles,
              blockedPositions
            );
            if (result === RESULT_CODES.OK) {
              const resolvedTarget = unit.pathTarget;
              if (
                resolvedTarget &&
                (resolvedTarget.x !== command.position.x || resolvedTarget.y !== command.position.y)
              ) {
                this.addLog(
                  LOG_TYPES.COMMAND_RESULT,
                  `Unit ${command.unitId} rerouted to (${resolvedTarget.x}, ${resolvedTarget.y})`,
                  {
                    command,
                    result_code: result,
                    type: RESULT_TYPES.MOVE_ADJUSTED,
                    result_data: {
                      x: resolvedTarget.x,
                      y: resolvedTarget.y,
                      requestedX: command.position.x,
                      requestedY: command.position.y,
                      hint: "Target tile was blocked, so a nearby reachable tile was chosen.",
                    },
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                    level: LOG_LEVELS.WARNING,
                  }
                );
              } else {
                this.addLog(
                  LOG_TYPES.COMMAND_RESULT,
                  `Unit ${command.unitId} moving to (${command.position.x}, ${command.position.y})`,
                  {
                    command,
                    result_code: result,
                    type: RESULT_TYPES.MOVE_SUCCESS,
                    result_data: {},
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                  }
                );
              }
            } else {
              const failure = this.describeMoveFailure(unit.id, command.position.x, command.position.y) ?? {
                type: "move_unreachable",
                hint: "No reachable nearby tile found.",
              };
              this.addLog(
                LOG_TYPES.COMMAND_RESULT,
                `Unit ${command.unitId} cannot move to (${command.position.x}, ${command.position.y})`,
                {
                  command,
                  result_code: result,
                  type: RESULT_TYPES.MOVE_BLOCKED,
                  result_data: {
                    x: command.position.x,
                    y: command.position.y,
                    requestedX: command.position.x,
                    requestedY: command.position.y,
                    hint: failure.hint,
                    type: failure.type,
                  },
                },
                {
                  owner: command.playerId,
                  feedbackTarget: command.playerId,
                  level: LOG_LEVELS.WARNING,
                }
              );
            }
          } else {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              `Move command failed: unit ${command.unitId} not found or does not belong to player`,
              {
                command,
                result_code: RESULT_CODES.ERR_INVALID_TARGET,
                type: RESULT_TYPES.INVALID_UNIT,
                result_data: {
                  unitId: command.unitId,
                  hint: "Check that the unit exists and belongs to your player.",
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
                level: LOG_LEVELS.WARNING,
              }
            );
          }
        }
        break;
      }

      case "attack": {
        if (command.unitId && command.targetId) {
          const attacker = this.unitManager.getUnit(command.unitId);
          if (attacker && attacker.playerId === command.playerId) {
            const result = this.executeAttackIntent(attacker, command.playerId, {
              type: "attack",
              targetId: command.targetId,
            });

            if (result !== RESULT_CODES.OK) {
              if (result === RESULT_CODES.ERR_NOT_IN_RANGE) {
                this.addLog(
                  LOG_TYPES.COMMAND_RESULT,
                  `Attack command failed for unit ${command.unitId}`,
                  {
                    command,
                    result_code: result,
                    type: RESULT_TYPES.ATTACK_OUT_OF_RANGE,
                    result_data: {
                      targetId: command.targetId!,
                      hint: "Move to a tile adjacent to the target before attacking.",
                    },
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                    level: LOG_LEVELS.WARNING,
                  }
                );
              } else {
                this.addLog(
                  LOG_TYPES.COMMAND_RESULT,
                  `Attack command failed for unit ${command.unitId}`,
                  {
                    command,
                    result_code: result,
                    type: RESULT_TYPES.ATTACK_INVALID_TARGET,
                    result_data: {
                      hint: "Check that the target still exists and belongs to the enemy.",
                    },
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                    level: LOG_LEVELS.WARNING,
                  }
                );
              }
            } else {
              this.addLog(
                LOG_TYPES.COMMAND_RESULT,
                `Unit ${command.unitId} attacking target ${command.targetId}`,
                {
                  command,
                  result_code: result,
                  type: RESULT_TYPES.ATTACK_SUCCESS,
                  result_data: {},
                },
                {
                  owner: command.playerId,
                  feedbackTarget: command.playerId,
                }
              );
            }
          } else {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              `Attack command failed: unit ${command.unitId} not found or does not belong to player`,
              {
                command,
                result_code: RESULT_CODES.ERR_INVALID_TARGET,
                type: RESULT_TYPES.INVALID_UNIT,
                result_data: {
                  unitId: command.unitId,
                  hint: "Check that the unit exists and belongs to your player.",
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
                level: LOG_LEVELS.WARNING,
              }
            );
          }
        }
        break;
      }

      case "attack_in_range": {
        if (command.unitId) {
          const attacker = this.unitManager.getUnit(command.unitId) as RuntimeUnit | undefined;
          if (attacker && attacker.playerId === command.playerId) {
            const result = this.executeAttackIntent(attacker, command.playerId, {
              type: "attack",
              targetPriority: command.targetPriority,
            });

            if (result !== RESULT_CODES.OK) {
              this.addLog(
                LOG_TYPES.COMMAND_RESULT,
                `Attack-in-range command failed for unit ${command.unitId}`,
                {
                  command,
                  result_code: result,
                  type: RESULT_TYPES.ATTACK_NO_TARGET_IN_RANGE,
                  result_data: {
                    hint: "No enemy matching the requested priority was in range at execution time.",
                  },
                },
                {
                  owner: command.playerId,
                  feedbackTarget: command.playerId,
                  level: LOG_LEVELS.WARNING,
                }
              );
            } else {
              this.addLog(
                LOG_TYPES.COMMAND_RESULT,
                `Unit ${command.unitId} attacking nearest enemy in range`,
                {
                  command,
                  result_code: result,
                  type: RESULT_TYPES.ATTACK_SUCCESS,
                  result_data: {},
                },
                {
                  owner: command.playerId,
                  feedbackTarget: command.playerId,
                }
              );
            }
          } else {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              `Attack-in-range command failed: unit ${command.unitId} not found or does not belong to player`,
              {
                command,
                result_code: RESULT_CODES.ERR_INVALID_TARGET,
                type: RESULT_TYPES.INVALID_UNIT,
                result_data: {
                  unitId: command.unitId,
                  hint: "Check that the unit exists and belongs to your player.",
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
                level: LOG_LEVELS.WARNING,
              }
            );
          }
        }
        break;
      }

      case "attack_move": {
        if (command.unitId && command.position) {
          const attacker = this.unitManager.getUnit(command.unitId) as RuntimeUnit | undefined;
          if (attacker && attacker.playerId === command.playerId) {
            const blockedPositions = this.buildingManager.getOccupiedPositions();
            const result = this.unitManager.setMoveTarget(
              attacker,
              command.position.x,
              command.position.y,
              this.tiles,
              blockedPositions,
              true
            );

            if (result === RESULT_CODES.OK) {
              const resolvedTarget = attacker.pathTarget;
              attacker.intent = {
                type: "attack_move",
                targetX: resolvedTarget?.x ?? command.position.x,
                targetY: resolvedTarget?.y ?? command.position.y,
                targetPriority: command.targetPriority,
              };

              if (
                resolvedTarget &&
                (resolvedTarget.x !== command.position.x || resolvedTarget.y !== command.position.y)
              ) {
                this.addLog(
                  LOG_TYPES.COMMAND_RESULT,
                  `Unit ${command.unitId} attack-moving via (${resolvedTarget.x}, ${resolvedTarget.y})`,
                  {
                    command,
                    result_code: result,
                    type: RESULT_TYPES.MOVE_ADJUSTED,
                    result_data: {
                      x: resolvedTarget.x,
                      y: resolvedTarget.y,
                      requestedX: command.position.x,
                      requestedY: command.position.y,
                      hint: "Attack-move target tile was blocked, so a nearby reachable tile was chosen.",
                    },
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                    level: LOG_LEVELS.WARNING,
                  }
                );
              } else {
                this.addLog(
                  LOG_TYPES.COMMAND_RESULT,
                  `Unit ${command.unitId} attack-moving to (${command.position.x}, ${command.position.y})`,
                  {
                    command,
                    result_code: result,
                    type: RESULT_TYPES.ATTACK_MOVE_SUCCESS,
                    result_data: {},
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                  }
                );
              }
            } else {
              const failure = this.describeMoveFailure(attacker.id, command.position.x, command.position.y) ?? {
                type: "move_unreachable",
                hint: "No reachable nearby tile found.",
              };
              this.addLog(
                LOG_TYPES.COMMAND_RESULT,
                `Unit ${command.unitId} cannot attack-move to (${command.position.x}, ${command.position.y})`,
                {
                  command,
                  result_code: result,
                  type: RESULT_TYPES.MOVE_BLOCKED,
                  result_data: {
                    x: command.position.x,
                    y: command.position.y,
                    requestedX: command.position.x,
                    requestedY: command.position.y,
                    hint: failure.hint,
                    type: failure.type,
                  },
                },
                {
                  owner: command.playerId,
                  feedbackTarget: command.playerId,
                  level: LOG_LEVELS.WARNING,
                }
              );
            }
          } else {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              `Attack-move command failed: unit ${command.unitId} not found or does not belong to player`,
              {
                command,
                result_code: RESULT_CODES.ERR_INVALID_TARGET,
                type: RESULT_TYPES.INVALID_UNIT,
                result_data: {
                  unitId: command.unitId,
                  hint: "Check that the unit exists and belongs to your player.",
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
                level: LOG_LEVELS.WARNING,
              }
            );
          }
        }
        break;
      }

      case "harvest_loop": {
        if (command.unitId) {
          const worker = this.unitManager.getUnit(command.unitId) as RuntimeUnit | undefined;
          if (!worker || worker.playerId !== command.playerId || worker.type !== UNIT_TYPES.WORKER) {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              `Harvest-loop command failed: worker ${command.unitId} not found or invalid`,
              {
                command,
                result_code: RESULT_CODES.ERR_INVALID_TARGET,
                type: RESULT_TYPES.INVALID_UNIT,
                result_data: {
                  unitId: command.unitId,
                  hint: "Only friendly workers can start harvest loops.",
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
                level: LOG_LEVELS.WARNING,
              }
            );
            break;
          }

          const resourceTarget = this.resolveHarvestResourceTarget(worker, command.position);
          if (!resourceTarget) {
            const fallbackX = command.position?.x ?? worker.x;
            const fallbackY = command.position?.y ?? worker.y;
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              `Harvest-loop command failed: invalid resource target for ${command.unitId}`,
              {
                command,
                result_code: RESULT_CODES.ERR_INVALID_TARGET,
                type: RESULT_TYPES.MOVE_BLOCKED,
                result_data: {
                  x: fallbackX,
                  y: fallbackY,
                  requestedX: fallbackX,
                  requestedY: fallbackY,
                  hint: "Choose a reachable resource tile, or omit the target to auto-pick the nearest resource.",
                  type: "move_bad_target",
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
                level: LOG_LEVELS.WARNING,
              }
            );
            break;
          }

          worker.intent = {
            type: "harvest_loop",
            targetX: resourceTarget.x,
            targetY: resourceTarget.y,
          };
          this.unitManager.clearPath(worker);
          this.addLog(
            LOG_TYPES.COMMAND_RESULT,
            `Worker ${command.unitId} harvesting in a loop from (${resourceTarget.x}, ${resourceTarget.y})`,
            {
              command,
              result_code: RESULT_CODES.OK,
              type: RESULT_TYPES.HARVEST_LOOP_SUCCESS,
              result_data: {
                targetX: resourceTarget.x,
                targetY: resourceTarget.y,
              },
            },
            {
              owner: command.playerId,
              feedbackTarget: command.playerId,
            }
          );
        }
        break;
      }

      case "hold": {
        if (command.unitId) {
          const unit = this.unitManager.getUnit(command.unitId);
          if (unit && unit.playerId === command.playerId) {
            this.unitManager.holdPosition(unit);
            // 清除寻路路径
            this.unitManager.clearPath(unit);
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              `Unit ${command.unitId} holding position`,
              {
                command,
                result_code: RESULT_CODES.OK,
                type: RESULT_TYPES.HOLD_SUCCESS,
                result_data: {
                  unitId: command.unitId,
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
              }
            );
          }
        }
        break;
      }

      case "spawn": {
        if (command.buildingId && command.unitType) {
          const building = this.buildingManager.getBuilding(command.buildingId);
          if (building && building.playerId === command.playerId) {
            const player = this.players.find((p) => p.id === command.playerId);
            if (player) {
              const unitCost = this.getUnitCost(command.unitType);
              if (!this.buildingManager.canProduce(building, command.unitType)) {
                const result = RESULT_CODES.ERR_INVALID_BUILDING;
                this.addLog(
                  LOG_TYPES.COMMAND_RESULT,
                  `Spawn command failed: ${building.type} cannot produce ${command.unitType}`,
                  {
                    command,
                    result_code: result,
                    type: RESULT_TYPES.SPAWN_INVALID_BUILDING,
                    result_data: {
                      buildingId: building.id,
                      buildingType: building.type,
                      unitType: command.unitType,
                      hint: building.type === BUILDING_TYPES.HQ
                        ? "HQ can only spawn workers. Build a barracks to produce soldiers."
                        : "Check that the unit type matches the building.",
                    },
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                    level: LOG_LEVELS.WARNING,
                  }
                );
              } else if (player.resources.credits >= unitCost) {
                player.resources.credits -= unitCost;
                this.buildingManager.spawnUnit(building, command.unitType);
                this.addLog(
                  LOG_TYPES.COMMAND_RESULT,
                  `Spawn command queued: ${command.unitType} from ${building.type}`,
                  {
                    command,
                    result_code: RESULT_CODES.OK,
                    type: RESULT_TYPES.SPAWN_SUCCESS,
                    result_data: {
                      buildingId: building.id,
                      unitType: command.unitType,
                    },
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                  }
                );
              } else {
                this.addLog(
                  LOG_TYPES.COMMAND_RESULT,
                  "Spawn command failed: insufficient credits",
                  {
                    command,
                    result_code: RESULT_CODES.ERR_NOT_ENOUGH_CREDITS,
                    type: RESULT_TYPES.SPAWN_INSUFFICIENT_CREDITS,
                    result_data: {
                      buildingId: building.id,
                      unitType: command.unitType,
                      requiredCredits: unitCost,
                      currentCredits: player.resources.credits,
                      hint: `Need ${unitCost} credits before spawning ${command.unitType}.`,
                    },
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                    level: LOG_LEVELS.WARNING,
                  }
                );
              }
            }
          }
        }
        break;
      }

      case "build": {
        if (command.unitId && command.position && command.buildingType) {
          const unit = this.unitManager.getUnit(command.unitId);
          const player = this.players.find((p) => p.id === command.playerId);

          if (!unit || !player || unit.playerId !== command.playerId || unit.type !== UNIT_TYPES.WORKER) {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              "Build command failed: only a friendly worker can build",
              {
                command,
                result_code: RESULT_CODES.ERR_INVALID_TARGET,
                type: RESULT_TYPES.INVALID_UNIT,
                result_data: {
                  unitId: command.unitId,
                  hint: "Only workers can construct buildings. Ensure the unit exists and is a worker and belongs to your player.",
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
                level: LOG_LEVELS.WARNING,
              }
            );
            break;
          }

          if (!isBuildableBuildingType(command.buildingType)) {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              "Build command failed: invalid building type",
              {
                command,
                result_code: RESULT_CODES.ERR_INVALID_BUILDING,
                type: RESULT_TYPES.BUILD_INVALID_BUILDING,
                result_data: {
                  hint: "Buildable structures are barracks and war_factory. HQ cannot be built.",
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
                level: LOG_LEVELS.WARNING,
              }
            );
            break;
          }

          const buildingCost = this.getBuildingCost(command.buildingType);
          if (player.resources.credits < buildingCost) {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              "Build command failed: insufficient credits",
              {
                command,
                result_code: RESULT_CODES.ERR_NOT_ENOUGH_CREDITS,
                type: RESULT_TYPES.BUILD_INSUFFICIENT_CREDITS,
                result_data: {
                  x: command.position.x,
                  y: command.position.y,
                  requiredCredits: buildingCost,
                  currentCredits: player.resources.credits,
                  hint: `Need ${buildingCost} credits before building ${command.buildingType}.`,
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
                level: LOG_LEVELS.WARNING,
              }
            );
            break;
          }

          const result = this.validateBuildPosition(command.playerId, command.buildingType, command.position.x, command.position.y);
          if (result !== RESULT_CODES.OK) {
            const buildFailure = this.describeBuildFailure(command.playerId, command.buildingType, command.position.x, command.position.y);
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              "Build command failed: invalid build position",
              {
                command,
                result_code: result,
                type: RESULT_TYPES.BUILD_INVALID_POSITION,
                result_data: {
                  x: command.position.x,
                  y: command.position.y,
                  hint: buildFailure.hint,
                  type: buildFailure.type,
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
                level: LOG_LEVELS.WARNING,
              }
            );
            break;
          }

          player.resources.credits -= buildingCost;
          const newBuilding = this.buildingManager.createBuilding(
            command.buildingType,
            command.position.x,
            command.position.y,
            command.playerId
          );
          this.addLog(LOG_TYPES.COMMAND_RESULT, `${command.buildingType} constructed for ${command.playerId}`, {
            command,
            result_code: RESULT_CODES.OK,
            type: RESULT_TYPES.BUILDING_CONSTRUCTED,
            result_data: {
              buildingId: newBuilding.id,
              buildingType: newBuilding.type,
              x: newBuilding.x,
              y: newBuilding.y,
            },
          }, {
            owner: command.playerId,
            feedbackTarget: command.playerId,
          });
        }
        break;
      }
    }
  }

  private getUnitCost(unitType: string): number {
    return isUnitType(unitType) ? getRulesetUnitCost(unitType) : 0;
  }

  private getBuildingCost(buildingType: string): number {
    return isBuildingType(buildingType) ? getRulesetBuildingCost(buildingType) : 0;
  }

  private attackBuilding(attacker: RuntimeUnit, target: Building): ResultCode {
    if (!attacker.exists || !target.exists) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    if (attacker.playerId === target.playerId) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    const distance = this.buildingManager.getDistanceToBuilding(target, attacker.x, attacker.y);
    if (distance > attacker.attackRange) {
      return RESULT_CODES.ERR_NOT_IN_RANGE;
    }

    const damage = getAttackDamageAgainstBuilding(attacker.type, target.type);
    this.buildingManager.takeDamage(target, damage);
    attacker.state = UNIT_STATES.ATTACKING;
    attacker.intent = { type: "attack", targetId: target.id, targetX: target.x, targetY: target.y };
    attacker.lastAttackTick = this.tick;

    return RESULT_CODES.OK;
  }

  private executeAttackTarget(
    attacker: RuntimeUnit,
    target: Unit | Building,
    kind: "unit" | "building"
  ): ResultCode {
    if (kind === "building") {
      return this.attackBuilding(attacker, target as Building);
    }

    const targetUnit = target as RuntimeUnit;
    const result = this.unitManager.attackUnit(attacker, targetUnit);
    if (result === RESULT_CODES.OK) {
      this.processUnitRetaliation(targetUnit, attacker);
    }
    return result;
  }

  private processUnitRetaliation(defender: RuntimeUnit, attacker: RuntimeUnit): void {
    if (!this.canUseUnitRetaliation(defender, attacker)) {
      return;
    }

    const result = this.unitManager.attackUnit(defender, attacker);
    if (result === RESULT_CODES.OK) {
      this.unitManager.clearPath(defender);
      defender.lastAttackTick = this.tick;
    }
  }

  private canUseUnitRetaliation(defender: RuntimeUnit, attacker: RuntimeUnit): boolean {
    if (
      !defender.exists ||
      !attacker.exists ||
      defender.playerId === attacker.playerId ||
      defender.lastAttackTick === this.tick ||
      !unitCanAttack(defender.type) ||
      defender.attackRange <= 0
    ) {
      return false;
    }

    if (defender.path?.length || defender.pathTarget) {
      return false;
    }

    if (defender.intent && defender.intent.type !== "hold") {
      return false;
    }

    return this.getChebyshevDistance(defender, attacker) <= defender.attackRange;
  }

  private getChebyshevDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  private executeAttackIntent(
    attacker: RuntimeUnit,
    playerId: PlayerId,
    intent: AttackIntent | UnitIntent
  ): ResultCode {
    if (!attacker.exists || !intent || intent.type !== "attack") {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    let result: ResultCode;

    if (intent.targetId) {
      const unitTarget = this.unitManager.getUnit(intent.targetId);
      const buildingTarget = this.buildingManager.getBuilding(intent.targetId);
      result = unitTarget
        ? this.executeAttackTarget(attacker, unitTarget, "unit")
        : buildingTarget
          ? this.executeAttackTarget(attacker, buildingTarget, "building")
          : RESULT_CODES.ERR_INVALID_TARGET;
    } else {
      const prioritizedTarget = this.findPrioritizedAttackTarget(attacker, playerId, intent.targetPriority);
      result = prioritizedTarget
        ? this.executeAttackTarget(attacker, prioritizedTarget.target, prioritizedTarget.kind)
        : RESULT_CODES.ERR_NOT_IN_RANGE;
    }

    if (result === RESULT_CODES.OK) {
      this.unitManager.clearPath(attacker);
      const resolvedIntent = attacker.intent;
      attacker.intent = {
        type: "attack",
        targetId: intent.targetId,
        targetPriority: intent.targetPriority,
        targetX: resolvedIntent?.targetX,
        targetY: resolvedIntent?.targetY,
      };
      attacker.lastAttackTick = this.tick;
    }

    return result;
  }

  private processAttackMoveIntents(): void {
    let remainingPursuitPaths = MAX_PURSUIT_PATHS_PER_TICK;
    for (const unit of this.unitManager.getAllUnits()) {
      const runtimeUnit = unit as RuntimeUnit;
      if (!runtimeUnit.exists || runtimeUnit.intent?.type !== "attack_move") {
        continue;
      }

      const attackMoveIntent = runtimeUnit.intent;
      const moveTarget = attackMoveIntent.targetX !== undefined && attackMoveIntent.targetY !== undefined
        ? { x: attackMoveIntent.targetX, y: attackMoveIntent.targetY }
        : null;

      if (!moveTarget || (runtimeUnit.x === moveTarget.x && runtimeUnit.y === moveTarget.y)) {
        this.unitManager.clearPath(runtimeUnit);
        runtimeUnit.intent = { type: "hold" };
        runtimeUnit.state = UNIT_STATES.IDLE;
        continue;
      }

      if (runtimeUnit.lastAttackTick !== this.tick) {
        const prioritizedTarget = this.findPrioritizedAttackTarget(
          runtimeUnit,
          runtimeUnit.playerId,
          attackMoveIntent.targetPriority
        );

        if (prioritizedTarget) {
          const result = this.executeAttackTarget(runtimeUnit, prioritizedTarget.target, prioritizedTarget.kind);
          if (result === RESULT_CODES.OK) {
            runtimeUnit.intent = {
              ...attackMoveIntent,
              targetId: prioritizedTarget.target.id,
            };
            runtimeUnit.lastAttackTick = this.tick;
            this.unitManager.clearPath(runtimeUnit);
            continue;
          }
          if (result === RESULT_CODES.ERR_NOT_IN_RANGE) {
            if (attackMoveIntent.targetId === prioritizedTarget.target.id && runtimeUnit.pathTarget) {
              continue;
            }
            if (remainingPursuitPaths <= 0) {
              continue;
            }
            remainingPursuitPaths -= 1;
            const blockedPositions = this.buildingManager.getOccupiedPositions();
            const moveResult = this.unitManager.setMoveTarget(
              runtimeUnit,
              prioritizedTarget.target.x,
              prioritizedTarget.target.y,
              this.tiles,
              blockedPositions,
              true,
            );
            if (moveResult === RESULT_CODES.OK) {
              runtimeUnit.intent = {
                ...attackMoveIntent,
                targetId: prioritizedTarget.target.id,
              };
              continue;
            }
          }
        }
      }

      delete attackMoveIntent.targetId;
      const alreadyPathing =
        runtimeUnit.pathTarget?.x === moveTarget.x &&
        runtimeUnit.pathTarget?.y === moveTarget.y;
      if (!alreadyPathing) {
        const blockedPositions = this.buildingManager.getOccupiedPositions();
        const result = this.unitManager.setMoveTarget(
          runtimeUnit,
          moveTarget.x,
          moveTarget.y,
          this.tiles,
          blockedPositions,
          true
        );
        if (result === RESULT_CODES.OK) {
          runtimeUnit.intent = {
            ...attackMoveIntent,
            targetX: runtimeUnit.pathTarget?.x ?? moveTarget.x,
            targetY: runtimeUnit.pathTarget?.y ?? moveTarget.y,
          };
        }
      }

      if (!runtimeUnit.pathTarget && runtimeUnit.lastAttackTick !== this.tick) {
        runtimeUnit.state = UNIT_STATES.IDLE;
      }
    }
  }

  private processAttackIntents(): void {
    for (const unit of this.unitManager.getAllUnits()) {
      if (!unit.exists || unit.intent?.type !== "attack") {
        continue;
      }

      const runtimeUnit = unit as RuntimeUnit;

      if (runtimeUnit.lastAttackTick === this.tick) {
        continue;
      }

      const result = this.executeAttackIntent(runtimeUnit, runtimeUnit.playerId, runtimeUnit.intent as AttackIntent);
      if (result === RESULT_CODES.ERR_INVALID_TARGET && runtimeUnit.intent?.targetId) {
        runtimeUnit.intent = { type: "hold" };
        runtimeUnit.state = UNIT_STATES.IDLE;
      } else if (result !== RESULT_CODES.OK && runtimeUnit.intent?.targetId) {
        runtimeUnit.state = UNIT_STATES.IDLE;
      }
    }
  }

  private processHarvestLoopIntents(): void {
    for (const unit of this.unitManager.getAllUnits()) {
      const runtimeUnit = unit as RuntimeUnit;
      if (
        !runtimeUnit.exists ||
        runtimeUnit.intent?.type !== "harvest_loop" ||
        runtimeUnit.type !== UNIT_TYPES.WORKER
      ) {
        continue;
      }

      const harvestIntent = runtimeUnit.intent;
      const deliveryBuilding = this.buildingManager
        .getBuildingsByPlayer(runtimeUnit.playerId)
        .filter((building) => this.isResourceDeliveryBuilding(building))
        .sort((left, right) =>
          this.buildingManager.getDistanceToBuilding(left, runtimeUnit.x, runtimeUnit.y) -
          this.buildingManager.getDistanceToBuilding(right, runtimeUnit.x, runtimeUnit.y)
        )[0];
      if (!deliveryBuilding) {
        continue;
      }

      const resourceTarget = this.resolveHarvestResourceTarget(runtimeUnit, {
        x: harvestIntent.targetX ?? runtimeUnit.x,
        y: harvestIntent.targetY ?? runtimeUnit.y,
      });
      if (!resourceTarget) {
        continue;
      }

      runtimeUnit.intent = {
        type: "harvest_loop",
        targetX: resourceTarget.x,
        targetY: resourceTarget.y,
      };

      if (runtimeUnit.carryingCredits >= runtimeUnit.carryCapacity) {
        if (!this.isWithinDeliveryRange(runtimeUnit, deliveryBuilding) && !this.isPathingIntoDeliveryRange(runtimeUnit, deliveryBuilding)) {
          const blockedPositions = this.buildingManager.getOccupiedPositions();
          if (this.unitManager.setMoveTarget(runtimeUnit, deliveryBuilding.x, deliveryBuilding.y, this.tiles, blockedPositions) === RESULT_CODES.OK) {
            runtimeUnit.intent = {
              type: "harvest_loop",
              targetX: resourceTarget.x,
              targetY: resourceTarget.y,
            };
          }
        }
        continue;
      }

      const onResourceTile = runtimeUnit.x === resourceTarget.x && runtimeUnit.y === resourceTarget.y;
      const pathingToResource =
        runtimeUnit.pathTarget?.x === resourceTarget.x &&
        runtimeUnit.pathTarget?.y === resourceTarget.y;

      if (!onResourceTile && !pathingToResource) {
        const blockedPositions = this.buildingManager.getOccupiedPositions();
        if (
          this.unitManager.setMoveTarget(runtimeUnit, resourceTarget.x, resourceTarget.y, this.tiles, blockedPositions) ===
          RESULT_CODES.OK
        ) {
          runtimeUnit.intent = {
            type: "harvest_loop",
            targetX: resourceTarget.x,
            targetY: resourceTarget.y,
          };
        }
      }
    }
  }

  private findPrioritizedAttackTarget(
    attacker: Unit,
    playerId: PlayerId,
    targetPriority?: AttackTargetType[]
  ): { kind: "unit"; target: Unit } | { kind: "building"; target: Building } | null {
    const hasExplicitPriority = Boolean(targetPriority && targetPriority.length > 0);
    const priority = (
      hasExplicitPriority
        ? targetPriority!
        : getDefaultAttackMovePriority(attacker.type)
    ).map((value) => String(value).toLowerCase());

    const acquisitionRange = getUnitVisionRange(attacker.type);
    const enemyUnits = this.unitManager
      .getAllUnits()
      .filter((unit) => unit.exists && unit.playerId !== playerId)
      .filter((unit) => Math.max(Math.abs(attacker.x - unit.x), Math.abs(attacker.y - unit.y)) <= acquisitionRange);
    const enemyBuildings = this.buildingManager
      .getAllBuildings()
      .filter((building) => building.exists && building.playerId !== playerId)
      .filter(
        (building) =>
          this.buildingManager.getDistanceToBuilding(building, attacker.x, attacker.y) <= acquisitionRange
      );

    const fallbackUnits = enemyUnits.sort((a, b) => a.id.localeCompare(b.id));
    const fallbackBuildings = enemyBuildings.sort((a, b) => a.id.localeCompare(b.id));

    for (const requestedType of priority) {
      const unitTarget = fallbackUnits.find((unit) => unit.type === requestedType);
      if (unitTarget) {
        return { kind: "unit", target: unitTarget };
      }

      const buildingTarget = fallbackBuildings.find((building) => building.type === requestedType);
      if (buildingTarget) {
        return { kind: "building", target: buildingTarget };
      }
    }

    if (hasExplicitPriority) {
      return null;
    }

    if (fallbackBuildings.length > 0) {
      return { kind: "building", target: fallbackBuildings[0] };
    }
    if (fallbackUnits.length > 0) {
      return { kind: "unit", target: fallbackUnits[0] };
    }

    return null;
  }

  private resolveHarvestResourceTarget(
    worker: Unit,
    requestedPosition?: { x: number; y: number }
  ): { x: number; y: number } | null {
    if (
      requestedPosition &&
      requestedPosition.x >= 0 &&
      requestedPosition.x < MAP_WIDTH &&
      requestedPosition.y >= 0 &&
      requestedPosition.y < MAP_HEIGHT &&
      this.tiles[requestedPosition.y][requestedPosition.x] === TILE_TYPES.RESOURCE
    ) {
      return requestedPosition;
    }

    if (requestedPosition) {
      return null;
    }

    const assignedHarvesters = new Map<string, number>();
    for (const unit of this.unitManager.getUnitsByPlayer(worker.playerId)) {
      if (unit.id === worker.id || unit.type !== UNIT_TYPES.WORKER || unit.intent?.type !== "harvest_loop") {
        continue;
      }
      const targetX = unit.intent.targetX;
      const targetY = unit.intent.targetY;
      if (targetX === undefined || targetY === undefined) {
        continue;
      }
      assignedHarvesters.set(`${targetX},${targetY}`, (assignedHarvesters.get(`${targetX},${targetY}`) ?? 0) + 1);
    }

    let best: { x: number; y: number; distance: number; assignedHarvesters: number; score: number } | null = null;
    for (let y = 0; y < MAP_HEIGHT; y++) {
      for (let x = 0; x < MAP_WIDTH; x++) {
        if (
          this.tiles[y][x] !== TILE_TYPES.RESOURCE ||
          (this.resourceRemaining.get(`${x},${y}`) ?? 0) <= 0
        ) {
          continue;
        }
        const distance = Math.max(Math.abs(worker.x - x), Math.abs(worker.y - y));
        const assigned = assignedHarvesters.get(`${x},${y}`) ?? 0;
        const score = distance + assigned * 4;
        if (
          !best ||
          score < best.score ||
          (score === best.score &&
            (assigned < best.assignedHarvesters ||
              (assigned === best.assignedHarvesters &&
                (distance < best.distance || (distance === best.distance && (y < best.y || (y === best.y && x < best.x)))))))
        ) {
          best = { x, y, distance, assignedHarvesters: assigned, score };
        }
      }
    }

    return best ? { x: best.x, y: best.y } : null;
  }

  private isPathingIntoDeliveryRange(unit: RuntimeUnit, building: Building): boolean {
    return Boolean(
      unit.pathTarget &&
      this.buildingManager.getDistanceToBuilding(building, unit.pathTarget.x, unit.pathTarget.y) <= this.getDeliveryRange(building)
    );
  }

  checkWinCondition(): boolean {
    for (const player of this.players) {
      const buildings = this.buildingManager.getBuildingsByPlayer(player.id);
      const hasHQ = buildings.some((b) => b.type === BUILDING_TYPES.HQ);

      if (!hasHQ) {
        // Find the other player as winner
        const winner = this.players.find((p) => p.id !== player.id);
        if (winner) {
          this.winner = winner.id;
          this.addLog(LOG_TYPES.GAME_END, `Player ${winner.id} wins!`, {
            winner: winner.id,
            loser: player.id,
          });
          this.stop();
          return true;
        }
      }
    }
    return false;
  }

  tickUpdate(): void {
    if (!this.isRunning) return;

    const tickStartedAt = performance.now();
    if (this.lastTickStartTimeMs !== null) {
      const elapsedMs = tickStartedAt - this.lastTickStartTimeMs;
      if (elapsedMs > TICK_LAG_WARNING_MS && tickStartedAt - this.lastTickLagWarningAtMs > PERF_WARNING_THROTTLE_MS) {
        this.lastTickLagWarningAtMs = tickStartedAt;
        this.addLog(LOG_TYPES.PERF_WARNING, `Tick interval lagged by ${Math.round(elapsedMs - TICK_INTERVAL_MS)}ms`, {
          scope: "game_tick",
          phase: "interval",
          elapsedMs: Math.round(elapsedMs),
          expectedMs: TICK_INTERVAL_MS,
          tick: this.tick,
        });
      }
    }
    this.lastTickStartTimeMs = tickStartedAt;

    try {
      this.tick++;

      // Process commands
      this.processCommands();

      // Process unit path movement (自动寻路移动)
      const blockedPositions = this.buildingManager.getOccupiedPositions();
      const repathBudget = { remaining: MAX_BLOCKED_REPATHS_PER_TICK };
      for (const unit of this.unitManager.getAllUnits()) {
        this.unitManager.processPathMovement(unit, this.tiles, blockedPositions, repathBudget);
      }

      // Process worker economy loop: gather on resource tiles, then deliver near HQ
      this.processWorkerEconomy();

      // Sustain harvest loops and attack-move intents.
      this.processHarvestLoopIntents();
      this.processAttackMoveIntents();

      // Sustain attack intents every tick so units keep attacking in range.
      this.processAttackIntents();

      // Process building production queues
      const completedUnits = this.buildingManager.processProductionQueues();
      for (const [playerId, completions] of completedUnits) {
        for (const completion of completions) {
          const spawnBuilding = this.buildingManager.getBuilding(completion.buildingId);

          if (spawnBuilding && spawnBuilding.exists) {
            // Find an empty position near the building
            const spawnPos = this.findEmptySpawnPosition(spawnBuilding);
            if (spawnPos) {
              this.unitManager.createUnit(completion.unitType, spawnPos.x, spawnPos.y, playerId);
              this.addLog(LOG_TYPES.UNIT_SPAWNED, `Unit ${completion.unitType} spawned for ${playerId}`, {
                unitType: completion.unitType,
              }, {
                owner: playerId,
                feedbackTarget: playerId,
              });
            } else {
              this.addLog(LOG_TYPES.SPAWN_FAILED, `No empty position to spawn ${completion.unitType} for ${playerId}`, {
                unitType: completion.unitType,
              }, { owner: playerId });
            }
          }
        }
      }

      // Check win condition
      this.checkWinCondition();
    } catch (error) {
      this.addLog(LOG_TYPES.TICK_ERROR, "Tick update crashed", {
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("Tick 更新异常:", error);
    } finally {
      // Save snapshot even if the tick had partial failure so the client stays connected.
      const snapshotStartedAt = performance.now();
      this.saveSnapshot();
      const snapshotMs = performance.now() - snapshotStartedAt;
      const tickDurationMs = performance.now() - tickStartedAt;
      if (
        (tickDurationMs > TICK_DURATION_WARNING_MS || snapshotMs > SNAPSHOT_DURATION_WARNING_MS) &&
        tickStartedAt - this.lastTickDurationWarningAtMs > PERF_WARNING_THROTTLE_MS
      ) {
        this.lastTickDurationWarningAtMs = tickStartedAt;
        this.addLog(LOG_TYPES.PERF_WARNING, `Tick work took ${Math.round(tickDurationMs)}ms`, {
          scope: "game_tick",
          phase: "work",
          elapsedMs: Math.round(tickDurationMs),
          tick: this.tick,
          details: {
            snapshotMs: Math.round(snapshotMs),
          },
        });
      }
    }
  }

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.lastTickStartTimeMs = null;
    this.addLog(LOG_TYPES.GAME_STARTED, "Game started");

    this.tickInterval = setInterval(() => {
      this.tickUpdate();
    }, TICK_INTERVAL_MS);
  }

  stop(): void {
    this.isRunning = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.lastTickStartTimeMs = null;
    this.addLog(LOG_TYPES.GAME_STOPPED, "Game stopped");
  }

  addLog<T extends LogType>(
    type: T,
    message: string,
    data?: GameLogDataMap[T],
    overrides?: {
      level?: LogLevel;
      owner?: ActorId;
      feedbackTarget?: AIFeedbackTarget;
      displayTarget?: LogDisplayTarget;
    }
  ): GameLog {
    const base = defaultLogMeta(type);

    const log: GameLog = {
      tick: this.tick,
      type,
      message,
      data,
      meta: {
        level: overrides?.level ?? base.level,
        owner: overrides?.owner ?? base.owner,
        feedbackTarget: overrides?.feedbackTarget ?? base.feedbackTarget,
        displayTarget: overrides?.displayTarget ?? base.displayTarget,
      },
    } as GameLog;
    this.logs.push(log);
    this.pendingSnapshotLogs.push(log);
    // 限制日志数量，防止内存泄漏
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-500);
    }
    return log;
  }

  private saveSnapshot(): void {
    this.refreshPlayerCollections();
    const players = this.players.map((player) => ({
      ...player,
      resources: { ...player.resources },
      units: player.units.map((unit) => {
        const { path: _path, ...snapshotUnit } = unit;
        return {
          ...snapshotUnit,
          intent: snapshotUnit.intent ? { ...snapshotUnit.intent } : undefined,
          pathTarget: snapshotUnit.pathTarget ? { ...snapshotUnit.pathTarget } : undefined,
        };
      }),
      buildings: player.buildings.map((building) => ({
        ...building,
        productionQueue: [...building.productionQueue],
        productionProgress: building.productionProgress ? { ...building.productionProgress } : undefined,
      })),
    }));
    const snapshot: GameSnapshot = {
      tick: this.tick,
      state: {
        tick: this.tick,
        players,
        tiles: this.tileView,
        winner: this.winner,
        logs: [...this.logs],
      },
      aiOutputs: { ...this.aiOutputs },
    };

    if (!this.initialSnapshot) {
      this.initialSnapshot = snapshot;
    } else if (this.latestSnapshot) {
      this.tickDeltaBuffer.push(buildTickDelta(this.latestSnapshot, snapshot, [...this.pendingSnapshotLogs]));
      if (this.tickDeltaBuffer.length >= TICK_DELTA_CHUNK_SIZE) {
        this.tickDeltaChunks.push(gzipSync(JSON.stringify(this.tickDeltaBuffer)).toString("base64"));
        this.tickDeltaBuffer = [];
      }
    }
    this.latestSnapshot = snapshot;
    this.pendingSnapshotLogs = [];
  }

  getWinner(): PlayerId | null {
    return this.winner;
  }

  isGameRunning(): boolean {
    return this.isRunning;
  }

  getTick(): number {
    return this.tick;
  }

  setAIOutput(playerId: PlayerId, output: string): void {
    this.aiOutputs[playerId] = output;
  }

  getAIFeedback(playerId: PlayerId, sinceTick?: number): GameLog[] {
    return this.logs.filter((log) => {
      if (sinceTick !== undefined && log.tick <= sinceTick) return false;
      const target = log.meta?.feedbackTarget;
      if (!target || target === AI_FEEDBACK_TARGETS.NONE) return false;
      if (target === AI_FEEDBACK_TARGETS.BOTH) return true;
      return target === playerId;
    });
  }

  private processWorkerEconomy(): void {
    for (const player of this.players) {
      const deliveryBuildings = this.buildingManager
        .getBuildingsByPlayer(player.id)
        .filter((building) => this.isResourceDeliveryBuilding(building));

      if (deliveryBuildings.length === 0) {
        continue;
      }

      for (const unit of this.unitManager.getUnitsByPlayer(player.id)) {
        if (unit.type !== UNIT_TYPES.WORKER || !unit.exists) {
          continue;
        }

        const preserveHarvestLoop = unit.intent?.type === "harvest_loop" ? unit.intent : null;
        const onResourceTile = this.tiles[unit.y]?.[unit.x] === TILE_TYPES.RESOURCE;
        const deliveryBuilding = deliveryBuildings
          .filter((building) => this.isWithinDeliveryRange(unit, building))
          .sort((left, right) =>
            this.buildingManager.getDistanceToBuilding(left, unit.x, unit.y) -
            this.buildingManager.getDistanceToBuilding(right, unit.x, unit.y)
          )[0];
        let economyActionTaken = false;

        if (onResourceTile && unit.carryingCredits < unit.carryCapacity) {
          const resourceKey = `${unit.x},${unit.y}`;
          const depositRemaining = this.resourceRemaining.get(resourceKey) ?? 0;
          const gatheredCredits = Math.min(
            ECONOMY_RULES.WORKER_GATHER_RATE,
            unit.carryCapacity - unit.carryingCredits,
            depositRemaining,
          );

          if (gatheredCredits > 0) {
            unit.carryingCredits += gatheredCredits;
            const nextDepositRemaining = depositRemaining - gatheredCredits;
            this.resourceRemaining.set(resourceKey, nextDepositRemaining);
            const currentTile = this.tileView[unit.y]?.[unit.x];
            const nextTile: Tile | undefined = currentTile
              ? nextDepositRemaining <= 0
                ? { x: currentTile.x, y: currentTile.y, type: TILE_TYPES.EMPTY }
                : { ...currentTile, resourceRemaining: nextDepositRemaining }
              : undefined;
            if (nextDepositRemaining <= 0) {
              this.tiles[unit.y][unit.x] = TILE_TYPES.EMPTY;
            }
            if (nextTile) {
              const nextRow = [...this.tileView[unit.y]];
              nextRow[unit.x] = nextTile;
              const nextTileView = [...this.tileView];
              nextTileView[unit.y] = nextRow;
              this.tileView = nextTileView;
            }
            unit.state = UNIT_STATES.GATHERING;
            unit.intent = preserveHarvestLoop ?? { type: "gather", targetX: unit.x, targetY: unit.y };
            this.addLog(LOG_TYPES.RESOURCE_GATHERED, `Worker ${unit.id} gathered ${gatheredCredits} credits`, {
              unitId: unit.id,
              amount: gatheredCredits,
              carryingCredits: unit.carryingCredits,
            }, {
              owner: player.id,
              feedbackTarget: player.id,
            });
            economyActionTaken = true;
          }
        }

        if (deliveryBuilding && !onResourceTile && unit.carryingCredits > 0) {
          const deliveredCredits = unit.carryingCredits;
          player.resources.credits += deliveredCredits;
          unit.carryingCredits = 0;
          unit.state = UNIT_STATES.IDLE;
          unit.intent = preserveHarvestLoop ?? { type: "deposit", targetX: deliveryBuilding.x, targetY: deliveryBuilding.y, targetId: deliveryBuilding.id };
          this.addLog(LOG_TYPES.CREDITS_DELIVERED, `Worker ${unit.id} delivered ${deliveredCredits} credits to HQ`, {
            unitId: unit.id,
            buildingId: deliveryBuilding.id,
            amount: deliveredCredits,
            credits: player.resources.credits,
          }, {
            owner: player.id,
            feedbackTarget: player.id,
          });
          economyActionTaken = true;
        }

        if (
          !economyActionTaken &&
          !unit.path?.length &&
          unit.state === UNIT_STATES.GATHERING &&
          (!onResourceTile || unit.carryingCredits >= unit.carryCapacity)
        ) {
          unit.state = UNIT_STATES.IDLE;
        }
      }
    }
  }

  /**
   * Find an empty position near the given coordinates for spawning a unit
   * Searches in expanding circles around the center point
   */
  private findEmptySpawnPosition(building: Building): { x: number; y: number } | null {
    const footprint = getBuildingFootprint(building.type);
    const halfWidth = Math.floor(footprint.width / 2);
    const halfHeight = Math.floor(footprint.height / 2);
    for (let distance = 1; distance <= 4; distance++) {
      for (let dx = -halfWidth - distance; dx <= halfWidth + distance; dx++) {
        for (let dy = -halfHeight - distance; dy <= halfHeight + distance; dy++) {
          if (this.buildingManager.getDistanceToBuilding(building, building.x + dx, building.y + dy) !== distance) continue;

          const x = building.x + dx;
          const y = building.y + dy;

          // Check bounds
          if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) continue;

          // Check if position is not an obstacle
          if (this.tiles[y][x] === TILE_TYPES.OBSTACLE) continue;

          // Check if position is not occupied by another unit or building
          if (!this.unitManager.hasUnitAt(x, y) && !this.buildingManager.hasBuildingAt(x, y)) {
            return { x, y };
          }
        }
      }
    }
    return null; // No empty position found
  }

  getSnapshots(): GameSnapshot[] {
    const snapshots = this.initialSnapshot && this.latestSnapshot && this.initialSnapshot !== this.latestSnapshot
      ? [this.initialSnapshot, this.latestSnapshot]
      : this.latestSnapshot
        ? [this.latestSnapshot]
        : [];
    return this.cloneValue(snapshots);
  }

  getLatestSnapshot(): GameSnapshot | null {
    return this.latestSnapshot ? this.cloneValue(this.latestSnapshot) : null;
  }

  getInitialSnapshot(): GameSnapshot | null {
    return this.initialSnapshot ? this.cloneValue(this.initialSnapshot) : null;
  }

  getTickDeltas(): TickDeltaRecord[] {
    return Array.from(this.iterateTickDeltas(), (delta) => this.cloneValue(delta));
  }

  *iterateTickDeltas(): Generator<TickDeltaRecord> {
    for (const chunk of this.tickDeltaChunks) {
      const deltas = JSON.parse(
        gunzipSync(Buffer.from(chunk, "base64")).toString("utf8"),
      ) as TickDeltaRecord[];
      yield* deltas;
    }
    yield* this.tickDeltaBuffer;
  }

  getAIOutputs(): Record<string, string> {
    return { ...this.aiOutputs };
  }

  getCommandResults(sinceTick?: number): GameLog[] {
    return Array.from(this.iterateCommandResults(sinceTick), (log) => this.cloneValue(log));
  }

  *iterateCommandResults(sinceTick?: number): Generator<GameLog> {
    const recordedLogs = function* (game: Game): Generator<GameLog> {
      yield* game.initialSnapshot?.state.logs ?? [];
      for (const delta of game.iterateTickDeltas()) {
        yield* delta.newLogs;
      }
      yield* game.pendingSnapshotLogs;
    }(this);
    for (const log of recordedLogs) {
      if (log.type !== LOG_TYPES.COMMAND_RESULT) continue;
      if (sinceTick !== undefined && log.tick <= sinceTick) continue;
      yield log;
    }
  }

  // For testing purposes
  getUnitManager(): UnitManager {
    return this.unitManager;
  }

  getBuildingManager(): BuildingManager {
    return this.buildingManager;
  }

  private isResourceDeliveryBuilding(building: Building): boolean {
    return building.exists && (building.type === BUILDING_TYPES.HQ || building.type === BUILDING_TYPES.REFINERY);
  }

  private getDeliveryRange(building: Building): number {
    return building.type === BUILDING_TYPES.REFINERY
      ? ECONOMY_RULES.REFINERY_DELIVERY_RANGE
      : ECONOMY_RULES.HQ_DELIVERY_RANGE;
  }

  private isWithinDeliveryRange(unit: Unit, building: Building): boolean {
    return this.buildingManager.getDistanceToBuilding(building, unit.x, unit.y) <= this.getDeliveryRange(building);
  }

  private validateBuildPosition(playerId: PlayerId, buildingType: BuildingType, x: number, y: number): ResultCode {
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    const footprintCells = getBuildingFootprintCells(buildingType, x, y);
    for (const cell of footprintCells) {
      if (cell.x < 0 || cell.x >= MAP_WIDTH || cell.y < 0 || cell.y >= MAP_HEIGHT) {
        return RESULT_CODES.ERR_INVALID_TARGET;
      }
      if (
        this.tiles[cell.y][cell.x] !== TILE_TYPES.EMPTY ||
        this.unitManager.hasUnitAt(cell.x, cell.y) ||
        this.buildingManager.hasBuildingAt(cell.x, cell.y)
      ) {
        return RESULT_CODES.ERR_POSITION_OCCUPIED;
      }
    }

    const hq = this.buildingManager
      .getBuildingsByPlayer(playerId)
      .find((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    if (hq && footprintCells.some((cell) => this.buildingManager.getDistanceToBuilding(hq, cell.x, cell.y) <= 1)) {
      return RESULT_CODES.ERR_POSITION_OCCUPIED;
    }

    return RESULT_CODES.OK;
  }

  private describeMoveFailure(unitId: string, x: number, y: number): { type: string; hint: string } | null {
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return { type: "move_bad_target", hint: "Use integer map coordinates." };
    }

    if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
      return { type: "move_bad_target", hint: "Choose a tile inside the map bounds." };
    }

    if (this.tiles[y][x] === TILE_TYPES.OBSTACLE) {
      return { type: "move_blocked_tile", hint: "That tile is an obstacle. Pick a nearby empty tile." };
    }

    if (this.buildingManager.hasBuildingAt(x, y)) {
      return { type: "move_blocked_tile", hint: "Buildings occupy their tile. Move to an adjacent empty tile instead." };
    }

    if (this.unitManager.hasUnitAt(x, y, unitId)) {
      return { type: "move_blocked_tile", hint: "Another unit is already on that tile. Pick a different nearby tile." };
    }

    return { type: "move_unreachable", hint: "No reachable nearby tile found." };
  }

  private describeBuildFailure(playerId: PlayerId, buildingType: BuildingType, x: number, y: number): { type: string; hint: string } {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
      return { type: "build_bad_target", hint: "Choose an empty tile inside the map bounds." };
    }

    const footprintCells = getBuildingFootprintCells(buildingType, x, y);
    if (footprintCells.some((cell) => cell.x < 0 || cell.x >= MAP_WIDTH || cell.y < 0 || cell.y >= MAP_HEIGHT)) {
      return { type: "build_bad_target", hint: "The full building footprint must stay inside the map." };
    }

    const hq = this.buildingManager
      .getBuildingsByPlayer(playerId)
      .find((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    if (hq && footprintCells.some((cell) => this.buildingManager.getDistanceToBuilding(hq, cell.x, cell.y) <= 1)) {
      return { type: "build_too_close_to_hq", hint: "Leave at least one clear tile between the full building footprint and HQ." };
    }

    if (footprintCells.some((cell) => this.tiles[cell.y][cell.x] !== TILE_TYPES.EMPTY || this.buildingManager.hasBuildingAt(cell.x, cell.y) || this.unitManager.hasUnitAt(cell.x, cell.y))) {
      return { type: "build_blocked_tile", hint: "The building footprint overlaps terrain, resources, units, or another structure." };
    }

    return { type: "build_bad_target", hint: "Choose another empty tile." };
  }

  private cloneValue<T>(value: T): T {
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  private normalizeCommand(command: Command): Command {
    return {
      id: String(command.id),
      type: String(command.type),
      unitId: command.unitId ? String(command.unitId) : undefined,
      buildingId: command.buildingId ? String(command.buildingId) : undefined,
      targetId: command.targetId ? String(command.targetId) : undefined,
      targetPriority: Array.isArray(command.targetPriority)
        ? command.targetPriority.filter((value): value is AttackTargetType => isUnitType(value) || isBuildingType(value))
        : undefined,
      position: command.position
        ? {
            x: Number(command.position.x),
            y: Number(command.position.y),
          }
        : undefined,
      unitType: command.unitType,
      buildingType: command.buildingType,
      playerId: command.playerId,
    };
  }
}
