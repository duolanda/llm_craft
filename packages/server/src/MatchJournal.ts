import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import type { AITerminalEvent, AITurnRecord } from "@llmcraft/shared";

type JournalRecord<T> = {
  sequence: number;
  value: T;
};

export interface TerminalHistoryPage {
  events: AITerminalEvent[];
  hasMore: boolean;
}

export class MatchJournal {
  private readonly directory: string;
  private readonly aiTurnsPath: string;
  private readonly terminalEventsPath: string;
  private aiTurnSequence = 0;
  private terminalEventSequence = 0;

  constructor(_recordDir: string, sessionId: string) {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
    this.directory = path.join(os.tmpdir(), "llmcraft-match-journals", safeSessionId);
    this.aiTurnsPath = path.join(this.directory, "ai-turns.ndjson");
    this.terminalEventsPath = path.join(this.directory, "terminal-events.ndjson");
    fs.mkdirSync(this.directory, { recursive: true });
  }

  get aiTurnCount(): number {
    return this.aiTurnSequence;
  }

  appendAITurn(turn: AITurnRecord): void {
    this.aiTurnSequence += 1;
    this.appendRecord(this.aiTurnsPath, { sequence: this.aiTurnSequence, value: turn });
  }

  appendTerminalEvent(event: AITerminalEvent): void {
    this.terminalEventSequence += 1;
    this.appendRecord(this.terminalEventsPath, { sequence: this.terminalEventSequence, value: event });
  }

  async *readAITurns(): AsyncGenerator<AITurnRecord> {
    for await (const record of this.readRecords<AITurnRecord>(this.aiTurnsPath)) {
      yield record.value;
    }
  }

  async readTerminalHistory(beforeSequence?: number, limit = 100): Promise<TerminalHistoryPage> {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
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

  private appendRecord<T>(filePath: string, record: JournalRecord<T>): void {
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  private async *readRecords<T>(filePath: string): AsyncGenerator<JournalRecord<T>> {
    try {
      await fsPromises.access(filePath);
    } catch {
      return;
    }
    const input = fs.createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim()) {
        yield JSON.parse(line) as JournalRecord<T>;
      }
    }
  }
}
