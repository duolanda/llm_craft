import fs from "node:fs/promises";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { MatchTraceRecordV3 } from "@llmcraft/shared";
import { parseMatchTraceRecordV3 } from "@llmcraft/trace";

const gunzipAsync = promisify(gunzip);
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

export function isSupportedRecordFileName(fileName: string): boolean {
  return fileName.endsWith(".json") || fileName.endsWith(".json.gz");
}

export function traceFileEncoding(fileName: string): "identity" | "gzip" {
  return fileName.endsWith(".gz") ? "gzip" : "identity";
}

/** Reads both historical plain JSON and current gzip-compressed Trace files. */
export async function readRecordJsonText(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  const gzipEncoded = bytes.length >= 2
    && bytes[0] === GZIP_MAGIC_0
    && bytes[1] === GZIP_MAGIC_1;
  if (!gzipEncoded) return bytes.toString("utf8");
  return (await gunzipAsync(bytes)).toString("utf8");
}

export async function readTraceRecordFile(filePath: string): Promise<MatchTraceRecordV3> {
  return parseMatchTraceRecordV3(await readRecordJsonText(filePath));
}
