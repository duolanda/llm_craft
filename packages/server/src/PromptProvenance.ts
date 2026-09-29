import fs from "node:fs/promises";
import path from "node:path";
import type { StrategyPrompt, StrategyPromptVersion, StrategyPromptVersionProvenance } from "@llmcraft/shared";
import { readRecordJsonText } from "./RecordFile";

interface RecordOrigin {
  fileName: string;
  models: Map<string, string>;
}

function reflectionOrigin(prompt: StrategyPrompt, version: StrategyPromptVersion): StrategyPromptVersion {
  const seen = new Set<string>();
  let current = version;
  while (current.source !== "reflection" && current.basedOnVersionId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = prompt.versions.find((item) => item.id === current.basedOnVersionId);
    if (!parent || seen.has(parent.id)) break;
    current = parent;
  }
  return current.source === "reflection" ? current : version;
}

/** Resolve only matching filenames, then verify the full match id inside the record. */
async function findRecordOrigin(directory: string, files: readonly string[], matchId: string): Promise<RecordOrigin | undefined> {
  const suffix = /^match_([a-f0-9]{8})-/i.exec(matchId)?.[1];
  if (!suffix) return undefined;
  const candidates = files.filter((file) => file.endsWith(`-${suffix}.match.json`) || file.endsWith(`-${suffix}.match.json.gz`)).sort().reverse();
  for (const fileName of candidates) {
    try {
      const record = JSON.parse(await readRecordJsonText(path.join(directory, fileName))) as {
        recordFormat?: unknown;
        matchId?: unknown;
        metadata?: { players?: unknown };
      } | null;
      if (record?.recordFormat !== "match-record" || record.matchId !== matchId) continue;
      const models = new Map<string, string>();
      if (Array.isArray(record.metadata?.players)) {
        for (const player of record.metadata.players as unknown[]) {
          if (typeof player !== "object" || player === null) continue;
          if ("playerId" in player && typeof player.playerId === "string" && "model" in player && typeof player.model === "string") {
            models.set(player.playerId, player.model);
          }
        }
      }
      return { fileName, models };
    } catch (error) {
      // A removed/corrupt record must not prevent reading the strategy library.
      const code = (error as NodeJS.ErrnoException).code;
      if (!(error instanceof SyntaxError) && code !== "ENOENT" && code !== "Z_DATA_ERROR" && code !== "Z_BUF_ERROR") throw error;
    }
  }
  return undefined;
}

/** Read-only projection; metadata stays per revision and old strategy files need no migration. */
export async function getPromptProvenance(prompt: StrategyPrompt, recordsDirectory: string): Promise<Record<string, StrategyPromptVersionProvenance>> {
  const entries = await fs.readdir(recordsDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const records = new Map<string, Promise<RecordOrigin | undefined>>();
  return Object.fromEntries(await Promise.all(prompt.versions.map(async (version) => {
    const source = reflectionOrigin(prompt, version);
    if (source.matchId && !records.has(source.matchId)) records.set(source.matchId, findRecordOrigin(recordsDirectory, files, source.matchId));
    const record = source.matchId ? await records.get(source.matchId) : undefined;
    const model = source.model || (source.playerId ? record?.models.get(source.playerId) : undefined);
    return [version.id, {
      sourceVersionId: source.id,
      sourceVersion: source.version,
      ...(model ? { model } : {}),
      ...(source.matchId ? { matchId: source.matchId } : {}),
      ...(source.playerId ? { playerId: source.playerId } : {}),
      ...(record ? { recordFileName: record.fileName } : {}),
    } satisfies StrategyPromptVersionProvenance];
  })));
}
