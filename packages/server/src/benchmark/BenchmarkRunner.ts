import type { ServerBenchmarkRoundResult } from "@llmcraft/shared";

export interface BenchmarkTrial {
  round: number;
  llmSide: "player_1" | "player_2";
}

export interface BenchmarkTrialFailure {
  round: number;
  error: string;
}

/**
 * Benchmark-only concurrency runner. It deliberately has no generic
 * "experiment" manifest, persistence, or cross-domain trial abstraction.
 */
export class BenchmarkRunner {
  constructor(
    private readonly trials: readonly BenchmarkTrial[],
    private readonly concurrency: number,
    private readonly runTrial: (trial: BenchmarkTrial) => Promise<ServerBenchmarkRoundResult | null>,
    private readonly shouldStop: () => boolean = () => false,
    private readonly onResult?: (result: ServerBenchmarkRoundResult) => void,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new Error("Benchmark concurrency must be a positive integer.");
    }
  }

  async run(): Promise<{
    results: ServerBenchmarkRoundResult[];
    failures: BenchmarkTrialFailure[];
  }> {
    const results: ServerBenchmarkRoundResult[] = [];
    const failures: BenchmarkTrialFailure[] = [];
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(this.concurrency, this.trials.length) },
      async () => {
        while (nextIndex < this.trials.length && !this.shouldStop()) {
          const trial = this.trials[nextIndex++]!;
          try {
            const result = await this.runTrial(trial);
            if (!result) continue;
            results.push(result);
            this.onResult?.(result);
          } catch (error) {
            failures.push({
              round: trial.round,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
    );
    await Promise.all(workers);
    results.sort((left, right) => left.round - right.round);
    failures.sort((left, right) => left.round - right.round);
    return { results, failures };
  }
}

export function createPairedBenchmarkTrials(rounds: number): BenchmarkTrial[] {
  return Array.from({ length: rounds }, (_, index) => ({
    round: index + 1,
    llmSide: index % 2 === 0 ? "player_1" : "player_2",
  }));
}

export function wilsonInterval(wins: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = wins / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}
