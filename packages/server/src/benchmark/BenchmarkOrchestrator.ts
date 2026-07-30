import {
  BuiltinCPURuntimeConfig,
  CPUStrategyType,
  DEFAULT_CPU_DECISION_INTERVAL_TICKS,
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
import { randomUUID } from "node:crypto";
import type { MatchRegistry } from "../MatchRegistry";
import {
  BenchmarkRunner,
  createPairedBenchmarkTrials,
  percentile,
  wilsonInterval,
} from "./BenchmarkRunner";
import { createDefaultMatchDefinition } from "../MatchDefinition";

type SendOnlyWebSocket = Pick<WebSocket, "send">;

type BenchmarkGameFactory = (config: GameOrchestratorConfig) => GameOrchestrator;
const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE_PATH);
const SERVER_PACKAGE_DIR = path.resolve(CURRENT_DIR, "..", "..");
const BENCHMARK_RECORDS_DIR = path.resolve(SERVER_PACKAGE_DIR, "logs", "benchmark-records");

export interface BenchmarkConfig {
  presetId: string;
  llmConfig: OpenAICompatibleRuntimeConfig;
  cpuStrategy: CPUStrategyType;
  rounds: number;
  recordReplay: boolean;
  decisionIntervalTicks?: number;
  concurrency?: number;
  debug?: MatchDebugOptions;
}

export class BenchmarkOrchestrator {
  private readonly rounds: ServerBenchmarkRoundResult[] = [];
  private readonly activeRounds = new Map<number, GameOrchestrator>();
  private currentRun: Promise<void> | null = null;
  private stopRequested = false;
  private ws: SendOnlyWebSocket | null;
  private readonly benchmarkId = `benchmark_${randomUUID()}`;

  constructor(
    private readonly config: BenchmarkConfig,
    ws: SendOnlyWebSocket | null,
    private readonly createGameOrchestrator: BenchmarkGameFactory = (matchConfig) => new GameOrchestrator(matchConfig),
    private readonly matchRegistry?: MatchRegistry,
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
    for (const orchestrator of this.activeRounds.values()) {
      orchestrator.stop();
    }
  }

  private async run(): Promise<void> {
    const trials = createPairedBenchmarkTrials(this.config.rounds);
    await new BenchmarkRunner(
      trials,
      Math.min(this.config.rounds, this.config.concurrency ?? 1),
      (trial) => this.runRound(trial.round, trial.llmSide),
      () => this.stopRequested,
    ).run();

    this.send(this.buildCompleteMessage());
  }

  private async runRound(roundNumber: number, llmSide: "player_1" | "player_2"): Promise<ServerBenchmarkRoundResult | null> {
    const cpuSide = llmSide === "player_1" ? "player_2" : "player_1";
    const cpuConfig: BuiltinCPURuntimeConfig = {
      providerType: "builtin-cpu",
      strategy: this.config.cpuStrategy,
    };
    const matchConfig: GameOrchestratorConfig = {
      player1: llmSide === "player_1" ? this.config.llmConfig : cpuConfig,
      player2: cpuSide === "player_2" ? cpuConfig : this.config.llmConfig,
      debug: {
        recordingProfile: this.config.recordReplay ? "evaluation" : "off",
        includeTranscript: this.config.debug?.includeTranscript ?? false,
      },
      runtime: {
        matchDefinition: createDefaultMatchDefinition(),
        decisionIntervalTicks: this.config.decisionIntervalTicks
          ?? DEFAULT_CPU_DECISION_INTERVAL_TICKS,
        recordDir: BENCHMARK_RECORDS_DIR,
      },
    };

    const orchestrator = this.createGameOrchestrator(matchConfig);
    this.matchRegistry?.register(orchestrator, {
      kind: "benchmark",
      parentId: this.benchmarkId,
      label: `Benchmark round ${roundNumber}`,
      terminalPolicy: this.config.recordReplay ? "save" : "none",
    });
    this.activeRounds.set(roundNumber, orchestrator);
    this.sendProgress();
    let completed = false;
    try {
      await orchestrator.start();
      await orchestrator.waitForEnd();

      if (this.stopRequested) {
        return null;
      }

      const game = orchestrator.getGame();
      const winner = game.getWinner();
      const durationTicks = game.getState().tick;
      if (typeof orchestrator.quiesce === "function") await orchestrator.quiesce();
      else orchestrator.stop();
      let recordPath: string | undefined;
      if (this.config.recordReplay) {
        recordPath = await orchestrator.saveRecord();
      }

      const roundResult: ServerBenchmarkRoundResult = {
        round: roundNumber,
        llmSide,
        winner:
          winner === null
            ? "draw"
            : winner === llmSide
              ? "llm"
              : "cpu",
        durationTicks,
        recordPath,
      };
      this.rounds.push(roundResult);
      completed = true;
      return roundResult;
    } finally {
      this.activeRounds.delete(roundNumber);
      if (completed && !this.stopRequested) {
        this.sendProgress();
      }
    }
    return null;
  }

  private sendProgress(): void {
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

  private buildCompleteMessage(): ServerBenchmarkCompleteMessage {
    const llmWins = this.rounds.filter((round) => round.winner === "llm").length;
    const cpuWins = this.rounds.filter((round) => round.winner === "cpu").length;
    const draws = this.rounds.filter((round) => round.winner === "draw").length;
    const averageDurationTicks = this.rounds.length === 0
      ? 0
      : Math.round(this.rounds.reduce((sum, round) => sum + round.durationTicks, 0) / this.rounds.length);
    const durations = this.rounds.map((round) => round.durationTicks);
    const p1Rounds = this.rounds.filter((round) => round.llmSide === "player_1");
    const p2Rounds = this.rounds.filter((round) => round.llmSide === "player_2");
    const p1WinRate = p1Rounds.length === 0 ? 0 : p1Rounds.filter((round) => round.winner === "llm").length / p1Rounds.length;
    const p2WinRate = p2Rounds.length === 0 ? 0 : p2Rounds.filter((round) => round.winner === "llm").length / p2Rounds.length;

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
      medianDurationTicks: percentile(durations, 0.5),
      p90DurationTicks: percentile(durations, 0.9),
      llmWinRateConfidence95: wilsonInterval(llmWins, this.rounds.length),
      positionBias: p1Rounds.length === 0 || p2Rounds.length === 0 ? 0 : p1WinRate - p2WinRate,
      stopped: this.stopRequested && this.rounds.length < this.config.rounds,
      rounds: [...this.rounds].sort((a, b) => a.round - b.round),
    };
  }

  private send(message: ServerBenchmarkProgressMessage | ServerBenchmarkCompleteMessage): void {
    this.ws?.send(JSON.stringify(message));
  }
}
