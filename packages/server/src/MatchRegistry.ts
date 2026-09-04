import type {
  AITerminalEvent,
  GameLogDataMap,
  GameSnapshot,
  GameState,
  LiveMatchSetupSnapshot,
  LOG_TYPES,
  MatchRegistryKind,
  MatchRegistryStatus,
  MatchRegistrySummary,
} from "@llmcraft/shared";

export type RegisteredMatchKind = MatchRegistryKind;
export type RegisteredMatchStatus = MatchRegistryStatus;

export interface MatchGameView {
  getState(): GameState | null;
  getTick?: () => number;
  getWinner?: () => GameState["winner"];
  isGameRunning?: () => boolean;
  getLogsTail?: (sinceCount: number) => { total: number; logs: GameState["logs"] };
  getAIOutputs?: () => Record<string, string>;
  getLatestSnapshot?: () => GameSnapshot | null;
  getDefinition?: () => { tickIntervalMs: number };
  addLog?: (
    type: typeof LOG_TYPES.PERF_WARNING,
    message: string,
    data: GameLogDataMap[typeof LOG_TYPES.PERF_WARNING],
  ) => unknown;
}

export interface RegisteredMatchHandle {
  getMatchId(): string;
  getGame(): MatchGameView;
  getMatchStatus?(): RegisteredMatchStatus;
  stop(): void;
  quiesce?: () => Promise<void>;
  saveRecord(): Promise<string>;
  getAITerminalFeed?: (sinceSequence?: number) => {
    sessionId: string;
    events: AITerminalEvent[];
    latestSequence: number;
    reset: boolean;
    hasMore: boolean;
  };
  getTerminalHistory?: (beforeSequence?: number, limit?: number) => Promise<{
    events: AITerminalEvent[];
    hasMore: boolean;
  }>;
}

export interface MatchRegistration {
  kind: RegisteredMatchKind;
  label?: string;
  parentId?: string;
  signature?: string;
  liveSetup?: LiveMatchSetupSnapshot;
  observe?: boolean;
  terminalPolicy?: "save" | "none";
}

export type RegisteredMatchSummary = MatchRegistrySummary;

export interface RegisteredMatchEntry extends Omit<MatchRegistration, "observe"> {
  matchId: string;
  createdAt: string;
  handle: RegisteredMatchHandle;
}

export interface MatchFinalizationResult {
  matchId: string;
  ok: boolean;
  filePath?: string;
  error?: string;
  skipped?: boolean;
}

/** Owns match identity and selection; it never mutates simulation or render state. */
export class MatchRegistry {
  private readonly entries = new Map<string, RegisteredMatchEntry>();
  private readonly finalizationByMatch = new Map<string, Promise<MatchFinalizationResult>>();
  private readonly finalizedByMatch = new Map<string, MatchFinalizationResult>();
  private readonly quiescedMatches = new Set<string>();
  private observedMatchId: string | null = null;

  register(handle: RegisteredMatchHandle, registration: MatchRegistration): RegisteredMatchEntry {
    const matchId = handle.getMatchId();
    if (!matchId) throw new Error("Registered match must have a stable matchId.");
    const existing = this.entries.get(matchId);
    if (existing) {
      if (existing.handle !== handle) {
        throw new Error(`Match ${matchId} is already registered by another runtime.`);
      }
      if (registration.observe) this.observedMatchId = matchId;
      return existing;
    }
    const entry: RegisteredMatchEntry = {
      matchId,
      kind: registration.kind,
      createdAt: new Date().toISOString(),
      handle,
      ...(registration.label ? { label: registration.label } : {}),
      ...(registration.parentId ? { parentId: registration.parentId } : {}),
      ...(registration.signature ? { signature: registration.signature } : {}),
      ...(registration.liveSetup ? { liveSetup: registration.liveSetup } : {}),
      ...(registration.terminalPolicy ? { terminalPolicy: registration.terminalPolicy } : {}),
    };
    this.entries.set(matchId, entry);
    if (registration.observe || this.observedMatchId === null) {
      this.observedMatchId = matchId;
    }
    return entry;
  }

  get(matchId: string): RegisteredMatchEntry | undefined {
    return this.entries.get(matchId);
  }

  require(matchId: string): RegisteredMatchEntry {
    const entry = this.entries.get(matchId);
    if (!entry) throw new Error(`Match not found: ${matchId}`);
    return entry;
  }

