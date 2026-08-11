import {
  Unit,
  AttackTargetType,
  Building,
  BuildingType,
  Player,
  PlayerId,
  UnitType,
  GameLog,
  Command,
  GameSnapshot,
  TickDeltaRecord,
  GameState,
  ActiveProjectile,
  Tile,
  ResultCode,
  TILE_TYPES,
  UNIT_TYPES,
  BUILDING_TYPES,
  UNIT_STATES,
  RESULT_CODES,
  ECONOMY_RULES,
  getBuildingCost as getRulesetBuildingCost,
  getBuildingConstructionTicks,
  getBuildingFootprint,
  getBuildingFootprintCells,
  getProductionOptions,
  isBuildableBuildingType,
  isBuildingType,
  isUnitType,
  MAP_WIDTH,
  MAP_HEIGHT,
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
  RESULT_TYPES,
  ResultType,
} from "@llmcraft/shared";
import { buildTickDelta } from "./GameHistory";
import { UnitManager } from "./UnitManager";
import { BuildingManager, MAX_PENDING_PRODUCTION_PER_UNIT_TYPE } from "./BuildingManager";
import { createDefaultMatchDefinition, type MatchDefinition, validateMatchDefinition } from "./MatchDefinition";
import { SimulationCore, type SimulationEvent, type SimulationStepResult } from "./SimulationCore";
import { WorldState } from "./WorldState";
import {
  isWorkerConstructing,
} from "./simulation/EconomyRules";
import { HarvestOrderSystem } from "./simulation/HarvestOrderSystem";
import { VictorySystem } from "./simulation/VictorySystem";
import { CombatSystem } from "./simulation/CombatSystem";
import { BackgroundTickDeltaArchive } from "./BackgroundTickDeltaArchive";

export interface AgentReadState {
  tick: number;
  revision: number;
  players: Player[];
  tiles: Tile[][];
  winner: PlayerId | null;
}

export interface CommandExecutionOutcome {
  tick: number;
  command: Command;
  resultCode: ResultCode;
  resultType: ResultType;
  resultData: unknown;
  success: boolean;
}

export interface GameCommandBatch {
  actorId: string;
  commands: readonly Command[];
}

export interface GameTickResult {
  commandOutcomes: CommandExecutionOutcome[];
  simulation: SimulationStepResult;
}

export class Game {
  private readonly definition: MatchDefinition;
  private readonly world: WorldState;
  private readonly simulationCore = new SimulationCore();
  private readonly harvestOrderSystem = new HarvestOrderSystem();
  private readonly victorySystem = new VictorySystem();
  private readonly commandCombatSystem = new CombatSystem();
  private logs: GameLog[] = [];
  private pendingSnapshotLogs: GameLog[] = [];
  private commandQueue: Command[] = [];
  private activeCommandOutcomes: CommandExecutionOutcome[] | null = null;
  private initialSnapshot: GameSnapshot | null = null;
  private latestSnapshot: GameSnapshot | null = null;
  private readonly tickDeltaArchive = new BackgroundTickDeltaArchive();
  private commandResultHistory: GameLog[] = [];
  private aiOutputs: Record<string, string> = {};
  private isRunning = false;

  constructor(definition: MatchDefinition = createDefaultMatchDefinition()) {
    validateMatchDefinition(definition);
    this.definition = structuredClone(definition);
    this.world = new WorldState(this.definition);
    this.harvestOrderSystem.assignDefaultHarvestOrders(this.world);
    this.addLog(LOG_TYPES.GAME_INIT, "Game initialized successfully");
    this.saveSnapshot();
  }

  getState(): GameState {
    return this.cloneValue({
      tick: this.world.tick,
      players: this.world.players,
      tiles: this.world.tileView,
      winner: this.world.winner,
      logs: this.logs,
      projectiles: this.world.projectiles,
    });
  }

  /**
   * Cheap log tail for live transports. Returns direct references without
   * cloning the world; callers must serialize synchronously.
   */
  getLogsTail(sinceCount: number): { total: number; logs: GameLog[] } {
    const total = this.logs.length;
    if (sinceCount <= 0 || sinceCount > total) {
      return { total, logs: this.logs.slice(Math.max(0, total - 20)) };
    }
    return { total, logs: this.logs.slice(sinceCount) };
  }

  getDefinition(): MatchDefinition {
    return structuredClone(this.definition);
  }

