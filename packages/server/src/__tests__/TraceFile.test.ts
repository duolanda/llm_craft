import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  isSupportedRecordFileName,
  readRecordJsonText,
  traceFileEncoding,
} from "../TraceFile";

const gzipAsync = promisify(gzip);

describe("TraceFile", () => {
  it("reads historical JSON and gzip Trace files through one boundary", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-trace-file-"));
    const plainPath = path.join(directory, "legacy.trace.json");
    const gzipPath = path.join(directory, "current.trace.json.gz");
    const json = JSON.stringify({ schemaVersion: 3, marker: "trace" });
    await fs.writeFile(plainPath, json, "utf8");
    await fs.writeFile(gzipPath, await gzipAsync(json));

    await expect(readRecordJsonText(plainPath)).resolves.toBe(json);
    await expect(readRecordJsonText(gzipPath)).resolves.toBe(json);
    expect(isSupportedRecordFileName("legacy.trace.json")).toBe(true);
    expect(isSupportedRecordFileName("current.trace.json.gz")).toBe(true);
    expect(isSupportedRecordFileName("trace.txt")).toBe(false);
    expect(traceFileEncoding("current.trace.json.gz")).toBe("gzip");

    await fs.rm(directory, { recursive: true, force: true });
  });
});
