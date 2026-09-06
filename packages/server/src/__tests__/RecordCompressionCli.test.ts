import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchRecord } from "@llmcraft/shared";
import { parseMatchRecord } from "@llmcraft/record";
import { Game } from "../Game";
import { createDefaultMatchDefinition } from "../MatchDefinition";
import { encodeRecordJson, readMatchRecordFile } from "../RecordFile";
import * as recordFile from "../RecordFile";
import { runRecordCompression } from "../RecordCompression";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const script = fileURLToPath(new URL("../../scripts/compress-records.ts", import.meta.url));
const serverDirectory = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = path.resolve(serverDirectory, "../..");
const tempDirectories: string[] = [];

interface CliReport {
  results: Array<{ source: string; target?: string; status: "converted" | "skipped" | "failed"; sourceDeleted?: boolean }>;
  summary: { converted: number; skipped: number; failed: number; removedOriginals: number; originalBytes: number; compressedBytes: number };
}

async function runCli(args: string[]) {
  try {
    const result = await execFileAsync(process.execPath, ["--import", require.resolve("tsx"), script, ...args], {
      cwd: serverDirectory,
      timeout: 10_000,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof failure.code !== "number" || typeof failure.stdout !== "string" || typeof failure.stderr !== "string") throw error;
    return { exitCode: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

async function createDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-record-compression-"));
  tempDirectories.push(directory);
  return directory;
}

function createRecord(): MatchRecord {
  const state = new Game().getState();
  return {
    recordFormat: "match-record",
    matchId: "match_compression_test",
    definition: createDefaultMatchDefinition(),
    metadata: {
      startedAt: "2026-09-06T00:00:00.000Z",
      savedAt: "2026-09-06T00:00:00.000Z",
      status: "stopped",
      winner: null,
      recordingProfile: "replay",
      includeTranscript: false,
      players: [],
    },
    initialState: state,
    finalState: state,
    tickDeltas: [],
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("Match Record batch compression CLI", () => {
  it("preserves original bytes for current and legacy records, deduplicates inputs, and recurses only on request", async () => {
    const directory = await createDirectory();
    const record = createRecord();
    const current = Buffer.from(`${JSON.stringify({ ...record, historicalExtra: "录像原文", preciseNumber: 0 }, null, 2).replace('"preciseNumber": 0', '"preciseNumber": 9007199254740993')}\n`);
    const legacy = Buffer.from(JSON.stringify({
      metadata: record.metadata, initialState: record.initialState, finalState: record.finalState,
      tickDeltas: [], historicalExtra: "保留旧结构，不迁移字段",
    }));
    const firstPath = path.join(directory, "current match.match.json");
    const legacyPath = path.join(directory, "old-record.json");
    const nestedDirectory = path.join(directory, "nested");
    await fs.mkdir(nestedDirectory);
    await fs.writeFile(firstPath, current);
    await fs.writeFile(legacyPath, legacy);
    await fs.writeFile(path.join(nestedDirectory, "nested.match.json"), current);
    await fs.writeFile(path.join(directory, "ignored.txt"), "not a record");

    const first = await runCli([path.relative(repoRoot, directory), firstPath, "--json"]);
    expect(first.exitCode).toBe(0);
    const report = JSON.parse(first.stdout) as CliReport;
    expect(report.summary).toMatchObject({ converted: 2, skipped: 0, failed: 0, removedOriginals: 0, originalBytes: current.length + legacy.length });
    expect(report.results).toHaveLength(2);
    for (const [source, target, original] of [
      [firstPath, path.join(directory, "current match.match.zst"), current],
      [legacyPath, path.join(directory, "old-record.match.zst"), legacy],
    ] as const) {
      const compressed = await fs.readFile(target);
      expect(zstdDecompressSync(compressed).equals(original)).toBe(true);
      expect(compressed[4] & 4).toBe(4);
      expect(compressed.length).toBeLessThan(original.length);
      expect((await fs.readFile(source)).equals(original)).toBe(true);
      expect(await readMatchRecordFile(target)).toEqual(parseMatchRecord(original.toString("utf8")));
    }
    await expect(fs.stat(path.join(nestedDirectory, "nested.match.zst"))).rejects.toMatchObject({ code: "ENOENT" });
    const repeated = await runCli([directory, "--recursive", "--json"]);
    expect(repeated.exitCode).toBe(0);
    expect((JSON.parse(repeated.stdout) as CliReport).summary).toMatchObject({ converted: 1, skipped: 2, failed: 0 });
    expect(zstdDecompressSync(await fs.readFile(path.join(nestedDirectory, "nested.match.zst"))).equals(current)).toBe(true);
  });

  it("deletes originals only after verifying newly written or matching existing compressed files", async () => {
    const directory = await createDirectory();
    const original = Buffer.from(JSON.stringify(createRecord()));
    const first = path.join(directory, "first.match.json");
    const second = path.join(directory, "second.match.json");
    await fs.writeFile(first, original);
    await fs.writeFile(second, original);
    expect((await runCli([first, "--json"])).exitCode).toBe(0);
    const result = await runCli([directory, "--delete-originals", "--json"]);
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as CliReport).summary).toMatchObject({ converted: 1, skipped: 1, failed: 0, removedOriginals: 2 });
    expect((await fs.readdir(directory)).sort()).toEqual(["first.match.zst", "second.match.zst"]);
    for (const file of await fs.readdir(directory)) {
      expect(zstdDecompressSync(await fs.readFile(path.join(directory, file))).equals(original)).toBe(true);
    }
  });

  it("continues after failures while preserving invalid originals and conflicting or damaged destinations", async () => {
    const directory = await createDirectory();
    const original = Buffer.from(JSON.stringify(createRecord()));
    const originals = new Map([
      ["broken.match.json", Buffer.from("{broken JSON")],
      ["settings.json", Buffer.from('{"not":"a record"}')],
      ["conflict.match.json", original],
      ["truncated.match.json", original],
      ["disguised.match.json", original],
      ["valid.match.json", original],
    ]);
    const destinations = new Map([
      ["conflict.match.zst", await encodeRecordJson(Buffer.concat([original, Buffer.from("\n")]))],
      ["truncated.match.zst", (await encodeRecordJson(original)).subarray(0, -4)],
      ["disguised.match.zst", original],
    ]);
    for (const [name, bytes] of [...originals, ...destinations]) await fs.writeFile(path.join(directory, name), bytes);
    const result = await runCli([directory, "--delete-originals", "--json"]);
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as CliReport;
    expect(report.summary).toMatchObject({ converted: 1, skipped: 0, failed: 5, removedOriginals: 1 });
    for (const [name, bytes] of [...originals, ...destinations]) {
      if (name === "valid.match.json") continue;
      expect((await fs.readFile(path.join(directory, name))).equals(bytes)).toBe(true);
    }
    await expect(fs.stat(path.join(directory, "valid.match.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(zstdDecompressSync(await fs.readFile(path.join(directory, "valid.match.zst"))).equals(original)).toBe(true);
    expect((await fs.readdir(directory)).some((name) => name.startsWith(".record-compress-"))).toBe(false);
  });

  it("publishes one complete file when conversions run concurrently", async () => {
    const directory = await createDirectory();
    const source = path.join(directory, "concurrent.match.json");
    const original = Buffer.from(JSON.stringify(createRecord()));
    await fs.writeFile(source, original);
    const runs = await Promise.all([runCli([source, "--json"]), runCli([source, "--json"])]);
    expect(runs.map((run) => run.exitCode)).toEqual([0, 0]);
    const reports = runs.map((run) => JSON.parse(run.stdout) as CliReport);
    expect(reports.reduce((total, report) => total + report.summary.converted, 0)).toBe(1);
    expect(reports.reduce((total, report) => total + report.summary.skipped, 0)).toBe(1);
    expect((await fs.readdir(directory)).sort()).toEqual(["concurrent.match.json", "concurrent.match.zst"]);
    expect(zstdDecompressSync(await fs.readFile(path.join(directory, "concurrent.match.zst"))).equals(original)).toBe(true);
  });

  it("preserves an original that changes while compression is in progress", async () => {
    const directory = await createDirectory();
    const source = path.join(directory, "changing.match.json");
    const original = Buffer.from(JSON.stringify(createRecord()));
    const changed = Buffer.concat([original, Buffer.from("\n")]);
    await fs.writeFile(source, original);
    const encode = recordFile.encodeRecordJson;
    vi.spyOn(recordFile, "encodeRecordJson").mockImplementationOnce(async (bytes) => {
      await fs.writeFile(source, changed);
      return encode(bytes);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runRecordCompression([source, "--delete-originals", "--json"])).toBe(1);
    expect((await fs.readFile(source)).equals(changed)).toBe(true);
    expect(zstdDecompressSync(await fs.readFile(path.join(directory, "changing.match.zst"))).equals(original)).toBe(true);
  });

  it("returns nonzero for missing inputs and invalid options, and zero for help", async () => {
    const directory = await createDirectory();
    const missing = await runCli([path.join(directory, "missing.json"), "--json"]);
    expect(missing.exitCode).toBe(1);
    expect((JSON.parse(missing.stdout) as CliReport).summary.failed).toBe(1);
    expect((await runCli([])).exitCode).toBe(1);
    expect((await runCli(["--unknown"])).exitCode).toBe(1);
    expect((await runCli(["--help"])).exitCode).toBe(0);
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
