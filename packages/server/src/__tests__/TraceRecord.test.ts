import { describe, expect, it } from "vitest";
import type { MatchTraceRecordV3 } from "@llmcraft/shared";
import { hashAuthoritativeStateV2 } from "../AuthoritativeStateHash";
import { Game } from "../Game";
import { createDefaultMatchDefinition } from "../MatchDefinition";
import {
  createTraceManifestV3,
  migrateCompactV2ToTraceV3,
  parseMatchTraceRecordV3,
  projectCommandResultEventToGameLog,
  projectRecordToGameRecord,
  TraceRecordValidationError,
  validateMatchTraceRecordV3,
  createStateProjectionDelta,
  applyStateProjectionDelta,
  SimulationFrameBuffer,
  analyzeGameRecord,
} from "@llmcraft/trace";

function createValidTrace(): MatchTraceRecordV3 {
  const game = new Game();
  const state = game.getState();
  return {
    schemaVersion: 3,
    manifest: createTraceManifestV3("trace_validation", createDefaultMatchDefinition()),
    initialKeyframe: state,
    finalKeyframe: state,
    commandSubmissions: [],
    stateHashes: [hashAuthoritativeStateV2(state, game.getDeterministicRngState())],
    domainEvents: [],
    aiTurns: [],
    terminalEvents: [],
  };
}

function addCompleteReplayProjection(trace: MatchTraceRecordV3): MatchTraceRecordV3 {
  trace.manifest.status = "stopped";
  trace.manifest.capabilities.replay = "complete";
  trace.replayProjection = {
    projectionVersion: 1,
    metadata: {
      startedAt: trace.manifest.createdAt,
      savedAt: trace.manifest.updatedAt,
      status: "stopped",
      winner: null,
      aiIntervalTicks: 5,
      aiContextWindowTurns: 0,
      map: {
        width: trace.manifest.definition.map.width,
        height: trace.manifest.definition.map.height,
      },
      systemPrompt: "test prompt",
      players: [
        { playerId: "player_1", model: "test-model" },
        { playerId: "player_2", model: "test-model" },
      ],
    },
    tickDeltas: [],
    commandResults: [],
  };
  return trace;
}

