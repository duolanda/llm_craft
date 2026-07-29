/** Agent-facing safety hints, kept outside observation and mutation code. */
export class AgentPolicy {
  getReadWarning(lastReadTick: number | null, currentTick: number): Record<string, unknown> | null {
    if (lastReadTick !== null) return null;
    return {
      type: "no_recent_read",
      message: "No read tool has been called in this run. Read the current situation before issuing more actions.",
      currentTick,
    };
  }
}
