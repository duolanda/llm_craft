import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const OWNER_METADATA_FILE = "owner.json";
const JOURNAL_METADATA_FILE = "journal.json";
const vitestOwnerDirectories = new Set<string>();
let vitestExitCleanupInstalled = false;

export interface JournalOwnerMetadataV1 {
  version: 1;
  ownerId: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

export interface JournalWorkspaceMetadataV1 {
  version: 1;
  journalId: string;
  matchId: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  state: "active" | "sealed";
  finalizedRecordPath?: string;
}

export interface JournalWorkspace {
  directory: string;
  metadataPath: string;
  metadata: JournalWorkspaceMetadataV1;
}

export type JournalRecoveryReason =
  | "inactive_owner"
  | "sealed_residue"
  | "legacy_unmanaged"
  | "invalid_owner_metadata";

export interface JournalRecoveryEntry {
  sourcePath: string;
  destinationPath?: string;
  ownerId?: string;
  matchIds: string[];
  bytes: number;
  modifiedAt: string;
  reason: JournalRecoveryReason;
  action: "recover" | "retain_live_owner" | "report_legacy";
}

export interface JournalRecoveryReport {
  scannedAt: string;
  dryRun: boolean;
  entries: JournalRecoveryEntry[];
  recoveredCount: number;
  recoveredBytes: number;
}

export interface JournalCleanupResult {
  cleaned: boolean;
  directory: string;
  error?: string;
}

export interface JournalLifecycleOptions {
  journalRootDir?: string;
  recoveryDir?: string;
  ownerId?: string;
  pid?: number;
  hostname?: string;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  legacyGraceMs?: number;
}

/**
 * Owns temporary journal workspaces for one server process. MatchJournal owns
 * stream contents; this service owns directories, crash recovery and cleanup.
 */
export class JournalLifecycleService {
  private readonly journalRootDir: string;
  private readonly recoveryDir: string;
  private readonly ownerId: string;
  private readonly ownerDirectory: string;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly now: () => Date;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly legacyGraceMs: number;
  private ownerInitialized = false;

  constructor(options: JournalLifecycleOptions = {}) {
    this.journalRootDir = options.journalRootDir
      ?? path.join(os.tmpdir(), "llmcraft-match-journals");
    this.recoveryDir = options.recoveryDir
      ?? path.join(os.tmpdir(), "llmcraft-recovered-journals");
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? os.hostname();
    this.now = options.now ?? (() => new Date());
    this.ownerId = sanitizePathSegment(options.ownerId ?? `owner-${this.pid}-${randomUUID()}`);
    this.ownerDirectory = path.join(this.journalRootDir, this.ownerId);
    this.isProcessAlive = options.isProcessAlive ?? isLocalProcessAlive;
    this.legacyGraceMs = options.legacyGraceMs ?? 5 * 60 * 1_000;

    if (process.env.VITEST === "true") {
      vitestOwnerDirectories.add(this.ownerDirectory);
      if (!vitestExitCleanupInstalled) {
        vitestExitCleanupInstalled = true;
        process.once("exit", () => {
          for (const directory of vitestOwnerDirectories) {
            fs.rmSync(directory, { recursive: true, force: true });
          }
        });
      }
    }
  }

  getJournalRootDir(): string {
    return this.journalRootDir;
  }

  getRecoveryDir(): string {
    return this.recoveryDir;
  }

  getOwnerId(): string {
    return this.ownerId;
  }

  createWorkspace(matchId: string): JournalWorkspace {
    this.ensureOwnerDirectory();
    const safeMatchId = sanitizePathSegment(matchId || "match");
    const journalId = `${safeMatchId}-${randomUUID()}`;
    const directory = path.join(this.ownerDirectory, journalId);
    fs.mkdirSync(directory, { recursive: false });
    const now = this.now().toISOString();
    const metadata: JournalWorkspaceMetadataV1 = {
      version: 1,
      journalId,
      matchId,
      ownerId: this.ownerId,
      createdAt: now,
      updatedAt: now,
      state: "active",
    };
    const metadataPath = path.join(directory, JOURNAL_METADATA_FILE);
    writeJsonAtomicSync(metadataPath, metadata);
    return { directory, metadataPath, metadata };
  }