describe("TraceRecord v3", () => {
  it("round-trips exact live/replay state through the shared projection delta", () => {
    const game = new Game();
    const previous = game.getState();
    const current = structuredClone(previous);
    current.tick = 3;
    current.players[0]!.resources.credits += 25;
    current.players[0]!.units[0]!.x += 2;
    current.tiles[0]![0]!.resourceRemaining = 17;
    current.logs.push({ ...current.logs[0]!, tick: 3, message: "projection" });

    const delta = createStateProjectionDelta(previous, current);
    expect(applyStateProjectionDelta(previous, delta)).toEqual(current);
    expect(previous.tick).toBe(0);
  });

  it("interpolates by simulation time regardless of packet arrival jitter", () => {
    const game = new Game();
    const previous = game.getState();
    const current = structuredClone(previous);
    current.tick = 1;
    const unitId = current.players[0]!.units[0]!.id;
    const startX = current.players[0]!.units[0]!.x;
    current.players[0]!.units[0]!.x += 10;
    const buffer = new SimulationFrameBuffer();
    buffer.ingest({
      kind: "keyframe",
      metadata: { frameVersion: 1, frameSequence: 1, simulationTick: 0, simulationTimeMs: 0, tickIntervalMs: 500, serverTimeMs: 10 },
      state: previous,
      aiOutputs: {},
    }, 100);
    buffer.ingest({
      kind: "delta",
      metadata: { frameVersion: 1, frameSequence: 2, simulationTick: 1, simulationTimeMs: 500, tickIntervalMs: 500, serverTimeMs: 510 },
      baseFrameSequence: 1,
      delta: createStateProjectionDelta(previous, current),
      aiOutputs: {},
    }, 900);

    expect(buffer.sampleEntityPosition(unitId, 250)?.x).toBe(startX + 5);
    expect(buffer.getLatestState()).toEqual(current);
  });

  it("uses the versioned metric registry and separate detectors", () => {
    const trace = addCompleteReplayProjection(createValidTrace());
    trace.finalKeyframe = structuredClone(trace.initialKeyframe);
    trace.finalKeyframe.players[0]!.resources.credits = 2500;
    trace.replayProjection!.metadata.tickIntervalMs = 250;
    const report = analyzeGameRecord(projectRecordToGameRecord(trace));

    expect(report.match.tickIntervalMs).toBe(250);
    expect(report.metrics).toContainEqual(expect.objectContaining({
      metricId: "economy.final_credits",
      metricVersion: 1,
      scopeId: "player_1",
      value: 2500,
      sourcePaths: expect.arrayContaining(["finalState.players"]),
    }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      detectorId: "floating_credits",
      detectorVersion: 1,
      rulesetId: "default-v1",
    }));

    trace.replayProjection!.metadata.rulesetId = "future-v2";
    expect(analyzeGameRecord(projectRecordToGameRecord(trace)).findings).not.toContainEqual(
      expect.objectContaining({ detectorId: "floating_credits" }),
    );
  });

  it("validates and parses the formal trace-v3 interchange shape", () => {
    const trace = createValidTrace();

    expect(() => validateMatchTraceRecordV3(trace)).not.toThrow();
    expect(parseMatchTraceRecordV3(JSON.stringify(trace))).toEqual(trace);
  });

  it("accepts legacy v1 definitions but rejects malformed v2 budget rules", () => {
    const legacy = createValidTrace();
    const current = legacy.manifest.definition;
    if (current.definitionVersion !== 2) throw new Error("expected v2 test definition");
    const { rules: _rules, ...legacyBase } = current;
    legacy.manifest.definition = { ...legacyBase, definitionVersion: 1 };
    expect(() => validateMatchTraceRecordV3(legacy)).not.toThrow();

    const malformed = createValidTrace();
    if (malformed.manifest.definition.definitionVersion !== 2) throw new Error("expected v2 test definition");
    malformed.manifest.definition.rules.commandBudget.maxPathCommandsPerTick = -1;
    expect(() => validateMatchTraceRecordV3(malformed)).toThrow(/maxPathCommandsPerTick/);
  });

  it("rejects undeclared capabilities instead of silently assuming data exists", () => {
    const trace = createValidTrace();
    const capabilities = trace.manifest.capabilities as unknown as Record<string, unknown>;
    capabilities.modelRequestSpans = "yes";

    expect(() => validateMatchTraceRecordV3(trace)).toThrowError(
      new TraceRecordValidationError(
        "$trace.manifest.capabilities.modelRequestSpans",
        "must be complete, partial, or absent",
      ),
    );
  });

  it("rejects gaps in the global domain event sequence", () => {
    const trace = createValidTrace();
    trace.domainEvents.push({
      eventVersion: 1,
      matchId: trace.manifest.matchId,
      eventSequence: 2,
      tick: 0,
      type: "command_envelope_rejected",
      payload: {},
    });

    expect(() => validateMatchTraceRecordV3(trace)).toThrow(/contiguous and start at 1/);
  });

  it("projects trace-v3 through the shared projector used by server and client", () => {
    const trace = addCompleteReplayProjection(createValidTrace());

    const projected = projectRecordToGameRecord(trace);

    expect(projected.metadata.recordFormat).toBe("compact-v2");
    expect(projected.initialState.tick).toBe(0);
    expect(projected.tickDeltas).toEqual([]);
  });

  it("migrates compact-v2 with explicit missing capabilities instead of inventing facts", () => {
    const trace = addCompleteReplayProjection(createValidTrace());
    const compact = projectRecordToGameRecord(trace);

    const migrated = migrateCompactV2ToTraceV3(compact, {
      matchId: "migrated_compact",
      definition: createDefaultMatchDefinition(),
    });

    expect(migrated.manifest.capabilities).toMatchObject({
      commandSubmissions: "absent",
      domainEvents: "absent",
      stateHashes: "absent",
      replay: "complete",
    });
    expect(projectRecordToGameRecord(migrated)).toEqual(compact);
  });

  it("projects compatibility command logs from authoritative DomainEvent facts", () => {
    const projected = projectCommandResultEventToGameLog({
      eventVersion: 1,
      matchId: "trace_validation",
      eventSequence: 1,
      tick: 3,
      type: "command_result",
      actorId: "player_1",
      commandId: "command_hold",
      payload: {
        command: { id: "command_hold", type: "hold", playerId: "player_1", unitId: "unit_1" },
        resultCode: 0,
        resultType: "hold_success",
        resultData: { unitId: "unit_1" },
        success: true,
      },
    });

    expect(projected).toMatchObject({
      tick: 3,
      type: "command_result",
      data: {
        command: { id: "command_hold" },
        result_code: 0,
        type: "hold_success",
      },
      meta: { owner: "player_1", feedbackTarget: "player_1", level: "info" },
    });
  });
});
