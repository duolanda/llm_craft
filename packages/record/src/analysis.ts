import type { MatchRecord, PlayerId } from "@llmcraft/shared";
import { getBuildingCost, getUnitCost, RESULT_CODES } from "@llmcraft/shared";

interface DetectorDefinition {
  id: string;
  ruleset: string;
  metricId: string;
  operator: ">" | "<" | ">=" | "<=";
  threshold: number;
  severity: "info" | "warning";
}

export interface MetricValue {
  metricId: string;
  scopeId: string;
  value: number;
}

export interface DetectorFinding {
  detectorId: string;
  scopeId: string;
  metricId: string;
  value: number;
  threshold: number;
  severity: DetectorDefinition["severity"];
  rulesetId: string;
}

export interface RecordAnalysisReport {
  match: {
    status: string;
    winner: PlayerId | null;
    tickIntervalMs: number;
    rulesetId: string;
    durationTicks: number;
    durationSeconds: number;
  };
  agents: AgentAnalysisReport[];
  metrics: MetricValue[];
  findings: DetectorFinding[];
}

export interface AgentRequestDiagnostic {
  turnId?: string;
  requestTick: number;
  executeTick: number;
  requestIndex: number;
  status: "success" | "error";
  finishReason: string;
  error?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  messageCount: number;
  toolCount: number;
}

export interface AgentAnalysisReport {
  playerId: PlayerId;
  requestCount: number;
  requests: AgentRequestDiagnostic[];
  statusCounts: Record<string, number>;
  finishReasonCounts: Record<string, number>;
  errorCount: number;
  errorCounts: Record<string, number>;
  longestSameErrorStreak: { count: number; error: string | null };
  zeroOutputCount: number;
  emptyMaxTokenCount: number;
  latencyMs: { p50: number; p90: number; max: number };
  tokens: { input: number; output: number; reasoning: number; cachedInput: number };
  contextDroppedMessages: number;
  contextTruncatedMessages: number;
  toolCalls: number;
  successfulToolCalls: number;
  invalidToolCalls: number;
  turnsWithTools: number;
  commandsSubmitted: number;
  turnsWithCommands: number;
  commandResults: number;
  successfulCommandResults: number;
  requestTickRange: { first: number | null; last: number | null };
}

const DETECTORS: readonly DetectorDefinition[] = [
  { id: "floating_credits", ruleset: "standard", metricId: "economy.peak_credits", operator: ">=", threshold: 2000, severity: "warning" },
  { id: "slow_model_p90", ruleset: "*", metricId: "agent.request_latency_p90", operator: ">=", threshold: 5000, severity: "warning" },
  { id: "noisy_tools", ruleset: "*", metricId: "agent.invalid_tool_ratio", operator: ">", threshold: 0.25, severity: "warning" },
  { id: "low_command_success", ruleset: "*", metricId: "agent.command_success_ratio", operator: "<", threshold: 0.75, severity: "warning" },
  { id: "request_error_storm", ruleset: "*", metricId: "agent.longest_same_error_streak", operator: ">=", threshold: 5, severity: "warning" },
  { id: "empty_max_token_response", ruleset: "*", metricId: "agent.empty_max_token_requests", operator: ">=", threshold: 1, severity: "warning" },
] as const;