  async sealWorkspace(workspace: JournalWorkspace, finalizedRecordPath: string): Promise<JournalCleanupResult> {
    this.assertOwnedWorkspace(workspace.directory);
    const metadata: JournalWorkspaceMetadataV1 = {
      ...workspace.metadata,
      updatedAt: this.now().toISOString(),
      state: "sealed",
      finalizedRecordPath,
    };
    workspace.metadata = metadata;
    try {
      writeJsonAtomicSync(workspace.metadataPath, metadata);
      await fsPromises.rm(workspace.directory, { recursive: true, force: true });
      await this.removeOwnerDirectoryIfEmpty();
      return { cleaned: true, directory: workspace.directory };
    } catch (error) {
      return {
        cleaned: false,
        directory: workspace.directory,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async discardWorkspace(workspace: JournalWorkspace): Promise<JournalCleanupResult> {
    this.assertOwnedWorkspace(workspace.directory);
    try {
      await fsPromises.rm(workspace.directory, { recursive: true, force: true });
      await this.removeOwnerDirectoryIfEmpty();
      return { cleaned: true, directory: workspace.directory };
    } catch (error) {
      return {
        cleaned: false,
        directory: workspace.directory,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Moves crash leftovers into durable recovery; fresh legacy roots get a short safety grace period. */
  async recoverOrphans(options: { dryRun?: boolean } = {}): Promise<JournalRecoveryReport> {
    const dryRun = options.dryRun ?? false;
    const scannedAt = this.now().toISOString();
    const entries: JournalRecoveryEntry[] = [];
    let rootEntries: fs.Dirent[] = [];
    try {
      rootEntries = await fsPromises.readdir(this.journalRootDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    for (const entry of rootEntries) {
      if (!entry.isDirectory() || entry.name === this.ownerId) continue;
      const sourcePath = path.join(this.journalRootDir, entry.name);
      if (path.resolve(sourcePath) === path.resolve(this.recoveryDir)) continue;
      const ownerMetadata = await readJsonFile<JournalOwnerMetadataV1>(
        path.join(sourcePath, OWNER_METADATA_FILE),
      );
      if (!ownerMetadata || ownerMetadata.version !== 1 || !ownerMetadata.ownerId) {
        const legacy = looksLikeLegacyJournal(sourcePath);
        const stats = await fsPromises.stat(sourcePath);
        const recoverLegacy = legacy && this.now().getTime() - stats.mtimeMs > this.legacyGraceMs;
        const destinationPath = path.join(
          this.recoveryDir,
          `${scannedAt.replace(/[:.]/g, "-")}-legacy-${sanitizePathSegment(entry.name)}`,
        );
        const recoveryEntry = await this.describeRecoveryEntry(sourcePath, {
          ...(recoverLegacy ? { destinationPath } : {}),
          reason: legacy ? "legacy_unmanaged" : "invalid_owner_metadata",
          action: recoverLegacy ? "recover" : "report_legacy",
        });
        entries.push(recoveryEntry);
        if (recoverLegacy && !dryRun) {
          await fsPromises.mkdir(this.recoveryDir, { recursive: true });
          await moveDirectory(sourcePath, destinationPath);
          await fsPromises.writeFile(
            path.join(destinationPath, "recovery.json"),
            JSON.stringify({ version: 1, recoveredAt: scannedAt, ...recoveryEntry }, null, 2),
            "utf8",
          );
        }
        continue;
      }
      if (ownerMetadata.hostname === this.hostname && this.isProcessAlive(ownerMetadata.pid)) {
        entries.push(await this.describeRecoveryEntry(sourcePath, {
          ownerId: ownerMetadata.ownerId,
          reason: "inactive_owner",
          action: "retain_live_owner",
        }));
        continue;
      }

      const journalStates = await readJournalStates(sourcePath);
      const reason: JournalRecoveryReason = journalStates.length > 0
        && journalStates.every((metadata) => metadata.state === "sealed")
        ? "sealed_residue"
        : "inactive_owner";
      const destinationPath = path.join(
        this.recoveryDir,
        `${scannedAt.replace(/[:.]/g, "-")}-${sanitizePathSegment(ownerMetadata.ownerId)}`,
      );
      const recoveryEntry = await this.describeRecoveryEntry(sourcePath, {
        destinationPath,
        ownerId: ownerMetadata.ownerId,
        reason,
        action: "recover",
      });
      entries.push(recoveryEntry);
      if (!dryRun) {
        await fsPromises.mkdir(this.recoveryDir, { recursive: true });
        await moveDirectory(sourcePath, destinationPath);
        await fsPromises.writeFile(
          path.join(destinationPath, "recovery.json"),
          JSON.stringify({ version: 1, recoveredAt: scannedAt, ...recoveryEntry }, null, 2),
          "utf8",
        );
      }
    }

    const recovered = entries.filter((entry) => entry.action === "recover");
    return {
      scannedAt,
      dryRun,
      entries,
      recoveredCount: recovered.length,
      recoveredBytes: recovered.reduce((total, entry) => total + entry.bytes, 0),
    };
  }

  async closeOwner(): Promise<{ closed: boolean; remainingJournalIds: string[] }> {
    let names: string[] = [];
    try {
      names = await fsPromises.readdir(this.ownerDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { closed: true, remainingJournalIds: [] };
      }
      throw error;
    }
    const remainingJournalIds = names.filter((name) => name !== OWNER_METADATA_FILE);
    if (remainingJournalIds.length > 0) {
      return { closed: false, remainingJournalIds };
    }
    await fsPromises.rm(this.ownerDirectory, { recursive: true, force: true });
    this.ownerInitialized = false;
    return { closed: true, remainingJournalIds: [] };
  }

  private ensureOwnerDirectory(): void {
    if (this.ownerInitialized && fs.existsSync(this.ownerDirectory)) return;
    fs.mkdirSync(this.ownerDirectory, { recursive: true });
    const metadata: JournalOwnerMetadataV1 = {
      version: 1,
      ownerId: this.ownerId,
      pid: this.pid,
      hostname: this.hostname,
      startedAt: this.now().toISOString(),
    };
    writeJsonAtomicSync(path.join(this.ownerDirectory, OWNER_METADATA_FILE), metadata);
    this.ownerInitialized = true;
  }

  private async removeOwnerDirectoryIfEmpty(): Promise<void> {
    const names = await fsPromises.readdir(this.ownerDirectory).catch(() => [] as string[]);
    if (names.every((name) => name === OWNER_METADATA_FILE)) {
      await fsPromises.rm(this.ownerDirectory, { recursive: true, force: true });
      this.ownerInitialized = false;
    }
  }

  private assertOwnedWorkspace(directory: string): void {
    const relative = path.relative(this.ownerDirectory, directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Journal workspace is not owned by ${this.ownerId}: ${directory}`);
    }
  }

  private async describeRecoveryEntry(
    sourcePath: string,
    partial: Pick<JournalRecoveryEntry, "reason" | "action"> & Partial<JournalRecoveryEntry>,
  ): Promise<JournalRecoveryEntry> {
    const stats = await fsPromises.stat(sourcePath);
    const journalStates = await readJournalStates(sourcePath);
    return {
      sourcePath,
      matchIds: journalStates.map((metadata) => metadata.matchId),
      bytes: await directorySize(sourcePath),
      modifiedAt: stats.mtime.toISOString(),
      reason: partial.reason,
      action: partial.action,
      ...(partial.destinationPath ? { destinationPath: partial.destinationPath } : {}),
      ...(partial.ownerId ? { ownerId: partial.ownerId } : {}),
    };
  }
}

let defaultLifecycle: JournalLifecycleService | null = null;

export function getDefaultJournalLifecycleService(): JournalLifecycleService {
  defaultLifecycle ??= new JournalLifecycleService();
  return defaultLifecycle;
}

async function readJournalStates(ownerDirectory: string): Promise<JournalWorkspaceMetadataV1[]> {
  const entries = await fsPromises.readdir(ownerDirectory, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
  const states: JournalWorkspaceMetadataV1[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metadata = await readJsonFile<JournalWorkspaceMetadataV1>(
      path.join(ownerDirectory, entry.name, JOURNAL_METADATA_FILE),
    );
    if (metadata?.version === 1) states.push(metadata);
  }
  return states;
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

async function moveDirectory(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await fsPromises.rename(sourcePath, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fsPromises.cp(sourcePath, destinationPath, { recursive: true, errorOnExist: true });
    await fsPromises.rm(sourcePath, { recursive: true, force: true });
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomicSync(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function looksLikeLegacyJournal(directory: string): boolean {
  return fs.existsSync(path.join(directory, "manifest.json"))
    || fs.existsSync(path.join(directory, "domain-events.ndjson"))
    || fs.existsSync(path.join(directory, "terminal-events.ndjson"))
    || fs.existsSync(path.join(directory, "replay-deltas.ndjson"));
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "-");
  return sanitized || "journal";
}

function isLocalProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
