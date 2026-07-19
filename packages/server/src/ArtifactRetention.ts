import fsPromises from "node:fs/promises";
import path from "node:path";

export type ArtifactGroup =
  | "records"
  | "benchmark-records"
  | "llm-debug"
  | "benchmark-llm-debug"
  | "orphan-journals";

export interface ArtifactRetentionLimit {
  maxAgeMs?: number;
  maxEntries?: number;
  maxBytes?: number;
}

export interface ArtifactRetentionSource {
  group: ArtifactGroup;
  directory: string;
  limit: ArtifactRetentionLimit;
  protectedNames?: string[];
}

export interface ArtifactRetentionEntry {
  group: ArtifactGroup;
  path: string;
  bytes: number;
  modifiedAt: string;
  protected: boolean;
  action: "keep" | "delete";
  reasons: Array<"max_age" | "max_entries" | "max_bytes" | "protected">;
}

export interface ArtifactRetentionGroupReport {
  group: ArtifactGroup;
  directory: string;
  limit: ArtifactRetentionLimit;
  entries: ArtifactRetentionEntry[];
  totalBytes: number;
  deleteBytes: number;
  remainingBytes: number;
  overLimitAfterCleanup: boolean;
}

export interface ArtifactRetentionReport {
  generatedAt: string;
  applied: boolean;
  groups: ArtifactRetentionGroupReport[];
  deleteCount: number;
  deleteBytes: number;
  failures: Array<{ path: string; error: string }>;
}

export interface ArtifactRetentionOptions {
  sources: ArtifactRetentionSource[];
  now?: () => Date;
}

/** Plans first and mutates only when apply=true. A sibling `<artifact>.keep` file protects files. */
export class ArtifactRetentionService {
  private readonly sources: ArtifactRetentionSource[];
  private readonly now: () => Date;

  constructor(options: ArtifactRetentionOptions) {
    this.sources = options.sources.map((source) => ({
      ...source,
      limit: validateLimit(source.group, source.limit),
    }));
    this.now = options.now ?? (() => new Date());
  }

  async inspect(options: { apply?: boolean; groups?: ArtifactGroup[] } = {}): Promise<ArtifactRetentionReport> {
    const applied = options.apply ?? false;
    const now = this.now();
    const selectedGroups = options.groups ? new Set(options.groups) : null;
    const groups = await Promise.all(this.sources
      .filter((source) => !selectedGroups || selectedGroups.has(source.group))
      .map((source) => this.inspectSource(source, now)));
    const failures: ArtifactRetentionReport["failures"] = [];
    if (applied) {
      for (const entry of groups.flatMap((group) => group.entries)) {
        if (entry.action !== "delete") continue;
        try {
          await fsPromises.rm(entry.path, { recursive: true, force: true });
          await fsPromises.rm(`${entry.path}.keep`, { force: true });
        } catch (error) {
          failures.push({
            path: entry.path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const deleted = groups.flatMap((group) => group.entries).filter((entry) => entry.action === "delete");
    return {
      generatedAt: now.toISOString(),
      applied,
      groups,
      deleteCount: deleted.length,
      deleteBytes: deleted.reduce((total, entry) => total + entry.bytes, 0),
      failures,
    };
  }

  private async inspectSource(
    source: ArtifactRetentionSource,
    now: Date,
  ): Promise<ArtifactRetentionGroupReport> {
    const artifacts = await listTopLevelArtifacts(
      source.group,
      source.directory,
      new Set(source.protectedNames ?? []),
    );
    const sorted = artifacts.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    const decisions = sorted.map((artifact): ArtifactRetentionEntry => ({
      ...artifact,
      action: "keep",
      reasons: artifact.protected ? ["protected"] : [],
    }));
    const nowMs = now.getTime();
    if (source.limit.maxAgeMs !== undefined) {
      for (const entry of decisions) {
        if (!entry.protected && nowMs - Date.parse(entry.modifiedAt) > source.limit.maxAgeMs) {
          markForDeletion(entry, "max_age");
        }
      }
    }
    if (source.limit.maxEntries !== undefined) {
      let retained = 0;
      for (const entry of decisions) {
        if (entry.action === "delete") continue;
        retained += 1;
        if (retained > source.limit.maxEntries && !entry.protected) {
          markForDeletion(entry, "max_entries");
        }
      }
    }
    if (source.limit.maxBytes !== undefined) {
      let retainedBytes = decisions
        .filter((entry) => entry.action === "keep")
        .reduce((total, entry) => total + entry.bytes, 0);
      for (const entry of [...decisions].reverse()) {
        if (retainedBytes <= source.limit.maxBytes) break;
        if (entry.action === "delete" || entry.protected) continue;
        markForDeletion(entry, "max_bytes");
        retainedBytes -= entry.bytes;
      }
    }

    const totalBytes = decisions.reduce((total, entry) => total + entry.bytes, 0);
    const deleteBytes = decisions
      .filter((entry) => entry.action === "delete")
      .reduce((total, entry) => total + entry.bytes, 0);
    const remaining = decisions.filter((entry) => entry.action === "keep");
    const remainingBytes = totalBytes - deleteBytes;
    return {
      group: source.group,
      directory: source.directory,
      limit: source.limit,
      entries: decisions,
      totalBytes,
      deleteBytes,
      remainingBytes,
      overLimitAfterCleanup: (
        (source.limit.maxEntries !== undefined && remaining.length > source.limit.maxEntries)
        || (source.limit.maxBytes !== undefined && remainingBytes > source.limit.maxBytes)
      ),
    };
  }
}

async function listTopLevelArtifacts(
  group: ArtifactGroup,
  directory: string,
  protectedNames: ReadonlySet<string>,
): Promise<Array<Omit<ArtifactRetentionEntry, "action" | "reasons">>> {
  let entries;
  try {
    entries = await fsPromises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const artifacts: Array<Omit<ArtifactRetentionEntry, "action" | "reasons">> = [];
  for (const entry of entries) {
    if (entry.name.endsWith(".keep") || entry.name === ".gitkeep") continue;
    const artifactPath = path.join(directory, entry.name);
    const stats = await fsPromises.stat(artifactPath);
    artifacts.push({
      group,
      path: artifactPath,
      bytes: entry.isDirectory() ? await directorySize(artifactPath) : stats.size,
      modifiedAt: stats.mtime.toISOString(),
      protected: protectedNames.has(entry.name)
        || await isProtectedArtifact(artifactPath, entry.isDirectory()),
    });
  }
  return artifacts;
}

async function isProtectedArtifact(artifactPath: string, directory: boolean): Promise<boolean> {
  const markerPath = directory
    ? path.join(artifactPath, ".llmcraft-keep")
    : `${artifactPath}.keep`;
  try {
    await fsPromises.access(markerPath);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  const entries = await fsPromises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(entryPath);
    else if (entry.isFile()) total += (await fsPromises.stat(entryPath)).size;
  }
  return total;
}

function markForDeletion(
  entry: ArtifactRetentionEntry,
  reason: "max_age" | "max_entries" | "max_bytes",
): void {
  entry.action = "delete";
  if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
}

function validateLimit(group: ArtifactGroup, limit: ArtifactRetentionLimit): ArtifactRetentionLimit {
  for (const [key, value] of Object.entries(limit)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Invalid ${group} retention ${key}: ${value}`);
    }
  }
  return { ...limit };
}
