import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactRetentionService } from "../ArtifactRetention";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createArtifact(
  directory: string,
  name: string,
  bytes: number,
  modifiedAt: string,
  protect = false,
): Promise<string> {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, "x".repeat(bytes), "utf8");
  const date = new Date(modifiedAt);
  await fs.utimes(filePath, date, date);
  if (protect) await fs.writeFile(`${filePath}.keep`, "pinned baseline\n", "utf8");
  return filePath;
}

describe("ArtifactRetentionService", () => {
  it("previews age/count/capacity decisions and never selects protected baselines", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-retention-"));
    roots.push(root);
    const pinned = await createArtifact(root, "pinned.trace.json", 8, "2026-01-01T00:00:00.000Z");
    const old = await createArtifact(root, "old.trace.json", 8, "2026-06-01T00:00:00.000Z");
    const middle = await createArtifact(root, "middle.trace.json", 8, "2026-07-14T00:00:00.000Z");
    const newest = await createArtifact(root, "new.trace.json", 8, "2026-07-15T00:00:00.000Z");
    const service = new ArtifactRetentionService({
      now: () => new Date("2026-07-16T00:00:00.000Z"),
      sources: [{
        group: "records",
        directory: root,
        limit: { maxAgeMs: 30 * 24 * 60 * 60 * 1_000, maxEntries: 2, maxBytes: 16 },
        protectedNames: ["pinned.trace.json"],
      }],
    });

    const report = await service.inspect();
    const entries = new Map(report.groups[0]!.entries.map((entry) => [entry.path, entry]));

    expect(report.applied).toBe(false);
    expect(entries.get(pinned)).toMatchObject({ action: "keep", protected: true, reasons: ["protected"] });
    expect(entries.get(old)).toMatchObject({ action: "delete", reasons: expect.arrayContaining(["max_age"]) });
    expect(entries.get(middle)?.action).toBe("delete");
    expect(entries.get(newest)?.action).toBe("keep");
    await expect(fs.access(old)).resolves.toBeUndefined();
  });

  it("deletes only the reported artifacts when apply is explicit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-retention-apply-"));
    roots.push(root);
    const keep = await createArtifact(root, "keep.log", 4, "2026-01-01T00:00:00.000Z", true);
    const remove = await createArtifact(root, "remove.log", 4, "2026-01-01T00:00:00.000Z");
    const service = new ArtifactRetentionService({
      now: () => new Date("2026-07-16T00:00:00.000Z"),
      sources: [{
        group: "llm-debug",
        directory: root,
        limit: { maxAgeMs: 7 * 24 * 60 * 60 * 1_000 },
      }],
    });

    const report = await service.inspect({ apply: true });

    expect(report).toMatchObject({ applied: true, deleteCount: 1, failures: [] });
    await expect(fs.access(remove)).rejects.toThrow();
    await expect(fs.access(keep)).resolves.toBeUndefined();
  });
});
