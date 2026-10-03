import {
  type MatchRecord,
  type MatchRecordingOptions,
  type PlayerId,
  type SavedAITurnRecord,
} from "@llmcraft/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { MatchRuntime } from "./MatchRuntime";
import { encodeMatchRecord } from "./RecordFile";

export interface MatchRecordContext {
  startedAt: string;
  recording: MatchRecordingOptions;
  systemPrompt: string;
  players: Array<{
    playerId: PlayerId;
    model: string;
    baseURL?: string;
  }>;
  aiTurns: SavedAITurnRecord[];
}

/**
 * Writes one losslessly compressed terminal Match Record. Runtime state remains
 * in memory while the match is active; recording does not rewrite an in-progress file.
 */
export class MatchRecorder {
  private savedPath: string | null = null;
  private savedSignature: string | null = null;
  private savePromise: Promise<string> | null = null;

  constructor(
    private readonly runtime: MatchRuntime,
    private readonly recordDir: string,
  ) {}

  async save(context: MatchRecordContext): Promise<string> {
    if (context.recording.profile === "off") {
      throw new Error("MATCH_RECORDING_DISABLED");
    }
    if (this.runtime.getGame().isGameRunning()) {
      throw new Error("MATCH_STILL_RUNNING");
    }
    const signature = this.buildSignature(context);
    if (this.savedPath && this.savedSignature === signature) return this.savedPath;
    if (this.savePromise) return this.savePromise;

    this.savePromise = this.write(context);
    try {
      this.savedPath = await this.savePromise;
      this.savedSignature = signature;
      return this.savedPath;
    } finally {
      this.savePromise = null;
    }
  }

  private buildSignature(context: MatchRecordContext): string {
    const game = this.runtime.getGame();
    return JSON.stringify({
      tick: game.getTick(),
      winner: game.getWinner(),
      status: this.runtime.getStatus(),
      aiTurns: context.aiTurns.length,
      commandResults: game.getCommandResults().length,
    });
  }

  private async write(context: MatchRecordContext): Promise<string> {
    const game = this.runtime.getGame();
    const finalState = game.getState();
    const savedAt = new Date().toISOString();
    const initialState = game.getInitialSnapshot()?.state ?? finalState;
    const profile = context.recording.profile;
    if (profile === "off") throw new Error("MATCH_RECORDING_DISABLED");
    const record: MatchRecord = {
      recordFormat: "match-record",
      matchId: this.runtime.getMatchId(),
      definition: this.runtime.getDefinition(),
      metadata: {
        startedAt: context.startedAt,
        savedAt,
        endedAt: savedAt,
        status: this.runtime.getStatus() === "failed"
          ? "failed"
          : finalState.winner
            ? "finished"
            : "stopped",
        winner: finalState.winner,
        recordingProfile: profile,
        includeTranscript: context.recording.includeTranscript,
        ...(context.recording.includeTranscript ? { systemPrompt: context.systemPrompt } : {}),
        players: structuredClone(context.players),
      },
      initialState,
      finalState,
      tickDeltas: await game.getTickDeltasAsync(),
      ...(profile === "evaluation"
        ? {
            commandResults: game.getCommandResults(),
            aiTurns: context.aiTurns.map((turn) => this.projectTurn(turn, context.recording.includeTranscript)),
          }
        : {}),
    };

    await fs.mkdir(this.recordDir, { recursive: true });
    const timestamp = savedAt.replace(/[:.]/g, "-");
    const matchSuffix = this.runtime.getMatchId().replace(/^match_/, "").slice(0, 8);
    const fileName = `match-${timestamp}-${matchSuffix}.match.zst`;
    const finalPath = path.join(this.recordDir, fileName);
    const tempPath = `${finalPath}.tmp-${process.pid}`;
    await fs.writeFile(tempPath, await encodeMatchRecord(record));
    await fs.rename(tempPath, finalPath);
    return finalPath;
  }

  private projectTurn(turn: SavedAITurnRecord, includeTranscript: boolean): SavedAITurnRecord {
    if (includeTranscript) return structuredClone(turn);
    return {
      ...structuredClone(turn),
      assistantMessages: [],
      metrics: {
        ...structuredClone(turn.metrics),
        modelRequestRecords: turn.metrics.modelRequestRecords?.map(({ messages: _messages, ...record }) => record),
      },
    };
  }
}
