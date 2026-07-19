import { CPUStrategyType, PlayerId, PLAYER_IDS, TICK_INTERVAL_MS, type Command } from "@llmcraft/shared";
import { Game } from "../Game";
import { GameAgentBridge } from "../agent/GameAgentBridge";
import { BuiltinTestController } from "../controller/BuiltinTestController";
import { MatchRuntime } from "../MatchRuntime";
import { MatchRecorder } from "../MatchRecorder";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RegisteredMatchStatus } from "../MatchRegistry";
import type { JournalLifecycleService } from "../JournalLifecycle";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONTROL_RECORDS_DIR = path.resolve(CURRENT_DIR, "..", "..", "logs", "records");

export interface ControlLobbyStatus {
  status: "waiting_for_players" | "running";
  ready: { player_1: boolean; player_2: boolean };
}

export class ControlPlaneMatch {
  private readonly matchRuntime: MatchRuntime;
  private readonly game: Game;
  private readonly recorder: MatchRecorder;
  private readonly startedAt = new Date().toISOString();
  private readonly bridgeByPlayer: Record<PlayerId, GameAgentBridge>;
  private readonly ready = { player_1: false, player_2: false };
  private started = false;
  private stopped = false;
  private cpuLoop: NodeJS.Timeout | null = null;
  private cpuRun: Promise<void> | null = null;
  private planLoop: NodeJS.Timeout | null = null;
  private lastPlanAdvanceTick = -1;
  private cpuNextActTick = 0;
  private readonly cpu:
    | {
        playerId: PlayerId;
        strategy: CPUStrategyType;
        controller: BuiltinTestController;
      }
    | null;

  constructor(options?: {
    cpuStrategy?: CPUStrategyType;
    recordDir?: string;
    matchId?: string;
    journalLifecycle?: JournalLifecycleService;
  }) {
    this.matchRuntime = new MatchRuntime({
      recordDir: options?.recordDir ?? DEFAULT_CONTROL_RECORDS_DIR,
      matchId: options?.matchId,
      journalLifecycle: options?.journalLifecycle,
    });
    this.game = this.matchRuntime.getGame();
    this.recorder = new MatchRecorder(this.matchRuntime);
    this.bridgeByPlayer = {
      [PLAYER_IDS.PLAYER_1]: new GameAgentBridge(this.game, PLAYER_IDS.PLAYER_1, {
        submitCommands: (commands, submitOptions) => this.submitCommands(PLAYER_IDS.PLAYER_1, commands, submitOptions),
      }),
      [PLAYER_IDS.PLAYER_2]: new GameAgentBridge(this.game, PLAYER_IDS.PLAYER_2, {
        submitCommands: (commands, submitOptions) => this.submitCommands(PLAYER_IDS.PLAYER_2, commands, submitOptions),
      }),
    };
    this.cpu = options?.cpuStrategy
      ? {
          playerId: PLAYER_IDS.PLAYER_2,
          strategy: options.cpuStrategy,
          controller: new BuiltinTestController(
            PLAYER_IDS.PLAYER_2,
            { providerType: "builtin-cpu", strategy: options.cpuStrategy },
            this.bridgeByPlayer[PLAYER_IDS.PLAYER_2],
          ),
        }
      : null;

    if (this.cpu) {
      this.ready.player_2 = true;
    }
  }

  getGame(): Game {
    return this.game;
  }

  getMatchId(): string {
    return this.matchRuntime.getMatchId();
  }

  getMatchRuntime(): MatchRuntime {
    return this.matchRuntime;
  }

  saveRecord(): Promise<string> {
    return this.recorder.save({
      startedAt: this.startedAt,
      aiIntervalTicks: 0,
      systemPrompt: "",
      players: [
        { playerId: PLAYER_IDS.PLAYER_1, model: "external-controller" },
        {
          playerId: PLAYER_IDS.PLAYER_2,
          model: this.cpu ? `deterministic-test:${this.cpu.strategy}` : "external-controller",
        },
      ],
    });
  }

  getMatchStatus(): RegisteredMatchStatus {
    if (this.game.getWinner()) return "finished";
    if (this.stopped) return "stopped";
    return this.started ? "running" : "waiting_for_players";
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
      this.submitCommands(playerId, commands);
    }
  }

  advanceOneTick(): void {
    this.matchRuntime.advanceOneTick();
  }

  private submitCommands(
    playerId: PlayerId,
    commands: readonly Command[],
    options: { clientRequestId?: string } = {},
  ): { duplicate: boolean } {
    if (commands.length === 0) return { duplicate: false };
    const result = this.matchRuntime.submitCommands(playerId, commands, options);
    if (!result.accepted) {
      throw new Error(`CommandGateway rejected ${result.clientRequestId}: ${result.code} (${result.message})`);
    }
    return { duplicate: result.duplicate };
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
    this.stopped = true;
    this.matchRuntime.stop();
    this.stopCpuLoop();
    this.stopPlanLoop();
  }

  async quiesce(): Promise<void> {
    this.stop();
    await this.cpuRun;
  }

  private startIfReady(): void {
    if (this.started || this.stopped || !this.ready.player_1 || !this.ready.player_2) {
      return;
    }
    this.started = true;
    this.matchRuntime.start();
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
      if (this.cpuRun) return;
      const run = this.runCpuTick();
      this.cpuRun = run;
      void run.finally(() => {
        if (this.cpuRun === run) this.cpuRun = null;
      });
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
      await this.cpu.controller.run({
        playerId: this.cpu.playerId,
        tick: state.tick,
        tickIntervalMs: TICK_INTERVAL_MS,
        summary: "deterministic control-plane smoke turn",
      }, {
        traceContext: {
          turnId: `test_${this.getMatchId()}_${state.tick}`,
          controllerId: this.cpu.controller.getDescriptor().controllerId,
        },
      });
    } catch (error) {
      console.error("Control-plane CPU player error:", error);
    }
  }
}
