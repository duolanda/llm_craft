import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMatchRecord, validateZstdRecordFrame } from "@llmcraft/record";
import { decodeRecordJsonBytes, encodeRecordJson } from "./RecordFile";

interface Options {
  inputs: string[];
  recursive: boolean;
  deleteOriginals: boolean;
  json: boolean;
  help: boolean;
}

interface ConvertedFile {
  source: string;
  target: string;
  status: "converted" | "skipped";
  originalBytes: number;
  compressedBytes: number;
  sourceDeleted: boolean;
}

type ConversionResult = ConvertedFile | {
  source: string;
  status: "failed";
  error: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const usage = `Usage: pnpm --filter @llmcraft/server compress:records <file.json|directory>... [options]

将旧 JSON 录像转换为同目录的 .match.zst（zstd 6 + 校验和）。
默认保留原文件；已有目标文件须解压后与原文件逐字节一致，否则报告失败。

  --recursive         递归处理子目录中的 JSON 文件
  --delete-originals  校验压缩文件完整一致后删除对应原文件
  --json              输出机器可读的处理结果和汇总
  --help              显示帮助
`;

function parseOptions(args: string[]): Options {
  const options: Options = { inputs: [], recursive: false, deleteOriginals: false, json: false, help: false };
  let positionalOnly = false;
  for (const arg of args) {
    if (positionalOnly) options.inputs.push(arg);
    else if (arg === "--") positionalOnly = true;
    else if (arg === "--recursive") options.recursive = true;
    else if (arg === "--delete-originals") options.deleteOriginals = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("-")) throw new Error(`未知选项：${arg}`);
    else options.inputs.push(arg);
  }
  return options;
}

async function collectFiles(input: string, recursive: boolean, files: Set<string>): Promise<void> {
  const info = await fs.lstat(input);
  if (info.isFile() && /\.json$/i.test(input)) {
    files.add(input);
  } else if (info.isDirectory()) {
    const entries = await fs.readdir(input, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(input, entry.name);
      if (entry.isFile() && /\.json$/i.test(entry.name)) files.add(child);
      else if (entry.isDirectory() && recursive) await collectFiles(child, true, files);
    }
  } else {
    throw new Error("输入必须是普通 JSON 文件或目录。");
  }
}

async function verifyCompressedFile(file: string, original: Buffer): Promise<number> {
  if (!(await fs.lstat(file)).isFile()) throw new Error(`目标不是普通文件：${file}`);
  const compressed = await fs.readFile(file);
  validateZstdRecordFrame(compressed);
  const decoded = await decodeRecordJsonBytes(compressed, original.length);
  if (!decoded.equals(original)) throw new Error(`压缩文件与原文件内容不一致：${file}`);
  return compressed.length;
}

async function convertFile(source: string, deleteOriginals: boolean): Promise<ConvertedFile> {
  const info = await fs.lstat(source);
  if (!info.isFile()) throw new Error("输入必须是普通 JSON 文件。");
  const original = await fs.readFile(source);
  // Validate readability without reserializing or migrating the stored document.
  parseMatchRecord(original.toString("utf8"));
  const target = source.replace(/(?:\.match)?\.json$/i, ".match.zst");
  let status: "converted" | "skipped" = "skipped";
  let compressedBytes: number;
  try {
    compressedBytes = await verifyCompressedFile(target, original);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(source), ".record-compress-"));
    const temporaryFile = path.join(temporaryDirectory, "record.zst");
    try {
      await fs.writeFile(temporaryFile, await encodeRecordJson(original), { mode: info.mode & 0o777, flush: true });
      await verifyCompressedFile(temporaryFile, original);
      try {
        // Publish a complete file atomically without overwriting a concurrent conversion.
        await fs.link(temporaryFile, target);
        status = "converted";
      } catch (publishError) {
        if ((publishError as NodeJS.ErrnoException).code !== "EEXIST") throw publishError;
      }
      compressedBytes = await verifyCompressedFile(target, original);
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
  if (deleteOriginals) {
    if (!(await fs.readFile(source)).equals(original)) {
      throw new Error("转换期间原文件发生变化，已保留原文件。");
    }
    await fs.unlink(source);
  }
  return { source, target, status, originalBytes: original.length, compressedBytes, sourceDeleted: deleteOriginals };
}

export async function runRecordCompression(args: string[]): Promise<number> {
  const options = parseOptions(args);
  if (options.help || options.inputs.length === 0) {
    console.log(usage);
    return options.help ? 0 : 1;
  }
  const results: ConversionResult[] = [];
  const files = new Set<string>();
  const reportFailure = (source: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ source, status: "failed", error: message });
    if (!options.json) console.error(`失败：${source} — ${message}`);
  };
  for (const input of options.inputs) {
    const cwdPath = path.resolve(input);
    const resolved = existsSync(cwdPath) ? cwdPath : path.resolve(repoRoot, input);
    try {
      await collectFiles(resolved, options.recursive, files);
    } catch (error) {
      reportFailure(resolved, error);
    }
  }
  for (const source of [...files].sort()) {
    try {
      const result = await convertFile(source, options.deleteOriginals);
      results.push(result);
      if (!options.json) {
        const savedPercent = (1 - result.compressedBytes / result.originalBytes) * 100;
        console.log(`${result.status === "converted" ? "转换" : "已有且一致"}：${source} -> ${result.target} (${result.originalBytes} -> ${result.compressedBytes} bytes，缩小 ${savedPercent.toFixed(1)}%)${result.sourceDeleted ? "，已删除原文件" : ""}`);
      }
    } catch (error) {
      reportFailure(source, error);
    }
  }
  const summary = { converted: 0, skipped: 0, failed: 0, removedOriginals: 0, originalBytes: 0, compressedBytes: 0 };
  for (const result of results) {
    summary[result.status]++;
    if (result.status !== "failed") {
      summary.originalBytes += result.originalBytes;
      summary.compressedBytes += result.compressedBytes;
      if (result.sourceDeleted) summary.removedOriginals++;
    }
  }
  if (options.json) console.log(JSON.stringify({ results, summary }, null, 2));
  else console.log(`完成：转换 ${summary.converted}，已有且一致 ${summary.skipped}，失败 ${summary.failed}，删除原文件 ${summary.removedOriginals}。`);
  return summary.failed > 0 ? 1 : 0;
}