  getAgentReadState(): AgentReadState {
    return {
      tick: this.world.tick,
      revision: this.world.revision,
      players: this.world.players,
      tiles: this.world.tileView,
      winner: this.world.winner,
    };
  }

  queueCommand(command: Command): void {
    this.commandQueue.push(this.normalizeCommand(command));
  }

  processCommands(): CommandExecutionOutcome[] {
    return this.processQueuedCommands();
  }

  private processQueuedCommands(): CommandExecutionOutcome[] {
    if (this.activeCommandOutcomes) {
      throw new Error("Command processing is already active.");
    }
    const outcomes: CommandExecutionOutcome[] = [];
    this.activeCommandOutcomes = outcomes;
    try {
      this.processPendingCommands();
      return outcomes;
    } finally {
      this.activeCommandOutcomes = null;
    }
  }

  private processPendingCommands(): void {
    const pendingCommands = this.commandQueue;
    this.commandQueue = [];
    if (pendingCommands.length > 0) {
      this.world.markChanged();
    }
    for (const command of pendingCommands) {
      const outcomeCountBefore = this.activeCommandOutcomes?.length ?? 0;
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
      if ((this.activeCommandOutcomes?.length ?? 0) === outcomeCountBefore) {
        this.addLog(LOG_TYPES.COMMAND_RESULT, `Command ${command.type} was rejected`, {
          command,
          result_code: RESULT_CODES.ERR_INVALID_TARGET,
          type: RESULT_TYPES.COMMAND_INVALID,
          result_data: { hint: "The command is incomplete, unsupported, or targets an entity not owned by the actor." },
        }, {
          owner: command.playerId,
          feedbackTarget: command.playerId,
          level: LOG_LEVELS.WARNING,
        });
      }
    }
  }

  private executeCommandBatch(commands: readonly Command[]): CommandExecutionOutcome[] {
    for (const command of commands) this.queueCommand(command);
    return this.processQueuedCommands();
  }

