import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneMatch } from "../control/ControlPlaneMatch";
import { readMatchRecordFile } from "../RecordFile";
import { CLIControllerAdapter } from "../controller/CLIControllerAdapter";
import { executeControlTool } from "../ControlHandler";

describe("ControlPlaneMatch", () => {
  it("dispatches the built-in CPU at ticks 0 and 10 by default", async () => {
    const match = new ControlPlaneMatch({ cpuStrategy: "rush" });
    const cpuRun = vi.fn(async (input: { tick: number }) => ({
      assistantMessages: [],
      toolCalls: [],
      plans: [],
      commands: [],
      stopReason: "cpu_turn_complete",
      metrics: { modelRequests: 0, toolCalls: 0 },
    }));
    (match as any).cpu.controller.run = cpuRun;

    match.join("player_1");
    await Promise.resolve();
    expect(match.getCPUDecisionIntervalTicks()).toBe(10);
    expect(cpuRun.mock.calls.map(([input]) => input.tick)).toEqual([0]);

    for (let tick = 1; tick < 10; tick += 1) {
      match.advanceOneTick();
      await Promise.resolve();
    }
    expect(cpuRun.mock.calls.map(([input]) => input.tick)).toEqual([0]);

    match.advanceOneTick();
    await Promise.resolve();
    expect(cpuRun.mock.calls.map(([input]) => input.tick)).toEqual([0, 10]);
    match.stop();
  });

  it("reports a terminal winner as finished through the lobby status", () => {
    const match = new ControlPlaneMatch();
    match.join("player_1");
    match.join("player_2");
    vi.spyOn(match.getGame(), "getWinner").mockReturnValue("player_2");

    expect(match.getLobbyStatus().status).toBe("finished");
    match.stop();
  });

  it("saves control matches with evaluation command results by default", async () => {
    const recordDir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-control-record-"));
    const match = new ControlPlaneMatch({
      recordDir,
      matchId: "match_external_control",
    });
    match.join("player_1");
    match.join("player_2");
    const controller = match.getGameplayController("player_1");
    const worker = match.getGame().getState().players[0].units[0];
    executeControlTool(
      new CLIControllerAdapter("player_1", controller, "record-test"),
      "move_unit",
      { unitIds: [worker.id], x: worker.x + 1, y: worker.y },
    );
    match.advanceOneTick();
    match.stop();

    const recordPath = await match.saveRecord();
    const record = await readMatchRecordFile(recordPath);

    expect(path.dirname(recordPath)).toBe(recordDir);
    expect(path.basename(recordPath)).toMatch(/^match-\d{4}-\d{2}-\d{2}T.*-external\.match\.json$/);
    expect(record).toMatchObject({
      recordFormat: "match-record",
      matchId: "match_external_control",
      metadata: {
        recordingProfile: "evaluation",
        includeTranscript: false,
      },
      finalState: { tick: 1 },
    });
    expect(record.aiTurns).toEqual([]);
    expect(record.commandResults).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          command: expect.objectContaining({
            type: "move",
            provenance: expect.objectContaining({ controllerId: "cli:record-test", source: "external" }),
          }),
        }),
      }),
    ]);
    await fs.rm(recordDir, { recursive: true, force: true });
  });
});
