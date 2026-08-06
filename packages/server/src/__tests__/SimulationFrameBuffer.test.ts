import { describe, expect, it } from "vitest";
import type { GameState, StateProjectionFrame } from "@llmcraft/shared";
import {
  LiveSimulationClock,
  ReplaySimulationClock,
  SimulationFrameBuffer,
  SimulationVisualTimeline,
} from "@llmcraft/record";
import { Game } from "../Game";

const TICK_MS = 500;
const VISUAL_FRAME_MS = 1000 / 60;
const TARGET_SPEED_CELLS_PER_SECOND = 2;

function movingUnitFrame(
  baseState: GameState,
  entityId: string,
  frameSequence: number,
  simulationTimeMs: number,
  x: number,
  y = 30,
  heading = 0,
): StateProjectionFrame {
  const state = structuredClone(baseState);
  state.tick = Math.round(simulationTimeMs / TICK_MS);
  const unit = state.players.flatMap((player) => player.units).find((candidate) => candidate.id === entityId);
  if (!unit) throw new Error(`Missing fixture unit ${entityId}`);
  unit.x = x;
  unit.y = y;
  unit.heading = heading;
  unit.state = "moving";
  return {
    kind: "keyframe",
    metadata: {
      frameSequence,
      simulationTick: state.tick,
      simulationTimeMs,
      tickIntervalMs: TICK_MS,
      serverTimeMs: simulationTimeMs,
    },
    state,
    aiOutputs: {},
  };
}

