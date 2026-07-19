import type { GameRecord, PlayerId } from "@llmcraft/shared";
import { getBuildingCost, getUnitCost, RESULT_CODES } from "@llmcraft/shared";

export type MetricScope = "match" | "player";

export interface MetricDefinition {
  id: string;
  version: 1;
  scope: MetricScope;
  unit: "count" | "ticks" | "seconds" | "credits" | "credit_ticks" | "milliseconds" | "tokens" | "ratio";
  description: string;
}

export interface DetectorDefinition {
  id: string;
  version: 1;
  ruleset: string;
  metricId: string;
  operator: ">" | "<" | ">=" | "<=";
  threshold: number;
  severity: "info" | "warning";
}

export interface MetricValue {
  metricId: string;
  metricVersion: number;
  scopeId: string;
  value: number;
  sourcePaths: string[];
}

export interface DetectorFinding {
  detectorId: string;
  detectorVersion: number;
  scopeId: string;
  metricId: string;
  value: number;
  threshold: number;
  severity: DetectorDefinition["severity"];
  rulesetId: string;
}

export interface RecordAnalysisReport {
  analysisVersion: 1;
  match: {
    status: string;
    winner: PlayerId | null;
    tickIntervalMs: number;
    rulesetId: string;
    durationTicks: number;
    durationSeconds: number;
  };
  metrics: MetricValue[];
  findings: DetectorFinding[];
}

export const METRIC_REGISTRY: readonly MetricDefinition[] = [
  { id: "match.duration_ticks", version: 1, scope: "match", unit: "ticks", description: "Committed simulation duration." },
  { id: "match.duration_seconds", version: 1, scope: "match", unit: "seconds", description: "Simulation duration using record tickIntervalMs." },
  { id: "economy.final_credits", version: 1, scope: "player", unit: "credits", description: "Credits at the final keyframe." },
  { id: "economy.peak_credits", version: 1, scope: "player", unit: "credits", description: "Peak observed credits." },
  { id: "economy.idle_credit_integral", version: 1, scope: "player", unit: "credit_ticks", description: "Integral of observed credits over simulation ticks." },
  { id: "army.final_resource_value", version: 1, scope: "player", unit: "credits", description: "Final live army value from the record ruleset." },
  { id: "infrastructure.final_resource_value", version: 1, scope: "player", unit: "credits", description: "Final live building value from the record ruleset." },
  { id: "army.final_units.*", version: 1, scope: "player", unit: "count", description: "Dynamic final unit count by recorded unit type." },
  { id: "infrastructure.final_buildings.*", version: 1, scope: "player", unit: "count", description: "Dynamic final building count by recorded building type." },
  { id: "agent.model_requests", version: 1, scope: "player", unit: "count", description: "Internal model request attempts, including retries." },
  { id: "agent.request_latency_median", version: 1, scope: "player", unit: "milliseconds", description: "Median internal model request latency." },
  { id: "agent.request_latency_p90", version: 1, scope: "player", unit: "milliseconds", description: "P90 internal model request latency." },
  { id: "agent.input_tokens", version: 1, scope: "player", unit: "tokens", description: "Total model input tokens." },
  { id: "agent.output_tokens", version: 1, scope: "player", unit: "tokens", description: "Total model output tokens." },
  { id: "agent.cached_input_tokens", version: 1, scope: "player", unit: "tokens", description: "Total cached input tokens." },
  { id: "agent.tool_calls", version: 1, scope: "player", unit: "count", description: "Tool calls executed by a controller." },
  { id: "agent.invalid_tool_ratio", version: 1, scope: "player", unit: "ratio", description: "Fraction of tool calls returning an error." },
  { id: "agent.command_success_ratio", version: 1, scope: "player", unit: "ratio", description: "Fraction of structured command results that succeeded." },
  { id: "mission.registered", version: 1, scope: "player", unit: "count", description: "Missions registered by the controller." },
] as const;

