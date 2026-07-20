import {
  LOG_TYPES,
  TICK_INTERVAL_MS,
  type Command,
  type CommandEnvelope,
  type CommandEnvelopeSubmissionResult,
  type GameState,
} from "@llmcraft/shared";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Game, type GameTickResult } from "./Game";
import { createDefaultMatchDefinition, type MatchDefinition } from "./MatchDefinition";
import { CommandGateway } from "./CommandGateway";

const TICK_DURATION_WARNING_MS = 250;
const SNAPSHOT_DURATION_WARNING_MS = 100;
const PERF_WARNING_THROTTLE_MS = 2000;

export type MatchRuntimeStatus = "created" | "running" | "finished" | "stopped" | "failed";
export type TickCommittedListener = (state: GameState, result: GameTickResult) => void;
export type MatchEndedListener = (status: MatchRuntimeStatus, state: GameState) => void;

export interface ClockDriver {
  readonly running: boolean;
  start(onTick: () => void): void;
  stop(): void;
}

export class FixedIntervalClockDriver implements ClockDriver {
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly intervalMs = TICK_INTERVAL_MS) {}

  get running(): boolean {
    return this.interval !== null;
  }

  start(onTick: () => void): void {
    if (this.interval) return;
    this.interval = setInterval(onTick, this.intervalMs);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }
}

export class MatchRuntime {
  private readonly game: Game;
  private readonly clock: ClockDriver;
  private readonly definition: MatchDefinition;
  private readonly matchId: string;
  private readonly commandGateway: CommandGateway;
  private readonly nextSequenceByActor = new Map<string, number>();
  private readonly submissionScheduleByRequest = new Map<string, {
    baseTick: number;
    applyAtTick: number;
    sequence: number;
  }>();
  private readonly tickListeners = new Set<TickCommittedListener>();
  private readonly endedListeners = new Set<MatchEndedListener>();
  private status: MatchRuntimeStatus = "created";
  private endedNotified = false;
  private lastTickStartTimeMs: number | null = null;
  private lastTickLagWarningAtMs = 0;
  private lastTickDurationWarningAtMs = 0;

  constructor(options: {
    definition?: MatchDefinition;
    game?: Game;
    clock?: ClockDriver;
    matchId?: string;
  } = {}) {
    const gameDefinition = options.game?.getDefinition();
    if (
      options.definition
      && gameDefinition
      && JSON.stringify(options.definition) !== JSON.stringify(gameDefinition)
    ) {
      throw new Error("MatchRuntime definition must match the supplied Game definition.");
    }
    this.definition = gameDefinition ?? options.definition ?? createDefaultMatchDefinition();
    this.game = options.game ?? new Game(this.definition);
    this.clock = options.clock ?? new FixedIntervalClockDriver(this.definition.tickIntervalMs);
    this.matchId = options.matchId ?? `match_${randomUUID()}`;
    this.commandGateway = new CommandGateway({
      matchId: this.matchId,
      getCurrentTick: () => this.game.getTick(),
    });
  }

  getGame(): Game {
    return this.game;
  }

  getDefinition(): MatchDefinition {
    return structuredClone(this.definition);
  }

  getMatchId(): string {
    return this.matchId;
  }

  getStatus(): MatchRuntimeStatus {
    return this.status;
  }

  onTickCommitted(listener: TickCommittedListener): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  onEnded(listener: MatchEndedListener): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  waitForEnd(): Promise<{ status: MatchRuntimeStatus; state: GameState }> {
    if (this.endedNotified) {
      return Promise.resolve({ status: this.status, state: this.game.getState() });
    }
    return new Promise((resolve) => {
      const unsubscribe = this.onEnded((status, state) => {
        unsubscribe();
        resolve({ status, state });
      });
    });
  }

  submitEnvelope(envelope: CommandEnvelope): CommandEnvelopeSubmissionResult {
    return this.commandGateway.submit(envelope);
  }

  submitCommands(
    actorId: string,
    commands: readonly Command[],
    options: { clientRequestId?: string; applyAtTick?: number; sequence?: number } = {},
  ): CommandEnvelopeSubmissionResult {
    const explicitRequestKey = options.clientRequestId
      ? `${actorId}\u0000${options.clientRequestId}`
      : null;
    const previousSchedule = explicitRequestKey
      ? this.submissionScheduleByRequest.get(explicitRequestKey)
      : undefined;
    const sequence = options.sequence
      ?? previousSchedule?.sequence
      ?? ((this.nextSequenceByActor.get(actorId) ?? 0) + 1);
    this.nextSequenceByActor.set(actorId, Math.max(sequence, this.nextSequenceByActor.get(actorId) ?? 0));
    const clientRequestId = options.clientRequestId
      ?? (commands.length === 1 ? commands[0].id : `batch_${actorId}_${sequence}_${commands.map((command) => command.id).join("_")}`);
    const requestKey = `${actorId}\u0000${clientRequestId}`;
    const schedule = this.submissionScheduleByRequest.get(requestKey) ?? {
      baseTick: this.game.getTick(),
      applyAtTick: options.applyAtTick ?? this.game.getTick() + 1,
      sequence,
    };
    const result = this.submitEnvelope({
      matchId: this.matchId,
      actorId,
      baseTick: schedule.baseTick,
      applyAtTick: schedule.applyAtTick,
      sequence: schedule.sequence,
      clientRequestId,
      commands: structuredClone([...commands]),
    });
    if (result.accepted) this.submissionScheduleByRequest.set(requestKey, schedule);
    return result;
  }

