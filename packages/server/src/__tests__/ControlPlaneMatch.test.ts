import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneMatch } from "../control/ControlPlaneMatch";
import { readMatchRecordFile } from "../RecordFile";

describe("ControlPlaneMatch", () => {
  it("reports a terminal winner as finished through the lobby status", () => {
    const match = new ControlPlaneMatch();
    match.join("player_1");
    match.join("player_2");
    vi.spyOn(match.getGame(), "getWinner").mockReturnValue("player_2");

    expect(match.getLobbyStatus().status).toBe("finished");
    match.stop();
  });

  it("saves one replay-profile Match Record", async () => {
    const recordDir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-control-record-"));
    const match = new ControlPlaneMatch({
      recordDir,
      matchId: "match_external_control",
    });
    match.join("player_1");
    match.join("player_2");
    match.advanceOneTick();
    match.stop();

    const recordPath = await match.saveRecord();
    const record = await readMatchRecordFile(recordPath);

    expect(recordPath).toBe(path.join(recordDir, "match_external_control.match.json"));
    expect(record).toMatchObject({
      recordFormat: "match-record",
      matchId: "match_external_control",
      metadata: {
        recordingProfile: "replay",
        includeTranscript: false,
      },
      finalState: { tick: 1 },
    });
    expect(record.aiTurns).toBeUndefined();
    expect(record.commandResults).toBeUndefined();
    await fs.rm(recordDir, { recursive: true, force: true });
  });
});
