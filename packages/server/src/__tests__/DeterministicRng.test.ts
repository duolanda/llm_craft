import { describe, expect, it } from "vitest";
import { DeterministicRng } from "../DeterministicRng";

describe("DeterministicRng", () => {
  it("replays the same sequence for the same seed", () => {
    const left = new DeterministicRng(42);
    const right = new DeterministicRng(42);

    expect(Array.from({ length: 8 }, () => left.nextUint32())).toEqual(
      Array.from({ length: 8 }, () => right.nextUint32()),
    );
  });

  it("restores the exact next value from a serializable checkpoint", () => {
    const rng = new DeterministicRng(7);
    rng.nextUint32();
    const checkpoint = rng.createCheckpoint();
    const expectedNext = rng.nextUint32();

    rng.nextUint32();
    rng.restoreCheckpoint(JSON.parse(JSON.stringify(checkpoint)));

    expect(rng.nextUint32()).toBe(expectedNext);
  });

  it("produces bounded integer draws and rejects invalid bounds", () => {
    const rng = new DeterministicRng(0);
    const values = Array.from({ length: 100 }, () => rng.nextInt(5));

    expect(values.every((value) => Number.isInteger(value) && value >= 0 && value < 5)).toBe(true);
    expect(() => rng.nextInt(0)).toThrow(/positive safe integer/);
  });
});