export const DETECTOR_REGISTRY: readonly DetectorDefinition[] = [
  { id: "floating_credits", version: 1, ruleset: "default-v1", metricId: "economy.peak_credits", operator: ">=", threshold: 2000, severity: "warning" },
  { id: "slow_model_p90", version: 1, ruleset: "*", metricId: "agent.request_latency_p90", operator: ">=", threshold: 5000, severity: "warning" },
  { id: "noisy_tools", version: 1, ruleset: "*", metricId: "agent.invalid_tool_ratio", operator: ">", threshold: 0.25, severity: "warning" },
  { id: "low_command_success", version: 1, ruleset: "*", metricId: "agent.command_success_ratio", operator: "<", threshold: 0.75, severity: "warning" },
] as const;

export function analyzeGameRecord(record: GameRecord): RecordAnalysisReport {
  const tickIntervalMs = record.metadata.tickIntervalMs ?? 500;
  const rulesetId = record.metadata.rulesetId ?? "default-v1";
  const durationTicks = record.finalState.tick;
  const metrics: MetricValue[] = [
    value("match.duration_ticks", "match", durationTicks),
    value("match.duration_seconds", "match", durationTicks * tickIntervalMs / 1000),
  ];
  for (const initialPlayer of record.initialState.players) {
    const playerId = initialPlayer.id;
    const finalPlayer = record.finalState.players.find((player) => player.id === playerId) ?? initialPlayer;
    let credits = initialPlayer.resources.credits;
    let previousTick = record.initialState.tick;
    let peakCredits = credits;
    let idleCreditIntegral = 0;
    for (const delta of record.tickDeltas) {
      idleCreditIntegral += credits * Math.max(0, delta.tick - previousTick);
      const playerDelta = delta.players.find((entry) => entry.playerId === playerId);
      if (playerDelta?.credits !== undefined) credits = playerDelta.credits;
      peakCredits = Math.max(peakCredits, credits);
      previousTick = delta.tick;
    }
    idleCreditIntegral += credits * Math.max(0, durationTicks - previousTick);
    peakCredits = Math.max(peakCredits, finalPlayer.resources.credits);
    const turns = record.aiTurns.filter((turn) => turn.playerId === playerId);
    const requests = turns.flatMap((turn) => turn.metrics?.modelRequestRecords ?? []);
    const latencies = requests.map((request) => request.latencyMs).filter((entry): entry is number => entry !== undefined);
    const tools = turns.flatMap((turn) => turn.toolCalls ?? []);
    const commandFacts = record.commandResults.filter((result) => {
      const command = (result.data as { command?: { playerId?: string } } | undefined)?.command;
      return command?.playerId === playerId;
    });
    const commandSuccesses = commandFacts.filter((result) => {
      const data = result.data as { success?: boolean; result_code?: number } | undefined;
      return data?.success === true || data?.result_code === RESULT_CODES.OK;
    }).length;
    metrics.push(
      value("economy.final_credits", playerId, finalPlayer.resources.credits),
      value("economy.peak_credits", playerId, peakCredits),
      value("economy.idle_credit_integral", playerId, idleCreditIntegral),
      value("army.final_resource_value", playerId, finalPlayer.units.filter((unit) => unit.exists).reduce((sum, unit) => sum + getUnitCost(unit.type), 0)),
      value("infrastructure.final_resource_value", playerId, finalPlayer.buildings.filter((building) => building.exists).reduce((sum, building) => sum + getBuildingCost(building.type), 0)),
      value("agent.model_requests", playerId, requests.length || turns.reduce((sum, turn) => sum + (turn.metrics?.modelRequests ?? 0), 0)),
      value("agent.request_latency_median", playerId, percentile(latencies, 0.5)),
      value("agent.request_latency_p90", playerId, percentile(latencies, 0.9)),
      value("agent.input_tokens", playerId, sum(requests.map((request) => request.inputTokens))),
      value("agent.output_tokens", playerId, sum(requests.map((request) => request.outputTokens))),
      value("agent.cached_input_tokens", playerId, sum(requests.map((request) => request.cachedInputTokens))),
      value("agent.tool_calls", playerId, tools.length),
      value("agent.invalid_tool_ratio", playerId, tools.length === 0 ? 0 : tools.filter((tool) => tool.isError).length / tools.length),
      value("mission.registered", playerId, turns.reduce((sum, turn) => sum + (turn.plans?.length ?? 0), 0)),
    );
    if (commandFacts.length > 0) {
      metrics.push(value("agent.command_success_ratio", playerId, commandSuccesses / commandFacts.length));
    }
    for (const [unitType, count] of countByType(finalPlayer.units.filter((unit) => unit.exists).map((unit) => unit.type))) {
      metrics.push(value(`army.final_units.${unitType}`, playerId, count));
    }
    for (const [buildingType, count] of countByType(finalPlayer.buildings.filter((building) => building.exists).map((building) => building.type))) {
      metrics.push(value(`infrastructure.final_buildings.${buildingType}`, playerId, count));
    }
  }
  return {
    analysisVersion: 1,
    match: {
      status: record.metadata.status,
      winner: record.metadata.winner ?? record.finalState.winner,
      tickIntervalMs,
      rulesetId,
      durationTicks,
      durationSeconds: durationTicks * tickIntervalMs / 1000,
    },
    metrics,
    findings: runDetectors(metrics, rulesetId),
  };
}

