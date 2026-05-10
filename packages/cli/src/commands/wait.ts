import type { ControlClient } from "../client.js";
import { ExitCode, exit } from "../io/errors.js";
import { printJson } from "../io/json.js";

export async function handleWait(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const ticksRaw = flags.get("ticks");
  if (!ticksRaw) {
    exit(ExitCode.ArgError, "wait requires --ticks <n>");
  }
  const ticks = parseInt(ticksRaw, 10);
  if (isNaN(ticks) || ticks <= 0) {
    exit(ExitCode.ArgError, "wait --ticks must be a positive integer");
  }

  const resp = await client.waitTicks(sessionId, ticks);
  if (!resp.ok) {
    exit(ExitCode.BackendFailure, resp.error?.message ?? "Failed to wait");
  }
  printJson(resp);
}
