import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptStore } from "../PromptStore";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createStore(): Promise<PromptStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-prompts-"));
  tempDirs.push(dir);
  return new PromptStore({ filePath: path.join(dir, "strategy-prompts.json") });
}

describe("PromptStore", () => {
  it("keeps immutable user revisions and can reactivate an older one", async () => {
    const store = await createStore();
    const created = await store.create({ name: "Rush", content: "Build infantry early." });
    const firstVersion = created.versions[0]!;

    const updated = await store.update(created.id, {
      name: "Measured rush",
      content: "Build infantry early, then scout before committing.",
    });

    expect(updated.versions).toHaveLength(2);
    expect(updated.versions[0]).toEqual(firstVersion);
    expect(updated.activeVersionId).toBe(updated.versions[1]?.id);

    const restored = await store.activateVersion(created.id, firstVersion.id);
    expect(restored.activeVersionId).toBe(firstVersion.id);
    expect(restored.versions).toHaveLength(2);
  });

  it("stores reflected revisions as inactive candidates with match provenance", async () => {
    const store = await createStore();
    const created = await store.create({ name: "Armor", content: "Prioritize tanks." });
    const baseVersion = created.versions[0]!;

    const candidate = await store.addVersion(created.id, {
      title: "装甲协同压制",
      model: "actual-response-model",
      content: "Protect the tank timing with anti-infantry support.",
      source: "reflection",
      basedOnVersionId: baseVersion.id,
      matchId: "match_example",
      playerId: "player_2",
      activate: false,
    });
    const [stored] = await store.list();

    expect(stored?.activeVersionId).toBe(baseVersion.id);
    expect(candidate).toMatchObject({
      title: "装甲协同压制",
      model: "actual-response-model",
      version: 2,
      source: "reflection",
      basedOnVersionId: baseVersion.id,
      matchId: "match_example",
      playerId: "player_2",
    });
  });

  it("can seed a named strategy directly from a post-match reflection", async () => {
    const store = await createStore();

    const created = await store.createFromReflection({
      name: "Red review",
      model: "first-response-model",
      content: "Scout before committing the main force.",
      matchId: "match_seed",
      playerId: "player_1",
    });

    expect(created.activeVersionId).toBe(created.versions[0]?.id);
    expect(created.versions[0]).toMatchObject({
      title: "Red review",
      model: "first-response-model",
      version: 1,
      source: "reflection",
      matchId: "match_seed",
      playerId: "player_1",
    });

    const renamed = await store.update(created.id, { name: "侦察后推进" });
    expect(renamed.name).toBe("侦察后推进");
    expect(renamed.versions).toEqual(created.versions);
    expect(renamed.activeVersionId).toBe(created.activeVersionId);
  });

  it("resolves the exact selected revision even when it is not active", async () => {
    const store = await createStore();
    const created = await store.create({ name: "Economy", content: "Use the original plan." });
    const original = created.versions[0]!;
    await store.update(created.id, { content: "Use the newer plan." });

    const resolved = await store.resolve({
      promptId: created.id,
      versionId: original.id,
    });

    expect(resolved.content).toBe("Use the original plan.");
    expect(resolved.snapshot).toMatchObject({
      promptId: created.id,
      promptName: "Economy",
      versionId: original.id,
      version: 1,
    });
  });
});
