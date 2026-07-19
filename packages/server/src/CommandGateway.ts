import {
  PLAYER_IDS,
  type Command,
  type CommandEnvelope,
  type CommandEnvelopeSubmissionResult,
} from "@llmcraft/shared";
import { DEFAULT_COMMAND_BUDGET_POLICY } from "./CommandBudget";
/*
 * Keep the gateway independent from Game and MatchRuntime. The only live input
 * is the authoritative tick accessor supplied by the owning runtime.
 */
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_FUTURE_TICKS = 100;

export interface CommandGatewayOptions {
  matchId: string;
  getCurrentTick: () => number;
  authorize?: (actorId: string, command: Command) => boolean;
  maxBatchSize?: number;
  maxFutureTicks?: number;
  maxCommandsPerActorPerTick?: number;
}

type StoredSubmission = {
  fingerprint: string;
  result: Extract<CommandEnvelopeSubmissionResult, { accepted: true }>;
};

/**
 * Deterministic, versioned admission queue for all match commands.
 *
 * It validates and accepts an entire envelope or rejects the entire envelope,
 * remembers clientRequestId for idempotent retry, and releases accepted batches
 * only at their declared simulation tick in a public deterministic order.
 */
export class CommandGateway {
  private readonly matchId: string;
  private readonly getCurrentTick: () => number;
  private readonly authorize: (actorId: string, command: Command) => boolean;
  private readonly maxBatchSize: number;
  private readonly maxFutureTicks: number;
  private readonly maxCommandsPerActorPerTick: number;
  private readonly pendingByTick = new Map<number, CommandEnvelope[]>();
  private readonly submissions = new Map<string, StoredSubmission>();
  private readonly acceptedCommandIds = new Set<string>();

  constructor(options: CommandGatewayOptions) {
    if (!options.matchId.trim()) throw new Error("CommandGateway matchId is required.");
    this.matchId = options.matchId;
    this.getCurrentTick = options.getCurrentTick;
    this.authorize = options.authorize ?? ((actorId, command) =>
      (command.playerId === PLAYER_IDS.PLAYER_1 || command.playerId === PLAYER_IDS.PLAYER_2)
      && actorId === command.playerId
    );
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxFutureTicks = options.maxFutureTicks ?? DEFAULT_MAX_FUTURE_TICKS;
    this.maxCommandsPerActorPerTick = options.maxCommandsPerActorPerTick
      ?? DEFAULT_COMMAND_BUDGET_POLICY.maxCommandsPerActorPerTick;
  }

  submit(envelope: CommandEnvelope): CommandEnvelopeSubmissionResult {
    const clientRequestId = typeof envelope?.clientRequestId === "string" ? envelope.clientRequestId : "";
    const fingerprint = this.fingerprint(envelope);
    const previous = this.submissions.get(clientRequestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return this.reject(clientRequestId, "idempotency_conflict", "clientRequestId was already used for a different envelope.");
      }
      return { ...previous.result, duplicate: true };
    }

    const rejection = this.validate(envelope);
    if (rejection) return rejection;

