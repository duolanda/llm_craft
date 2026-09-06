import fs from "node:fs/promises";
import { constants, zstdCompress, zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import type { MatchRecord } from "@llmcraft/shared";
import { parseMatchRecord, validateZstdRecordFrame } from "@llmcraft/record";

const compressAsync = promisify(zstdCompress);
const decompressAsync = promisify(zstdDecompress);
const ZSTD_MAGIC = 0xfd2fb528;

export function isSupportedRecordFileName(fileName: string): boolean {
  return fileName.endsWith(".json") || fileName.endsWith(".match.zst");
}

export function recordFileEncoding(fileName: string): "identity" | "zstd" {
  return fileName.endsWith(".zst") ? "zstd" : "identity";
}

export async function encodeMatchRecord(record: MatchRecord): Promise<Buffer> {
  return encodeRecordJson(JSON.stringify(record));
}

/** Preserves an existing JSON document's bytes when compressing historical records. */
export async function encodeRecordJson(json: string | Buffer): Promise<Buffer> {
  return compressAsync(json, {
    params: {
      [constants.ZSTD_c_compressionLevel]: 6,
      [constants.ZSTD_c_checksumFlag]: 1,
    },
  });
}

/** File imports and stored records share the server-side decoding boundary. */
export async function decodeRecordJsonBytes(bytes: Buffer, maxOutputLength?: number): Promise<Buffer> {
  const zstdEncoded = bytes.length >= 4 && bytes.readUInt32LE(0) === ZSTD_MAGIC;
  if (!zstdEncoded) return bytes;
  validateZstdRecordFrame(bytes);
  return decompressAsync(bytes, { maxOutputLength });
}

export async function decodeRecordJsonText(bytes: Buffer, maxOutputLength?: number): Promise<string> {
  return (await decodeRecordJsonBytes(bytes, maxOutputLength)).toString("utf8");
}

export async function decodeMatchRecord(bytes: Buffer, maxOutputLength?: number): Promise<MatchRecord> {
  return parseMatchRecord(await decodeRecordJsonText(bytes, maxOutputLength));
}

export async function readRecordJsonText(filePath: string): Promise<string> {
  return decodeRecordJsonText(await fs.readFile(filePath));
}

export async function readMatchRecordFile(filePath: string): Promise<MatchRecord> {
  return decodeMatchRecord(await fs.readFile(filePath));
}