export function runDetectors(metrics: readonly MetricValue[], rulesetId = "default-v1"): DetectorFinding[] {
  const findings: DetectorFinding[] = [];
  for (const detector of DETECTOR_REGISTRY) {
    if (detector.ruleset !== "*" && detector.ruleset !== rulesetId) continue;
    for (const metric of metrics.filter((entry) => entry.metricId === detector.metricId)) {
      if (!compare(metric.value, detector.operator, detector.threshold)) continue;
      findings.push({
        detectorId: detector.id,
        detectorVersion: detector.version,
        scopeId: metric.scopeId,
        metricId: metric.metricId,
        value: metric.value,
        threshold: detector.threshold,
        severity: detector.severity,
        rulesetId,
      });
    }
  }
  return findings;
}

function value(metricId: string, scopeId: string, metricValue: number): MetricValue {
  const definition = METRIC_REGISTRY.find((entry) => (
    entry.id === metricId || (entry.id.endsWith("*") && metricId.startsWith(entry.id.slice(0, -1)))
  ));
  if (!definition) throw new Error(`Metric ${metricId} is not registered.`);
  return {
    metricId,
    metricVersion: definition.version,
    scopeId,
    value: Number.isFinite(metricValue) ? metricValue : 0,
    sourcePaths: metricSourcePaths(metricId),
  };
}

function metricSourcePaths(metricId: string): string[] {
  if (metricId.startsWith("match.")) return ["finalState.tick", "metadata.tickIntervalMs"];
  if (metricId.startsWith("economy.")) return ["initialState.players", "tickDeltas[].players", "finalState.players"];
  if (metricId.startsWith("army.") || metricId.startsWith("infrastructure.")) return ["finalState.players"];
  if (metricId === "agent.command_success_ratio") return ["commandResults[].data.command", "commandResults[].data.result_code"];
  if (metricId === "agent.tool_calls" || metricId === "agent.invalid_tool_ratio") return ["aiTurns[].toolCalls"];
  if (metricId.startsWith("agent.")) return ["aiTurns[].metrics.modelRequestRecords"];
  if (metricId.startsWith("mission.")) return ["aiTurns[].plans"];
  return [];
}

function sum(values: Array<number | undefined>): number {
  return values.reduce<number>((total, entry) => total + (entry ?? 0), 0);
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function compare(value: number, operator: DetectorDefinition["operator"], threshold: number): boolean {
  if (operator === ">") return value > threshold;
  if (operator === "<") return value < threshold;
  if (operator === ">=") return value >= threshold;
  return value <= threshold;
}

function countByType(types: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  return counts;
}
