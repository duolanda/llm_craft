import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type {
  AITerminalEvent,
  AITurnRecord,
  DomainEvent,
  GameLog,
  GameState,
  TickDeltaRecord,
  TraceCommandSubmissionRecord,
  TraceManifestV3,
  TraceReplayMetadataV1,
  TraceStateHashRecord,
} from "@llmcraft/shared";
import { projectCommandResultEventToGameLog, validateTraceManifestV3 } from "@llmcraft/trace";
import {
  getDefaultJournalLifecycleService,
  type JournalCleanupResult,
  type JournalLifecycleService,
  type JournalWorkspace,
} from "./JournalLifecycle";
import { readTraceRecordFile } from "./TraceFile";

const TRACE_GZIP_CHUNK_BYTES = 64 * 1024;

type JournalRecord<T> = {
  sequence: number;
  value: T;
};

export interface TerminalHistoryPage {
  events: AITerminalEvent[];
  hasMore: boolean;
}

export interface MatchJournalCut {
  aiTurns: number;
  terminalEvents: number;
  domainEvents: number;
  commandSubmissions: number;
  stateHashes: number;
  stateHashTick: number;
  replayDeltas: number;
  replayDeltaTick: number;
}

export interface FinalizeTraceV3Options {
  manifest: TraceManifestV3;
  initialKeyframe: GameState;
  finalKeyframe: GameState;
  replayProjection: {
    metadata: TraceReplayMetadataV1;
    tickDeltas: Iterable<TickDeltaRecord> | AsyncIterable<TickDeltaRecord>;
    commandResults: Iterable<GameLog> | AsyncIterable<GameLog>;
  };
  cut?: MatchJournalCut;
}

export class MatchJournal {
  private readonly lifecycle: JournalLifecycleService;
  private readonly workspace: JournalWorkspace;
  private readonly directory: string;
  private readonly aiTurnsPath: string;
  private readonly terminalEventsPath: string;
  private readonly domainEventsPath: string;
  private readonly commandSubmissionsPath: string;
  private readonly stateHashesPath: string;
  private readonly replayDeltasPath: string;
  private readonly traceManifestPath: string;
  private readonly recordDir: string;
  private readonly matchId: string;
  private aiTurnSequence = 0;
  private terminalEventSequence = 0;
  private domainEventSequence = 0;
  private commandSubmissionSequence = 0;
  private stateHashCount = 0;
  private lastStateHashTick = -1;
  private replayDeltaCount = 0;
  private lastReplayDeltaTick = -1;
  private recentDomainEvents: DomainEvent[] = [];
  private sealed = false;
  private sealedRecordPath: string | null = null;

  constructor(
    recordDir: string,
    sessionId: string,
    matchId = sessionId,
    lifecycle: JournalLifecycleService = getDefaultJournalLifecycleService(),
  ) {
    this.lifecycle = lifecycle;
    this.workspace = lifecycle.createWorkspace(matchId);
    this.directory = this.workspace.directory;
    this.aiTurnsPath = path.join(this.directory, "ai-turns.ndjson");
    this.terminalEventsPath = path.join(this.directory, "terminal-events.ndjson");
    this.domainEventsPath = path.join(this.directory, "domain-events.ndjson");
    this.commandSubmissionsPath = path.join(this.directory, "command-submissions.ndjson");
    this.stateHashesPath = path.join(this.directory, "state-hashes.ndjson");
    this.replayDeltasPath = path.join(this.directory, "replay-deltas.ndjson");
    this.traceManifestPath = path.join(this.directory, "manifest.json");
    this.recordDir = recordDir;
    this.matchId = matchId;
    for (const streamPath of [
      this.aiTurnsPath,
      this.terminalEventsPath,
      this.domainEventsPath,
      this.commandSubmissionsPath,
      this.stateHashesPath,
      this.replayDeltasPath,
    ]) {
      fs.writeFileSync(streamPath, "", "utf8");
    }
  }

  get aiTurnCount(): number {
    return this.aiTurnSequence;
  }

  get domainEventCount(): number {
    return this.domainEventSequence;
  }

  get stateHashRecordCount(): number {
    return this.stateHashCount;
  }

  get terminalEventCount(): number {
    return this.terminalEventSequence;
  }

