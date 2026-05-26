import { CPUStrategyType, PlayerId, PLAYER_IDS } from "@llmcraft/shared";
import { Game } from "../Game";
import { GameAgentBridge } from "../agent/GameAgentBridge";
import { executeAgentTool } from "../agent/AgentTools";
import { runBuiltinCPUStrategy } from "../benchmark/BuiltinCPUStrategy";

export interface ControlLobbyStatus {
  status: "waiting_for_players" | "running";
  ready: { player_1: boolean; player_2: boolean };
}

export class ControlPlaneMatch {
  private readonly game = new Game();
  private readonly bridgeByPlayer: Record<PlayerId, GameAgentBridge>;
  private readonly ready = { player_1: false, player_2: false };
  private started = false;
  private cpuLoop: NodeJS.Timeout | null = null;
  private planLoop: NodeJS.Timeout | null = null;
  private lastPlanAdvanceTick = -1;
  private cpuNextActTick = 0;
  private readonly cpu:
    | {
        playerId: PlayerId;
        strategy: CPUStrategyType;
        bridge: GameAgentBridge;
      }
    | null;

  constructor(options?: { cpuStrategy?: CPUStrategyType }) {
    this.bridgeByPlayer = {
      [PLAYER_IDS.PLAYER_1]: new GameAgentBridge(this.game, PLAYER_IDS.PLAYER_1),
      [PLAYER_IDS.PLAYER_2]: new GameAgentBridge(this.game, PLAYER_IDS.PLAYER_2),
    };
    this.cpu = options?.cpuStrategy
      ? {
          playerId: PLAYER_IDS.PLAYER_2,
          strategy: options.cpuStrategy,
          bridge: this.bridgeByPlayer[PLAYER_IDS.PLAYER_2],
        }
      : null;

    if (this.cpu) {
      this.ready.player_2 = true;
    }
  }

  getGame(): Game {
    return this.game;
  }

  getBridge(playerId: PlayerId): GameAgentBridge {
    return this.bridgeByPlayer[playerId];
  }

  advancePlans(): void {
    const state = this.game.getState();
    if (!state || state.winner || state.tick === this.lastPlanAdvanceTick) {
      return;
    }

    this.lastPlanAdvanceTick = state.tick;
    for (const playerId of [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2]) {
      const commands = this.bridgeByPlayer[playerId].advancePlans();
      for (const command of commands) {
        this.game.queueCommand(command);
      }
    }
  }

  getLobbyStatus(): ControlLobbyStatus {
    return {
      status: this.started ? "running" : "waiting_for_players",
      ready: { ...this.ready },
    };
  }

  join(playerId: PlayerId): void {
    this.ready[playerId] = true;
    this.startIfReady();
  }

  isFinished(): boolean {
    return Boolean(this.game.getState()?.winner);
  }

  stop(): void {
    this.game.stop();
    this.stopCpuLoop();
    this.stopPlanLoop();
  }

  private startIfReady(): void {
    if (this.started || !this.ready.player_1 || !this.ready.player_2) {
      return;
    }
    this.started = true;
    this.game.start();
    this.startPlanLoop();
    this.startCpuLoop();
  }

  private startPlanLoop(): void {
    if (this.planLoop) {
      return;
    }
    this.planLoop = setInterval(() => {
      this.advancePlans();
    }, 100);
  }

  private stopPlanLoop(): void {
    if (!this.planLoop) {
      return;
    }
    clearInterval(this.planLoop);
    this.planLoop = null;
  }

  private startCpuLoop(): void {
    if (!this.cpu || this.cpuLoop) {
      return;
    }
    this.cpuLoop = setInterval(() => {
      void this.runCpuTick();
    }, 200);
  }

  private stopCpuLoop(): void {
    if (!this.cpuLoop) {
      return;
    }
    clearInterval(this.cpuLoop);
    this.cpuLoop = null;
  }

  private async runCpuTick(): Promise<void> {
    if (!this.cpu) {
      return;
    }
    const state = this.game.getState();
    if (!state) {
      return;
    }
    if (state.winner) {
      this.stopCpuLoop();
      return;
    }
    if (state.tick < this.cpuNextActTick) {
      return;
    }
    this.cpuNextActTick = state.tick + 10;

    try {
      const myState = this.cpu.bridge.getMyState().result;
      const myUnits = this.cpu.bridge.getMyUnits().result;
      const mapState = this.cpu.bridge.getMapState({ includeCells: false }).result;
      await runBuiltinCPUStrategy({
        strategy: this.cpu.strategy,
        runtime: { myState, myUnits, mapState },
        callTool: (toolName, args) => executeAgentTool(this.cpu!.bridge, toolName, args).result,
      });
    } catch (error) {
      console.error("Control-plane CPU player error:", error);
    }
  }
}
