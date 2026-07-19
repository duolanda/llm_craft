import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectTraceV3ToGameRecord } from "@llmcraft/trace";
import { ControlPlaneMatch } from "../control/ControlPlaneMatch";
import { JournalLifecycleService } from "../JournalLifecycle";
import { readTraceRecordFile } from "../TraceFile";

describe("ControlPlaneMatch recording", () => {
  it("saves the same Trace v3 contract as live matches", async () => {
    const recordDir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-control-record-"));
    const journalRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-control-journal-"));
    const match = new ControlPlaneMatch({
      recordDir,
      matchId: "match_external_control",
      journalLifecycle: new JournalLifecycleService({
        journalRootDir,
        recoveryDir: path.join(journalRootDir, "recovery"),
        ownerId: "owner-control-test",
      }),
    });
    const workspaceDirectory = match.getMatchRuntime().getJournal().getWorkspaceDirectory();
    match.getMatchRuntime().getJournal().appendTerminalEvent({
      id: "evt_1",
      kind: "request",
      playerId: "player_1",
      requestNumber: 1,
      requestTick: 0,
      createdAt: "2026-07-16T00:00:00.000Z",
    });
    match.join("player_1");
    match.join("player_2");
    match.advanceOneTick();
    match.stop();

    const recordPath = await match.saveRecord();
    const trace = await readTraceRecordFile(recordPath);
    const replay = projectTraceV3ToGameRecord(trace);

    expect(trace.manifest.matchId).toBe("match_external_control");
    expect(trace.stateHashes.map((entry) => entry.tick)).toEqual([0, 1]);
    expect(replay.metadata.players).toEqual([
      expect.objectContaining({ playerId: "player_1", model: "external-controller" }),
      expect.objectContaining({ playerId: "player_2", model: "external-controller" }),
    ]);
    expect(replay.finalState.tick).toBe(1);
    await expect(fs.access(workspaceDirectory)).rejects.toThrow();
    await expect(match.getMatchRuntime().getJournal().readTerminalHistory(2, 10)).resolves.toMatchObject({
      events: [expect.objectContaining({ id: "evt_1" })],
      hasMore: false,
    });
    await fs.rm(recordDir, { recursive: true, force: true });
    await fs.rm(journalRootDir, { recursive: true, force: true });
  });
});
