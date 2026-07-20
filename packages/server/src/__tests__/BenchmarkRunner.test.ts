import { describe, expect, it, vi } from "vitest";
import {
  BenchmarkRunner,
  createPairedBenchmarkTrials,
} from "../benchmark/BenchmarkRunner";

describe("BenchmarkRunner", () => {
  it("pairs player sides and runs bounded concurrent benchmark rounds", async () => {
    const trials = createPairedBenchmarkTrials(4);
    const runTrial = vi.fn(async (trial: (typeof trials)[number]) => ({
      round: trial.round,
      llmSide: trial.llmSide,
      winner: trial.llmSide === "player_1" ? "llm" as const : "cpu" as const,
      durationTicks: trial.round * 10,
    }));
    const observed: number[] = [];

    const result = await new BenchmarkRunner(
      trials,
      2,
      runTrial,
      undefined,
      (round) => observed.push(round.round),
    ).run();

    expect(trials.map((trial) => trial.llmSide)).toEqual([
      "player_1",
      "player_2",
      "player_1",
      "player_2",
    ]);
    expect(runTrial).toHaveBeenCalledTimes(4);
    expect(result.failures).toEqual([]);
    expect(result.results.map((round) => round.round)).toEqual([1, 2, 3, 4]);
    expect(observed).toHaveLength(4);
  });
});