  get commandSubmissionCount(): number {
    return this.commandSubmissionSequence;
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  getWorkspaceDirectory(): string {
    return this.directory;
  }

  captureCut(): MatchJournalCut {
    return {
      aiTurns: this.aiTurnSequence,
      terminalEvents: this.terminalEventSequence,
      domainEvents: this.domainEventSequence,
      commandSubmissions: this.commandSubmissionSequence,
      stateHashes: this.stateHashCount,
      stateHashTick: this.lastStateHashTick,
      replayDeltas: this.replayDeltaCount,
      replayDeltaTick: this.lastReplayDeltaTick,
    };
  }

  writeTraceManifest(manifest: TraceManifestV3): void {
    this.assertWritable();
    const temporaryPath = `${this.traceManifestPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(manifest), "utf8");
    fs.renameSync(temporaryPath, this.traceManifestPath);
  }

  async readTraceManifest(): Promise<TraceManifestV3> {
    return JSON.parse(await fsPromises.readFile(this.traceManifestPath, "utf8")) as TraceManifestV3;
  }

  appendAITurn(turn: AITurnRecord): void {
    this.assertWritable();
    this.aiTurnSequence += 1;
    this.appendRecord(this.aiTurnsPath, { sequence: this.aiTurnSequence, value: turn });
  }

  appendTerminalEvent(event: AITerminalEvent): void {
    this.assertWritable();
    this.terminalEventSequence += 1;
    this.appendRecord(this.terminalEventsPath, { sequence: this.terminalEventSequence, value: event });
  }

  appendDomainEvent<TPayload extends Record<string, unknown>>(
    event: Omit<DomainEvent<TPayload>, "eventVersion" | "matchId" | "eventSequence">,
  ): DomainEvent<TPayload> {
    this.assertWritable();
    this.domainEventSequence += 1;
    const recorded: DomainEvent<TPayload> = {
      eventVersion: 1,
      matchId: this.matchId,
      eventSequence: this.domainEventSequence,
      ...structuredClone(event),
    };
    this.appendRecord(this.domainEventsPath, { sequence: recorded.eventSequence, value: recorded });
    this.recentDomainEvents.push(recorded);
    if (this.recentDomainEvents.length > 500) {
      this.recentDomainEvents = this.recentDomainEvents.slice(-500);
    }
    return structuredClone(recorded);
  }

  appendCommandSubmission(
    record: Omit<TraceCommandSubmissionRecord, "submissionVersion" | "matchId" | "submissionSequence">,
  ): TraceCommandSubmissionRecord {
    this.assertWritable();
    this.commandSubmissionSequence += 1;
    const recorded: TraceCommandSubmissionRecord = {
      submissionVersion: 1,
      matchId: this.matchId,
      submissionSequence: this.commandSubmissionSequence,
      ...structuredClone(record),
    };
    this.appendRecord(this.commandSubmissionsPath, {
      sequence: recorded.submissionSequence,
      value: recorded,
    });
    return structuredClone(recorded);
  }

  appendStateHash(record: TraceStateHashRecord): void {
    this.assertWritable();
    if (record.tick <= this.lastStateHashTick) {
      throw new Error(`State hash tick ${record.tick} must be greater than ${this.lastStateHashTick}.`);
    }
    this.stateHashCount += 1;
    this.lastStateHashTick = record.tick;
    this.appendRecord(this.stateHashesPath, { sequence: this.stateHashCount, value: structuredClone(record) });
  }

  appendReplayDelta(delta: TickDeltaRecord): void {
    this.assertWritable();
    if (delta.tick <= this.lastReplayDeltaTick) {
      throw new Error(`Replay delta tick ${delta.tick} must be greater than ${this.lastReplayDeltaTick}.`);
    }
    this.replayDeltaCount += 1;
    this.lastReplayDeltaTick = delta.tick;
    this.appendRecord(this.replayDeltasPath, {
      sequence: this.replayDeltaCount,
      value: structuredClone(delta),
    });
  }

  getRecentDomainEvents(): DomainEvent[] {
    return structuredClone(this.recentDomainEvents);
  }

  async *readAITurns(maxSequence?: number): AsyncGenerator<AITurnRecord> {
    for await (const record of this.readRecords<AITurnRecord>(this.aiTurnsPath, maxSequence)) {
      yield record.value;
    }
  }

  async *readDomainEvents(maxSequence?: number): AsyncGenerator<DomainEvent> {
    for await (const record of this.readRecords<DomainEvent>(this.domainEventsPath, maxSequence)) {
      yield record.value;
    }
  }

  async *readProjectedCommandResults(maxSequence?: number): AsyncGenerator<GameLog> {
    for await (const event of this.readDomainEvents(maxSequence)) {
      const projected = projectCommandResultEventToGameLog(event);
      if (projected) yield projected;
    }
  }

  async *readCommandSubmissions(maxSequence?: number): AsyncGenerator<TraceCommandSubmissionRecord> {
    for await (const record of this.readRecords<TraceCommandSubmissionRecord>(this.commandSubmissionsPath, maxSequence)) {
      yield record.value;
    }
  }

  async *readTerminalEvents(maxSequence?: number): AsyncGenerator<AITerminalEvent> {
    for await (const record of this.readRecords<AITerminalEvent>(this.terminalEventsPath, maxSequence)) {
      yield record.value;
    }
  }

  async *readStateHashes(maxSequence?: number): AsyncGenerator<TraceStateHashRecord> {
    for await (const record of this.readRecords<TraceStateHashRecord>(this.stateHashesPath, maxSequence)) {
      yield record.value;
    }
  }

  async *readReplayDeltas(maxSequence?: number): AsyncGenerator<TickDeltaRecord> {
    for await (const record of this.readRecords<TickDeltaRecord>(this.replayDeltasPath, maxSequence)) {
      yield record.value;
    }
  }

  async readTerminalHistory(beforeSequence?: number, limit = 100): Promise<TerminalHistoryPage> {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    if (this.sealedRecordPath) {
      const trace = await readTraceRecordFile(this.sealedRecordPath);
      const matching = trace.terminalEvents.filter((event, index) => {
        const sequence = terminalEventSequence(event, index + 1);
        return beforeSequence === undefined || sequence < beforeSequence;
      });
      return {
        events: structuredClone(matching.slice(-boundedLimit)),
        hasMore: matching.length > boundedLimit,
      };
    }
    const retained: JournalRecord<AITerminalEvent>[] = [];
    let matchingCount = 0;
    for await (const record of this.readRecords<AITerminalEvent>(this.terminalEventsPath)) {
      if (beforeSequence !== undefined && record.sequence >= beforeSequence) {
        continue;
      }
      matchingCount += 1;
      retained.push(record);
      if (retained.length > boundedLimit) {
        retained.shift();
      }
    }
    return {
      events: retained.map((record) => record.value),
      hasMore: matchingCount > retained.length,
    };
  }

  async finalizeTraceV3(options: FinalizeTraceV3Options): Promise<string> {
    this.assertWritable();
    const cut = options.cut ?? this.captureCut();
    if (cut.stateHashes < 1 || cut.stateHashTick !== options.finalKeyframe.tick) {
      throw new Error(
        `Trace cut is not aligned with final keyframe tick ${options.finalKeyframe.tick}.`,
      );
    }
    const manifest: TraceManifestV3 = {
      ...structuredClone(options.manifest),
      updatedAt: options.replayProjection.metadata.savedAt,
      status: options.manifest.status === "failed"
        ? "failed"
        : options.replayProjection.metadata.status,
      capabilities: {
        ...options.manifest.capabilities,
        replay: "complete",
      },
    };
    validateTraceManifestV3(manifest);

    await fsPromises.mkdir(this.recordDir, { recursive: true });
    const safeMatchId = this.matchId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const timestamp = options.replayProjection.metadata.savedAt.replace(/[:.]/g, "-");
    const cutSuffix = `t${options.finalKeyframe.tick}-e${cut.domainEvents}-a${cut.aiTurns}-x${cut.terminalEvents}`;
    const filePath = path.join(
      this.recordDir,
      `match-${safeMatchId}-${timestamp}-${cutSuffix}.trace.json.gz`,
    );
    const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
    const output = fs.createWriteStream(temporaryPath, { flags: "wx" });
    const gzip = createGzip({
      level: 6,
      chunkSize: TRACE_GZIP_CHUNK_BYTES,
    });
    const completion = pipeline(gzip, output);
    try {
      await this.writeChunk(gzip, `{"schemaVersion":3,"manifest":${JSON.stringify(manifest)}`);
      await this.writeChunk(gzip, `,"initialKeyframe":${JSON.stringify(options.initialKeyframe)}`);
      await this.writeChunk(gzip, `,"finalKeyframe":${JSON.stringify(options.finalKeyframe)}`);
      await this.writeChunk(gzip, ",\"commandSubmissions\":[");
      await this.writeJsonAsyncIterable(gzip, this.readCommandSubmissions(cut.commandSubmissions));
      await this.writeChunk(gzip, "],\"stateHashes\":[");
      await this.writeJsonAsyncIterable(gzip, this.readStateHashes(cut.stateHashes));
      await this.writeChunk(gzip, "],\"domainEvents\":[");
      await this.writeJsonAsyncIterable(gzip, this.readDomainEvents(cut.domainEvents));
      await this.writeChunk(gzip, "],\"aiTurns\":[");
      await this.writeJsonAsyncIterable(gzip, this.readAITurns(cut.aiTurns));
      await this.writeChunk(gzip, "],\"terminalEvents\":[");
      await this.writeJsonAsyncIterable(gzip, this.readTerminalEvents(cut.terminalEvents));
      await this.writeChunk(gzip, `],"replayProjection":{"projectionVersion":1,"metadata":${JSON.stringify(options.replayProjection.metadata)},"tickDeltas":[`);
      let previousTick = options.initialKeyframe.tick;
      await this.writeJsonValues(gzip, options.replayProjection.tickDeltas, (delta) => {
        if (delta.tick <= previousTick) {
          throw new Error(`Replay tick ${delta.tick} must be greater than ${previousTick}.`);
        }
        previousTick = delta.tick;
      });
      if (previousTick !== options.finalKeyframe.tick) {
        throw new Error(
          `Replay projection ended at tick ${previousTick}, expected ${options.finalKeyframe.tick}.`,
        );
      }
      await this.writeChunk(gzip, "],\"commandResults\":[");
      await this.writeJsonValues(gzip, options.replayProjection.commandResults);
      await this.writeChunk(gzip, "]}}");
      gzip.end();
      await completion;
      const handle = await fsPromises.open(temporaryPath, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsPromises.rename(temporaryPath, filePath);
      return filePath;
    } catch (error) {
      gzip.destroy(error instanceof Error ? error : new Error(String(error)));
      output.destroy();
      await completion.catch(() => undefined);
      await fsPromises.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async seal(finalizedRecordPath: string): Promise<JournalCleanupResult> {
    if (this.sealed) {
      return fs.existsSync(this.directory)
        ? this.lifecycle.sealWorkspace(this.workspace, this.sealedRecordPath ?? finalizedRecordPath)
        : { cleaned: true, directory: this.directory };
    }
    this.sealed = true;
    this.sealedRecordPath = finalizedRecordPath;
    return this.lifecycle.sealWorkspace(this.workspace, finalizedRecordPath);
  }

  async discard(): Promise<JournalCleanupResult> {
    if (this.sealed) {
      return fs.existsSync(this.directory)
        ? this.lifecycle.discardWorkspace(this.workspace)
        : { cleaned: true, directory: this.directory };
    }
    this.sealed = true;
    return this.lifecycle.discardWorkspace(this.workspace);
  }

  private appendRecord<T>(filePath: string, record: JournalRecord<T>): void {
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  private async *readRecords<T>(filePath: string, maxSequence?: number): AsyncGenerator<JournalRecord<T>> {
    try {
      await fsPromises.access(filePath);
    } catch {
      return;
    }
    const input = fs.createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim()) {
        const record = JSON.parse(line) as JournalRecord<T>;
        if (maxSequence !== undefined && record.sequence > maxSequence) break;
        yield record;
      }
    }
  }

  private async writeJsonIterable<T>(
    output: Writable,
    values: Iterable<T>,
    validate?: (value: T) => void,
  ): Promise<void> {
    let first = true;
    for (const value of values) {
      validate?.(value);
      await this.writeChunk(output, `${first ? "" : ","}${JSON.stringify(value)}`);
      first = false;
    }
  }

  private async writeJsonAsyncIterable(
    output: Writable,
    values: AsyncIterable<unknown>,
  ): Promise<void> {
    let first = true;
    for await (const value of values) {
      await this.writeChunk(output, `${first ? "" : ","}${JSON.stringify(value)}`);
      first = false;
    }
  }

  private async writeJsonValues<T>(
    output: Writable,
    values: Iterable<T> | AsyncIterable<T>,
    validate?: (value: T) => void,
  ): Promise<void> {
    if (Symbol.asyncIterator in Object(values)) {
      let first = true;
      for await (const value of values as AsyncIterable<T>) {
        validate?.(value);
        await this.writeChunk(output, `${first ? "" : ","}${JSON.stringify(value)}`);
        first = false;
      }
      return;
    }
    await this.writeJsonIterable(output, values as Iterable<T>, validate);
  }

  private async writeChunk(output: Writable, chunk: string): Promise<void> {
    if (!output.write(chunk, "utf8")) await once(output, "drain");
  }

  private assertWritable(): void {
    if (this.sealed) {
      throw new Error(`Match journal ${this.matchId} is sealed.`);
    }
  }
}

function terminalEventSequence(event: AITerminalEvent, fallback: number): number {
  const sequence = Number(event.id.replace(/^evt_/, ""));
  return Number.isFinite(sequence) && sequence > 0 ? sequence : fallback;
}
