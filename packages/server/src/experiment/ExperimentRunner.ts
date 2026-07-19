import fs from "node:fs/promises";
import path from "node:path";

export interface ExperimentTrialDefinition {
  trialId: string;
  seed: number;
  repeat: number;
  side: "player_1" | "player_2";
  variables: Record<string, unknown>;
}

export interface ExperimentManifestV1 {
  manifestVersion: 1;
  experimentId: string;
  createdAt: string;
  baseline?: string;
  fixed: Record<string, unknown>;
  concurrency: number;
  trials: ExperimentTrialDefinition[];
}

export interface ExperimentTrialResult {
  trialId: string;
  status: "completed" | "failed";
  winner?: "candidate" | "baseline" | "draw";
  durationTicks?: number;
  modelLatencyMs?: number[];
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  payload?: unknown;
  error?: string;
  completedAt: string;
}

export interface ExperimentResultFileV1 {
  resultVersion: 1;
  manifest: ExperimentManifestV1;
  results: ExperimentTrialResult[];
  updatedAt: string;
}

export interface ExperimentSummary {
  completed: number;
  failed: number;
  candidateWins: number;
  winRate: number;
  winRateConfidence95: { low: number; high: number };
  sideBias: number;
  medianDurationTicks: number;
  p90DurationTicks: number;
  medianModelLatencyMs: number;
  p90ModelLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

export class ExperimentRunner {
  constructor(
    private readonly manifest: ExperimentManifestV1,
    private readonly runTrial: (trial: ExperimentTrialDefinition) => Promise<Omit<ExperimentTrialResult, "trialId" | "completedAt">>,
    private readonly resultPath?: string,
    private readonly shouldStop: () => boolean = () => false,
    private readonly onUpdate?: (file: ExperimentResultFileV1) => void,
  ) {
    if (!Number.isSafeInteger(manifest.concurrency) || manifest.concurrency <= 0) {
      throw new Error("Experiment concurrency must be a positive integer.");
    }
  }

  async run(): Promise<ExperimentResultFileV1> {
    const file = await this.loadOrCreate();
    this.onUpdate?.(file);
    const completedIds = new Set(file.results.filter((result) => result.status === "completed").map((result) => result.trialId));
    const queue = this.manifest.trials.filter((trial) => !completedIds.has(trial.trialId));
    let next = 0;
    let writeChain = Promise.resolve();
    const persist = () => {
      writeChain = writeChain.then(() => this.persist(file));
      return writeChain;
    };
    const workers = Array.from({ length: Math.min(this.manifest.concurrency, queue.length) }, async () => {
      while (next < queue.length && !this.shouldStop()) {
        const trial = queue[next++]!;
        let result: ExperimentTrialResult;
        try {
          result = { trialId: trial.trialId, ...await this.runTrial(trial), completedAt: new Date().toISOString() };
        } catch (error) {
          result = {
            trialId: trial.trialId,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            completedAt: new Date().toISOString(),
          };
        }
        const oldIndex = file.results.findIndex((entry) => entry.trialId === trial.trialId);
        if (oldIndex === -1) file.results.push(result);
        else file.results[oldIndex] = result;
        file.updatedAt = new Date().toISOString();
        this.onUpdate?.(file);
        await persist();
      }
    });
    await Promise.all(workers);
    await writeChain;
    file.results.sort((left, right) => left.trialId.localeCompare(right.trialId));
    return file;
  }

  private async loadOrCreate(): Promise<ExperimentResultFileV1> {
    if (this.resultPath) {
      try {
        const parsed = JSON.parse(await fs.readFile(this.resultPath, "utf8")) as ExperimentResultFileV1;
        if (parsed.resultVersion === 1 && parsed.manifest.experimentId === this.manifest.experimentId) {
          if (!Array.isArray(parsed.results) || !this.hasCompatibleDefinition(parsed.manifest)) {
            throw new Error(`Experiment ${this.manifest.experimentId} does not match its persisted manifest.`);
          }
          return parsed;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { resultVersion: 1, manifest: structuredClone(this.manifest), results: [], updatedAt: new Date().toISOString() };
  }

  private hasCompatibleDefinition(persisted: ExperimentManifestV1): boolean {
    return persisted.manifestVersion === this.manifest.manifestVersion
      && persisted.baseline === this.manifest.baseline
      && stableStringify(persisted.fixed) === stableStringify(this.manifest.fixed)
      && stableStringify(persisted.trials) === stableStringify(this.manifest.trials);
  }

  private async persist(file: ExperimentResultFileV1): Promise<void> {
    if (!this.resultPath) return;
    await fs.mkdir(path.dirname(this.resultPath), { recursive: true });
    const temporary = `${this.resultPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.resultPath);
  }
}

export function summarizeExperiment(file: ExperimentResultFileV1): ExperimentSummary {
  const completed = file.results.filter((result) => result.status === "completed");
  const wins = completed.filter((result) => result.winner === "candidate");
  const durations = completed.map((result) => result.durationTicks).filter((value): value is number => value !== undefined);
  const latencies = completed.flatMap((result) => result.modelLatencyMs ?? []);
  const sideByTrial = new Map(file.manifest.trials.map((trial) => [trial.trialId, trial.side]));
  const p1 = completed.filter((result) => sideByTrial.get(result.trialId) === "player_1");
  const p2 = completed.filter((result) => sideByTrial.get(result.trialId) === "player_2");
  const p1Rate = p1.length === 0 ? 0 : p1.filter((result) => result.winner === "candidate").length / p1.length;
  const p2Rate = p2.length === 0 ? 0 : p2.filter((result) => result.winner === "candidate").length / p2.length;
  return {
    completed: completed.length,
    failed: file.results.length - completed.length,
    candidateWins: wins.length,
    winRate: completed.length === 0 ? 0 : wins.length / completed.length,
    winRateConfidence95: wilsonInterval(wins.length, completed.length),
    sideBias: p1.length === 0 || p2.length === 0 ? 0 : p1Rate - p2Rate,
    medianDurationTicks: percentile(durations, 0.5),
    p90DurationTicks: percentile(durations, 0.9),
    medianModelLatencyMs: percentile(latencies, 0.5),
    p90ModelLatencyMs: percentile(latencies, 0.9),
    inputTokens: completed.reduce((sum, result) => sum + (result.inputTokens ?? 0), 0),
    outputTokens: completed.reduce((sum, result) => sum + (result.outputTokens ?? 0), 0),
    totalCost: completed.reduce((sum, result) => sum + (result.cost ?? 0), 0),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function createPairedTrials(options: {
  seeds: number[];
  repeats: number;
  variables?: Record<string, unknown>;
}): ExperimentTrialDefinition[] {
  const trials: ExperimentTrialDefinition[] = [];
  for (const seed of options.seeds) {
    for (let repeat = 1; repeat <= options.repeats; repeat++) {
      for (const side of ["player_1", "player_2"] as const) {
        trials.push({ trialId: `seed-${seed}-repeat-${repeat}-${side}`, seed, repeat, side, variables: structuredClone(options.variables ?? {}) });
      }
    }
  }
  return trials;
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
