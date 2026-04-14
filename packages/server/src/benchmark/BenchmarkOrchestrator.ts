import {
  BuiltinCPURuntimeConfig,
  CPUStrategyType,
  GameState,
  MatchDebugOptions,
  OpenAICompatibleRuntimeConfig,
  ServerBenchmarkCompleteMessage,
  ServerBenchmarkProgressMessage,
  ServerBenchmarkRoundResult,
} from "@llmcraft/shared";
import type WebSocket from "ws";
import { GameOrchestrator, GameOrchestratorConfig } from "../GameOrchestrator";
import path from "node:path";
import { fileURLToPath } from "node:url";

type SendOnlyWebSocket = Pick<WebSocket, "send">;

type BenchmarkGameFactory = (config: GameOrchestratorConfig) => GameOrchestrator;

const EMPTY_GAME = {
  getState: (): GameState | null => null,
  getSnapshots: () => [],
};

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE_PATH);
const SERVER_PACKAGE_DIR = path.resolve(CURRENT_DIR, "..", "..");
const BENCHMARK_RECORDS_DIR = path.resolve(SERVER_PACKAGE_DIR, "logs", "benchmark-records");
const BENCHMARK_LLM_DEBUG_DIR = path.resolve(SERVER_PACKAGE_DIR, "logs", "benchmark-llm-debug");

export interface BenchmarkConfig {
  presetId: string;
  llmConfig: OpenAICompatibleRuntimeConfig;
  cpuStrategy: CPUStrategyType;
  rounds: number;
  recordReplay: boolean;
  decisionIntervalTicks?: number;
  debug?: MatchDebugOptions;
}

export class BenchmarkOrchestrator {
  private readonly rounds: ServerBenchmarkRoundResult[] = [];
  private currentOrchestrator: GameOrchestrator | null = null;
  private currentRun: Promise<void> | null = null;
  private stopRequested = false;
  private ws: SendOnlyWebSocket | null;

  constructor(
    private readonly config: BenchmarkConfig,
    ws: SendOnlyWebSocket | null,
    private readonly createGameOrchestrator: BenchmarkGameFactory = (matchConfig) => new GameOrchestrator(matchConfig)
  ) {
    this.ws = ws;
  }

  setWebSocket(ws: SendOnlyWebSocket | null): void {
    this.ws = ws;
  }

  async start(): Promise<void> {
    if (this.currentRun) {
      return;
    }
    this.stopRequested = false;
    this.currentRun = this.run()
      .catch((error) => {
        this.ws?.send(JSON.stringify({
          type: "error",
          message: `Benchmark 失败: ${error instanceof Error ? error.message : String(error)}`,
        }));
      })
      .finally(() => {
        this.currentRun = null;
      });
  }

  stop(): void {
    this.stopRequested = true;
    this.currentOrchestrator?.stop();
  }

  async saveRecord(): Promise<string> {
    if (!this.currentOrchestrator) {
      throw new Error("当前没有可保存的 benchmark 对局。");
    }
    return this.currentOrchestrator.saveRecord();
  }

  getGame() {
    return this.currentOrchestrator?.getGame() ?? EMPTY_GAME;
  }

  private async run(): Promise<void> {
    for (let index = 0; index < this.config.rounds; index++) {
      if (this.stopRequested) {
        break;
      }

      const llmSide = index % 2 === 0 ? "player_1" : "player_2";
      const cpuSide = llmSide === "player_1" ? "player_2" : "player_1";
      const cpuConfig: BuiltinCPURuntimeConfig = {
        providerType: "builtin-cpu",
        strategy: this.config.cpuStrategy,
      };
      const matchConfig: GameOrchestratorConfig = {
        player1: llmSide === "player_1" ? this.config.llmConfig : cpuConfig,
        player2: cpuSide === "player_2" ? cpuConfig : this.config.llmConfig,
        debug: this.config.debug,
        runtime: {
          aiIntervalTicksByPlayer: {
            [llmSide]: 5,
            [cpuSide]: this.config.decisionIntervalTicks ?? 5,
          },
          recordDir: BENCHMARK_RECORDS_DIR,
          transcriptDir: BENCHMARK_LLM_DEBUG_DIR,
        },
      };

      const orchestrator = this.createGameOrchestrator(matchConfig);
      this.currentOrchestrator = orchestrator;
      await orchestrator.start();
      await this.waitForRoundEnd(orchestrator);

      if (this.stopRequested) {
        break;
      }

      const game = orchestrator.getGame();
      const winner = game.getWinner();
      const durationTicks = game.getState().tick;
      let recordPath: string | undefined;
      if (this.config.recordReplay) {
        recordPath = await orchestrator.saveRecord();
      }

      const transcriptPath = orchestrator.getTranscriptFilePath() ?? undefined;
      this.rounds.push({
        round: index + 1,
        llmSide,
        winner:
          winner === null
            ? "draw"
            : winner === llmSide
              ? "llm"
              : "cpu",
        durationTicks,
        recordPath,
        transcriptPath,
      });

      this.send({
        type: "benchmark_progress",
        cpuStrategy: this.config.cpuStrategy,
        completedRounds: this.rounds.length,
        totalRounds: this.config.rounds,
        llmWins: this.rounds.filter((round) => round.winner === "llm").length,
        cpuWins: this.rounds.filter((round) => round.winner === "cpu").length,
        draws: this.rounds.filter((round) => round.winner === "draw").length,
      } satisfies ServerBenchmarkProgressMessage);
    }

    this.send(this.buildCompleteMessage());
  }

  private async waitForRoundEnd(orchestrator: GameOrchestrator): Promise<void> {
    await new Promise<void>((resolve) => {
      const poll = () => {
        const game = orchestrator.getGame();
        if (this.stopRequested || game.getWinner() || !game.isGameRunning()) {
          resolve();
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  private buildCompleteMessage(): ServerBenchmarkCompleteMessage {
    const llmWins = this.rounds.filter((round) => round.winner === "llm").length;
    const cpuWins = this.rounds.filter((round) => round.winner === "cpu").length;
    const draws = this.rounds.filter((round) => round.winner === "draw").length;
    const averageDurationTicks = this.rounds.length === 0
      ? 0
      : Math.round(this.rounds.reduce((sum, round) => sum + round.durationTicks, 0) / this.rounds.length);

    return {
      type: "benchmark_complete",
      cpuStrategy: this.config.cpuStrategy,
      presetId: this.config.presetId,
      totalRounds: this.config.rounds,
      completedRounds: this.rounds.length,
      llmWins,
      cpuWins,
      draws,
      llmWinRate: this.rounds.length === 0 ? 0 : Number(((llmWins / this.rounds.length) * 100).toFixed(1)),
      averageDurationTicks,
      stopped: this.stopRequested && this.rounds.length < this.config.rounds,
      rounds: [...this.rounds],
    };
  }

  private send(message: ServerBenchmarkProgressMessage | ServerBenchmarkCompleteMessage): void {
    this.ws?.send(JSON.stringify(message));
  }
}
