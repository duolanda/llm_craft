import {
  CPUStrategyType,
  PlayerId,
  PLAYER_IDS,
  type Command,
  type MatchRecordingOptions,
} from "@llmcraft/shared";
import { Game } from "../Game";
import { GameplayController } from "../controller/GameplayController";
import { BuiltinCPUController } from "../controller/BuiltinCPUController";
import { MatchRuntime } from "../MatchRuntime";
import { MatchRecorder } from "../MatchRecorder";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONTROL_RECORDS_DIR = path.resolve(CURRENT_DIR, "..", "..", "logs", "records");

export interface ControlLobbyStatus {
  status: "waiting_for_players" | "running" | "finished" | "stopped";
  ready: { player_1: boolean; player_2: boolean };
}

export class ControlPlaneMatch {
  private readonly matchRuntime: MatchRuntime;
  private readonly game: Game;
  private readonly recorder: MatchRecorder;
  private readonly startedAt = new Date().toISOString();
  private readonly gameplayControllerByPlayer: Record<PlayerId, GameplayController>;
  private readonly ready = { player_1: false, player_2: false };
  private started = false;
  private stopped = false;
  private cpuRun: Promise<void> | null = null;
  private readonly recording: MatchRecordingOptions;
  private unsubscribeTick: (() => void) | null = null;
  private readonly cpu:
    | {
        playerId: PlayerId;
        strategy: CPUStrategyType;
        controller: BuiltinCPUController;
      }
    | null;

  constructor(options?: {
    cpuStrategy?: CPUStrategyType;
    recordDir?: string;
    matchId?: string;
    recording?: MatchRecordingOptions;
  }) {
    this.matchRuntime = new MatchRuntime({
      matchId: options?.matchId,
    });
    this.game = this.matchRuntime.getGame();
    this.recorder = new MatchRecorder(
      this.matchRuntime,
      options?.recordDir ?? DEFAULT_CONTROL_RECORDS_DIR,
    );
    this.recording = options?.recording ?? { profile: "evaluation", includeTranscript: false };
    this.gameplayControllerByPlayer = {
      [PLAYER_IDS.PLAYER_1]: new GameplayController(this.game, PLAYER_IDS.PLAYER_1, {
        submitCommands: (commands, submitOptions) => this.submitCommands(PLAYER_IDS.PLAYER_1, commands, submitOptions),
      }),
      [PLAYER_IDS.PLAYER_2]: new GameplayController(this.game, PLAYER_IDS.PLAYER_2, {
        submitCommands: (commands, submitOptions) => this.submitCommands(PLAYER_IDS.PLAYER_2, commands, submitOptions),
      }),
    };
    this.cpu = options?.cpuStrategy
      ? {
          playerId: PLAYER_IDS.PLAYER_2,
          strategy: options.cpuStrategy,
          controller: new BuiltinCPUController(
            PLAYER_IDS.PLAYER_2,
            { providerType: "builtin-cpu", strategy: options.cpuStrategy },
            this.gameplayControllerByPlayer[PLAYER_IDS.PLAYER_2],
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
      recording: this.recording,
      systemPrompt: "",
      players: [
        { playerId: PLAYER_IDS.PLAYER_1, model: "external-controller" },
        {
          playerId: PLAYER_IDS.PLAYER_2,
          model: this.cpu ? `builtin-cpu:${this.cpu.strategy}` : "external-controller",
        },
      ],
      aiTurns: [],
    });
  }

  getMatchStatus(): ControlLobbyStatus["status"] {
    if (this.game.getWinner()) return "finished";
    if (this.stopped) return "stopped";
    return this.started ? "running" : "waiting_for_players";
  }

  getGameplayController(playerId: PlayerId): GameplayController {
    return this.gameplayControllerByPlayer[playerId];
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
      status: this.getMatchStatus(),
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
    this.unsubscribeTick?.();
    this.unsubscribeTick = null;
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
    this.unsubscribeTick = this.matchRuntime.onTickCommitted((state) => {
      for (const playerId of [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2]) {
        this.submitCommands(playerId, this.gameplayControllerByPlayer[playerId].handleCommittedTick());
      }
      if (!state.winner && this.cpu && !this.cpuRun) {
        const run = this.runCpuTick();
        this.cpuRun = run;
        void run.finally(() => {
          if (this.cpuRun === run) this.cpuRun = null;
        });
      }
    });
    this.matchRuntime.start();
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
      return;
    }

    try {
      const tickIntervalMs = this.matchRuntime.getDefinition().tickIntervalMs;
      await this.cpu.controller.run({
        playerId: this.cpu.playerId,
        tick: state.tick,
        tickIntervalMs,
        summary: "built-in CPU control turn",
      }, {
        runContext: {
          turnId: `cpu_${this.getMatchId()}_${state.tick}`,
          controllerId: this.cpu.controller.getDescriptor().controllerId,
        },
      });
    } catch (error) {
      console.error("Control-plane CPU player error:", error);
    }
  }
}
