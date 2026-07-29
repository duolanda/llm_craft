import {
  DEFAULT_CPU_DECISION_INTERVAL_TICKS,
  MAX_CPU_DECISION_INTERVAL_TICKS,
  MIN_CPU_DECISION_INTERVAL_TICKS,
} from "@llmcraft/shared";

export function resolveCPUDecisionIntervalTicks(value?: number): number {
  const interval = value ?? DEFAULT_CPU_DECISION_INTERVAL_TICKS;
  if (
    !Number.isInteger(interval)
    || interval < MIN_CPU_DECISION_INTERVAL_TICKS
    || interval > MAX_CPU_DECISION_INTERVAL_TICKS
  ) {
    throw new Error(
      `CPU decisionIntervalTicks must be an integer from ${MIN_CPU_DECISION_INTERVAL_TICKS} to ${MAX_CPU_DECISION_INTERVAL_TICKS}.`,
    );
  }
  return interval;
}

export function isCPUDecisionTick(
  currentTick: number,
  lastDispatchTick: number,
  intervalTicks: number,
): boolean {
  return lastDispatchTick < 0 || currentTick - lastDispatchTick >= intervalTicks;
}
