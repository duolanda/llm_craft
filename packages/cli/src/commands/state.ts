import type { ControlClient } from "../client.js";
import { ExitCode, exit } from "../io/errors.js";
import { printJson } from "../io/json.js";

function getFlags(flags: Map<string, string>) {
  return {
    compact: flags.has("compact"),
    cells: flags.has("cells"),
    emptyTiles: flags.has("empty-tiles"),
    ascii: flags.has("ascii"),
    limit: flags.has("limit") ? parseInt(flags.get("limit")!, 10) : undefined,
  };
}

function toSelectionResponse(
  toolResponse: unknown,
  dataKey: string,
  data: unknown,
) {
  const resp = toolResponse as Record<string, unknown>;
  return {
    ok: true,
    tick: resp.tick as number,
    kind: "selection" as const,
    data: { [dataKey]: data },
  };
}

export async function handleState(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const opts = getFlags(flags);

  if (opts.compact || opts.ascii) {
    if (!opts.cells && !opts.emptyTiles) {
      const stateResp = await client.getState(sessionId);
      if (!stateResp.ok) {
        exit(ExitCode.BackendFailure, stateResp.error?.message ?? "Failed to get state");
      }
      const data = stateResp.data as Record<string, unknown>;
      printJson({
        ok: true,
        tick: stateResp.tick,
        kind: "selection",
        data: {
          asciiMap: data.asciiMap,
          winner: data.winner ?? null,
        },
      });
      return;
    }

    // Compact: only asciiMap + tick
    const mapResp = await client.callTool(sessionId, "get_map_state", {
      includeCells: opts.cells || false,
      includeEmptyTiles: opts.emptyTiles || false,
    });
    if (!mapResp.ok) {
      exit(ExitCode.BackendFailure, mapResp.error?.message ?? "Failed to get map state");
    }
    const data = mapResp.data as Record<string, unknown>;
    const stateResp = await client.getState(sessionId);
    const stateData = stateResp.ok ? stateResp.data as Record<string, unknown> : {};
    printJson({
      ok: true,
      tick: mapResp.tick,
      kind: "selection",
      data: {
        asciiMap: data.asciiMap,
        ...(opts.cells && data.cells ? { cells: data.cells } : {}),
        winner: stateData.winner ?? null,
      },
    });
    return;
  }

  // Full state: use the combined /state endpoint
  const stateResp = await client.getState(sessionId);
  if (!stateResp.ok) {
    exit(ExitCode.BackendFailure, stateResp.error?.message ?? "Failed to get state");
  }
  printJson({
    ok: true,
    tick: stateResp.tick,
    kind: "selection",
    data: stateResp.data,
  });
}

export async function handleMap(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  // Alias for state --compact
  flags.set("compact", "true");
  if (!flags.has("ascii")) {
    flags.set("ascii", "true");
  }
  return handleState(client, sessionId, flags);
}

export async function handleMe(
  client: ControlClient,
  sessionId: string,
): Promise<void> {
  const resp = await client.callTool(sessionId, "get_my_state");
  if (!resp.ok) {
    exit(ExitCode.BackendFailure, resp.error?.message ?? "Failed to get my state");
  }
  const data = resp.data as Record<string, unknown>;
  printJson(toSelectionResponse(resp, "player", data));
}

export async function handleEvents(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const resp = await client.callTool(sessionId, "get_recent_events");
  if (!resp.ok) {
    exit(ExitCode.BackendFailure, resp.error?.message ?? "Failed to get events");
  }
  const data = resp.data as Record<string, unknown>;
  const events = (data.events as unknown[]) ?? [];
  const limit = flags.has("limit") ? parseInt(flags.get("limit")!, 10) : undefined;
  const sliced = limit ? events.slice(-limit) : events;
  printJson(toSelectionResponse(resp, "events", sliced));
}

export async function handlePlans(
  client: ControlClient,
  sessionId: string,
): Promise<void> {
  const resp = await client.callTool(sessionId, "get_active_plans");
  if (!resp.ok) {
    exit(ExitCode.BackendFailure, resp.error?.message ?? "Failed to get plans");
  }
  const data = resp.data as Record<string, unknown>;
  printJson(toSelectionResponse(resp, "plans", data.plans ?? data));
}
