import {
  Unit,
  Building,
  Player,
  GameLog,
  Command,
  GameSnapshot,
  GameState,
  CommandResult,
  Tile,
  TileType,
  ResultCode,
  TILE_TYPES,
  UNIT_TYPES,
  UNIT_STATS,
  BUILDING_TYPES,
  UNIT_STATES,
  RESULT_CODES,
  ECONOMY_RULES,
  TICK_INTERVAL_MS,
  MAP_WIDTH,
  MAP_HEIGHT,
  GAME_LOG_TYPES,
  GameLogType,
  LOG_LEVELS,
  LogLevel,
  PLAYER_IDS,
  ACTOR_IDS,
  PlayerId,
  ActorId,
  AI_FEEDBACK_TARGETS,
  AIFeedbackTarget,
  LOG_DISPLAY_TARGETS,
  LogDisplayTarget,
  getDefaultFeedbackTarget,
  getDefaultDisplayTarget,
  LOG_TYPE_DEFAULT_LEVEL,
  LOG_TYPE_DEFAULT_DISPLAY_TARGET,
  CommandLogMeta,
  GameLogDataMap,
} from "@llmcraft/shared";
import { MapGenerator } from "./MapGenerator";
import { UnitManager } from "./UnitManager";
import { BuildingManager } from "./BuildingManager";

type AttackIntent = {
  type: "attack";
  targetId?: string;
  targetX?: number;
  targetY?: number;
  targetPriority?: string[];
};

type RuntimeUnit = Unit & {
  intent?: Unit["intent"] | AttackIntent;
  lastAttackTick?: number;
};