    const accepted: Extract<CommandEnvelopeSubmissionResult, { accepted: true }> = {
      accepted: true,
      duplicate: false,
      matchId: this.matchId,
      clientRequestId,
      applyAtTick: envelope.applyAtTick,
    };
    const storedEnvelope = structuredClone(envelope);
    const pending = this.pendingByTick.get(envelope.applyAtTick) ?? [];
    pending.push(storedEnvelope);
    this.pendingByTick.set(envelope.applyAtTick, pending);
    this.submissions.set(clientRequestId, { fingerprint, result: accepted });
    for (const command of storedEnvelope.commands) this.acceptedCommandIds.add(command.id);
    return accepted;
  }

  takeForTick(tick: number): CommandEnvelope[] {
    const pending = this.pendingByTick.get(tick) ?? [];
    this.pendingByTick.delete(tick);
    return pending
      .sort((left, right) =>
        left.actorId.localeCompare(right.actorId)
        || left.sequence - right.sequence
        || left.clientRequestId.localeCompare(right.clientRequestId)
      )
      .map((envelope) => structuredClone(envelope));
  }

  private validate(envelope: CommandEnvelope): CommandEnvelopeSubmissionResult | null {
    const clientRequestId = typeof envelope?.clientRequestId === "string" ? envelope.clientRequestId : "";
    if (
      envelope?.envelopeVersion !== 1
      || !clientRequestId.trim()
      || typeof envelope.actorId !== "string"
      || !envelope.actorId.trim()
      || !Number.isSafeInteger(envelope.baseTick)
      || !Number.isSafeInteger(envelope.applyAtTick)
      || !Number.isSafeInteger(envelope.sequence)
      || envelope.sequence < 0
      || !Array.isArray(envelope.commands)
      || envelope.commands.length === 0
    ) {
      return this.reject(clientRequestId, "invalid_envelope", "Envelope fields are missing or invalid.");
    }
    if (envelope.matchId !== this.matchId) {
      return this.reject(clientRequestId, "wrong_match", `Envelope targets ${envelope.matchId}, expected ${this.matchId}.`);
    }
    if (envelope.commands.length > this.maxBatchSize) {
      return this.reject(clientRequestId, "batch_too_large", `Envelope exceeds ${this.maxBatchSize} commands.`);
    }
    const acceptedForActorAtTick = (this.pendingByTick.get(envelope.applyAtTick) ?? [])
      .filter((pending) => pending.actorId === envelope.actorId)
      .reduce((count, pending) => count + pending.commands.length, 0);
    if (acceptedForActorAtTick + envelope.commands.length > this.maxCommandsPerActorPerTick) {
      return this.reject(
        clientRequestId,
        "tick_command_budget_exceeded",
        `Actor ${envelope.actorId} exceeds ${this.maxCommandsPerActorPerTick} commands at tick ${envelope.applyAtTick}.`,
      );
    }

    const currentTick = this.getCurrentTick();
    if (
      envelope.baseTick > currentTick
      || envelope.baseTick < 0
      || envelope.applyAtTick <= currentTick
      || envelope.applyAtTick > currentTick + this.maxFutureTicks
    ) {
      return this.reject(clientRequestId, "invalid_tick", `Envelope cannot apply at tick ${envelope.applyAtTick} from tick ${currentTick}.`);
    }

    const commandIds = new Set<string>();
    for (const command of envelope.commands) {
      if (
        !command
        || typeof command.id !== "string"
        || !command.id.trim()
        || typeof command.type !== "string"
        || !command.type.trim()
        || commandIds.has(command.id)
      ) {
        return this.reject(clientRequestId, "invalid_envelope", "Every command must have a unique non-empty id and type.");
      }
      commandIds.add(command.id);
      if (this.acceptedCommandIds.has(command.id)) {
        return this.reject(clientRequestId, "duplicate_command_id", `Command id ${command.id} was already accepted in this match.`);
      }
      if (!this.authorize(envelope.actorId, command)) {
        return this.reject(clientRequestId, "unauthorized_actor", `Actor ${envelope.actorId} cannot command ${command.playerId}.`);
      }
    }
    return null;
  }

  private reject(
    clientRequestId: string,
    code: Extract<CommandEnvelopeSubmissionResult, { accepted: false }>["code"],
    message: string,
  ): Extract<CommandEnvelopeSubmissionResult, { accepted: false }> {
    return {
      accepted: false,
      duplicate: false,
      matchId: this.matchId,
      clientRequestId,
      code,
      message,
    };
  }

  private fingerprint(envelope: CommandEnvelope): string {
    try {
      return JSON.stringify(this.canonicalize(envelope));
    } catch {
      return "<unserializable>";
    }
  }

  private canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.canonicalize(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, this.canonicalize(item)]),
    );
  }
}