  get running(): boolean {
    return this.clock.running;
  }

  start(): void {
    if (this.clock.running) return;
    this.game.start();
    this.status = "running";
    this.endedNotified = false;
    this.lastTickStartTimeMs = null;
    this.clock.start(() => this.runTick());
  }

  stop(): void {
    this.clock.stop();
    this.game.stop();
    if (this.status !== "failed") {
      this.status = this.game.getWinner() ? "finished" : "stopped";
    }
    this.lastTickStartTimeMs = null;
    this.notifyEnded();
  }

  /** Synchronous driver for tests and non-wall-clock runners. */
  advanceOneTick(): void {
    this.runTick();
  }

  private runTick(): void {
    if (!this.game.isGameRunning()) return;
    const tickStartedAt = performance.now();
    this.recordIntervalLag(tickStartedAt);
    const targetTick = this.game.getTick() + 1;
    const releasedEnvelopes = this.commandGateway.takeForTick(targetTick);
    let result: GameTickResult | null = null;

    try {
      result = this.game.advanceSimulationTick(releasedEnvelopes.map((envelope) => ({
        actorId: envelope.actorId,
        commands: envelope.commands,
      })));
    } catch (error) {
      this.handleSimulationFailure(targetTick, error);
    } finally {
      const snapshotStartedAt = performance.now();
      this.game.captureSimulationSnapshot();
      this.recordTickDuration(tickStartedAt, performance.now() - snapshotStartedAt);
    }

    if (result) {
      const state = this.game.getState();
      for (const listener of this.tickListeners) {
        try {
          listener(structuredClone(state), result);
        } catch (error) {
          console.error("Tick listener failed:", error);
        }
      }
    }

    if (!this.game.isGameRunning()) {
      this.clock.stop();
      this.lastTickStartTimeMs = null;
      if (this.status !== "failed") {
        this.status = this.game.getWinner() ? "finished" : "stopped";
      }
      this.notifyEnded();
    }
  }

  private handleSimulationFailure(targetTick: number, error: unknown): void {
    this.game.addLog(LOG_TYPES.TICK_ERROR, "Tick update crashed", {
      error: error instanceof Error ? error.message : String(error),
      attemptedTick: targetTick,
    });
    console.error("Tick 更新异常:", error);
    this.status = "failed";
    this.game.stop();
  }

  private notifyEnded(): void {
    if (this.endedNotified) return;
    this.endedNotified = true;
    const state = this.game.getState();
    for (const listener of this.endedListeners) {
      try {
        listener(this.status, structuredClone(state));
      } catch (error) {
        console.error("Match end listener failed:", error);
      }
    }
  }

  private recordIntervalLag(tickStartedAt: number): void {
    if (this.lastTickStartTimeMs !== null) {
      const elapsedMs = tickStartedAt - this.lastTickStartTimeMs;
      const warningThresholdMs = this.definition.tickIntervalMs * 1.8;
      if (
        elapsedMs > warningThresholdMs
        && tickStartedAt - this.lastTickLagWarningAtMs > PERF_WARNING_THROTTLE_MS
      ) {
        this.lastTickLagWarningAtMs = tickStartedAt;
        this.game.addLog(
          LOG_TYPES.PERF_WARNING,
          `Tick interval lagged by ${Math.round(elapsedMs - this.definition.tickIntervalMs)}ms`,
          {
            scope: "game_tick",
            phase: "interval",
            elapsedMs: Math.round(elapsedMs),
            expectedMs: this.definition.tickIntervalMs,
            tick: this.game.getTick(),
          },
        );
      }
    }
    this.lastTickStartTimeMs = tickStartedAt;
  }

  private recordTickDuration(tickStartedAt: number, snapshotMs: number): void {
    const tickDurationMs = performance.now() - tickStartedAt;
    if (
      (tickDurationMs > TICK_DURATION_WARNING_MS || snapshotMs > SNAPSHOT_DURATION_WARNING_MS)
      && tickStartedAt - this.lastTickDurationWarningAtMs > PERF_WARNING_THROTTLE_MS
    ) {
      this.lastTickDurationWarningAtMs = tickStartedAt;
      this.game.addLog(LOG_TYPES.PERF_WARNING, `Tick work took ${Math.round(tickDurationMs)}ms`, {
        scope: "game_tick",
        phase: "work",
        elapsedMs: Math.round(tickDurationMs),
        tick: this.game.getTick(),
        details: { snapshotMs: Math.round(snapshotMs) },
      });
    }
  }
}
