import fs from "node:fs/promises";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { MatchRecord } from "@llmcraft/shared";
import { parseMatchRecord } from "@llmcraft/record";

const gunzipAsync = promisify(gunzip);
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

export function isSupportedRecordFileName(fileName: string): boolean {
  return fileName.endsWith(".json") || fileName.endsWith(".json.gz");
}

export function recordFileEncoding(fileName: string): "identity" | "gzip" {
  return fileName.endsWith(".gz") ? "gzip" : "identity";
}

/** Reads current JSON Match Records and historical gzip-compressed records. */
export async function readRecordJsonText(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  const gzipEncoded = bytes.length >= 2
    && bytes[0] === GZIP_MAGIC_0
    && bytes[1] === GZIP_MAGIC_1;
  if (!gzipEncoded) return bytes.toString("utf8");
  return (await gunzipAsync(bytes)).toString("utf8");
}

export async function readMatchRecordFile(filePath: string): Promise<MatchRecord> {
  return parseMatchRecord(await readRecordJsonText(filePath));
}
