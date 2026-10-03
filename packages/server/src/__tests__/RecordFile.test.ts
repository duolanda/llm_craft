import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants, zstdCompress, zstdCompressSync } from "node:zlib";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  isSupportedRecordFileName,
  readRecordJsonText,
  recordFileEncoding,
  decodeRecordJsonText,
} from "../RecordFile";

const compressAsync = promisify(zstdCompress);

describe("RecordFile", () => {
  it("reads current zstd Match Records and legacy files by signature through one boundary", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-record-file-"));
    const json = JSON.stringify({ recordFormat: "match-record", marker: "战场录像", values: [null, 1.23456789] });
    try {
      for (const [fileName, zstdEncoded] of [
        ["current.match.zst", true],
        ["legacy.match.json", false],
        ["compressed-without-suffix.json", true],
      ] as const) {
        const filePath = path.join(directory, fileName);
        await fs.writeFile(filePath, zstdEncoded ? await compressAsync(json) : json);
        await expect(readRecordJsonText(filePath)).resolves.toBe(json);
        expect(isSupportedRecordFileName(fileName)).toBe(true);
      }
      expect(isSupportedRecordFileName("record.txt")).toBe(false);
      expect(isSupportedRecordFileName("unused.match.json.gz")).toBe(false);
      expect(isSupportedRecordFileName("current.match.zst.tmp-123")).toBe(false);
      expect(recordFileEncoding("current.match.zst")).toBe("zstd");
      expect(recordFileEncoding("legacy.match.json")).toBe("identity");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects truncated zstd data instead of returning a partial record", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-record-file-"));
    try {
      const filePath = path.join(directory, "broken.match.zst");
      const bytes = await compressAsync(JSON.stringify({ recordFormat: "match-record" }));
      await fs.writeFile(filePath, bytes.subarray(0, bytes.length - 8));
      await expect(readRecordJsonText(filePath)).rejects.toThrow();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds decompressed imports before allocating their complete output", async () => {
    const bytes = await compressAsync("record".repeat(1024));
    await expect(decodeRecordJsonText(bytes, 128)).rejects.toMatchObject({ code: "ERR_BUFFER_TOO_LARGE" });
  });

  it("rejects missing or corrupt checksums even when all JSON content is present", async () => {
    const json = JSON.stringify({ payload: "录像".repeat(2048) });
    const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
    for (const bytes of [zstdCompressSync(json, options), await compressAsync(json, options)]) {
      await expect(decodeRecordJsonText(bytes)).resolves.toBe(json);
      for (const removed of [1, 4, 8]) {
        await expect(decodeRecordJsonText(bytes.subarray(0, bytes.length - removed))).rejects.toThrow();
      }
      const corrupt = Buffer.from(bytes);
      corrupt[corrupt.length - 1] ^= 1;
      await expect(decodeRecordJsonText(corrupt)).rejects.toThrow();
      await expect(decodeRecordJsonText(Buffer.concat([bytes, Buffer.from([0])]))).rejects.toThrow();
    }
  });
});