  private processCommand(command: Command): void {
    if (command.unitId && command.type !== "build") {
      const unit = this.world.units.getUnit(command.unitId);
      if (unit && unit.playerId === command.playerId && isWorkerConstructing(unit)) {
        this.addLog(
          LOG_TYPES.COMMAND_RESULT,
          `${command.type} command failed: worker is constructing`,
          {
            command,
            result_code: RESULT_CODES.ERR_BUSY,
            type: RESULT_TYPES.INVALID_UNIT,
            result_data: {
              unitId: command.unitId,
              hint: "This worker is constructing a building and cannot accept other orders until construction finishes.",
            },
          },
          {
            owner: command.playerId,
            feedbackTarget: command.playerId,
            level: LOG_LEVELS.WARNING,
          }
        );
        return;
      }
    }

    switch (command.type) {
      case "move": {
        if (command.unitId && command.position) {
          const unit = this.world.units.getUnit(command.unitId);
          if (unit && unit.playerId === command.playerId) {
            const blockedPositions = this.world.buildings.getOccupiedPositions();
            // 使用寻路移动：设置目标，让系统每 tick 自动沿路径移动
            const result: ResultCode = this.world.units.setMoveTarget(
              unit,
              command.position.x,
              command.position.y,
              this.world.tiles,
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
          const attacker = this.world.units.getUnit(command.unitId);
          if (attacker && attacker.playerId === command.playerId) {
            const result = this.commandCombatSystem.executeAttackOrder(this.world, attacker, command.playerId, {
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
          const attacker = this.world.units.getUnit(command.unitId);
          if (attacker && attacker.playerId === command.playerId) {
            const result = this.commandCombatSystem.executeAttackOrder(this.world, attacker, command.playerId, {
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
          const attacker = this.world.units.getUnit(command.unitId);
          if (attacker && attacker.playerId === command.playerId) {
            const blockedPositions = this.world.buildings.getOccupiedPositions();
            const result = this.world.units.setMoveTarget(
              attacker,
              command.position.x,
              command.position.y,
              this.world.tiles,
              blockedPositions,
              true
            );

            if (result === RESULT_CODES.OK) {
              const resolvedTarget = attacker.pathTarget;
              attacker.order = {
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
          const worker = this.world.units.getUnit(command.unitId);
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

          const resourceTarget = this.harvestOrderSystem.resolveResourceTarget(this.world, worker, command.position);
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

          worker.order = {
            type: "harvest_loop",
            targetX: resourceTarget.x,
            targetY: resourceTarget.y,
          };
          this.world.units.clearPath(worker);
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
          const unit = this.world.units.getUnit(command.unitId);
          if (unit && unit.playerId === command.playerId) {
            this.world.units.holdPosition(unit);
            // 清除寻路路径
            this.world.units.clearPath(unit);
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

      case "set_rally_point": {
        if (command.buildingId) {
          const building = this.world.buildings.getBuilding(command.buildingId);
          const positionValid = !command.position || (
            Number.isInteger(command.position.x) &&
            Number.isInteger(command.position.y) &&
            command.position.y >= 0 &&
            command.position.y < this.world.tiles.length &&
            command.position.x >= 0 &&
            command.position.x < (this.world.tiles[command.position.y]?.length ?? 0)
          );
          if (
            building?.exists &&
            building.playerId === command.playerId &&
            getProductionOptions(building.type).length > 0 &&
            positionValid &&
            !(command.position && command.rallyMode === "attack_move" && building.type === BUILDING_TYPES.HQ)
          ) {
            if (command.position) {
              building.rallyPoint = {
                ...command.position,
                mode: command.rallyMode === "attack_move" ? "attack_move" : "move",
              };
            } else {
              delete building.rallyPoint;
            }
            this.world.markChanged();
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              command.position
                ? `Rally point for ${building.id} set to (${command.position.x}, ${command.position.y}) using ${building.rallyPoint?.mode}`
                : `Rally point for ${building.id} cleared`,
              {
                command,
                result_code: RESULT_CODES.OK,
                type: RESULT_TYPES.RALLY_POINT_UPDATED,
                result_data: {
                  buildingId: building.id,
                  rallyPoint: building.rallyPoint ?? null,
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
              },
            );
          } else {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              `Cannot update rally point for ${command.buildingId}`,
              {
                command,
                result_code: RESULT_CODES.ERR_INVALID_TARGET,
                type: RESULT_TYPES.RALLY_INVALID_TARGET,
                result_data: {
                  buildingId: command.buildingId,
                  hint: "Use a friendly HQ, barracks, or war factory and choose an in-bounds destination.",
                },
              },
              {
                owner: command.playerId,
                feedbackTarget: command.playerId,
                level: LOG_LEVELS.WARNING,
              },
            );
          }
        }
        break;
      }

      case "spawn": {
        if (command.buildingId && command.productionRequests?.length) {
          const building = this.world.buildings.getBuilding(command.buildingId);
          if (building && building.playerId === command.playerId) {
            const requests = command.productionRequests;
            const invalidRequest = requests.find((request) =>
              !isUnitType(request.unitType) ||
              !Number.isInteger(request.count) ||
              request.count <= 0 ||
              !this.world.buildings.canProduce(building, request.unitType)
            );
            const requestedCounts = new Map<UnitType, number>();
            for (const request of requests) {
              if (isUnitType(request.unitType) && Number.isInteger(request.count) && request.count > 0) {
                requestedCounts.set(request.unitType, (requestedCounts.get(request.unitType) ?? 0) + request.count);
              }
            }
            const overflowingType = [...requestedCounts].find(([unitType, count]) =>
              this.world.buildings.getPendingCount(building, unitType) + count > MAX_PENDING_PRODUCTION_PER_UNIT_TYPE
            )?.[0];
            if (building.constructionProgress) {
                const result = RESULT_CODES.ERR_BUSY;
                this.addLog(
                  LOG_TYPES.COMMAND_RESULT,
                  `Spawn command failed: ${building.type} is still under construction`,
                  {
                    command,
                    result_code: result,
                    type: RESULT_TYPES.SPAWN_INVALID_BUILDING,
                    result_data: {
                      buildingId: building.id,
                      buildingType: building.type,
                      unitType: String(requests[0]?.unitType ?? "unknown"),
                      hint: `${building.type} is still under construction and cannot produce units yet.`,
                    },
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                    level: LOG_LEVELS.WARNING,
                  }
                );
            } else if (invalidRequest || overflowingType) {
                const result = RESULT_CODES.ERR_INVALID_BUILDING;
                this.addLog(
                  LOG_TYPES.COMMAND_RESULT,
                  `Production queue command failed for ${building.type}`,
                  {
                    command,
                    result_code: result,
                    type: RESULT_TYPES.SPAWN_INVALID_BUILDING,
                    result_data: {
                      buildingId: building.id,
                      buildingType: building.type,
                      unitType: String(invalidRequest?.unitType ?? overflowingType ?? "unknown"),
                      hint: overflowingType
                        ? `A building may have at most ${MAX_PENDING_PRODUCTION_PER_UNIT_TYPE} pending ${overflowingType} units.`
                        : `${building.type} cannot produce one of the requested unit types, or its count is not a positive integer.`,
                    },
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                    level: LOG_LEVELS.WARNING,
                  }
                );
            } else {
                const orders = this.world.buildings.enqueueProduction(building, requests);
                this.world.markChanged();
                this.addLog(
                  LOG_TYPES.COMMAND_RESULT,
                  `Production batch queued from ${building.type}`,
                  {
                    command,
                    result_code: RESULT_CODES.OK,
                    type: RESULT_TYPES.SPAWN_SUCCESS,
                    result_data: {
                      buildingId: building.id,
                      orders: orders.map((order) => ({ ...order })),
                      queue: building.productionQueue.map((order) => ({ ...order })),
                    },
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                  }
                );
            }
          }
        }
        break;
      }

      case "cancel_production": {
        const player = this.world.getPlayerState(command.playerId);
        const requestedOrderIds = new Set(command.productionOrderIds ?? []);
        const ownedBuildings = this.world.buildings.getBuildingsByPlayer(command.playerId);
        const targetBuildings = command.buildingId
          ? ownedBuildings.filter((building) => building.id === command.buildingId)
          : ownedBuildings.filter((building) =>
              building.productionQueue.some((order) => requestedOrderIds.has(order.orderId))
            );
        if (!player || targetBuildings.length === 0 || (!command.buildingId && requestedOrderIds.size === 0)) {
          this.addLog(LOG_TYPES.COMMAND_RESULT, "Cancel production failed: no matching queue or order", {
            command,
            result_code: RESULT_CODES.ERR_INVALID_TARGET,
            type: RESULT_TYPES.PRODUCTION_INVALID_ORDER,
            result_data: { hint: "Use get_production_queue and pass friendly buildingIds or active orderIds." },
          }, {
            owner: command.playerId,
            feedbackTarget: command.playerId,
            level: LOG_LEVELS.WARNING,
          });
          break;
        }

        const cancelledOrderIds: string[] = [];
        let refundCredits = 0;
        for (const building of targetBuildings) {
          const cancellation = this.world.buildings.cancelProduction(
            building,
            command.buildingId ? undefined : requestedOrderIds,
          );
          cancelledOrderIds.push(...cancellation.cancelledOrderIds);
          refundCredits += cancellation.refundCredits;
        }
        if (cancelledOrderIds.length === 0) {
          this.addLog(LOG_TYPES.COMMAND_RESULT, "Cancel production failed: no matching queue or order", {
            command,
            result_code: RESULT_CODES.ERR_INVALID_TARGET,
            type: RESULT_TYPES.PRODUCTION_INVALID_ORDER,
            result_data: { hint: "The selected queues are already empty or the order IDs no longer exist." },
          }, {
            owner: command.playerId,
            feedbackTarget: command.playerId,
            level: LOG_LEVELS.WARNING,
          });
          break;
        }
        player.resources.credits += refundCredits;
        this.world.markChanged();
        this.addLog(LOG_TYPES.COMMAND_RESULT, "Production cancelled", {
          command,
          result_code: RESULT_CODES.OK,
          type: RESULT_TYPES.PRODUCTION_CANCELLED,
          result_data: {
            buildingIds: targetBuildings.map((building) => building.id),
            cancelledOrderIds,
            refundCredits,
          },
        }, {
          owner: command.playerId,
          feedbackTarget: command.playerId,
        });
        break;
      }

      case "build": {
        if (command.unitId && command.position && command.buildingType) {
          const unit = this.world.units.getUnit(command.unitId);
          const player = this.world.getPlayerState(command.playerId);

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

          if (isWorkerConstructing(unit)) {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              "Build command failed: worker is already constructing",
              {
                command,
                result_code: RESULT_CODES.ERR_BUSY,
                type: RESULT_TYPES.INVALID_UNIT,
                result_data: {
                  unitId: command.unitId,
                  hint: "This worker is already constructing a building and cannot start another order yet.",
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
                  hint: "HQ cannot be built; use one of the buildable production, economy, defense, or technology structures.",
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

          const missingPrerequisites = this.world.buildings.getMissingBuildingPrerequisites(
            command.playerId,
            command.buildingType,
          );
          if (missingPrerequisites.length > 0) {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              "Build command failed: missing technology prerequisite",
              {
                command,
                result_code: RESULT_CODES.ERR_INVALID_BUILDING,
                type: RESULT_TYPES.BUILD_INVALID_BUILDING,
                result_data: {
                  hint: `Build and complete ${missingPrerequisites.join(", ")} before starting ${command.buildingType}.`,
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

          if (!this.isWorkerAdjacentToBuildFootprint(unit, command.buildingType, command.position.x, command.position.y)) {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              "Build command failed: worker too far from build site",
              {
                command,
                result_code: RESULT_CODES.ERR_NOT_IN_RANGE,
                type: RESULT_TYPES.BUILD_INVALID_POSITION,
                result_data: {
                  x: command.position.x,
                  y: command.position.y,
                  hint: "Move the worker to a tile adjacent to the full building footprint before building.",
                  type: "build_worker_too_far",
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
          const constructionTicks = getBuildingConstructionTicks(command.buildingType);
          const newBuilding = this.world.createBuilding(
            command.buildingType,
            command.position.x,
            command.position.y,
            command.playerId,
            {
              constructionProgress: {
                workerId: unit.id,
                remainingTicks: constructionTicks,
                totalTicks: constructionTicks,
                resumeWorkerOrder: command.resumeWorkerOrder,
              },
            }
          );
          this.world.units.clearPath(unit);
          unit.state = UNIT_STATES.BUILDING;
          unit.order = { type: "build", targetX: newBuilding.x, targetY: newBuilding.y, targetId: newBuilding.id };
          unit.constructingBuildingId = newBuilding.id;
          this.addLog(LOG_TYPES.COMMAND_RESULT, `${command.buildingType} construction started for ${command.playerId}`, {
            command,
            result_code: RESULT_CODES.OK,
            type: RESULT_TYPES.BUILDING_CONSTRUCTION_STARTED,
            result_data: {
              buildingId: newBuilding.id,
              buildingType: newBuilding.type,
              x: newBuilding.x,
              y: newBuilding.y,
              workerId: unit.id,
              constructionTicks,
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

  private getBuildingCost(buildingType: string): number {
    return isBuildingType(buildingType) ? getRulesetBuildingCost(buildingType) : 0;
  }

  private isWorkerAdjacentToBuildFootprint(unit: Unit, buildingType: BuildingType, x: number, y: number): boolean {
    return getBuildingFootprintCells(buildingType, x, y).some((cell) =>
      Math.max(Math.abs(unit.x - cell.x), Math.abs(unit.y - cell.y)) <= 1
    );
  }

  checkWinCondition(): boolean {
    const outcome = this.victorySystem.step(this.world);
    if (!outcome) return false;
    this.addLog(LOG_TYPES.GAME_END, `Player ${outcome.winnerId} wins! Player ${outcome.loserId} has no remaining buildings.`, {
      winner: outcome.winnerId,
      loser: outcome.loserId,
    });
    this.stop();
    return true;
  }

  beginSimulationTick(): void {
    this.world.tick++;
    this.world.markChanged();
  }

  private applySimulationEvents(events: readonly SimulationEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "resource_gathered":
          this.addLog(LOG_TYPES.RESOURCE_GATHERED, `Worker ${event.unitId} gathered ${event.amount} credits`, {
            unitId: event.unitId,
            amount: event.amount,
            carryingCredits: event.carryingCredits,
          }, {
            owner: event.playerId,
            feedbackTarget: event.playerId,
          });
          break;
        case "credits_delivered":
          this.addLog(LOG_TYPES.CREDITS_DELIVERED, `Worker ${event.unitId} delivered ${event.amount} credits to HQ`, {
            unitId: event.unitId,
            buildingId: event.buildingId,
            amount: event.amount,
            credits: event.credits,
          }, {
            owner: event.playerId,
            feedbackTarget: event.playerId,
          });
          break;
        case "building_completed":
          this.addLog(LOG_TYPES.BUILDING_COMPLETED, `${event.buildingType} completed for ${event.playerId}`, {
            buildingId: event.buildingId,
            buildingType: event.buildingType,
            workerId: event.workerId,
          }, {
            owner: event.playerId,
            feedbackTarget: event.playerId,
          });
          break;
        case "building_cancelled":
          // Legacy Game never exposed this outcome; an event consumer can handle it directly.
          break;
        case "unit_spawned":
          this.addLog(LOG_TYPES.UNIT_SPAWNED, `Unit ${event.unitType} spawned for ${event.playerId}`, {
            unitId: event.unitId,
            unitType: event.unitType,
          }, {
            owner: event.playerId,
            feedbackTarget: event.playerId,
          });
          break;
        case "unit_destroyed":
          this.addLog(LOG_TYPES.UNIT_DESTROYED, `Unit ${event.unitId} (${event.unitType}) lost by ${event.playerId}`, {
            unitId: event.unitId,
            unitType: event.unitType,
          }, {
            owner: event.playerId,
            feedbackTarget: event.playerId,
            level: LOG_LEVELS.WARNING,
          });
          break;
        case "unit_spawn_failed":
          this.addLog(LOG_TYPES.SPAWN_FAILED, `No empty position to spawn ${event.unitType} for ${event.playerId}`, {
            unitType: event.unitType,
          }, { owner: event.playerId });
          break;
        case "player_eliminated":
          this.addLog(LOG_TYPES.GAME_END, `Player ${event.winnerId} wins! Player ${event.loserId} has no remaining buildings.`, {
            winner: event.winnerId,
            loser: event.loserId,
          });
          this.stop();
          break;
      }
    }
  }

  tickUpdate(): void {
    if (!this.isRunning) return;

    try {
      this.advanceSimulationTick();
    } catch (error) {
      this.addLog(LOG_TYPES.TICK_ERROR, "Tick update crashed", {
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("Tick 更新异常:", error);
      this.stop();
    } finally {
      this.saveSnapshot();
    }
  }

  /** Applies every submitted command independently, then advances simulation once. */
  advanceSimulationTick(commandBatches: readonly GameCommandBatch[] = []): GameTickResult | null {
    if (!this.isRunning) return null;

    this.beginSimulationTick();
    const queued = this.processQueuedCommands();
    const submittedCommandOutcomes = commandBatches.flatMap(
      (batch) => this.executeCommandBatch(batch.commands),
    );
    const simulation = this.simulationCore.step(this.world);
    this.applySimulationEvents(simulation.events);
    return {
      commandOutcomes: [
        ...queued,
        ...submittedCommandOutcomes,
      ],
      simulation,
    };
  }

  captureSimulationSnapshot(): TickDeltaRecord | null {
    return this.saveSnapshot();
  }

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.addLog(LOG_TYPES.GAME_STARTED, "Game started");
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
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
      tick: this.world.tick,
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
    if (type === LOG_TYPES.COMMAND_RESULT && data && this.activeCommandOutcomes) {
      const result = data as GameLogDataMap[typeof LOG_TYPES.COMMAND_RESULT];
      this.activeCommandOutcomes.push({
        tick: this.world.tick,
        command: this.cloneValue(result.command),
        resultCode: result.result_code,
        resultType: result.type,
        resultData: this.cloneValue(result.result_data),
        success: result.result_code === RESULT_CODES.OK,
      });
    }
    if (type === LOG_TYPES.COMMAND_RESULT) {
      this.commandResultHistory.push(this.cloneValue(log));
    }
    this.logs.push(log);
    this.pendingSnapshotLogs.push(log);
    // 限制日志数量，防止内存泄漏
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-500);
    }
    return log;
  }

  private saveSnapshot(): TickDeltaRecord | null {
    const players = this.world.players.map((player) => ({
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
        rallyPoint: building.rallyPoint ? { ...building.rallyPoint } : undefined,
        productionQueue: building.productionQueue.map((order) => ({ ...order })),
        productionProgress: building.productionProgress ? { ...building.productionProgress } : undefined,
        constructionProgress: building.constructionProgress ? { ...building.constructionProgress } : undefined,
      })),
    }));
    const snapshot: GameSnapshot = {
      tick: this.world.tick,
      state: {
        tick: this.world.tick,
        players,
        tiles: this.world.tileView,
        winner: this.world.winner,
        logs: [...this.logs],
      },
      aiOutputs: { ...this.aiOutputs },
    };

    let delta: TickDeltaRecord | null = null;
    if (!this.initialSnapshot) {
      this.initialSnapshot = snapshot;
    } else if (this.latestSnapshot) {
      if (snapshot.tick > this.latestSnapshot.tick) {
        delta = buildTickDelta(this.latestSnapshot, snapshot, [...this.pendingSnapshotLogs]);
        this.tickDeltaArchive.append(delta);
      }
    }
    this.latestSnapshot = snapshot;
    this.pendingSnapshotLogs = [];
    return delta ? this.cloneValue(delta) : null;
  }

  getWinner(): PlayerId | null {
    return this.world.winner;
  }

  isGameRunning(): boolean {
    return this.isRunning;
  }

  getTick(): number {
    return this.world.tick;
  }

  getStateRevision(): number {
    return this.world.revision;
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

  async getTickDeltasAsync(): Promise<TickDeltaRecord[]> {
    const archived = await this.tickDeltaArchive.getAll();
    return archived.map((delta) => this.cloneValue(delta));
  }

  *iterateTickDeltas(throughTick?: number): Generator<TickDeltaRecord> {
    for (const delta of this.tickDeltaArchive.iterateSync()) {
      if (throughTick !== undefined && delta.tick > throughTick) return;
      yield delta;
    }
  }

  getAIOutputs(): Record<string, string> {
    return { ...this.aiOutputs };
  }

  getCommandResults(sinceTick?: number): GameLog[] {
    return Array.from(this.iterateCommandResults(sinceTick), (log) => this.cloneValue(log));
  }

  *iterateCommandResults(sinceTick?: number, throughTick?: number): Generator<GameLog> {
    for (const log of this.commandResultHistory) {
      if (sinceTick !== undefined && log.tick <= sinceTick) continue;
      if (throughTick !== undefined && log.tick > throughTick) continue;
      yield log;
    }
  }

  // For testing purposes
  getUnitManager(): UnitManager {
    return this.world.units;
  }

  getBuildingManager(): BuildingManager {
    return this.world.buildings;
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
        this.world.tiles[cell.y][cell.x] !== TILE_TYPES.EMPTY ||
        this.world.units.hasUnitAt(cell.x, cell.y) ||
        this.world.buildings.hasBuildingAt(cell.x, cell.y)
      ) {
        return RESULT_CODES.ERR_POSITION_OCCUPIED;
      }
    }

    const hq = this.world.buildings
      .getBuildingsByPlayer(playerId)
      .find((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    if (hq && footprintCells.some((cell) => this.world.buildings.getDistanceToBuilding(hq, cell.x, cell.y) <= 1)) {
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

    if (this.world.tiles[y][x] === TILE_TYPES.OBSTACLE) {
      return { type: "move_blocked_tile", hint: "That tile is an obstacle. Pick a nearby empty tile." };
    }

    if (this.world.buildings.hasBuildingAt(x, y)) {
      return { type: "move_blocked_tile", hint: "Buildings occupy their tile. Move to an adjacent empty tile instead." };
    }

    if (this.world.units.hasUnitAt(x, y, unitId)) {
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

    const hq = this.world.buildings
      .getBuildingsByPlayer(playerId)
      .find((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    if (hq && footprintCells.some((cell) => this.world.buildings.getDistanceToBuilding(hq, cell.x, cell.y) <= 1)) {
      return { type: "build_too_close_to_hq", hint: "Leave at least one clear tile between the full building footprint and HQ." };
    }

    if (footprintCells.some((cell) => this.world.tiles[cell.y][cell.x] !== TILE_TYPES.EMPTY || this.world.buildings.hasBuildingAt(cell.x, cell.y) || this.world.units.hasUnitAt(cell.x, cell.y))) {
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
      productionRequests: command.productionRequests?.map((request) => ({ ...request })),
      productionOrderIds: command.productionOrderIds?.map(String),
      buildingType: command.buildingType,
      rallyMode:
        command.rallyMode === "move" || command.rallyMode === "attack_move"
          ? command.rallyMode
          : undefined,
      resumeWorkerOrder: command.resumeWorkerOrder
        ? this.cloneValue(command.resumeWorkerOrder)
        : undefined,
      playerId: command.playerId,
      provenance: command.provenance ? this.cloneValue(command.provenance) : undefined,
    };
  }
}
