import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GameOrchestrator } from "../GameOrchestrator";
import type { MatchRuntime } from "../MatchRuntime";
import { ControlPlaneMatch } from "../control/ControlPlaneMatch";
import { readTraceRecordFile } from "../TraceFile";

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

  it.each(entryPoints)("applies the same runtime/Trace contract through $name", async ({ create }) => {
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
    const trace = await readTraceRecordFile(filePath);
    expect(filePath).toMatch(/\.trace\.json\.gz$/);
    expect(trace.manifest.definition).toMatchObject({
      definitionVersion: 2,
      rules: { schemaVersion: 1, commandBudget: { maxCommandsPerActorPerTick: 100 } },
    });
    expect(trace.commandSubmissions).toHaveLength(1);
    expect(trace.domainEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "command_envelope_released", actorId: "player_1" }),
      expect.objectContaining({ type: "command_result", commandId: "contract_hold" }),
    ]));
    expect(trace.replayProjection?.commandResults).toEqual([
      expect.objectContaining({ type: "command_result", data: expect.objectContaining({ type: "hold_success" }) }),
    ]);
    expect(trace.stateHashes.map((entry) => entry.tick)).toEqual([0, 1]);

    await fs.rm(recordDir, { recursive: true, force: true });
  });
});
