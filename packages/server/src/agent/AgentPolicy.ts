const DEFAULT_STALE_READ_WARNING_TICKS = 10;

/** Agent-facing safety hints, kept outside observation and mutation code. */
export class AgentPolicy {
  constructor(private readonly staleReadWarningTicks = DEFAULT_STALE_READ_WARNING_TICKS) {}

  getStaleReadWarning(lastReadTick: number | null, currentTick: number): Record<string, unknown> | null {
    if (lastReadTick === null) {
      return {
        type: "no_recent_read",
        message: "No read tool has been called in this run. Read the current situation before issuing more actions.",
        currentTick,
        staleAfterTicks: this.staleReadWarningTicks,
      };
    }
    const ageTicks = currentTick - lastReadTick;
    if (ageTicks <= this.staleReadWarningTicks) return null;
    return {
      type: "state_stale",
      message: `Last read was ${ageTicks} ticks ago. Read the current situation before issuing more actions.`,
      lastReadTick,
      currentTick,
      ageTicks,
      staleAfterTicks: this.staleReadWarningTicks,
    };
  }
}
