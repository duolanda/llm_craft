import { describe, expect, it, vi } from "vitest";
import { Game } from "../Game";
import { MatchRegistry, type RegisteredMatchHandle } from "../MatchRegistry";

function createHandle(matchId: string) {
  const game = new Game();
  const stop = vi.fn(() => game.stop());
  const saveRecord = vi.fn(async () => `/tmp/${matchId}.match.json`);
  const handle: RegisteredMatchHandle = {
    getMatchId: () => matchId,
    getGame: () => game,
    stop,
    saveRecord,
  };
  return { game, handle, stop, saveRecord };
}

describe("MatchRegistry", () => {
  it("owns multiple isolated matches without replacing the previously registered runtime", () => {
    const registry = new MatchRegistry();
    const first = createHandle("match_first");
    const second = createHandle("match_second");

    registry.register(first.handle, { kind: "live", observe: true });
    registry.register(second.handle, { kind: "control" });
    first.game.start();
    first.game.tickUpdate();

    expect(registry.list()).toHaveLength(2);
    expect(registry.require("match_first").handle.getGame().getState()!.tick).toBe(1);
    expect(registry.require("match_second").handle.getGame().getState()!.tick).toBe(0);
    expect(registry.getObservedMatchId()).toBe("match_first");
  });

  it("changes observation independently from match lifecycle", () => {
    const registry = new MatchRegistry();
    const first = createHandle("match_first");
    const second = createHandle("match_second");
    registry.register(first.handle, { kind: "live" });
    registry.register(second.handle, { kind: "benchmark" });

    registry.observe("match_second");

    expect(registry.getObserved()?.handle).toBe(second.handle);
    expect(first.stop).not.toHaveBeenCalled();
  });

  it("rejects matchId collisions from different runtimes", () => {
    const registry = new MatchRegistry();
    registry.register(createHandle("match_collision").handle, { kind: "live" });

    expect(() => registry.register(createHandle("match_collision").handle, { kind: "control" }))
      .toThrow(/already registered/);
  });

  it("routes save and stop operations to the selected match handle", async () => {
    const registry = new MatchRegistry();
    const target = createHandle("match_target");
    registry.register(target.handle, { kind: "control" });

    await expect(registry.save("match_target")).resolves.toBe("/tmp/match_target.match.json");
    registry.stop("match_target");

    expect(target.saveRecord).toHaveBeenCalledTimes(1);
    expect(target.stop).toHaveBeenCalledTimes(1);
  });

  it("stops and saves each terminal boundary once even when housekeeping retries", async () => {
    const registry = new MatchRegistry();
    const target = createHandle("match_terminal");
    target.handle.getMatchStatus = () => "finished";
    registry.register(target.handle, { kind: "control" });

    const first = await registry.finalizeTerminalMatches();
    const second = await registry.finalizeTerminalMatches();
    const shutdown = await registry.stopAndSaveAll();

    expect(first).toEqual([expect.objectContaining({ ok: true, matchId: "match_terminal" })]);
    expect(second).toEqual(first);
    expect(shutdown).toEqual(first);
    expect(target.saveRecord).toHaveBeenCalledTimes(1);
    expect(target.stop).toHaveBeenCalledTimes(1);
  });

  it("selects a fallback after the observed match is removed", () => {
    const registry = new MatchRegistry();
    const warmed = createHandle("match_warmed");
    const fallback = createHandle("match_fallback");
    registry.register(warmed.handle, { kind: "live", signature: "preset-pair", observe: true });
    registry.register(fallback.handle, { kind: "control" });

    registry.remove("match_warmed", { stop: true });

    expect(warmed.stop).toHaveBeenCalledTimes(1);
    expect(registry.getObservedMatchId()).toBe("match_fallback");
  });

  it("keeps save progress and failures isolated and allows a save retry", async () => {
    const registry = new MatchRegistry();
    const target = createHandle("match_record_progress");
    const other = createHandle("match_other");
    registry.register(target.handle, { kind: "control" });
    registry.register(other.handle, { kind: "live", terminalPolicy: "none" });
    let rejectSave!: (error: Error) => void;
    target.saveRecord.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));

    const pending = registry.save(target.handle.getMatchId());
    expect(registry.getRecordSaveState(target.handle.getMatchId())).toEqual({ status: "saving" });
    expect(registry.getRecordSaveState(other.handle.getMatchId())).toEqual({ status: "disabled" });
    rejectSave(new Error("disk full"));
    await expect(pending).rejects.toThrow("disk full");
    expect(registry.getRecordSaveState(target.handle.getMatchId())).toEqual({ status: "failed", error: "disk full" });

    await registry.save(target.handle.getMatchId());
    expect(registry.getRecordSaveState(target.handle.getMatchId())).toEqual({
      status: "saved", filePath: "/tmp/match_record_progress.match.json",
    });
  });

  it("automatically saves stopped control matches while leaving paused live matches alone", async () => {
    const registry = new MatchRegistry();
    const control = createHandle("match_control_stop");
    const live = createHandle("match_live_pause");
    control.handle.getMatchStatus = () => "stopped";
    live.handle.getMatchStatus = () => "stopped";
    registry.register(control.handle, { kind: "control" });
    registry.register(live.handle, { kind: "live" });

    await registry.finalizeTerminalMatches();
    await registry.finalizeTerminalMatches();
    expect(control.saveRecord).toHaveBeenCalledTimes(1);
    expect(live.saveRecord).not.toHaveBeenCalled();
    expect(registry.getRecordSaveState(control.handle.getMatchId()).status).toBe("saved");
    expect(registry.getRecordSaveState(live.handle.getMatchId()).status).toBe("idle");
  });
});