  list(): RegisteredMatchSummary[] {
    return [...this.entries.values()]
      .map((entry) => this.toSummary(entry))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  observe(matchId: string | null): void {
    if (matchId !== null && !this.entries.has(matchId)) {
      throw new Error(`Cannot observe unknown match: ${matchId}`);
    }
    this.observedMatchId = matchId;
  }

  getObserved(): RegisteredMatchEntry | null {
    if (this.observedMatchId) {
      const observed = this.entries.get(this.observedMatchId);
      if (observed) return observed;
    }
    const fallback = [...this.entries.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
    this.observedMatchId = fallback?.matchId ?? null;
    return fallback;
  }

  getObservedMatchId(): string | null {
    return this.getObserved()?.matchId ?? null;
  }

  async save(matchId: string): Promise<string> {
    const entry = this.require(matchId);
    const filePath = await entry.handle.saveRecord();
    const state = entry.handle.getGame().getState();
    const status = entry.handle.getMatchStatus?.() ?? inferStatus(entry.handle, state);
    if (status === "stopped" || status === "finished" || status === "failed") {
      this.finalizedByMatch.set(matchId, { matchId, ok: true, filePath });
    }
    return filePath;
  }

  stop(matchId: string): void {
    this.require(matchId).handle.stop();
  }

  stopAndSave(matchId: string): Promise<MatchFinalizationResult> {
    return this.finalizeEntry(this.require(matchId), true);
  }

  async finalizeTerminalMatches(): Promise<MatchFinalizationResult[]> {
    const terminalEntries = [...this.entries.values()].filter((entry) => {
      const state = entry.handle.getGame().getState();
      const status = entry.handle.getMatchStatus?.() ?? inferStatus(entry.handle, state);
      return status === "finished" || status === "failed";
    });
    return Promise.all(terminalEntries.map((entry) => (
      entry.terminalPolicy === "none"
        ? this.skipTerminalEntry(entry)
        : this.finalizeEntry(entry, true)
    )));
  }

  async stopAndSaveAll(): Promise<MatchFinalizationResult[]> {
    return Promise.all([...this.entries.values()].map((entry) => (
      entry.terminalPolicy === "none"
        ? this.skipTerminalEntry(entry)
        : this.finalizeEntry(entry, true)
    )));
  }

  remove(matchId: string, options: { stop?: boolean } = {}): boolean {
    const entry = this.entries.get(matchId);
    if (!entry) return false;
    if (options.stop) entry.handle.stop();
    this.entries.delete(matchId);
    this.finalizedByMatch.delete(matchId);
    this.quiescedMatches.delete(matchId);
    if (this.observedMatchId === matchId) {
      this.observedMatchId = null;
      this.getObserved();
    }
    return true;
  }

  stopAll(): void {
    for (const entry of this.entries.values()) entry.handle.stop();
  }

  private finalizeEntry(entry: RegisteredMatchEntry, stopFirst: boolean): Promise<MatchFinalizationResult> {
    const finalized = this.finalizedByMatch.get(entry.matchId);
    if (finalized) {
      return stopFirst && !this.quiescedMatches.has(entry.matchId)
        ? this.quiesceEntry(entry).then(() => finalized)
        : Promise.resolve(finalized);
    }
    const pending = this.finalizationByMatch.get(entry.matchId);
    if (pending) return pending;
    const finalization = (async (): Promise<MatchFinalizationResult> => {
      try {
        if (stopFirst) await this.quiesceEntry(entry);
        const filePath = await entry.handle.saveRecord();
        const result = { matchId: entry.matchId, ok: true, filePath } satisfies MatchFinalizationResult;
        this.finalizedByMatch.set(entry.matchId, result);
        return result;
      } catch (error) {
        return {
          matchId: entry.matchId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    this.finalizationByMatch.set(entry.matchId, finalization);
    void finalization.finally(() => {
      if (this.finalizationByMatch.get(entry.matchId) === finalization) {
        this.finalizationByMatch.delete(entry.matchId);
      }
    });
    return finalization;
  }

  private async skipTerminalEntry(entry: RegisteredMatchEntry): Promise<MatchFinalizationResult> {
    const finalized = this.finalizedByMatch.get(entry.matchId);
    if (finalized) return finalized;
    try {
      await this.quiesceEntry(entry);
      const result = { matchId: entry.matchId, ok: true, skipped: true } satisfies MatchFinalizationResult;
      this.finalizedByMatch.set(entry.matchId, result);
      return result;
    } catch (error) {
      return {
        matchId: entry.matchId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async quiesceEntry(entry: RegisteredMatchEntry): Promise<void> {
    if (entry.handle.quiesce) {
      await entry.handle.quiesce();
    } else {
      entry.handle.stop();
    }
    this.quiescedMatches.add(entry.matchId);
  }

  private toSummary(entry: RegisteredMatchEntry): RegisteredMatchSummary {
    const state = entry.handle.getGame().getState();
    return {
      matchId: entry.matchId,
      kind: entry.kind,
      status: entry.handle.getMatchStatus?.() ?? inferStatus(entry.handle, state),
      tick: state?.tick ?? 0,
      winner: state?.winner ?? null,
      createdAt: entry.createdAt,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.parentId ? { parentId: entry.parentId } : {}),
      observed: this.observedMatchId === entry.matchId,
    };
  }
}

function inferStatus(handle: RegisteredMatchHandle, state: GameState | null): RegisteredMatchStatus {
  if (state?.winner) return "finished";
  return handle.getGame().isGameRunning?.() ? "running" : "stopped";
}
