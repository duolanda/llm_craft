import {
  LOG_TYPES,
  TICK_INTERVAL_MS,
  type Command,
  type CommandEnvelope,
  type CommandEnvelopeSubmissionResult,
  type DomainEvent,
  type TraceManifestV3,
  type TraceStateHashRecord,
} from "@llmcraft/shared";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Game, type CommandExecutionOutcome, type GameTickResult } from "./Game";
import { createDefaultMatchDefinition, type MatchDefinition } from "./MatchDefinition";
import { CommandGateway } from "./CommandGateway";
import { MatchJournal } from "./MatchJournal";
import type { SimulationEvent } from "./SimulationCore";
import { hashAuthoritativeStateV2 } from "./AuthoritativeStateHash";
import { createTraceManifestV3 } from "@llmcraft/trace";
import type { JournalLifecycleService } from "./JournalLifecycle";
import { resolveCommandBudgetPolicy } from "./CommandBudget";

const TICK_DURATION_WARNING_MS = 250;
const SNAPSHOT_DURATION_WARNING_MS = 100;
const PERF_WARNING_THROTTLE_MS = 2000;

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
    if (this.interval) {
      return;
    }
    this.interval = setInterval(onTick, this.intervalMs);
  }

  stop(): void {
    if (!this.interval) {
      return;
    }
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
  private readonly journal: MatchJournal;
  private traceManifest: TraceManifestV3;
  private readonly nextSequenceByActor = new Map<string, number>();
  private readonly submissionScheduleByRequest = new Map<string, {
    baseTick: number;
    applyAtTick: number;
    sequence: number;
  }>();
  private readonly commandContextById = new Map<string, { actorId: string; clientRequestId: string }>();
  private lastTickStartTimeMs: number | null = null;
  private lastTickLagWarningAtMs = 0;
  private lastTickDurationWarningAtMs = 0;

  constructor(options: {
    definition?: MatchDefinition;
    game?: Game;
    clock?: ClockDriver;
    matchId?: string;
    recordDir?: string;
    journalLifecycle?: JournalLifecycleService;
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
    const commandBudget = resolveCommandBudgetPolicy(this.definition);
    this.commandGateway = new CommandGateway({
      matchId: this.matchId,
      getCurrentTick: () => this.game.getTick(),
      maxBatchSize: commandBudget.maxCommandsPerActorPerTick,
      maxCommandsPerActorPerTick: commandBudget.maxCommandsPerActorPerTick,
    });
    this.journal = new MatchJournal(
      options.recordDir ?? "",
      this.matchId,
      this.matchId,
      options.journalLifecycle,
    );
    this.traceManifest = createTraceManifestV3(this.matchId, this.definition);
    this.journal.writeTraceManifest(this.traceManifest);
    this.journal.appendStateHash(hashAuthoritativeStateV2(
      this.game.getState(),
      this.game.getDeterministicRngState(),
    ));
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

  getJournal(): MatchJournal {
    return this.journal;
  }

  getTraceManifest(): TraceManifestV3 {
    return structuredClone(this.traceManifest);
  }

  readStateHashes(): AsyncGenerator<TraceStateHashRecord> {
    return this.journal.readStateHashes();
  }

  getRecentDomainEvents(): DomainEvent[] {
    return this.journal.getRecentDomainEvents();
  }

  readDomainEvents(): AsyncGenerator<DomainEvent> {
    return this.journal.readDomainEvents();
  }

  submitEnvelope(envelope: CommandEnvelope): CommandEnvelopeSubmissionResult {
    const result = this.commandGateway.submit(envelope);
    this.journal.appendCommandSubmission({
      receivedAtTick: this.game.getTick(),
      envelope,
      result,
    });
    const eventType = result.accepted
      ? result.duplicate ? "command_envelope_duplicate" : "command_envelope_accepted"
      : "command_envelope_rejected";
    this.appendDomainEvent({
      tick: this.game.getTick(),
      type: eventType,
      ...(typeof envelope?.actorId === "string" && envelope.actorId ? { actorId: envelope.actorId } : {}),
      payload: {
        clientRequestId: result.clientRequestId,
        targetMatchId: envelope?.matchId,
        baseTick: envelope?.baseTick,
        applyAtTick: result.accepted ? result.applyAtTick : envelope?.applyAtTick,
        sequence: envelope?.sequence,
        commandIds: Array.isArray(envelope?.commands) ? envelope.commands.map((command) => command.id) : [],
        ...(result.accepted ? { duplicate: result.duplicate } : { code: result.code, message: result.message }),
      },
    });
    if (result.accepted && !result.duplicate) {
      for (const command of envelope.commands) {
        this.commandContextById.set(command.id, {
          actorId: envelope.actorId,
          clientRequestId: envelope.clientRequestId,
        });
      }
    }
    return result;
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
      envelopeVersion: 1,
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
    if (this.clock.running) {
      return;
    }
    this.game.start();
    this.updateTraceStatus("running");
    this.lastTickStartTimeMs = null;
    this.clock.start(() => this.runTick());
  }

  stop(): void {
    this.clock.stop();
    this.game.stop();
    this.updateTraceStatus(this.game.getWinner() ? "finished" : "stopped");
    this.lastTickStartTimeMs = null;
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

    let traceWriteFailed = false;
    try {
      let result: GameTickResult | null = null;
      try {
        result = this.game.advanceSimulationTick(releasedEnvelopes.map((envelope) => ({
          actorId: envelope.actorId,
          commands: envelope.commands,
        })));
      } catch (error) {
        this.handleSimulationFailure(releasedEnvelopes, targetTick, error);
      }

      if (result) {
        try {
          this.recordSuccessfulTick(releasedEnvelopes, result);
          this.journal.appendStateHash(hashAuthoritativeStateV2(
            this.game.getState(),
            this.game.getDeterministicRngState(),
          ));
        } catch (error) {
          traceWriteFailed = true;
          this.handleTraceJournalFailure(result.simulation.tick, error);
        }
      }
    } finally {
      const snapshotStartedAt = performance.now();
      const delta = this.game.captureSimulationSnapshot();
      if (delta && !traceWriteFailed) {
        try {
          this.journal.appendReplayDelta(delta);
          this.game.discardRecordedTickDeltas();
        } catch (error) {
          this.handleTraceJournalFailure(delta.tick, error);
        }
      }
      const snapshotMs = performance.now() - snapshotStartedAt;
      this.recordTickDuration(tickStartedAt, snapshotMs);
    }

    if (!this.game.isGameRunning()) {
      this.clock.stop();
      this.lastTickStartTimeMs = null;
      if (this.traceManifest.status !== "failed") {
        this.updateTraceStatus(this.game.getWinner() ? "finished" : "stopped");
      }
    }
  }

  private handleSimulationFailure(
    releasedEnvelopes: readonly CommandEnvelope[],
    targetTick: number,
    error: unknown,
  ): void {
    try {
      for (const envelope of releasedEnvelopes) {
        this.appendDomainEvent({
          tick: targetTick,
          type: "command_envelope_rolled_back",
          actorId: envelope.actorId,
          payload: {
            clientRequestId: envelope.clientRequestId,
            commandIds: envelope.commands.map((command) => command.id),
          },
        });
      }
      this.appendDomainEvent({
        tick: this.game.getTick(),
        type: "simulation_tick_failed",
        payload: { error: error instanceof Error ? error.message : String(error), attemptedTick: targetTick },
      });
    } catch (journalError) {
      console.error("Simulation 失败后无法写入 Trace Journal:", journalError);
    }
    this.game.addLog(LOG_TYPES.TICK_ERROR, "Tick update crashed and was rolled back", {
      error: error instanceof Error ? error.message : String(error),
      attemptedTick: targetTick,
      committed: false,
    });
    console.error("Tick 更新异常:", error);
    this.game.stop();
    this.tryUpdateTraceStatus("failed");
  }

  private handleTraceJournalFailure(committedTick: number, error: unknown): void {
    this.game.addLog(LOG_TYPES.TICK_ERROR, "Trace journal failed after tick commit", {
      error: error instanceof Error ? error.message : String(error),
      committedTick,
      committed: true,
    });
    console.error("Trace Journal 写入异常，已停止对局:", error);
    this.game.stop();
    this.tryUpdateTraceStatus("failed");
  }

  private recordSuccessfulTick(envelopes: readonly CommandEnvelope[], result: GameTickResult): void {
    for (const [index, envelope] of envelopes.entries()) {
      const batchResult = result.commandBatchResults[index];
      this.appendDomainEvent({
        tick: result.simulation.tick,
        type: "command_envelope_released",
        actorId: envelope.actorId,
        payload: {
          clientRequestId: envelope.clientRequestId,
          baseTick: envelope.baseTick,
          applyAtTick: envelope.applyAtTick,
          sequence: envelope.sequence,
          commandIds: envelope.commands.map((command) => command.id),
          committed: batchResult?.committed ?? false,
        },
      });
      if (batchResult && !batchResult.committed) {
        this.appendDomainEvent({
          tick: result.simulation.tick,
          type: "command_envelope_rolled_back",
          actorId: envelope.actorId,
          payload: {
            clientRequestId: envelope.clientRequestId,
            commandIds: envelope.commands.map((command) => command.id),
            reason: batchResult.failureReason,
            failedCommandId: batchResult.failedCommandId,
          },
        });
      }
    }
    for (const outcome of result.commandOutcomes) this.recordCommandOutcome(outcome);
    for (const event of result.simulation.events) this.recordSimulationEvent(result.simulation.tick, event);
  }

  private recordCommandOutcome(outcome: CommandExecutionOutcome): void {
    const context = this.commandContextById.get(outcome.command.id);
    if (context) this.commandContextById.delete(outcome.command.id);
    const entityIds = [outcome.command.unitId, outcome.command.buildingId, outcome.command.targetId]
      .filter((id): id is string => Boolean(id));
    this.appendDomainEvent({
      tick: outcome.tick,
      type: "command_result",
      actorId: context?.actorId ?? outcome.command.playerId,
      commandId: outcome.command.id,
      ...(entityIds.length > 0 ? { entityIds: [...new Set(entityIds)] } : {}),
      payload: {
        clientRequestId: context?.clientRequestId,
        command: outcome.command,
        resultCode: outcome.resultCode,
        resultType: outcome.resultType,
        resultData: outcome.resultData,
        success: outcome.success,
      },
    });
  }

  private recordSimulationEvent(tick: number, event: SimulationEvent): void {
    const { type, ...payload } = event;
    const candidateIds = [
      "unitId" in event ? event.unitId : undefined,
      "buildingId" in event ? event.buildingId : undefined,
      "workerId" in event ? event.workerId : undefined,
    ].filter((id): id is string => Boolean(id));
    const playerId = "playerId" in event ? event.playerId : undefined;
    this.appendDomainEvent({
      tick,
      type,
      ...(playerId ? { actorId: playerId } : {}),
      ...(candidateIds.length > 0 ? { entityIds: [...new Set(candidateIds)] } : {}),
      payload,
    });
  }

  private appendDomainEvent(event: Omit<DomainEvent<Record<string, unknown>>, "eventVersion" | "matchId" | "eventSequence">): void {
    this.journal.appendDomainEvent(event);
  }

  private updateTraceStatus(status: TraceManifestV3["status"]): void {
    if (this.traceManifest.status === status) return;
    this.traceManifest = {
      ...this.traceManifest,
      status,
      updatedAt: new Date().toISOString(),
    };
    this.journal.writeTraceManifest(this.traceManifest);
  }

  private tryUpdateTraceStatus(status: TraceManifestV3["status"]): void {
    try {
      this.updateTraceStatus(status);
    } catch (error) {
      console.error(`无法将 Trace manifest 更新为 ${status}:`, error);
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
        details: {
          snapshotMs: Math.round(snapshotMs),
        },
      });
    }
  }
}
