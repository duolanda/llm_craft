import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GameOrchestrator } from "../GameOrchestrator";
import type { MatchRuntime } from "../MatchRuntime";
import { ControlPlaneMatch } from "../control/ControlPlaneMatch";
import { readMatchRecordFile } from "../RecordFile";

type ContractHandle = {
  runtime: MatchRuntime;
  saveRecord(): Promise<string>;
};

const openAIConfig = {
  providerType: "openai-compatible" as const,
  apiKey: "contract-test-key",
  baseURL: "https://contract.invalid/v1",
  model: "contract-model",
};

describe("Match entry-point contract", () => {
  const entryPoints: Array<{
    name: string;
    create(recordDir: string): ContractHandle;
  }> = [
    {
      name: "live",
      create: (recordDir) => {
        const orchestrator = new GameOrchestrator({
          player1: openAIConfig,
          player2: openAIConfig,
          runtime: { recordDir },
        });
        return {
          runtime: orchestrator.getMatchRuntime(),
          saveRecord: () => orchestrator.saveRecord(),
        };
      },
    },
    {
      name: "cli",
      create: (recordDir) => {
        const match = new ControlPlaneMatch({ recordDir });
        return {
          runtime: match.getMatchRuntime(),
          saveRecord: () => match.saveRecord(),
        };
      },
    },
    {
      name: "benchmark",
      create: (recordDir) => {
        const orchestrator = new GameOrchestrator({
          player1: openAIConfig,
          player2: { providerType: "builtin-cpu", strategy: "rush" },
          runtime: { recordDir },
        });
        return {
          runtime: orchestrator.getMatchRuntime(),
          saveRecord: () => orchestrator.saveRecord(),
        };
      },
    },
  ];

  it.each(entryPoints)("applies the same runtime/Match Record contract through $name", async ({ create }) => {
    const recordDir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-entry-contract-"));
    const handle = create(recordDir);
    const game = handle.runtime.getGame();
    const worker = game.getState().players[0]!.units[0]!;

    handle.runtime.start();
    expect(handle.runtime.submitCommands("player_1", [{
      id: "contract_hold",
      type: "hold",
      playerId: "player_1",
      unitId: worker.id,
    }], { clientRequestId: "contract_request" })).toMatchObject({ accepted: true });
    handle.runtime.advanceOneTick();
    handle.runtime.stop();

    const filePath = await handle.saveRecord();
    const record = await readMatchRecordFile(filePath);
    expect(filePath).toMatch(/\.match\.zst$/);
    expect(record.definition).toMatchObject({
      rulesetId: "standard",
      map: {
        id: "standard",
        playerStarts: [
          expect.objectContaining({ playerId: "player_1" }),
          expect.objectContaining({ playerId: "player_2" }),
        ],
      },
    });
    expect(record.initialState.tick).toBe(0);
    expect(record.finalState.tick).toBe(1);
    expect(record.tickDeltas).toHaveLength(1);

    await fs.rm(recordDir, { recursive: true, force: true });
  });
});
