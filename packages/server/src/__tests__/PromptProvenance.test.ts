import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { StrategyPrompt, StrategyPromptVersion } from "@llmcraft/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getPromptProvenance } from "../PromptProvenance";

const tempDirs: string[] = [];
const firstMatch = "match_12345678-1111-4111-8111-111111111111";
const secondMatch = "match_87654321-2222-4222-8222-222222222222";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createDirectory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-prompt-provenance-"));
  tempDirs.push(dir);
  return dir;
}

function version(number: number, fields: Partial<StrategyPromptVersion> = {}): StrategyPromptVersion {
  return { id: `version-${number}`, version: number, content: `strategy ${number}`, source: "reflection", createdAt: "2026-09-05T08:55:44.435Z", ...fields };
}

function prompt(versions: StrategyPromptVersion[]): StrategyPrompt {
  return { id: "prompt", name: "arbitrary name, not a model", versions, activeVersionId: versions[0]!.id, createdAt: versions[0]!.createdAt, updatedAt: versions[0]!.createdAt };
}

async function writeRecord(dir: string, fileName: string, matchId: string, players: unknown): Promise<void> {
  const content = JSON.stringify({ recordFormat: "match-record", matchId, metadata: { players } });
  await fs.writeFile(path.join(dir, fileName), fileName.endsWith(".gz") ? gzipSync(content) : content);
}

describe("prompt provenance", () => {
  it("resolves each reflection's own record and model without altering immutable revisions", async () => {
    const dir = await createDirectory();
    const firstFile = "match-2026-09-05T02-31-39-512Z-12345678.match.json";
    const secondFile = "match-2026-09-05T08-53-59-853Z-87654321.match.json.gz";
    await writeRecord(dir, firstFile, firstMatch, [{ playerId: "player_1", model: "original-model", baseURL: "private-endpoint" }]);
    await writeRecord(dir, secondFile, secondMatch, [{ playerId: "player_1", model: "configured-alias" }]);
    const strategy = prompt([
      version(1, { matchId: firstMatch, playerId: "player_1" }),
      version(2, { basedOnVersionId: "version-1", matchId: secondMatch, playerId: "player_1", model: "actual-response-model" }),
    ]);
    const before = structuredClone(strategy);

    expect(await getPromptProvenance(strategy, dir)).toEqual({
      "version-1": { sourceVersionId: "version-1", sourceVersion: 1, model: "original-model", matchId: firstMatch, playerId: "player_1", recordFileName: firstFile },
      "version-2": { sourceVersionId: "version-2", sourceVersion: 2, model: "actual-response-model", matchId: secondMatch, playerId: "player_1", recordFileName: secondFile },
    });
    expect(strategy).toEqual(before);
  });

  it("follows edited and translated versions back to their own side's AI reflection", async () => {
    const dir = await createDirectory();
    const fileName = "match-2026-09-05T00-00-00-000Z-12345678.match.json";
    await writeRecord(dir, fileName, firstMatch, [{ playerId: "player_1", model: "red-model" }, { playerId: "player_2", model: "blue-model" }]);
    const strategy = prompt([
      version(1, { matchId: firstMatch, playerId: "player_2" }),
      version(2, { source: "user", basedOnVersionId: "version-1" }),
      version(3, { source: "user", basedOnVersionId: "version-2" }),
    ]);

    const result = await getPromptProvenance(strategy, dir);
    expect(result["version-3"]).toEqual(result["version-1"]);
    expect(result["version-2"]).toMatchObject({ sourceVersionId: "version-1", sourceVersion: 1, model: "blue-model", playerId: "player_2", recordFileName: fileName });
  });

  it("verifies the full match id and skips corrupt files instead of using a short-id collision", async () => {
    const dir = await createDirectory();
    const correctFile = "match-2026-09-05T01-00-00-000Z-12345678.match.json";
    await writeRecord(dir, correctFile, firstMatch, [null, "invalid-player", { playerId: "player_1", model: "right-model" }]);
    await writeRecord(dir, "match-2026-09-05T02-00-00-000Z-12345678.match.json", firstMatch.replace("111111111111", "222222222222"), [{ playerId: "player_1", model: "wrong-model" }]);
    await fs.writeFile(path.join(dir, "match-2026-09-05T03-00-00-000Z-12345678.match.json"), "invalid json");
    await fs.writeFile(path.join(dir, "match-2026-09-05T04-00-00-000Z-12345678.match.json.gz"), Buffer.from([0x1f, 0x8b, 0x08]));

    const result = await getPromptProvenance(prompt([version(1, { matchId: firstMatch, playerId: "player_1" })]), dir);
    expect(result["version-1"]).toMatchObject({ model: "right-model", recordFileName: correctFile });
  });

  it("keeps known metadata when recordings are unavailable, without inventing the model or filename", async () => {
    const dir = path.join(await createDirectory(), "not-created");
    const result = await getPromptProvenance(prompt([
      version(1, { matchId: firstMatch, playerId: "player_1", model: "known-model" }),
      version(2, { matchId: secondMatch, playerId: "player_2" }),
    ]), dir);
    expect(result["version-1"]).toEqual({ sourceVersionId: "version-1", sourceVersion: 1, matchId: firstMatch, playerId: "player_1", model: "known-model" });
    expect(result["version-2"]).toEqual({ sourceVersionId: "version-2", sourceVersion: 2, matchId: secondMatch, playerId: "player_2" });
  });

  it("does not attribute purely manual, missing-parent or cyclic histories to an AI", async () => {
    const dir = await createDirectory();
    const strategy = prompt([
      version(1, { source: "user" }),
      version(2, { source: "user", basedOnVersionId: "version-1" }),
      version(3, { source: "user", basedOnVersionId: "missing" }),
      version(4, { source: "user", basedOnVersionId: "version-5" }),
      version(5, { source: "user", basedOnVersionId: "version-4" }),
    ]);
    const result = await getPromptProvenance(strategy, dir);
    for (const item of strategy.versions) expect(result[item.id]).toEqual({ sourceVersionId: item.id, sourceVersion: item.version });
  });
});