export function analyzeMatchRecord(record: MatchRecord): RecordAnalysisReport {
  const tickIntervalMs = record.definition.tickIntervalMs;
  const rulesetId = record.definition.rulesetId;
  const durationTicks = record.finalState.tick;
  const metrics: MetricValue[] = [
    value("match.duration_ticks", "match", durationTicks),
    value("match.duration_seconds", "match", durationTicks * tickIntervalMs / 1000),
  ];
  const agents: AgentAnalysisReport[] = [];
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
    const turns = (record.aiTurns ?? []).filter((turn) => turn.playerId === playerId);
    const requests = turns.flatMap((turn) => turn.metrics?.modelRequestRecords ?? []);
    const latencies = requests.map((request) => request.latencyMs).filter((entry): entry is number => entry !== undefined);
    const tools = turns.flatMap((turn) => turn.toolCalls ?? []);
    const commandFacts = (record.commandResults ?? []).filter((result) => {
      const command = (result.data as { command?: { playerId?: string } } | undefined)?.command;
      return command?.playerId === playerId;
    });
    const commandSuccesses = commandFacts.filter((result) => {
      const data = result.data as { success?: boolean; result_code?: number } | undefined;
      return data?.success === true || data?.result_code === RESULT_CODES.OK;
    }).length;
    const agent = buildAgentAnalysis(playerId, turns, commandFacts, commandSuccesses);
    agents.push(agent);
    metrics.push(
      value("economy.final_credits", playerId, finalPlayer.resources.credits),
      value("economy.peak_credits", playerId, peakCredits),
      value("economy.idle_credit_integral", playerId, idleCreditIntegral),
      value("army.final_resource_value", playerId, finalPlayer.units.filter((unit) => unit.exists).reduce((sum, unit) => sum + getUnitCost(unit.type), 0)),
      value("infrastructure.final_resource_value", playerId, finalPlayer.buildings.filter((building) => building.exists).reduce((sum, building) => sum + getBuildingCost(building.type), 0)),
      value("agent.model_requests", playerId, requests.length || turns.reduce((sum, turn) => sum + (turn.metrics?.modelRequests ?? 0), 0)),
      value("agent.request_latency_median", playerId, percentile(latencies, 0.5)),
      value("agent.request_latency_p90", playerId, percentile(latencies, 0.9)),
      value("agent.request_latency_max", playerId, agent.latencyMs.max),
      value("agent.input_tokens", playerId, sum(requests.map((request) => request.inputTokens))),
      value("agent.output_tokens", playerId, sum(requests.map((request) => request.outputTokens))),
      value("agent.reasoning_tokens", playerId, agent.tokens.reasoning),
      value("agent.cached_input_tokens", playerId, sum(requests.map((request) => request.cachedInputTokens))),
      value("agent.request_errors", playerId, agent.errorCount),
      value("agent.longest_same_error_streak", playerId, agent.longestSameErrorStreak.count),
      value("agent.zero_output_requests", playerId, agent.zeroOutputCount),
      value("agent.empty_max_token_requests", playerId, agent.emptyMaxTokenCount),
      value("agent.context_dropped_messages", playerId, agent.contextDroppedMessages),
      value("agent.context_truncated_messages", playerId, agent.contextTruncatedMessages),
      value("agent.tool_calls", playerId, tools.length),
      value("agent.invalid_tool_ratio", playerId, tools.length === 0 ? 0 : tools.filter((tool) => tool.isError).length / tools.length),
      value("mission.registered", playerId, turns.reduce((sum, turn) => sum + (turn.plans?.length ?? 0), 0)),
      value("agent.commands_submitted", playerId, agent.commandsSubmitted),
      value("agent.command_results", playerId, agent.commandResults),
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
    match: {
      status: record.metadata.status,
      winner: record.metadata.winner ?? record.finalState.winner,
      tickIntervalMs,
      rulesetId,
      durationTicks,
      durationSeconds: durationTicks * tickIntervalMs / 1000,
    },
    agents,
    metrics,
    findings: runDetectors(metrics, rulesetId),
  };
}

