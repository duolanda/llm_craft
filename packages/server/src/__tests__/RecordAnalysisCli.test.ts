import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { constants, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { analyzeMatchRecord } from "@llmcraft/record";
import type { MatchRecord } from "@llmcraft/shared";
import { Game } from "../Game";
import { createDefaultMatchDefinition } from "../MatchDefinition";
import { encodeMatchRecord } from "../RecordFile";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../../scripts/analyze-record.mjs", import.meta.url));

interface StorageReport {
  encoding: "identity" | "zstd";
  fileBytes: number;
  decodedBytes: number;
  zstdBytes: number;
  zstdSavingsPercent: number;
  sections: Array<{ name: string; bytes: number }>;
  tickDeltaSections: { units: number; buildings: number; newLogs: number; aiOutputs: number };
}

interface CliOutput {
  reports: Array<{ file: string; report: ReturnType<typeof analyzeMatchRecord>; storage?: StorageReport }>;
  comparison: unknown;
}

describe("Match Record analysis CLI", () => {
  it("analyzes zstd and plain records identically and reports their actual byte sizes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-record-analysis-"));
    try {
      const initialState = new Game().getState();
      const finalState = structuredClone(initialState);
      finalState.tick = 1;
      const record: MatchRecord = {
        recordFormat: "match-record",
        matchId: "match_analysis_fixture",
        definition: createDefaultMatchDefinition(),
        metadata: {
          startedAt: "2026-09-06T00:00:00.000Z",
          savedAt: "2026-09-06T00:00:00.500Z",
          status: "stopped",
          winner: null,
          recordingProfile: "replay",
          includeTranscript: false,
          players: [],
        },
        initialState,
        finalState,
        tickDeltas: [{
          tick: 1,
          players: initialState.players.map((player) => ({ playerId: player.id, units: [], buildings: [] })),
          newLogs: [],
          aiOutputs: { player_1: "战场：继续采集" },
        }],
      };
      const plainPath = path.join(directory, "plain.match.json");
      const zstdPath = path.join(directory, "compressed.match.zst");
      const json = JSON.stringify(record);
      const compressed = await encodeMatchRecord(record);
      await fs.writeFile(plainPath, json);
      await fs.writeFile(zstdPath, compressed);

      const { stdout } = await execFileAsync(process.execPath, [script, directory, "--storage", "--json"]);
      const output = JSON.parse(stdout) as CliOutput;
      expect(output.reports.map((entry) => entry.file)).toEqual(["compressed.match.zst", "plain.match.json"]);
      const zstdEntry = output.reports[0]!;
      const plainEntry = output.reports[1]!;
      expect(zstdEntry.report).toEqual(plainEntry.report);
      expect(zstdEntry.report).toEqual(analyzeMatchRecord(record));
      expect(zstdEntry.storage).toMatchObject({
        encoding: "zstd",
        fileBytes: compressed.length,
        decodedBytes: Buffer.byteLength(json),
        zstdBytes: compressed.length,
        tickDeltaSections: {
          units: initialState.players.length * 2,
          buildings: initialState.players.length * 2,
          newLogs: 2,
          aiOutputs: Buffer.byteLength(JSON.stringify(record.tickDeltas[0]!.aiOutputs)),
        },
      });
      expect(plainEntry.storage).toMatchObject({
        encoding: "identity",
        fileBytes: Buffer.byteLength(json),
        decodedBytes: Buffer.byteLength(json),
        zstdBytes: zstdCompressSync(json, {
          params: { [constants.ZSTD_c_compressionLevel]: 6, [constants.ZSTD_c_checksumFlag]: 1 },
        }).length,
      });
      expect(zstdEntry.storage!.sections).toEqual(plainEntry.storage!.sections);
      expect(zstdEntry.storage!.sections).toContainEqual({ name: "tickDeltas", bytes: Buffer.byteLength(JSON.stringify(record.tickDeltas)) });
      expect(zstdEntry.storage!.zstdSavingsPercent).toBeCloseTo((1 - compressed.length / Buffer.byteLength(json)) * 100);

      const normal = await execFileAsync(process.execPath, [script, zstdPath, "--json"]);
      const normalOutput = JSON.parse(normal.stdout) as CliOutput;
      expect(normalOutput.reports[0]!.report).toEqual(zstdEntry.report);
      expect(normalOutput.reports[0]).not.toHaveProperty("storage");

      const human = await execFileAsync(process.execPath, [script, zstdPath, "--storage"]);
      expect(human.stdout).toContain(`file=${compressed.length} bytes`);
      expect(human.stdout).toContain(`decoded=${Buffer.byteLength(json)} bytes`);

      const csv = await execFileAsync(process.execPath, [script, zstdPath, "--storage", "--csv"]);
      expect(csv.stdout.split("\n")).toContain(`compressed.match.zst,stopped,,standard,storage,file_bytes,${compressed.length}`);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
