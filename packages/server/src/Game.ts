import {
  Unit,
  Building,
  Player,
  GameLog,
  Command,
  GameSnapshot,
  GameState,
  Tile,
  TileType,
  UNIT_TYPES,
  BUILDING_TYPES,
  UNIT_STATES,
  RESULT_CODES,
  TICK_INTERVAL_MS,
  MAP_WIDTH,
  MAP_HEIGHT,
} from "@llmcraft/shared";
import { MapGenerator } from "./MapGenerator";
import { UnitManager } from "./UnitManager";
import { BuildingManager } from "./BuildingManager";

export class Game {
  private tick = 0;
  private unitManager = new UnitManager();
  private buildingManager = new BuildingManager();
  private tiles: TileType[][] = [];
  private players: Player[] = [];
  private logs: GameLog[] = [];
  private commandQueue: Command[] = [];
  private snapshots: GameSnapshot[] = [];
  private aiOutputs: Record<string, string> = {};
  private winner: string | null = null;
  private isRunning = false;
  private tickInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.initializeGame();
  }

  private initializeGame(): void {
    // 1. Generate map
    this.tiles = MapGenerator.generate();

    // 2. Create two players
    this.players = [
      {
        id: "player_1",
        units: [],
        buildings: [],
        resources: { energy: 200, energyPerTick: 0 },
      },
      {
        id: "player_2",
        units: [],
        buildings: [],
        resources: { energy: 200, energyPerTick: 0 },
      },
    ];

    // 3. Place HQ: player_1 at (2,10), player_2 at (17,10)
    this.buildingManager.createBuilding(BUILDING_TYPES.HQ, 2, 10, "player_1");
    this.buildingManager.createBuilding(BUILDING_TYPES.HQ, 17, 10, "player_2");

    // 4. Place initial units: 2 workers + 1 soldier for each player
    this.unitManager.createUnit(UNIT_TYPES.WORKER, 3, 9, "player_1");
    this.unitManager.createUnit(UNIT_TYPES.WORKER, 3, 11, "player_1");
    this.unitManager.createUnit(UNIT_TYPES.SOLDIER, 4, 10, "player_1");

    this.unitManager.createUnit(UNIT_TYPES.WORKER, 16, 9, "player_2");
    this.unitManager.createUnit(UNIT_TYPES.WORKER, 16, 11, "player_2");
    this.unitManager.createUnit(UNIT_TYPES.SOLDIER, 15, 10, "player_2");

    this.addLog("game_start", "Game initialized successfully");
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

    return {
      tick: this.tick,
      players: this.players,
      tiles,
      winner: this.winner,
      logs: this.logs,
    };
  }

  queueCommand(command: Command): void {
    this.commandQueue.push(command);
  }

  processCommands(): void {
    for (const command of this.commandQueue) {
      this.processCommand(command);
    }
    this.commandQueue = [];
  }

  private processCommand(command: Command): void {
    switch (command.type) {
      case "move": {
        if (command.unitId && command.position) {
          const unit = this.unitManager.getUnit(command.unitId);
          if (unit && unit.playerId === command.playerId) {
            const result = this.unitManager.moveUnit(
              unit,
              command.position.x,
              command.position.y,
              this.tiles
            );
            if (result === RESULT_CODES.ERR_POSITION_OCCUPIED) {
              this.addLog(
                "move_blocked",
                `Unit ${command.unitId} cannot move to (${command.position.x}, ${command.position.y}): position occupied`,
                { command, result }
              );
            } else if (result !== RESULT_CODES.OK) {
              this.addLog(
                "command_failed",
                `Move command failed for unit ${command.unitId}`,
                { command, result }
              );
            }
          }
        }
        break;
      }

      case "attack": {
        if (command.unitId && command.targetId) {
          const attacker = this.unitManager.getUnit(command.unitId);
          const target = this.unitManager.getUnit(command.targetId);
          if (attacker && target && attacker.playerId === command.playerId) {
            const result = this.unitManager.attackUnit(attacker, target);
            if (result !== RESULT_CODES.OK) {
              this.addLog(
                "command_failed",
                `Attack command failed for unit ${command.unitId}`,
                { command, result }
              );
            }
          }
        }
        break;
      }

      case "hold": {
        if (command.unitId) {
          const unit = this.unitManager.getUnit(command.unitId);
          if (unit && unit.playerId === command.playerId) {
            this.unitManager.holdPosition(unit);
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
              if (player.resources.energy >= unitCost) {
                player.resources.energy -= unitCost;
                this.buildingManager.spawnUnit(building, command.unitType);
              } else {
                this.addLog(
                  "command_failed",
                  `Spawn command failed: insufficient energy`,
                  { command }
                );
              }
            }
          }
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
      case UNIT_TYPES.SCOUT:
        return 30;
      default:
        return 0;
    }
  }

  updateResources(): void {
    for (const player of this.players) {
      const energyProduction = this.buildingManager.getEnergyProduction(player.id);
      player.resources.energyPerTick = energyProduction;
      player.resources.energy += energyProduction;
    }
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
          this.addLog("game_end", `Player ${winner.id} wins!`, {
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

    this.tick++;

    // Process commands
    this.processCommands();

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
          // Spawn unit near the building
          this.unitManager.createUnit(
            unitType,
            spawnBuilding.x + 1,
            spawnBuilding.y,
            playerId
          );
          this.addLog("unit_spawned", `Unit ${unitType} spawned for ${playerId}`, {
            playerId,
            unitType,
          });
        }
      }
    }

    // Update resources
    this.updateResources();

    // Check win condition
    this.checkWinCondition();

    // Save snapshot
    this.saveSnapshot();
  }

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.addLog("game_started", "Game started");

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
    this.addLog("game_stopped", "Game stopped");
  }

  private addLog(type: string, message: string, data?: any): void {
    this.logs.push({
      tick: this.tick,
      type,
      message,
      data,
    });
    // 限制日志数量，防止内存泄漏
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-500);
    }
  }

  private saveSnapshot(): void {
    this.snapshots.push({
      tick: this.tick,
      state: this.getState(),
      aiOutputs: { ...this.aiOutputs },
    });
    // 限制快照数量，防止内存泄漏（保留最近 1000 个 tick）
    if (this.snapshots.length > 1000) {
      this.snapshots = this.snapshots.slice(-500);
    }
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

  getSnapshots(): GameSnapshot[] {
    return this.snapshots;
  }

  // For testing purposes
  getUnitManager(): UnitManager {
    return this.unitManager;
  }

  getBuildingManager(): BuildingManager {
    return this.buildingManager;
  }
}
