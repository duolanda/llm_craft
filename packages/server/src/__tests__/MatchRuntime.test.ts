import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Game } from "../Game";
import { type ClockDriver, MatchRuntime } from "../MatchRuntime";
import { createDefaultMatchDefinition } from "../MatchDefinition";
import { ProductionSystem } from "../simulation/ProductionSystem";
import { readTraceRecordFile } from "../TraceFile";

class ManualClockDriver implements ClockDriver {
  running = false;
  private onTick: (() => void) | null = null;

  start(onTick: () => void): void {
    if (this.running) return;
    this.running = true;
    this.onTick = onTick;
  }

  stop(): void {
    this.running = false;
    this.onTick = null;
  }

  tick(): void {
    this.onTick?.();
  }
}

describe("MatchRuntime", () => {
  it("is the only owner that connects a clock to synchronous Game ticks", () => {
    const game = new Game();
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock });
    const startSpy = vi.spyOn(game, "start");

    runtime.start();
    runtime.start();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(runtime.running).toBe(true);

    clock.tick();
    clock.tick();
    expect(game.getTick()).toBe(2);

    runtime.stop();
    clock.tick();
    expect(runtime.running).toBe(false);
    expect(game.getTick()).toBe(2);
  });

  it("does not let Game.start create an independent wall clock", () => {
    vi.useFakeTimers();
    try {
      const game = new Game();
      game.start();
      vi.advanceTimersByTime(2_000);
      expect(game.getTick()).toBe(0);
      game.tickUpdate();
      expect(game.getTick()).toBe(1);
      game.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops its clock when game rules end the match", () => {
    const game = new Game();
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock });
    for (const building of game.getBuildingManager().getBuildingsByPlayer("player_2")) {
      game.getBuildingManager().removeBuilding(building.id);
    }

    runtime.start();
    clock.tick();

    expect(runtime.running).toBe(false);
  });

  it("uses MatchDefinition tickIntervalMs for the default clock", () => {
    vi.useFakeTimers();
    try {
      const definition = createDefaultMatchDefinition();
      definition.tickIntervalMs = 100;
      const runtime = new MatchRuntime({ definition });

      runtime.start();
      vi.advanceTimersByTime(99);
      expect(runtime.getGame().getTick()).toBe(0);
      vi.advanceTimersByTime(1);
      expect(runtime.getGame().getTick()).toBe(1);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a definition that disagrees with an injected Game", () => {
    const definition = createDefaultMatchDefinition();
    const game = new Game(definition);
    const conflictingDefinition = createDefaultMatchDefinition();
    conflictingDefinition.tickIntervalMs += 1;

    expect(() => new MatchRuntime({ definition: conflictingDefinition, game })).toThrow(/must match/);
  });

  it("fail-stops the live clock after rolling back a crashed simulation step", () => {
    const game = new Game();
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(ProductionSystem.prototype, "step").mockImplementationOnce(() => {
      throw new Error("injected runtime failure");
    });

    runtime.start();
    clock.tick();

    expect(runtime.running).toBe(false);
    expect(game.isGameRunning()).toBe(false);
    expect(game.getTick()).toBe(0);
    expect(game.getState().logs.some((log) => log.type === "tick_error")).toBe(true);
    expect(runtime.getRecentDomainEvents().at(-1)).toMatchObject({
      type: "simulation_tick_failed",
      payload: { error: "injected runtime failure", attemptedTick: 1 },
    });
    consoleError.mockRestore();
  });

  it("does not misreport a post-commit journal failure as a simulation rollback", () => {
    const game = new Game();
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock, matchId: "match_journal_failure" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(runtime.getJournal(), "appendStateHash").mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    runtime.start();
    clock.tick();

    expect(game.getTick()).toBe(1);
    expect(runtime.running).toBe(false);
    expect(runtime.getTraceManifest().status).toBe("failed");
    expect(runtime.getRecentDomainEvents().some((event) => event.type === "simulation_tick_failed")).toBe(false);
    const traceFailureLog = [...game.getState().logs].reverse().find((log) => log.type === "tick_error");
    expect(traceFailureLog).toMatchObject({
      type: "tick_error",
      data: { committed: true, committedTick: 1 },
    });
    consoleError.mockRestore();
  });

  it("applies accepted command envelopes exactly at the next tick boundary", () => {
    const game = new Game();
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock, matchId: "match_gateway" });
    const worker = game.getUnitManager().getUnitsByPlayer("player_1")[0];
    const target = { x: worker.x + 4, y: worker.y };

    expect(runtime.submitCommands("player_1", [{
      id: "gateway_move_1",
      type: "move",
      playerId: "player_1",
      unitId: worker.id,
      position: target,
    }])).toMatchObject({ accepted: true, applyAtTick: 1 });
    expect(worker.pathTarget).toBeUndefined();

    runtime.start();
    clock.tick();

    expect(game.getUnitManager().getUnit(worker.id)?.pathTarget).toEqual(target);
    expect(game.getTick()).toBe(1);
    runtime.stop();
  });

  it("rolls back every command in an envelope when one command fails", () => {
    const game = new Game();
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock, matchId: "match_atomic_failure" });
    const worker = game.getUnitManager().getUnitsByPlayer("player_1")[0]!;

    expect(runtime.submitCommands("player_1", [
      {
        id: "atomic_valid_hold",
        type: "hold",
        playerId: "player_1",
        unitId: worker.id,
      },
      {
        id: "atomic_invalid_hold",
        type: "hold",
        playerId: "player_1",
        unitId: "missing_unit",
      },
    ], { clientRequestId: "atomic_failure_request" })).toMatchObject({ accepted: true });

    runtime.start();
    clock.tick();
    runtime.stop();

    expect(game.getState().players[0]!.units.find((unit) => unit.id === worker.id)?.intent?.type).not.toBe("hold");
    const events = runtime.getRecentDomainEvents();
    expect(events.find((event) => event.type === "command_envelope_rolled_back")).toMatchObject({
      payload: {
        clientRequestId: "atomic_failure_request",
        reason: "command_failed",
        failedCommandId: "atomic_invalid_hold",
      },
    });
    expect(events.filter((event) => event.type === "command_result")).toEqual([
      expect.objectContaining({ commandId: "atomic_valid_hold", payload: expect.objectContaining({ success: false }) }),
      expect.objectContaining({ commandId: "atomic_invalid_hold", payload: expect.objectContaining({ success: false }) }),
    ]);
  });

  it("rejects an entire envelope instead of carrying path commands into later ticks", () => {
    const game = new Game();
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock, matchId: "match_atomic_path_budget" });
    const worker = game.getUnitManager().getUnitsByPlayer("player_1")[0]!;
    const commands = Array.from({ length: 5 }, (_, index) => ({
      id: `path_budget_${index}`,
      type: "move",
      playerId: "player_1" as const,
      unitId: worker.id,
      position: { x: worker.x + index + 1, y: worker.y },
    }));
    runtime.submitCommands("player_1", commands, { clientRequestId: "path_budget_request" });

    runtime.start();
    clock.tick();
    clock.tick();
    runtime.stop();

    expect(game.getUnitManager().getUnit(worker.id)?.pathTarget).toBeUndefined();
    expect(runtime.getRecentDomainEvents().find((event) => event.type === "command_envelope_rolled_back")).toMatchObject({
      tick: 1,
      payload: { clientRequestId: "path_budget_request", reason: "path_budget_exceeded" },
    });
  });

  it("reserves path-command capacity for both players in the same tick", () => {
    const game = new Game();
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock, matchId: "match_fair_path_budget" });
    const player1Workers = game.getUnitManager().getUnitsByPlayer("player_1").slice(0, 2);
    const player2Workers = game.getUnitManager().getUnitsByPlayer("player_2").slice(0, 2);
    runtime.submitCommands("player_1", player1Workers.map((worker, index) => ({
      id: `fair_p1_${index}`,
      type: "move",
      playerId: "player_1" as const,
      unitId: worker.id,
      position: { x: worker.x + 8, y: worker.y },
    })), { clientRequestId: "fair_path_p1" });
    runtime.submitCommands("player_2", player2Workers.map((worker, index) => ({
      id: `fair_p2_${index}`,
      type: "move",
      playerId: "player_2" as const,
      unitId: worker.id,
      position: { x: worker.x - 8, y: worker.y },
    })), { clientRequestId: "fair_path_p2" });

    runtime.start();
    clock.tick();
    runtime.stop();

    const events = runtime.getRecentDomainEvents();
    expect(events.filter((event) => event.type === "command_envelope_rolled_back")).toHaveLength(0);
    const results = events.filter((event) => event.type === "command_result" && String(event.commandId).startsWith("fair_p"));
    expect(results).toHaveLength(4);
    expect(results.every((event) => event.payload.success === true)).toBe(true);
  });

  it("prevents one actor from bypassing its per-tick command budget with multiple envelopes", () => {
    const game = new Game();
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock, matchId: "match_command_budget" });
    const worker = game.getUnitManager().getUnitsByPlayer("player_1")[0]!;
    const createHolds = (prefix: string) => Array.from({ length: 60 }, (_, index) => ({
      id: `${prefix}_${index}`,
      type: "hold",
      playerId: "player_1" as const,
      unitId: worker.id,
    }));
    runtime.submitCommands("player_1", createHolds("budget_first"), {
      clientRequestId: "command_budget_first",
    });
    const secondSubmission = runtime.submitCommands("player_1", createHolds("budget_second"), {
      clientRequestId: "command_budget_second",
    });
    expect(secondSubmission).toMatchObject({ accepted: false, code: "tick_command_budget_exceeded" });

    runtime.start();
    clock.tick();
    runtime.stop();

    expect(runtime.getRecentDomainEvents().find((event) => (
      event.type === "command_envelope_rejected"
      && event.payload.clientRequestId === "command_budget_second"
    ))).toMatchObject({ payload: { code: "tick_command_budget_exceeded" } });
    const secondResults = runtime.getRecentDomainEvents().filter((event) => (
      event.type === "command_result" && String(event.commandId).startsWith("budget_second_")
    ));
    expect(secondResults).toHaveLength(0);
  });

  it("journals a monotonic accepted-to-result event chain with command correlation", async () => {
    const game = new Game();
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock, matchId: "match_event_chain" });
    const worker = game.getUnitManager().getUnitsByPlayer("player_1")[0];
    const envelope = {
      envelopeVersion: 1 as const,
      matchId: runtime.getMatchId(),
      actorId: "player_1",
      baseTick: 0,
      applyAtTick: 1,
      sequence: 1,
      clientRequestId: "request_event_chain",
      commands: [{
        id: "command_event_chain",
        type: "move",
        playerId: "player_1" as const,
        unitId: worker.id,
        position: { x: worker.x + 4, y: worker.y },
      }],
    };

    expect(runtime.submitEnvelope(envelope)).toMatchObject({ accepted: true, duplicate: false });
    runtime.start();
    clock.tick();
    runtime.stop();

    const recent = runtime.getRecentDomainEvents();
    expect(recent.map((event) => event.type)).toEqual([
      "command_envelope_accepted",
      "command_envelope_released",
      "command_result",
    ]);
    expect(recent.map((event) => event.eventSequence)).toEqual([1, 2, 3]);
    expect(recent[2]).toMatchObject({
      matchId: "match_event_chain",
      tick: 1,
      actorId: "player_1",
      commandId: "command_event_chain",
      payload: {
        clientRequestId: "request_event_chain",
        resultType: "move_success",
        success: true,
      },
    });

    const persisted = [];
    for await (const event of runtime.readDomainEvents()) persisted.push(event);
    expect(persisted).toEqual(recent);

    const submissions = [];
    for await (const submission of runtime.getJournal().readCommandSubmissions()) submissions.push(submission);
    expect(submissions).toEqual([expect.objectContaining({
      submissionVersion: 1,
      matchId: "match_event_chain",
      submissionSequence: 1,
      receivedAtTick: 0,
      envelope,
      result: expect.objectContaining({ accepted: true, duplicate: false }),
    })]);
  });

  it("emits a structured failure for commands that legacy Game used to drop silently", () => {
    const game = new Game();
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock, matchId: "match_invalid_command" });
    runtime.submitCommands("player_1", [{
      id: "invalid_hold",
      type: "hold",
      playerId: "player_1",
      unitId: "missing_unit",
    }]);

    runtime.start();
    clock.tick();
    runtime.stop();

    expect(runtime.getRecentDomainEvents().find((event) => event.commandId === "invalid_hold")).toMatchObject({
      type: "command_result",
      payload: {
        resultType: "command_invalid",
        success: false,
      },
    });
  });

  it("journals SimulationCore outcomes without parsing compatibility logs", () => {
    const definition = createDefaultMatchDefinition();
    const game = new Game(definition);
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock, matchId: "match_simulation_events" });
    const worker = game.getUnitManager().getUnitsByPlayer("player_1")[0];
    const resource = definition.map.resources[0];
    worker.x = resource.x;
    worker.y = resource.y;

    runtime.start();
    clock.tick();
    runtime.stop();

    expect(runtime.getRecentDomainEvents().find((event) => event.type === "resource_gathered")).toMatchObject({
      tick: 1,
      actorId: "player_1",
      entityIds: [worker.id],
      payload: {
        playerId: "player_1",
        unitId: worker.id,
        amount: 10,
        carryingCredits: 10,
      },
    });
  });

  it("persists a trace-v3 manifest and one authoritative hash per committed tick", async () => {
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ clock, matchId: "match_trace_prefix" });

    expect(runtime.getTraceManifest()).toMatchObject({
      schemaVersion: 3,
      recordFormat: "trace-v3",
      matchId: "match_trace_prefix",
      status: "created",
      definition: {
        definitionVersion: 2,
        seed: 0,
        rulesetId: "default-v1",
        rules: {
          schemaVersion: 1,
          commandBudget: {
            maxCommandsPerActorPerTick: 100,
            maxPathCommandsPerTick: 4,
          },
        },
      },
      capabilities: {
        domainEvents: "complete",
        modelRequestSpans: "partial",
        stateHashes: "complete",
        replay: "partial",
      },
    });

    runtime.start();
    clock.tick();
    clock.tick();
    runtime.stop();

    const hashes = [];
    for await (const hash of runtime.readStateHashes()) hashes.push(hash);
    expect(hashes.map((hash) => hash.tick)).toEqual([0, 1, 2]);
    expect(hashes.every((hash) => hash.hashVersion === 2 && hash.hash.length === 64)).toBe(true);
    expect(await runtime.getJournal().readTraceManifest()).toMatchObject({
      matchId: "match_trace_prefix",
      status: "stopped",
    });
  });

  it("uses the versioned MatchDefinition budget for gateway admission and tick execution", () => {
    const definition = createDefaultMatchDefinition();
    definition.rules.commandBudget = {
      maxCommandsPerActorPerTick: 3,
      maxPathCommandsPerTick: 1,
    };
    const game = new Game(definition);
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ game, clock, matchId: "match_versioned_budget" });
    const worker = game.getUnitManager().getUnitsByPlayer("player_1")[0]!;
    const holds = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}_${index}`,
      type: "hold",
      playerId: "player_1" as const,
      unitId: worker.id,
    }));

    expect(runtime.submitCommands("player_1", holds("first", 2), {
      clientRequestId: "versioned_budget_first",
    })).toMatchObject({ accepted: true });
    expect(runtime.submitCommands("player_1", holds("second", 2), {
      clientRequestId: "versioned_budget_second",
    })).toMatchObject({ accepted: false, code: "tick_command_budget_exceeded" });

    const moves = [0, 1].map((index) => ({
      id: `versioned_path_${index}`,
      type: "move",
      playerId: "player_2" as const,
      unitId: game.getUnitManager().getUnitsByPlayer("player_2")[0]!.id,
      position: { x: 130 - index, y: 10 },
    }));
    expect(runtime.submitCommands("player_2", moves, {
      clientRequestId: "versioned_path_budget",
    })).toMatchObject({ accepted: true });

    runtime.start();
    clock.tick();
    runtime.stop();

    expect(runtime.getRecentDomainEvents().find((event) => (
      event.type === "command_envelope_rolled_back"
      && event.payload.clientRequestId === "versioned_path_budget"
    ))).toMatchObject({ payload: { reason: "path_budget_exceeded" } });
    expect(runtime.getTraceManifest().definition).toEqual(definition);
  });

  it("finalizes an immutable journal cut while later appends remain active", async () => {
    const recordDir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-trace-cut-"));
    const runtime = new MatchRuntime({ recordDir, matchId: "match_consistent_cut" });
    const game = runtime.getGame();
    const journal = runtime.getJournal();
    const cut = journal.captureCut();
    journal.appendDomainEvent({
      tick: 0,
      type: "command_envelope_rejected",
      payload: { reason: "appended after cut" },
    });
    const savedAt = new Date().toISOString();
    const state = game.getState();
    const definition = runtime.getDefinition();

    const filePath = await journal.finalizeTraceV3({
      manifest: runtime.getTraceManifest(),
      initialKeyframe: state,
      finalKeyframe: state,
      cut,
      replayProjection: {
        metadata: {
          startedAt: savedAt,
          savedAt,
          endedAt: savedAt,
          status: "stopped",
          winner: null,
          aiIntervalTicks: 5,
          aiContextWindowTurns: 0,
          map: { width: definition.map.width, height: definition.map.height },
          systemPrompt: "test",
          players: [
            { playerId: "player_1", model: "test-model" },
            { playerId: "player_2", model: "test-model" },
          ],
        },
        tickDeltas: [],
        commandResults: [],
      },
    });

    expect(filePath).toMatch(/\.trace\.json\.gz$/);
    const header = await fs.readFile(filePath);
    expect([...header.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    const trace = await readTraceRecordFile(filePath);
    expect(trace.domainEvents).toEqual([]);
    expect(journal.domainEventCount).toBe(1);
    expect((await fs.readdir(recordDir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    await fs.rm(recordDir, { recursive: true, force: true });
  });

  it("removes temporary output when trace finalization validation fails", async () => {
    const recordDir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-trace-atomic-"));
    const clock = new ManualClockDriver();
    const runtime = new MatchRuntime({ recordDir, clock, matchId: "match_atomic_failure" });
    runtime.start();
    clock.tick();
    runtime.stop();
    const state = runtime.getGame().getState();
    const definition = runtime.getDefinition();
    const savedAt = new Date().toISOString();

    await expect(runtime.getJournal().finalizeTraceV3({
      manifest: runtime.getTraceManifest(),
      initialKeyframe: runtime.getGame().getInitialSnapshot()!.state,
      finalKeyframe: state,
      replayProjection: {
        metadata: {
          startedAt: savedAt,
          savedAt,
          endedAt: savedAt,
          status: "stopped",
          winner: null,
          aiIntervalTicks: 5,
          aiContextWindowTurns: 0,
          map: { width: definition.map.width, height: definition.map.height },
          systemPrompt: "test",
          players: [
            { playerId: "player_1", model: "test-model" },
            { playerId: "player_2", model: "test-model" },
          ],
        },
        tickDeltas: [],
        commandResults: [],
      },
    })).rejects.toThrow(/ended at tick 0, expected 1/);
    expect(await fs.readdir(recordDir)).toEqual([]);
    await fs.rm(recordDir, { recursive: true, force: true });
  });
});
