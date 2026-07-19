import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JournalLifecycleService } from "../JournalLifecycle";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-journal-lifecycle-"));
  roots.push(root);
  return root;
}

describe("JournalLifecycleService", () => {
  it("creates collision-safe workspaces without truncating a previous same-match journal", async () => {
    const root = await createRoot();
    const service = new JournalLifecycleService({
      journalRootDir: root,
      recoveryDir: path.join(root, "recovery"),
      ownerId: "owner-current",
    });
    const first = service.createWorkspace("match_same");
    await fs.writeFile(path.join(first.directory, "evidence.ndjson"), "first\n", "utf8");
    const second = service.createWorkspace("match_same");

    expect(second.directory).not.toBe(first.directory);
    await expect(fs.readFile(path.join(first.directory, "evidence.ndjson"), "utf8"))
      .resolves.toBe("first\n");
  });

  it("seals a finalized workspace and removes an empty owner directory", async () => {
    const root = await createRoot();
    const service = new JournalLifecycleService({
      journalRootDir: root,
      recoveryDir: path.join(root, "recovery"),
      ownerId: "owner-current",
    });
    const workspace = service.createWorkspace("match_final");

    const result = await service.sealWorkspace(workspace, "/records/match_final.trace.json");

    expect(result.cleaned).toBe(true);
    await expect(fs.access(workspace.directory)).rejects.toThrow();
    await expect(fs.access(path.join(root, "owner-current"))).rejects.toThrow();
  });

  it("moves journals from a dead owner into durable recovery and records provenance", async () => {
    const root = await createRoot();
    const recoveryDir = path.join(root, "recovered");
    const crashed = new JournalLifecycleService({
      journalRootDir: root,
      recoveryDir,
      ownerId: "owner-crashed",
      pid: 12345,
      hostname: "test-host",
      isProcessAlive: () => false,
    });
    const workspace = crashed.createWorkspace("match_crashed");
    await fs.writeFile(path.join(workspace.directory, "domain-events.ndjson"), "evidence\n", "utf8");
    const current = new JournalLifecycleService({
      journalRootDir: root,
      recoveryDir,
      ownerId: "owner-current",
      pid: 23456,
      hostname: "test-host",
      isProcessAlive: () => false,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    });

    const preview = await current.recoverOrphans({ dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, recoveredCount: 1 });
    expect(preview.entries[0]).toMatchObject({
      ownerId: "owner-crashed",
      matchIds: ["match_crashed"],
      reason: "inactive_owner",
      action: "recover",
    });
    await expect(fs.access(workspace.directory)).resolves.toBeUndefined();

    const applied = await current.recoverOrphans();
    const destination = applied.entries[0]!.destinationPath!;
    await expect(fs.readFile(path.join(destination, "recovery.json"), "utf8"))
      .resolves.toContain("match_crashed");
    await expect(fs.access(workspace.directory)).rejects.toThrow();
  });

  it("reports legacy unmanaged directories without moving or deleting them", async () => {
    const root = await createRoot();
    const legacy = path.join(root, "match_legacy");
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, "manifest.json"), "{}", "utf8");
    const current = new JournalLifecycleService({
      journalRootDir: root,
      recoveryDir: path.join(root, "recovery"),
      ownerId: "owner-current",
    });

    const report = await current.recoverOrphans();

    expect(report.entries).toEqual([
      expect.objectContaining({ reason: "legacy_unmanaged", action: "report_legacy" }),
    ]);
    await expect(fs.access(legacy)).resolves.toBeUndefined();
  });

  it("recovers legacy journals after the safety grace period", async () => {
    const root = await createRoot();
    const legacy = path.join(root, "match_old_legacy");
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, "manifest.json"), "{}", "utf8");
    const old = new Date("2026-07-15T22:00:00.000Z");
    await fs.utimes(legacy, old, old);
    const current = new JournalLifecycleService({
      journalRootDir: root,
      recoveryDir: path.join(root, "recovery"),
      ownerId: "owner-current",
      now: () => new Date("2026-07-16T00:00:00.000Z"),
      legacyGraceMs: 5 * 60 * 1_000,
    });

    const report = await current.recoverOrphans();

    expect(report.entries).toEqual([
      expect.objectContaining({ reason: "legacy_unmanaged", action: "recover" }),
    ]);
    await expect(fs.access(legacy)).rejects.toThrow();
    await expect(fs.access(report.entries[0]!.destinationPath!)).resolves.toBeUndefined();
  });
});
