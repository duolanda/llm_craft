import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPairedTrials, ExperimentRunner, summarizeExperiment } from "../experiment/ExperimentRunner";

describe("ExperimentRunner", () => {
  it("pairs seeds/sides, persists results, and resumes only incomplete trials", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llmcraft-experiment-"));
    const resultPath = path.join(directory, "result.json");
    const trials = createPairedTrials({ seeds: [7, 9], repeats: 1 });
    const manifest = {
      manifestVersion: 1 as const,
      experimentId: "paired-test",
      createdAt: new Date(0).toISOString(),
      fixed: { ruleset: "default-v1" },
      concurrency: 2,
      trials,
    };
    const runTrial = vi.fn(async (trial: (typeof trials)[number]) => ({
      status: "completed" as const,
      winner: trial.side === "player_1" ? "candidate" as const : "baseline" as const,
      durationTicks: trial.seed,
      modelLatencyMs: [100, 200],
      inputTokens: 10,
      outputTokens: 5,
      payload: { round: trial.seed, side: trial.side },
    }));
    const updates: number[] = [];
    const first = await new ExperimentRunner(manifest, runTrial, resultPath, undefined, (file) => {
      updates.push(file.results.length);
    }).run();
    expect(runTrial).toHaveBeenCalledTimes(4);
    expect(JSON.parse(await readFile(resultPath, "utf8")).results).toHaveLength(4);
    expect(first.results[0]?.payload).toBeDefined();
    expect(updates).toContain(4);

    await new ExperimentRunner(manifest, runTrial, resultPath).run();
    expect(runTrial).toHaveBeenCalledTimes(4);
    expect(summarizeExperiment(first)).toEqual(expect.objectContaining({
      completed: 4,
      candidateWins: 2,
      winRate: 0.5,
      sideBias: 1,
      medianModelLatencyMs: 100,
      p90ModelLatencyMs: 200,
      inputTokens: 40,
      outputTokens: 20,
    }));

    await expect(new ExperimentRunner({
      ...manifest,
      fixed: { ruleset: "changed-v2" },
    }, runTrial, resultPath).run()).rejects.toThrow("does not match its persisted manifest");
  });
});