function buildAgentAnalysis(
  playerId: PlayerId,
  turns: NonNullable<MatchRecord["aiTurns"]>,
  commandFacts: NonNullable<MatchRecord["commandResults"]>,
  commandSuccesses: number,
): AgentAnalysisReport {
  const requests: AgentRequestDiagnostic[] = turns.flatMap((turn) => (
    (turn.metrics?.modelRequestRecords ?? []).map((request) => ({
      turnId: turn.turnId,
      requestTick: turn.requestTick,
      executeTick: turn.executeTick,
      requestIndex: request.requestIndex,
      status: requestStatus(request),
      finishReason: request.finishReason,
      ...(request.error ? { error: request.error } : {}),
      ...(request.latencyMs !== undefined ? { latencyMs: request.latencyMs } : {}),
      ...(request.inputTokens !== undefined ? { inputTokens: request.inputTokens } : {}),
      ...(request.outputTokens !== undefined ? { outputTokens: request.outputTokens } : {}),
      ...(request.reasoningTokens !== undefined ? { reasoningTokens: request.reasoningTokens } : {}),
      ...(request.cachedInputTokens !== undefined ? { cachedInputTokens: request.cachedInputTokens } : {}),
      messageCount: request.messageCount,
      toolCount: request.toolCount,
    }))
  ));
  const statusCounts = countStrings(requests.map((request) => request.status));
  const finishReasonCounts = countStrings(requests.map((request) => request.finishReason));
  const errorRequests = requests.filter((request) => request.status === "error");
  const errorCounts = countStrings(errorRequests.map((request) => request.error?.trim() || request.finishReason));
  const longestSameErrorStreak = longestErrorStreak(requests);
  const latencies = requests.map((request) => request.latencyMs).filter((entry): entry is number => entry !== undefined);
  const tools = turns.flatMap((turn) => turn.toolCalls ?? []);
  const commands = turns.flatMap((turn) => turn.commands ?? []);
  const requestTicks = turns
    .filter((turn) => (turn.metrics?.modelRequestRecords?.length ?? turn.metrics?.modelRequests ?? 0) > 0)
    .map((turn) => turn.requestTick);
  return {
    playerId,
    requestCount: requests.length || turns.reduce((total, turn) => total + (turn.metrics?.modelRequests ?? 0), 0),
    requests,
    statusCounts,
    finishReasonCounts,
    errorCount: errorRequests.length,
    errorCounts,
    longestSameErrorStreak,
    zeroOutputCount: requests.filter((request) => request.status === "success" && request.outputTokens === 0).length,
    emptyMaxTokenCount: requests.filter((request) => (
      request.status === "success"
      && request.outputTokens === 0
      && (request.finishReason === "length" || request.finishReason === "max_tokens")
    )).length,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p90: percentile(latencies, 0.9),
      max: latencies.length > 0 ? Math.max(...latencies) : 0,
    },
    tokens: {
      input: sum(requests.map((request) => request.inputTokens)),
      output: sum(requests.map((request) => request.outputTokens)),
      reasoning: sum(requests.map((request) => request.reasoningTokens)),
      cachedInput: sum(requests.map((request) => request.cachedInputTokens)),
    },
    contextDroppedMessages: sum(turns.map((turn) => turn.metrics?.contextWindow?.droppedMessages)),
    contextTruncatedMessages: sum(turns.map((turn) => turn.metrics?.contextWindow?.truncatedMessages)),
    toolCalls: tools.length || turns.reduce((total, turn) => total + (turn.metrics?.toolCalls ?? 0), 0),
    successfulToolCalls: tools.filter((tool) => !tool.isError).length,
    invalidToolCalls: tools.filter((tool) => tool.isError).length,
    turnsWithTools: turns.filter((turn) => (turn.toolCalls?.length ?? 0) > 0).length,
    commandsSubmitted: commands.length,
    turnsWithCommands: turns.filter((turn) => (turn.commands?.length ?? 0) > 0).length,
    commandResults: commandFacts.length,
    successfulCommandResults: commandSuccesses,
    requestTickRange: {
      first: requestTicks.length > 0 ? Math.min(...requestTicks) : null,
      last: requestTicks.length > 0 ? Math.max(...requestTicks) : null,
    },
  };
}

function requestStatus(request: NonNullable<NonNullable<MatchRecord["aiTurns"]>[number]["metrics"]["modelRequestRecords"]>[number]): "success" | "error" {
  if (request.status) return request.status;
  return request.error || request.finishReason === "request_error" ? "error" : "success";
}

function countStrings(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of values) counts[entry] = (counts[entry] ?? 0) + 1;
  return counts;
}

function longestErrorStreak(requests: AgentRequestDiagnostic[]): { count: number; error: string | null } {
  let longest = { count: 0, error: null as string | null };
  let current = { count: 0, error: null as string | null };
  for (const request of requests) {
    if (request.status !== "error") {
      current = { count: 0, error: null };
      continue;
    }
    const error = request.error?.trim() || request.finishReason;
    current = current.error === error
      ? { count: current.count + 1, error }
      : { count: 1, error };
    if (current.count > longest.count) longest = { ...current };
  }
  return longest;
}

export function runDetectors(metrics: readonly MetricValue[], rulesetId = "standard"): DetectorFinding[] {
  const findings: DetectorFinding[] = [];
  for (const detector of DETECTORS) {
    if (detector.ruleset !== "*" && detector.ruleset !== rulesetId) continue;
    for (const metric of metrics.filter((entry) => entry.metricId === detector.metricId)) {
      if (!compare(metric.value, detector.operator, detector.threshold)) continue;
      findings.push({
        detectorId: detector.id,
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
  return {
    metricId,
    scopeId,
    value: Number.isFinite(metricValue) ? metricValue : 0,
  };
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