describe("SimulationFrameBuffer", () => {
  it("keeps render time and straight-line position monotonic under +/-200ms arrival jitter", () => {
    const game = new Game();
    const state = game.getState();
    const unit = state.players[0]!.units[0]!;
    const buffer = new SimulationFrameBuffer(8);
    const timeline = new SimulationVisualTimeline(buffer, new LiveSimulationClock(buffer));
    const arrivalJitterMs = [-200, 200, -200, 200, -200, 200, -200, 200, -200, 200, -200, 200];
    const scheduled = arrivalJitterMs.map((jitterMs, index) => ({
      arrivalMs: 200 + index * TICK_MS + jitterMs,
      frame: movingUnitFrame(
        state,
        unit.id,
        index + 1,
        index * TICK_MS,
        20 + index,
      ),
    }));
    const samples: Array<{ nowMs: number; renderTimeMs: number; x: number }> = [];
    let nextFrame = 0;

    for (let nowMs = 0; nowMs <= 5_500; nowMs += VISUAL_FRAME_MS) {
      while (scheduled[nextFrame] && scheduled[nextFrame]!.arrivalMs <= nowMs + 0.001) {
        const next = scheduled[nextFrame++]!;
        buffer.ingest(next.frame, next.arrivalMs);
      }
      if (!buffer.getLatestFrame()) continue;
      const renderTimeMs = timeline.getSimulationTimeMs(nowMs);
      const position = timeline.sampleEntityPosition(unit.id, nowMs);
      if (position) samples.push({ nowMs, renderTimeMs, x: position.x });
    }

    for (let index = 1; index < samples.length; index++) {
      expect(samples[index]!.renderTimeMs).toBeGreaterThanOrEqual(samples[index - 1]!.renderTimeMs - 1e-6);
      expect(samples[index]!.x).toBeGreaterThanOrEqual(samples[index - 1]!.x - 1e-6);
    }

    const warmed = samples.filter((sample) => sample.renderTimeMs >= 1_000 && sample.renderTimeMs <= 4_500);
    const velocities = warmed.slice(1).map((sample, index) => (
      (sample.x - warmed[index]!.x) / ((sample.nowMs - warmed[index]!.nowMs) / 1000)
    ));
    let longestStationaryRun = 0;
    let stationaryRun = 0;
    for (const velocity of velocities) {
      stationaryRun = velocity < TARGET_SPEED_CELLS_PER_SECOND * 0.1 ? stationaryRun + 1 : 0;
      longestStationaryRun = Math.max(longestStationaryRun, stationaryRun);
    }
    const ordinaryVelocities = velocities.filter((velocity) => velocity > TARGET_SPEED_CELLS_PER_SECOND * 0.1);
    const sortedVelocities = [...ordinaryVelocities].sort((left, right) => left - right);
    const p95 = sortedVelocities[Math.ceil(sortedVelocities.length * 0.95) - 1] ?? 0;

    expect(warmed.length).toBeGreaterThan(120);
    expect(longestStationaryRun).toBeLessThanOrEqual(3);
    expect(p95).toBeLessThanOrEqual(TARGET_SPEED_CELLS_PER_SECOND * 1.35);
    expect(ordinaryVelocities.every((velocity) => velocity >= TARGET_SPEED_CELLS_PER_SECOND * 0.65)).toBe(true);
  });

  it("snaps immediately across the existing ten-cell visual snap distance", () => {
    const game = new Game();
    const state = game.getState();
    const unit = state.players[0]!.units[0]!;
    const buffer = new SimulationFrameBuffer();
    buffer.ingest(movingUnitFrame(state, unit.id, 1, 0, 20), 0);
    buffer.ingest(movingUnitFrame(state, unit.id, 2, TICK_MS, 31), TICK_MS);

    expect(buffer.sampleEntityPosition(unit.id, buffer.getRenderSimulationTime(TICK_MS))?.x).toBe(31);
  });

  it("ignores a stale keyframe without rewinding render time or position", () => {
    const game = new Game();
    const state = game.getState();
    const unit = state.players[0]!.units[0]!;
    const buffer = new SimulationFrameBuffer();
    buffer.ingest(movingUnitFrame(state, unit.id, 2, 500, 21), 500);
    const renderTimeBefore = buffer.getRenderSimulationTime(1_050);
    const xBefore = buffer.sampleEntityPosition(unit.id, renderTimeBefore)?.x;

    buffer.ingest(movingUnitFrame(state, unit.id, 1, 450, 20.9), 700);
    const renderTimeAfter = buffer.getRenderSimulationTime(1_050);
    const xAfter = buffer.sampleEntityPosition(unit.id, renderTimeAfter)?.x;

    expect(renderTimeAfter).toBeGreaterThanOrEqual(renderTimeBefore);
    expect(xAfter).toBeGreaterThanOrEqual(xBefore ?? Number.NEGATIVE_INFINITY);
    expect(buffer.getLatestFrame()?.metadata.frameSequence).toBe(2);
  });

  it("uses the shortest heading arc and bounds extrapolation below one tick", () => {
    const game = new Game();
    const state = game.getState();
    const unit = state.players[0]!.units[0]!;
    const buffer = new SimulationFrameBuffer();
    buffer.ingest(movingUnitFrame(state, unit.id, 1, 0, 20, 30, Math.PI * 179 / 180), 0);
    buffer.ingest(movingUnitFrame(state, unit.id, 2, TICK_MS, 21, 30, -Math.PI * 179 / 180), TICK_MS);

    const midpoint = buffer.sampleEntityTransform(unit.id, TICK_MS / 2);
    const farFuture = buffer.sampleEntityTransform(unit.id, 60_000);

    expect(Math.abs(midpoint?.heading ?? 0)).toBeGreaterThan(Math.PI * 0.99);
    expect(farFuture?.x).toBeCloseTo(21.8, 6);
  });

  it("samples one continuous five-cell replay path at render-frame cadence", () => {
    const game = new Game();
    const state = game.getState();
    const unit = state.players[0]!.units[0]!;
    const buffer = new SimulationFrameBuffer(8);
    for (let tick = 0; tick <= 5; tick++) {
      buffer.ingest(movingUnitFrame(state, unit.id, tick + 1, tick * TICK_MS, 20 + tick), tick * TICK_MS);
    }
    const clock = new ReplaySimulationClock();
    clock.setBounds(0, 5 * TICK_MS, 0);
    clock.seek(0, 0);
    clock.setPlaying(true, 0);
    const timeline = new SimulationVisualTimeline(buffer, clock);
    const positions: number[] = [];

    for (let nowMs = 0; nowMs < 5 * TICK_MS; nowMs += VISUAL_FRAME_MS) {
      positions.push(timeline.sampleEntityTransform(unit.id, nowMs)?.x ?? Number.NaN);
    }

    const steps = positions.slice(1).map((position, index) => position - positions[index]!);
    expect(new Set(positions.map((position) => position.toFixed(4))).size).toBeGreaterThan(120);
    expect(positions[0]).toBeCloseTo(20, 6);
    expect(positions.at(-1)).toBeGreaterThan(24.9);
    expect(steps.every((step) => step > 0 && step < 0.05)).toBe(true);

    clock.setPlaying(false, 5 * TICK_MS);
    const paused = timeline.sampleEntityTransform(unit.id, 8 * TICK_MS)?.x;
    expect(paused).toBeCloseTo(25, 6);
  });
});
