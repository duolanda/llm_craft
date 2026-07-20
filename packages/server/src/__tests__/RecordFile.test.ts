import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  isSupportedRecordFileName,
  readRecordJsonText,
  recordFileEncoding,
} from "../RecordFile";

const gzipAsync = promisify(gzip);

describe("RecordFile", () => {
  it("reads Match Record JSON and historical gzip files through one boundary", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-record-file-"));
    const plainPath = path.join(directory, "current.match.json");
    const gzipPath = path.join(directory, "legacy.json.gz");
    const json = JSON.stringify({ recordFormat: "match-record", marker: "record" });
    await fs.writeFile(plainPath, json, "utf8");
    await fs.writeFile(gzipPath, await gzipAsync(json));

    await expect(readRecordJsonText(plainPath)).resolves.toBe(json);
    await expect(readRecordJsonText(gzipPath)).resolves.toBe(json);
    expect(isSupportedRecordFileName("current.match.json")).toBe(true);
    expect(isSupportedRecordFileName("legacy.json.gz")).toBe(true);
    expect(isSupportedRecordFileName("record.txt")).toBe(false);
    expect(recordFileEncoding("legacy.json.gz")).toBe("gzip");

    await fs.rm(directory, { recursive: true, force: true });
  });
});
