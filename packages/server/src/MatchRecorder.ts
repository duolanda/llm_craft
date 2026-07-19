import type { GameState, TraceReplayMetadataV1 } from "@llmcraft/shared";
import type { MatchJournalCut } from "./MatchJournal";
import { MatchRuntime } from "./MatchRuntime";

export interface MatchRecordContext {
  startedAt: string;
  aiIntervalTicks: number;
  aiContextWindowTurns?: number;
  systemPrompt: string;
  players: TraceReplayMetadataV1["players"];
}

interface CapturedRecordCut {
  state: GameState;
  initialState: GameState;
  journalCut: MatchJournalCut;
  status: TraceReplayMetadataV1["status"];
  signature: string;
  savedAt: string;
}

/**
 * Owns stable record cuts and write serialization for every MatchRuntime user.
 * Controllers provide metadata only; they do not implement their own record path.
 */
export class MatchRecorder {
  private readonly journal;
  private readonly game;
  private writeChain: Promise<void> = Promise.resolve();
  private pendingSaves = new Map<string, Promise<string>>();
  private lastSavedSignature: string | null = null;
  private lastSavedPath: string | null = null;

  constructor(private readonly runtime: MatchRuntime) {
    this.journal = runtime.getJournal();
    this.game = runtime.getGame();
  }

  async save(context: MatchRecordContext): Promise<string> {
    const captured = this.captureCut();
    if (captured.signature === this.lastSavedSignature && this.lastSavedPath) {
      if (captured.status !== "running") {
        const cleanup = await this.journal.seal(this.lastSavedPath);
        if (!cleanup.cleaned) {
          console.warn(`Trace 已保存，但临时 journal 重试清理失败（${cleanup.directory}）: ${cleanup.error}`);
        }
      }
      return this.lastSavedPath;
    }
    const pending = this.pendingSaves.get(captured.signature);
    if (pending) return pending;

    const savePromise = this.writeChain.then(() => this.finalize(captured, context));
    this.writeChain = savePromise.then(() => undefined, () => undefined);
    this.pendingSaves.set(captured.signature, savePromise);
    try {
      return await savePromise;
    } finally {
      if (this.pendingSaves.get(captured.signature) === savePromise) {
        this.pendingSaves.delete(captured.signature);
      }
    }
  }

  private captureCut(): CapturedRecordCut {
    const state = this.game.getState();
    const journalCut = this.journal.captureCut();
    const status = this.game.getWinner()
      ? "finished"
      : this.game.isGameRunning()
        ? "running"
        : "stopped";
    return {
      state,
      initialState: this.game.getInitialSnapshot()?.state ?? state,
      journalCut,
      status,
      savedAt: new Date().toISOString(),
      signature: JSON.stringify({
        tick: state.tick,
        winner: this.game.getWinner(),
        status,
        journalCut,
      }),
    };
  }

  private async finalize(captured: CapturedRecordCut, context: MatchRecordContext): Promise<string> {
    const definition = this.runtime.getDefinition();
    const metadata: TraceReplayMetadataV1 = {
      startedAt: context.startedAt,
      savedAt: captured.savedAt,
      endedAt: captured.status === "running" ? undefined : captured.savedAt,
      status: captured.status,
      winner: captured.state.winner,
      aiIntervalTicks: context.aiIntervalTicks,
      aiContextWindowTurns: context.aiContextWindowTurns ?? this.journal.aiTurnCount,
      tickIntervalMs: definition.tickIntervalMs,
      rulesetId: definition.rulesetId,
      map: {
        width: definition.map.width,
        height: definition.map.height,
      },
      systemPrompt: context.systemPrompt,
      players: structuredClone(context.players),
    };
    const manifest = this.runtime.getTraceManifest();
    manifest.status = captured.status;
    manifest.updatedAt = captured.savedAt;
    const filePath = await this.journal.finalizeTraceV3({
      manifest,
      initialKeyframe: captured.initialState,
      finalKeyframe: captured.state,
      cut: captured.journalCut,
      replayProjection: {
        metadata,
        tickDeltas: this.journal.readReplayDeltas(captured.journalCut.replayDeltas),
        commandResults: this.journal.readProjectedCommandResults(captured.journalCut.domainEvents),
      },
    });
    if (captured.status !== "running") {
      const cleanup = await this.journal.seal(filePath);
      if (!cleanup.cleaned) {
        console.warn(`Trace 已保存，但临时 journal 清理失败（${cleanup.directory}）: ${cleanup.error}`);
      }
    }
    this.lastSavedSignature = captured.signature;
    this.lastSavedPath = filePath;
    return filePath;
  }
}
