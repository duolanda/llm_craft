import { describe, expect, it, vi } from "vitest";
import type { Command } from "@llmcraft/shared";
import { MatchRuntime, type ClockDriver } from "../MatchRuntime";
import { ConstructionSystem } from "../simulation/ConstructionSystem";

class ManualClock implements ClockDriver {
  running = false;
  private callback: (() => void) | null = null;

  start(onTick: () => void): void {
    this.running = true;
    this.callback = onTick;
  }

  stop(): void {
    this.running = false;
    this.callback = null;
  }

  tick(): void {
    this.callback?.();
  }
}

describe("MatchRuntime", () => {
  it("owns the clock and emits exactly one notification per committed tick", () => {
    const clock = new ManualClock();
    const runtime = new MatchRuntime({ clock, matchId: "match_tick_events" });
    const observed: number[] = [];
    runtime.onTickCommitted((state) => observed.push(state.tick));

    runtime.start();
    clock.tick();
    clock.tick();

    expect(observed).toEqual([1, 2]);
    expect(runtime.getStatus()).toBe("running");
    runtime.stop();
    expect(runtime.getStatus()).toBe("stopped");
  });

  it("releases accepted commands at the next tick boundary", () => {
    const runtime = new MatchRuntime({ clock: new ManualClock(), matchId: "match_gateway" });
    const worker = runtime.getGame().getState().players[0]!.units[0]!;
    runtime.start();

    const result = runtime.submitCommands("player_1", [{
      id: "hold-worker",
      type: "hold",
      playerId: "player_1",
      unitId: worker.id,
    }]);
    expect(result).toMatchObject({ accepted: true, applyAtTick: 1 });

    runtime.advanceOneTick();
    expect(runtime.getGame().getState().players[0]!.units[0]!.intent).toMatchObject({ type: "hold" });
  });

  it("executes valid commands in an envelope even when another command is invalid", () => {
    const runtime = new MatchRuntime({ clock: new ManualClock(), matchId: "match_partial_batch" });
    let outcomes: Array<{ command: Command; success: boolean }> = [];
    runtime.onTickCommitted((_state, result) => {
      outcomes = result.commandOutcomes;
    });
    const worker = runtime.getGame().getState().players[0]!.units[0]!;
    const commands: Command[] = [
      {
        id: "valid-hold",
        type: "hold",
        playerId: "player_1",
        unitId: worker.id,
      },
      {
        id: "invalid-hold",
        type: "hold",
        playerId: "player_1",
        unitId: "missing-unit",
      },
    ];
    runtime.start();
    expect(runtime.submitCommands("player_1", commands)).toMatchObject({ accepted: true });

    runtime.advanceOneTick();

    expect(runtime.getGame().getState().players[0]!.units[0]!.intent).toMatchObject({ type: "hold" });
    expect(outcomes.find((outcome) => outcome.command.id === "valid-hold")?.success).toBe(true);
    expect(outcomes.find((outcome) => outcome.command.id === "invalid-hold")?.success).toBe(false);
  });

  it("stops and reports failed when an unexpected simulation exception escapes", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = new MatchRuntime({ clock: new ManualClock(), matchId: "match_failure" });
    vi.spyOn(ConstructionSystem.prototype, "step").mockImplementationOnce(() => {
      throw new Error("injected failure");
    });
    const ended = runtime.waitForEnd();
    runtime.start();
    runtime.advanceOneTick();

    await expect(ended).resolves.toMatchObject({ status: "failed" });
    expect(runtime.getStatus()).toBe("failed");
    expect(runtime.getGame().getState().logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tick_error" }),
    ]));
    consoleError.mockRestore();
  });

  it("keeps the active MatchDefinition as the runtime contract", () => {
    const runtime = new MatchRuntime({ matchId: "match_definition" });
    const definition = runtime.getDefinition();

    expect(definition.map.playerStarts[0].buildings[0]).toMatchObject({
      type: "hq",
      position: expect.any(Object),
    });
    expect(runtime.getGame().getDefinition()).toEqual(definition);
  });
});