export class Game {
  private tick = 0;
  private unitManager = new UnitManager();
  private buildingManager = new BuildingManager();
  private tiles: TileType[][] = [];
  private players: Player[] = [];
  private logs: GameLog[] = [];
  private commandQueue: Command[] = [];
  private commandResults: CommandResult[] = [];
  private snapshots: GameSnapshot[] = [];
  private aiOutputs: Record<string, string> = {};
  private winner: string | null = null;
  private isRunning = false;
  private tickInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.initializeGame();
  }

  private initializeGame(): void {
    const centerY = Math.floor(MAP_HEIGHT / 2);
    const leftHqX = 2;
    const rightHqX = MAP_WIDTH - 3;

    // 1. Generate map
    this.tiles = MapGenerator.generate();

    // 2. Create two players
    this.players = [
      {
        id: "player_1",
        units: [],
        buildings: [],
        resources: { credits: 200 },
      },
      {
        id: "player_2",
        units: [],
        buildings: [],
        resources: { credits: 200 },
      },
    ];

    // 3. Place HQ
    this.buildingManager.createBuilding(BUILDING_TYPES.HQ, leftHqX, centerY, "player_1");
    this.buildingManager.createBuilding(BUILDING_TYPES.HQ, rightHqX, centerY, "player_2");

    // 4. Place initial units: 2 workers for each player
    this.unitManager.createUnit(UNIT_TYPES.WORKER, leftHqX + 1, centerY - 1, "player_1");
    this.unitManager.createUnit(UNIT_TYPES.WORKER, leftHqX + 1, centerY + 1, "player_1");

    this.unitManager.createUnit(UNIT_TYPES.WORKER, rightHqX - 1, centerY - 1, "player_2");
    this.unitManager.createUnit(UNIT_TYPES.WORKER, rightHqX - 1, centerY + 1, "player_2");

    this.addLog(GAME_LOG_TYPES.GAME_START, "Game initialized successfully");
    this.saveSnapshot();
  }

  getState(): GameState {
    // Update player units and buildings from managers
    for (const player of this.players) {
      player.units = this.unitManager.getUnitsByPlayer(player.id);
      player.buildings = this.buildingManager.getBuildingsByPlayer(player.id);
    }

    // Convert TileType[][] to Tile[][]
    const tiles: Tile[][] = [];
    for (let y = 0; y < MAP_HEIGHT; y++) {
      tiles[y] = [];
      for (let x = 0; x < MAP_WIDTH; x++) {
        tiles[y][x] = {
          x,
          y,
          type: this.tiles[y][x],
        };
      }
    }

    return this.cloneValue({
      tick: this.tick,
      players: this.players,
      tiles,
      winner: this.winner,
      logs: this.logs,
    });
  }

  queueCommand(command: Command): void {
    this.commandQueue.push(this.normalizeCommand(command));
  }

  processCommands(): void {
    for (const command of this.commandQueue) {
      try {
        this.processCommand(command);
      } catch (error) {
        const log = this.addLog(GAME_LOG_TYPES.COMMAND_ERROR, `Command processing crashed for ${command.type}`, {
          command,
          error: error instanceof Error ? error.message : String(error),
        }, {
          owner: command.playerId as ActorId,
          feedbackTarget: command.playerId as AIFeedbackTarget,
          level: LOG_LEVELS.ERROR,
        });
        this.recordCommandResult(command, RESULT_CODES.ERR_INVALID_TARGET, false, "Command processing crashed");
        console.error("命令处理异常:", error, command);
      }
    }
    this.commandQueue = [];
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
                  GAME_LOG_TYPES.MOVE_ADJUSTED,
                  `Unit ${command.unitId} rerouted to (${resolvedTarget.x}, ${resolvedTarget.y})`,
                  {
                    command,
                    result,
                    phase: "command",
                    code: "move_adjusted",
                    commandMeta: {
                      x: resolvedTarget.x,
                      y: resolvedTarget.y,
                      requestedX: command.position.x,
                      requestedY: command.position.y,
                      hint: "Target tile was blocked, so a nearby reachable tile was chosen.",
                    },
                  },
                  {
                    owner: command.playerId as ActorId,
                    feedbackTarget: command.playerId as AIFeedbackTarget,
                    level: LOG_LEVELS.WARNING,
                  }
                );
              }
            } else {
              const failure = this.describeMoveFailure(unit.id, command.position.x, command.position.y) ?? {
                code: "move_unreachable",
                hint: "No reachable nearby tile found.",
              };
              this.addLog(
                GAME_LOG_TYPES.MOVE_BLOCKED,
                `Unit ${command.unitId} cannot move to (${command.position.x}, ${command.position.y})`,
                {
                  command,
                  result,
                  phase: "command",
                  code: failure.code,
                  commandMeta: {
                    x: command.position.x,
                    y: command.position.y,
                    requestedX: command.position.x,
                    requestedY: command.position.y,
                    hint: failure.hint,
                  },
                },
                {
                  owner: command.playerId as ActorId,
                  feedbackTarget: command.playerId as AIFeedbackTarget,
                  level: LOG_LEVELS.WARNING,
                }
              );
            }
            this.recordCommandResult(command, result, result === RESULT_CODES.OK, "Move command processed");
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
              this.addLog(
                GAME_LOG_TYPES.COMMAND_ERROR,
                `Attack command failed for unit ${command.unitId}`,
                {
                  command,
                  result,
                  phase: "command",
                  code: result === RESULT_CODES.ERR_NOT_IN_RANGE ? "attack_out_of_range" : "attack_invalid_target",
                  commandMeta: {
                    targetId: command.targetId,
                    hint:
                      result === RESULT_CODES.ERR_NOT_IN_RANGE
                        ? "Move to a tile adjacent to the target before attacking."
                        : "Check that the target still exists and belongs to the enemy.",
                  },
                },
                {
                  owner: command.playerId as ActorId,
                  feedbackTarget: command.playerId as AIFeedbackTarget,
                  level: LOG_LEVELS.WARNING,
                }
              );
            }
            this.recordCommandResult(command, result, result === RESULT_CODES.OK, "Attack command processed");
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
                GAME_LOG_TYPES.COMMAND_ERROR,
                `Attack-in-range command failed for unit ${command.unitId}`,
                {
                  command,
                  result,
                  phase: "command",
                  code: "attack_in_range_no_target",
                  commandMeta: {
                    hint: "No enemy matching the requested priority was in range at execution time.",
                  },
                },
                {
                  owner: command.playerId as ActorId,
                  feedbackTarget: command.playerId as AIFeedbackTarget,
                  level: LOG_LEVELS.WARNING,
                }
              );
            }
            this.recordCommandResult(command, result, result === RESULT_CODES.OK, "Attack-in-range command processed");
          }
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
            this.recordCommandResult(command, RESULT_CODES.OK, true, "Hold command processed");
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
                  GAME_LOG_TYPES.COMMAND_ERROR,
                  `Spawn command failed: ${building.type} cannot produce ${command.unitType}`,
                  {
                    command,
                    result,
                    phase: "command",
                    code: "spawn_invalid_building",
                    commandMeta: {
                      targetId: building.id,
                      hint: building.type === BUILDING_TYPES.HQ
                        ? "HQ can only spawn workers. Build a barracks to produce soldiers."
                        : "Check that the unit type matches the building.",
                    },
                  },
                  {
                    owner: command.playerId as ActorId,
                    feedbackTarget: command.playerId as AIFeedbackTarget,
                    level: LOG_LEVELS.WARNING,
                  }
                );
                this.recordCommandResult(command, result, false, "Building cannot produce this unit type");
              } else if (player.resources.credits >= unitCost) {
                player.resources.credits -= unitCost;
                this.buildingManager.spawnUnit(building, command.unitType);
                this.recordCommandResult(command, RESULT_CODES.OK, true, "Spawn command queued");
              } else {
                this.addLog(
                  GAME_LOG_TYPES.COMMAND_ERROR,
                  "Spawn command failed: insufficient credits",
                  {
                    command,
                    result: RESULT_CODES.ERR_NOT_ENOUGH_CREDITS,
                    phase: "command",
                    code: "insufficient_credits",
                    commandMeta: {
                      targetId: building.id,
                      hint: `Need ${unitCost} credits before spawning ${command.unitType}.`,
                    },
                  },
                  {
                    owner: command.playerId as ActorId,
                    feedbackTarget: command.playerId as AIFeedbackTarget,
                    level: LOG_LEVELS.WARNING,
                  }
                );
                this.recordCommandResult(
                  command,
                  RESULT_CODES.ERR_NOT_ENOUGH_CREDITS,
                  false,
                  "Insufficient credits"
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
            this.recordCommandResult(command, RESULT_CODES.ERR_INVALID_TARGET, false, "Only a friendly worker can build");
            break;
          }

          if (command.buildingType !== BUILDING_TYPES.BARRACKS) {
            this.addLog(
              GAME_LOG_TYPES.COMMAND_ERROR,
              "Build command failed: only barracks can be built in MVP",
              {
                command,
                result: RESULT_CODES.ERR_INVALID_BUILDING,
                phase: "command",
                code: "build_invalid_building",
                commandMeta: {
                  hint: "Only barracks are buildable in the current MVP.",
                },
              },
              {
                owner: command.playerId as ActorId,
                feedbackTarget: command.playerId as AIFeedbackTarget,
                level: LOG_LEVELS.WARNING,
              }
            );
            this.recordCommandResult(command, RESULT_CODES.ERR_INVALID_BUILDING, false, "Only barracks can be built in MVP");
            break;
          }

          const buildingCost = this.getBuildingCost(command.buildingType);
          if (player.resources.credits < buildingCost) {
            this.addLog(
              GAME_LOG_TYPES.COMMAND_ERROR,
              "Build command failed: insufficient credits",
              {
                command,
                result: RESULT_CODES.ERR_NOT_ENOUGH_CREDITS,
                phase: "command",
                code: "insufficient_credits",
                commandMeta: {
                  x: command.position.x,
                  y: command.position.y,
                  hint: `Need ${buildingCost} credits before building a barracks.`,
                },
              },
              {
                owner: command.playerId as ActorId,
                feedbackTarget: command.playerId as AIFeedbackTarget,
                level: LOG_LEVELS.WARNING,
              }
            );
            this.recordCommandResult(
              command,
              RESULT_CODES.ERR_NOT_ENOUGH_CREDITS,
              false,
              "Insufficient credits"
            );
            break;
          }

          const result = this.validateBuildPosition(command.playerId, command.position.x, command.position.y);
          if (result !== RESULT_CODES.OK) {
            const buildFailure = this.describeBuildFailure(command.playerId, command.position.x, command.position.y);
            this.addLog(
              GAME_LOG_TYPES.COMMAND_ERROR,
              "Build command failed: invalid build position",
              {
                command,
                result,
                phase: "command",
                code: buildFailure.code,
                commandMeta: {
                  x: command.position.x,
                  y: command.position.y,
                  hint: buildFailure.hint,
                },
              },
              {
                owner: command.playerId as ActorId,
                feedbackTarget: command.playerId as AIFeedbackTarget,
                level: LOG_LEVELS.WARNING,
              }
            );
            this.recordCommandResult(command, result, false, "Invalid build position");
            break;
          }

          player.resources.credits -= buildingCost;
          this.buildingManager.createBuilding(
            command.buildingType,
            command.position.x,
            command.position.y,
            command.playerId
          );
          this.addLog(GAME_LOG_TYPES.BUILDING_CONSTRUCTED, `Barracks constructed for ${command.playerId}`, {
            command,
          });
          this.recordCommandResult(command, RESULT_CODES.OK, true, "Building constructed");
        }
        break;
      }
    }
  }

  private getUnitCost(unitType: string): number {
    switch (unitType) {
      case UNIT_TYPES.WORKER:
        return 50;
      case UNIT_TYPES.SOLDIER:
        return 80;
      default:
        return 0;
    }
  }

  private getBuildingCost(buildingType: string): number {
    switch (buildingType) {
      case BUILDING_TYPES.BARRACKS:
        return 120;
      default:
        return 0;
    }
  }

  private attackBuilding(attacker: RuntimeUnit, target: Building): ResultCode {
    if (!attacker.exists || !target.exists) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    if (attacker.playerId === target.playerId) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    const distance = Math.max(Math.abs(attacker.x - target.x), Math.abs(attacker.y - target.y));
    if (distance > attacker.attackRange) {
      return RESULT_CODES.ERR_NOT_IN_RANGE;
    }

    const damage = UNIT_STATS[attacker.type].attack;
    this.buildingManager.takeDamage(target, damage);
    attacker.state = UNIT_STATES.ATTACKING;
    attacker.intent = { type: "attack", targetId: target.id, targetX: target.x, targetY: target.y };
    attacker.lastAttackTick = this.tick;

    return RESULT_CODES.OK;
  }

  private executeAttackIntent(
    attacker: RuntimeUnit,
    playerId: string,
    intent: AttackIntent | Unit["intent"]
  ): ResultCode {
    if (!attacker.exists || !intent || intent.type !== "attack") {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    let result: ResultCode;

    if (intent.targetId) {
      const unitTarget = this.unitManager.getUnit(intent.targetId);
      const buildingTarget = this.buildingManager.getBuilding(intent.targetId);
      result = unitTarget
        ? this.unitManager.attackUnit(attacker, unitTarget)
        : buildingTarget
          ? this.attackBuilding(attacker, buildingTarget)
          : RESULT_CODES.ERR_INVALID_TARGET;
    } else {
      const prioritizedTarget = this.findPrioritizedAttackTarget(attacker, playerId, intent.targetPriority);
      result = prioritizedTarget
        ? prioritizedTarget.kind === "unit"
          ? this.unitManager.attackUnit(attacker, prioritizedTarget.target)
          : this.attackBuilding(attacker, prioritizedTarget.target)
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

  private processAttackIntents(): void {
    for (const unit of this.unitManager.getAllUnits()) {
      if (!unit.exists || unit.intent?.type !== "attack") {
        continue;
      }

      const runtimeUnit = unit as RuntimeUnit;

      if (runtimeUnit.lastAttackTick === this.tick) {
        continue;
      }

      const result = this.executeAttackIntent(runtimeUnit, runtimeUnit.playerId, runtimeUnit.intent);
      if (result === RESULT_CODES.ERR_INVALID_TARGET && runtimeUnit.intent?.targetId) {
        runtimeUnit.intent = { type: "hold" };
        runtimeUnit.state = UNIT_STATES.IDLE;
      } else if (result !== RESULT_CODES.OK && runtimeUnit.intent?.targetId) {
        runtimeUnit.state = UNIT_STATES.IDLE;
      }
    }
  }

  private findPrioritizedAttackTarget(
    attacker: Unit,
    playerId: string,
    targetPriority?: string[]
  ): { kind: "unit"; target: Unit } | { kind: "building"; target: Building } | null {
    const priority = (targetPriority && targetPriority.length > 0
      ? targetPriority
      : ["hq", "soldier", "worker", "barracks"]
    ).map((value) => String(value).toLowerCase());

    const enemyUnits = this.unitManager
      .getAllUnits()
      .filter((unit) => unit.exists && unit.playerId !== playerId)
      .filter((unit) => Math.max(Math.abs(attacker.x - unit.x), Math.abs(attacker.y - unit.y)) <= attacker.attackRange);
    const enemyBuildings = this.buildingManager
      .getAllBuildings()
      .filter((building) => building.exists && building.playerId !== playerId)
      .filter(
        (building) =>
          Math.max(Math.abs(attacker.x - building.x), Math.abs(attacker.y - building.y)) <= attacker.attackRange
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

    if (fallbackBuildings.length > 0) {
      return { kind: "building", target: fallbackBuildings[0] };
    }
    if (fallbackUnits.length > 0) {
      return { kind: "unit", target: fallbackUnits[0] };
    }

    return null;
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
          this.addLog(GAME_LOG_TYPES.GAME_END, `Player ${winner.id} wins!`, {
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

    try {
      this.tick++;

      // Process commands
      this.processCommands();

      // Process unit path movement (自动寻路移动)
      const blockedPositions = this.buildingManager.getOccupiedPositions();
      for (const unit of this.unitManager.getAllUnits()) {
        this.unitManager.processPathMovement(unit, this.tiles, blockedPositions);
      }

      // Process worker economy loop: gather on resource tiles, then deliver near HQ
      this.processWorkerEconomy();

      // Sustain attack intents every tick so units keep attacking in range.
      this.processAttackIntents();

      // Process building production queues
      const completedUnits = this.buildingManager.processProductionQueues();
      for (const [playerId, unitTypes] of completedUnits) {
        for (const unitType of unitTypes) {
          // Find barracks to spawn unit near
          const buildings = this.buildingManager.getBuildingsByPlayer(playerId);
          const barracks = buildings.find((b) => b.type === BUILDING_TYPES.BARRACKS);
          const hq = buildings.find((b) => b.type === BUILDING_TYPES.HQ);
          const spawnBuilding = barracks || hq;

          if (spawnBuilding) {
            // Find an empty position near the building
            const spawnPos = this.findEmptySpawnPosition(spawnBuilding.x, spawnBuilding.y);
            if (spawnPos) {
              this.unitManager.createUnit(unitType, spawnPos.x, spawnPos.y, playerId);
              this.addLog(GAME_LOG_TYPES.UNIT_SPAWNED, `Unit ${unitType} spawned for ${playerId}`, {
                playerId,
                unitType,
              });
            } else {
              this.addLog(GAME_LOG_TYPES.SPAWN_FAILED, `No empty position to spawn ${unitType} for ${playerId}`, {
                playerId,
                unitType,
              });
            }
          }
        }
      }

      // Check win condition
      this.checkWinCondition();
    } catch (error) {
      this.addLog(GAME_LOG_TYPES.TICK_ERROR, "Tick update crashed", {
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("Tick 更新异常:", error);
    } finally {
      // Save snapshot even if the tick had partial failure so the client stays connected.
      this.saveSnapshot();
    }
  }

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.addLog(GAME_LOG_TYPES.GAME_STARTED, "Game started");

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
    this.addLog(GAME_LOG_TYPES.GAME_STOPPED, "Game stopped");
  }

  addLog<T extends GameLogType>(
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
    const owner = overrides?.owner
      ?? ((data as Record<string, unknown> | undefined)?.playerId as ActorId | undefined)
      ?? ACTOR_IDS.SYSTEM;

    const feedbackTarget = overrides?.feedbackTarget ?? getDefaultFeedbackTarget(type);
    const level = overrides?.level ?? LOG_TYPE_DEFAULT_LEVEL[type];
    const displayTarget = overrides?.displayTarget ?? getDefaultDisplayTarget(type);

    const log: GameLog = {
      tick: this.tick,
      type,
      message,
      data,
      meta: {
        level,
        owner,
        feedbackTarget,
        displayTarget,
      },
    } as GameLog;
    this.logs.push(log);
    // 限制日志数量，防止内存泄漏
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-500);
    }
    return log;
  }

  private saveSnapshot(): void {
    this.snapshots.push({
      tick: this.tick,
      state: this.getState(),
      aiOutputs: this.cloneValue(this.aiOutputs),
    });
  }

  getWinner(): string | null {
    return this.winner;
  }

  isGameRunning(): boolean {
    return this.isRunning;
  }

  getTick(): number {
    return this.tick;
  }

  setAIOutput(playerId: string, output: string): void {
    this.aiOutputs[playerId] = output;
  }

  getAIFeedback(playerId: string, sinceTick?: number): GameLog[] {
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
      const hq = this.buildingManager
        .getBuildingsByPlayer(player.id)
        .find((building) => building.type === BUILDING_TYPES.HQ && building.exists);

      if (!hq) {
        continue;
      }

      for (const unit of this.unitManager.getUnitsByPlayer(player.id)) {
        if (unit.type !== UNIT_TYPES.WORKER || !unit.exists) {
          continue;
        }

        const onResourceTile = this.tiles[unit.y]?.[unit.x] === TILE_TYPES.RESOURCE;
        const isNearFriendlyHQ = this.isWithinDeliveryRange(unit, hq);
        let economyActionTaken = false;

        if (onResourceTile && unit.carryingCredits < unit.carryCapacity) {
          const gatheredCredits = Math.min(
            ECONOMY_RULES.WORKER_GATHER_RATE,
            unit.carryCapacity - unit.carryingCredits
          );

          if (gatheredCredits > 0) {
            unit.carryingCredits += gatheredCredits;
            unit.state = UNIT_STATES.GATHERING;
            unit.intent = { type: "gather", targetX: unit.x, targetY: unit.y };
            this.addLog(GAME_LOG_TYPES.RESOURCE_GATHERED, `Worker ${unit.id} gathered ${gatheredCredits} credits`, {
              playerId: player.id,
              unitId: unit.id,
              amount: gatheredCredits,
              carryingCredits: unit.carryingCredits,
            });
            economyActionTaken = true;
          }
        }

        if (isNearFriendlyHQ && !onResourceTile && unit.carryingCredits > 0) {
          const deliveredCredits = unit.carryingCredits;
          player.resources.credits += deliveredCredits;
          unit.carryingCredits = 0;
          unit.state = UNIT_STATES.IDLE;
          unit.intent = { type: "deposit", targetX: hq.x, targetY: hq.y, targetId: hq.id };
          this.addLog(GAME_LOG_TYPES.CREDITS_DELIVERED, `Worker ${unit.id} delivered ${deliveredCredits} credits to HQ`, {
            playerId: player.id,
            unitId: unit.id,
            buildingId: hq.id,
            amount: deliveredCredits,
            credits: player.resources.credits,
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
  private findEmptySpawnPosition(centerX: number, centerY: number): { x: number; y: number } | null {
    // Check positions in expanding distance from center
    for (let distance = 1; distance <= 3; distance++) {
      // Check all positions at current distance
      for (let dx = -distance; dx <= distance; dx++) {
        for (let dy = -distance; dy <= distance; dy++) {
          // Only check positions at exactly this Manhattan distance
          if (Math.abs(dx) + Math.abs(dy) !== distance) continue;

          const x = centerX + dx;
          const y = centerY + dy;

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
    return this.cloneValue(this.snapshots);
  }

  getLatestSnapshot(): GameSnapshot | null {
    const latest = this.snapshots[this.snapshots.length - 1];
    return latest ? this.cloneValue(latest) : null;
  }

  getCommandResults(): CommandResult[] {
    return this.cloneValue(this.commandResults);
  }

  // For testing purposes
  getUnitManager(): UnitManager {
    return this.unitManager;
  }

  getBuildingManager(): BuildingManager {
    return this.buildingManager;
  }

  private isWithinDeliveryRange(unit: Unit, hq: Building): boolean {
    return (
      Math.abs(unit.x - hq.x) <= ECONOMY_RULES.HQ_DELIVERY_RANGE &&
      Math.abs(unit.y - hq.y) <= ECONOMY_RULES.HQ_DELIVERY_RANGE
    );
  }

  private validateBuildPosition(playerId: string, x: number, y: number): ResultCode {
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
      return RESULT_CODES.ERR_INVALID_TARGET;
    }

    if (this.tiles[y][x] === TILE_TYPES.OBSTACLE) {
      return RESULT_CODES.ERR_POSITION_OCCUPIED;
    }

    if (this.unitManager.hasUnitAt(x, y) || this.buildingManager.hasBuildingAt(x, y)) {
      return RESULT_CODES.ERR_POSITION_OCCUPIED;
    }

    const hq = this.buildingManager
      .getBuildingsByPlayer(playerId)
      .find((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    if (hq && Math.max(Math.abs(hq.x - x), Math.abs(hq.y - y)) <= 1) {
      return RESULT_CODES.ERR_POSITION_OCCUPIED;
    }

    return RESULT_CODES.OK;
  }

  private recordCommandResult(
    command: Command,
    result: ResultCode,
    success: boolean,
    message: string
  ): void {
    this.commandResults.push({
      tick: this.tick,
      command,
      result,
      success,
      message,
    });
  }

  private describeMoveFailure(unitId: string, x: number, y: number): { code: string; hint: string } | null {
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return { code: "move_bad_target", hint: "Use integer map coordinates." };
    }

    if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
      return { code: "move_bad_target", hint: "Choose a tile inside the map bounds." };
    }

    if (this.tiles[y][x] === TILE_TYPES.OBSTACLE) {
      return { code: "move_blocked_tile", hint: "That tile is an obstacle. Pick a nearby empty tile." };
    }

    if (this.buildingManager.hasBuildingAt(x, y)) {
      return { code: "move_blocked_tile", hint: "Buildings occupy their tile. Move to an adjacent empty tile instead." };
    }

    if (this.unitManager.hasUnitAt(x, y, unitId)) {
      return { code: "move_blocked_tile", hint: "Another unit is already on that tile. Pick a different nearby tile." };
    }

    return { code: "move_unreachable", hint: "No reachable nearby tile found." };
  }

  private describeBuildFailure(playerId: string, x: number, y: number): { code: string; hint: string } {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
      return { code: "build_bad_target", hint: "Choose an empty tile inside the map bounds." };
    }

    if (this.tiles[y][x] === TILE_TYPES.OBSTACLE) {
      return { code: "build_blocked_tile", hint: "That tile is blocked by terrain." };
    }

    if (this.buildingManager.hasBuildingAt(x, y) || this.unitManager.hasUnitAt(x, y)) {
      return { code: "build_blocked_tile", hint: "That tile is already occupied." };
    }

    const hq = this.buildingManager
      .getBuildingsByPlayer(playerId)
      .find((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    if (hq && Math.max(Math.abs(hq.x - x), Math.abs(hq.y - y)) <= 1) {
      return { code: "build_too_close_to_hq", hint: "Leave at least one empty tile around HQ before placing barracks." };
    }

    return { code: "build_bad_target", hint: "Choose another empty tile." };
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
        ? command.targetPriority.map((value) => String(value))
        : undefined,
      position: command.position
        ? {
            x: Number(command.position.x),
            y: Number(command.position.y),
          }
        : undefined,
      unitType: command.unitType,
      buildingType: command.buildingType,
      playerId: String(command.playerId),
    };
  }
}
