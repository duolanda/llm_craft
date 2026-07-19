import {
  Unit,
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
  getUnitCost as getRulesetUnitCost,
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
import { gzipSync, gunzipSync } from "node:zlib";
import { UnitManager } from "./UnitManager";
import { BuildingManager } from "./BuildingManager";
import { createDefaultMatchDefinition, type MatchDefinition, validateMatchDefinition } from "./MatchDefinition";
import { SimulationCore, type SimulationEvent, type SimulationStepResult } from "./SimulationCore";
import { WorldState } from "./WorldState";
import {
  isWorkerConstructing,
} from "./simulation/EconomyRules";
import { HarvestOrderSystem } from "./simulation/HarvestOrderSystem";
import { VictorySystem } from "./simulation/VictorySystem";
import { CombatSystem } from "./simulation/CombatSystem";
import type { DeterministicRngState } from "./DeterministicRng";
import { allocateFairPathBudgets, resolveCommandBudgetPolicy, type CommandBudgetPolicy } from "./CommandBudget";

interface GameSimulationCheckpoint {
  tick: number;
  revision: number;
  units: ReturnType<UnitManager["createCheckpoint"]>;
  buildings: ReturnType<BuildingManager["createCheckpoint"]>;
  resourceRemaining: Array<[string, number]>;
  playerCredits: Array<[PlayerId, number]>;
  logs: GameLog[];
  pendingSnapshotLogs: GameLog[];
  commandQueue: Command[];
  projectiles: ActiveProjectile[];
  projectileCounter: number;
  rng: DeterministicRngState;
  winner: PlayerId | null;
  isRunning: boolean;
}

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

export interface CommandBatchExecutionResult {
  committed: boolean;
  outcomes: CommandExecutionOutcome[];
  failureReason?: "command_failed" | "command_budget_exceeded" | "path_budget_exceeded";
  failedCommandId?: string;
}

export interface GameCommandBatch {
  actorId: string;
  commands: readonly Command[];
}

export interface GameTickResult {
  commandOutcomes: CommandExecutionOutcome[];
  commandBatchResults: CommandBatchExecutionResult[];
  simulation: SimulationStepResult;
}

const TICK_DELTA_CHUNK_SIZE = 100;
export class Game {
  private readonly definition: MatchDefinition;
  private readonly commandBudgetPolicy: CommandBudgetPolicy;
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
  private tickDeltaBuffer: TickDeltaRecord[] = [];
  private tickDeltaChunks: string[] = [];
  private aiOutputs: Record<string, string> = {};
  private isRunning = false;

  constructor(definition: MatchDefinition = createDefaultMatchDefinition()) {
    validateMatchDefinition(definition);
    this.definition = structuredClone(definition);
    this.commandBudgetPolicy = resolveCommandBudgetPolicy(this.definition);
    this.world = new WorldState(this.definition);
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

  getDefinition(): MatchDefinition {
    return structuredClone(this.definition);
  }

  getDeterministicRngState(): DeterministicRngState {
    return this.world.rng.createCheckpoint();
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
    return this.processQueuedCommands(this.commandBudgetPolicy.maxPathCommandsPerTick).outcomes;
  }

  private processQueuedCommands(pathBudget: number): {
    outcomes: CommandExecutionOutcome[];
    remainingPathBudget: number;
  } {
    if (this.activeCommandOutcomes) {
      throw new Error("Command processing is already active.");
    }
    const outcomes: CommandExecutionOutcome[] = [];
    this.activeCommandOutcomes = outcomes;
    try {
      return {
        outcomes,
        remainingPathBudget: this.processPendingCommands(pathBudget, true),
      };
    } finally {
      this.activeCommandOutcomes = null;
    }
  }

  private processPendingCommands(pathBudget: number, deferExcessPathCommands: boolean): number {
    const pendingCommands = this.commandQueue;
    this.commandQueue = [];
    if (pendingCommands.length > 0) {
      this.world.markChanged();
    }
    let remainingPathCommands = pathBudget;
    for (const command of pendingCommands) {
      const requiresPath = command.type === "move" || command.type === "attack_move" || command.type === "harvest_loop";
      if (requiresPath && remainingPathCommands <= 0) {
        if (deferExcessPathCommands) this.commandQueue.push(command);
        continue;
      }
      if (requiresPath) remainingPathCommands -= 1;
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
    return remainingPathCommands;
  }

  private executeCommandBatch(
    commands: readonly Command[],
    pathBudget: number,
    commandBudget: number,
  ): {
    result: CommandBatchExecutionResult;
    consumedCommands: number;
    consumedPathCommands: number;
  } {
    const pathCommandCount = commands.filter((command) => (
      command.type === "move" || command.type === "attack_move" || command.type === "harvest_loop"
    )).length;
    if (commands.length > commandBudget) {
      return {
        result: this.recordRolledBackBatch(commands, "command_budget_exceeded"),
        consumedCommands: 0,
        consumedPathCommands: 0,
      };
    }
    if (pathCommandCount > pathBudget) {
      return {
        result: this.recordRolledBackBatch(commands, "path_budget_exceeded"),
        consumedCommands: 0,
        consumedPathCommands: 0,
      };
    }

    const checkpoint = this.createSimulationCheckpoint();
    for (const command of commands) this.queueCommand(command);
    const processed = this.processQueuedCommands(pathBudget);
    const failed = processed.outcomes.find((outcome) => !outcome.success);
    if (!failed) {
      return {
        result: { committed: true, outcomes: processed.outcomes },
        consumedCommands: commands.length,
        consumedPathCommands: pathCommandCount,
      };
    }

    this.restoreSimulationCheckpoint(checkpoint);
    return {
      result: this.recordRolledBackBatch(commands, "command_failed", failed),
      consumedCommands: commands.length,
      consumedPathCommands: pathCommandCount,
    };
  }

  private recordRolledBackBatch(
    commands: readonly Command[],
    failureReason: CommandBatchExecutionResult["failureReason"],
    failedOutcome?: CommandExecutionOutcome,
  ): CommandBatchExecutionResult {
    const outcomes: CommandExecutionOutcome[] = [];
    if (this.activeCommandOutcomes) {
      throw new Error("Cannot record a rolled-back batch while command processing is active.");
    }
    this.activeCommandOutcomes = outcomes;
    try {
      for (const command of commands) {
        this.addLog(LOG_TYPES.COMMAND_RESULT, `Command batch rolled back for ${command.type}`, {
          command,
          result_code: RESULT_CODES.ERR_INVALID_TARGET,
          type: RESULT_TYPES.COMMAND_INVALID,
          result_data: {
            hint: failureReason === "path_budget_exceeded"
              ? "The complete command envelope exceeded this actor's fair path-command budget for the tick and was rolled back."
              : failureReason === "command_budget_exceeded"
                ? "The complete command envelope exceeded this actor's remaining command budget for the tick and was rolled back."
                : "At least one command failed, so the complete command envelope was rolled back.",
            reason: failureReason,
            failedCommandId: failedOutcome?.command.id,
            failedResultCode: failedOutcome?.resultCode,
            failedResultType: failedOutcome?.resultType,
          },
        }, {
          owner: command.playerId,
          feedbackTarget: command.playerId,
          level: LOG_LEVELS.WARNING,
        });
      }
    } finally {
      this.activeCommandOutcomes = null;
    }
    return {
      committed: false,
      outcomes,
      failureReason,
      ...(failedOutcome ? { failedCommandId: failedOutcome.command.id } : {}),
    };
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

      case "spawn": {
        if (command.buildingId && command.unitType) {
          const building = this.world.buildings.getBuilding(command.buildingId);
          if (building && building.playerId === command.playerId) {
            const player = this.world.getPlayerState(command.playerId);
            if (player) {
              const unitCost = this.getUnitCost(command.unitType);
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
                      unitType: command.unitType,
                      hint: `${building.type} is still under construction and cannot produce units yet.`,
                    },
                  },
                  {
                    owner: command.playerId,
                    feedbackTarget: command.playerId,
                    level: LOG_LEVELS.WARNING,
                  }
                );
              } else if (!this.world.buildings.canProduce(building, command.unitType)) {
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
                this.world.buildings.spawnUnit(building, command.unitType);
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
                  hint: "Buildable structures are barracks, war_factory, and refinery. HQ cannot be built.",
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

          if (!this.canStartBuildingType(command.playerId, command.buildingType)) {
            this.addLog(
              LOG_TYPES.COMMAND_RESULT,
              "Build command failed: missing technology prerequisite",
              {
                command,
                result_code: RESULT_CODES.ERR_INVALID_BUILDING,
                type: RESULT_TYPES.BUILD_INVALID_BUILDING,
                result_data: {
                  hint: "Build a completed barracks before starting a war_factory.",
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

  private getUnitCost(unitType: string): number {
    return isUnitType(unitType) ? getRulesetUnitCost(unitType) : 0;
  }

  private getBuildingCost(buildingType: string): number {
    return isBuildingType(buildingType) ? getRulesetBuildingCost(buildingType) : 0;
  }

  private isBuildingComplete(building: Building): boolean {
    return building.exists && !building.constructionProgress;
  }

  private canStartBuildingType(playerId: PlayerId, buildingType: BuildingType): boolean {
    if (buildingType !== BUILDING_TYPES.WAR_FACTORY) {
      return true;
    }
    return this.world.buildings
      .getBuildingsByPlayer(playerId)
      .some((building) => building.type === BUILDING_TYPES.BARRACKS && this.isBuildingComplete(building));
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

  createSimulationCheckpoint(): GameSimulationCheckpoint {
    return {
      tick: this.world.tick,
      revision: this.world.revision,
      units: this.world.units.createCheckpoint(),
      buildings: this.world.buildings.createCheckpoint(),
      resourceRemaining: Array.from(this.world.resourceRemaining.entries()),
      playerCredits: this.world.getPlayerCredits(),
      logs: [...this.logs],
      pendingSnapshotLogs: [...this.pendingSnapshotLogs],
      commandQueue: structuredClone(this.commandQueue),
      projectiles: structuredClone(this.world.projectiles),
      projectileCounter: this.world.projectileCounter,
      rng: this.world.rng.createCheckpoint(),
      winner: this.world.winner,
      isRunning: this.isRunning,
    };
  }

  restoreSimulationCheckpoint(checkpointValue: unknown): void {
    const checkpoint = checkpointValue as GameSimulationCheckpoint;
    this.world.tick = checkpoint.tick;
    this.world.revision = checkpoint.revision;
    this.world.units.restoreCheckpoint(checkpoint.units);
    this.world.buildings.restoreCheckpoint(checkpoint.buildings);
    this.world.resourceRemaining = new Map(checkpoint.resourceRemaining);
    this.world.rebuildMapProjection();
    this.world.restorePlayerCredits(checkpoint.playerCredits);
    this.logs = [...checkpoint.logs];
    this.pendingSnapshotLogs = [...checkpoint.pendingSnapshotLogs];
    this.commandQueue = structuredClone(checkpoint.commandQueue);
    this.world.projectiles = structuredClone(checkpoint.projectiles);
    this.world.projectileCounter = checkpoint.projectileCounter;
    this.world.rng.restoreCheckpoint(checkpoint.rng);
    this.world.winner = checkpoint.winner;
    this.isRunning = checkpoint.isRunning;
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
          // Legacy Game never exposed this outcome; the versioned event journal will.
          break;
        case "unit_spawned":
          this.addLog(LOG_TYPES.UNIT_SPAWNED, `Unit ${event.unitType} spawned for ${event.playerId}`, {
            unitType: event.unitType,
          }, {
            owner: event.playerId,
            feedbackTarget: event.playerId,
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

  /** Compatibility transaction boundary used by MatchRuntime and legacy tickUpdate. */
  advanceSimulationTick(commandBatches: readonly GameCommandBatch[] = []): GameTickResult | null {
    if (!this.isRunning) return null;

    const checkpoint = this.createSimulationCheckpoint();
    try {
      this.beginSimulationTick();
      const queued = this.processQueuedCommands(this.commandBudgetPolicy.maxPathCommandsPerTick);
      const deferredLegacyCommands = structuredClone(this.commandQueue);
      this.commandQueue = [];
      const pathDemandByActor = new Map<string, number>();
      for (const batch of commandBatches) {
        const pathDemand = batch.commands.filter((command) => (
          command.type === "move" || command.type === "attack_move" || command.type === "harvest_loop"
        )).length;
        pathDemandByActor.set(batch.actorId, (pathDemandByActor.get(batch.actorId) ?? 0) + pathDemand);
      }
      const remainingPathBudgetByActor = allocateFairPathBudgets(
        pathDemandByActor,
        queued.remainingPathBudget,
        this.world.tick,
      );
      const remainingCommandBudgetByActor = new Map<string, number>();
      const commandBatchResults: CommandBatchExecutionResult[] = [];
      for (const batch of commandBatches) {
        const commandBudget = remainingCommandBudgetByActor.get(batch.actorId)
          ?? this.commandBudgetPolicy.maxCommandsPerActorPerTick;
        const pathBudget = remainingPathBudgetByActor.get(batch.actorId) ?? 0;
        const executed = this.executeCommandBatch(batch.commands, pathBudget, commandBudget);
        commandBatchResults.push(executed.result);
        remainingCommandBudgetByActor.set(batch.actorId, commandBudget - executed.consumedCommands);
        remainingPathBudgetByActor.set(batch.actorId, pathBudget - executed.consumedPathCommands);
      }
      this.commandQueue.push(...deferredLegacyCommands);
      const simulation = this.simulationCore.step(this.world);
      this.applySimulationEvents(simulation.events);
      return {
        commandOutcomes: [
          ...queued.outcomes,
          ...commandBatchResults.flatMap((batch) => batch.outcomes),
        ],
        commandBatchResults,
        simulation,
      };
    } catch (error) {
      this.restoreSimulationCheckpoint(checkpoint);
      throw error;
    }
  }

  captureSimulationSnapshot(): TickDeltaRecord | null {
    return this.saveSnapshot();
  }

  /** MatchRuntime persists deltas in MatchJournal and releases this compatibility cache every tick. */
  discardRecordedTickDeltas(): void {
    this.tickDeltaBuffer = [];
    this.tickDeltaChunks = [];
  }

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.addLog(LOG_TYPES.GAME_STARTED, "Game started");
  }

  stop(): void {
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
        productionQueue: [...building.productionQueue],
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
        this.tickDeltaBuffer.push(delta);
      }
      if (this.tickDeltaBuffer.length >= TICK_DELTA_CHUNK_SIZE) {
        this.tickDeltaChunks.push(gzipSync(JSON.stringify(this.tickDeltaBuffer)).toString("base64"));
        this.tickDeltaBuffer = [];
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

  *iterateTickDeltas(throughTick?: number): Generator<TickDeltaRecord> {
    for (const chunk of this.tickDeltaChunks) {
      const deltas = JSON.parse(
        gunzipSync(Buffer.from(chunk, "base64")).toString("utf8"),
      ) as TickDeltaRecord[];
      for (const delta of deltas) {
        if (throughTick !== undefined && delta.tick > throughTick) return;
        yield delta;
      }
    }
    for (const delta of this.tickDeltaBuffer) {
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
      buildingType: command.buildingType,
      playerId: command.playerId,
      provenance: command.provenance ? this.cloneValue(command.provenance) : undefined,
    };
  }
}
