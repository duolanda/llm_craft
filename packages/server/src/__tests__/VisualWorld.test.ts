import { describe, expect, it } from "vitest";
import {
  type SampledEntityTransform,
  VisualWorld,
  type VisualTimelineSampler,
} from "@llmcraft/record";
import { Game } from "../Game";

const FRAME_MS = 1000 / 60;

describe("VisualWorld", () => {
  it("samples the clock once and advances a five-cell path on every 60fps render frame", () => {
    const game = new Game();
    const unit = game.getState().players[0]!.units[0]!;
    const sourceX = unit.x;
    let clockReads = 0;
    let transformReads = 0;
    const timeline: VisualTimelineSampler = {
      getSimulationTimeMs(nowMs) {
        clockReads += 1;
        return nowMs;
      },
      sampleEntityTransformAtSimulationTime(_entityId, simulationTimeMs): SampledEntityTransform {
        transformReads += 1;
        return { x: sourceX + simulationTimeMs / 500, y: unit.y, heading: 0 };
      },
    };
    const world = new VisualWorld();
    const positions: number[] = [];

    for (let frame = 0; frame <= 150; frame += 1) {
      world.step([unit], timeline, frame * FRAME_MS);
      positions.push(world.getTransform(unit.id)!.x);
    }

    const steps = positions.slice(1).map((position, index) => position - positions[index]!);
    expect(clockReads).toBe(151);
    expect(transformReads).toBe(151);
    expect(steps.every((step) => step > 0 && step < 0.04)).toBe(true);
    expect(positions.at(-1)).toBeCloseTo(sourceX + 5, 6);
    expect(unit.x).toBe(sourceX);
  });

  it("removes visual entities without mutating authoritative units", () => {
    const game = new Game();
    const units = game.getState().players[0]!.units.slice(0, 2);
    const world = new VisualWorld();

    world.step(units, undefined, 0);
    expect(world.getTransform(units[0]!.id)).toBeDefined();
    expect(world.getTransform(units[1]!.id)).toBeDefined();

    world.step([units[0]!], undefined, FRAME_MS);
    expect(world.getTransform(units[0]!.id)).toBeDefined();
    expect(world.getTransform(units[1]!.id)).toBeUndefined();
    expect(units[0]!.x).toBe(game.getState().players[0]!.units[0]!.x);
  });
});
