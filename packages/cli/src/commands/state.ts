import type { ControlClient } from "../client.js";
import { ExitCode, exit } from "../io/errors.js";
import { printJson } from "../io/json.js";

function getFlags(flags: Map<string, string>) {
  return {
    compact: flags.has("compact"),
    cells: flags.has("cells"),
    emptyTiles: flags.has("empty-tiles"),
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

function summarizeSide(data: Record<string, unknown>, relation: "self" | "enemy") {
  const units = ((data.units as Array<Record<string, unknown>>) ?? []).filter((unit) => unit.relation === relation);
  const buildings = ((data.buildings as Array<Record<string, unknown>>) ?? []).filter((building) => building.relation === relation);
  const countByType = (entities: Array<Record<string, unknown>>) => {
    const counts: Record<string, number> = {};
    for (const entity of entities) {
      const type = String(entity.type);
      counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
  };
  return {
    units: countByType(units),
    buildings: countByType(buildings),
    headquarters: buildings.filter((building) => building.type === "hq"),
  };
}

export async function handleState(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const opts = getFlags(flags);
  if (flags.has("ascii")) {
    exit(ExitCode.ArgError, "--ascii has been removed. Use map for structured coordinates or state --compact for a summary.");
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
    data: opts.compact ? (() => {
      const data = stateResp.data as Record<string, unknown>;
      const player = data.player as Record<string, unknown> | undefined;
      return {
        winner: data.winner ?? null,
        ...(data.status ? { status: data.status } : {}),
        ...(data.ready ? { ready: data.ready } : {}),
        width: data.width,
        height: data.height,
        credits: player?.credits,
        self: summarizeSide(data, "self"),
        enemy: summarizeSide(data, "enemy"),
      };
    })() : stateResp.data,
  });
}

export async function handleMap(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  if (flags.has("ascii")) {
    exit(ExitCode.ArgError, "--ascii has been removed. map returns structured coordinates.");
  }
  const opts = getFlags(flags);
  const response = await client.callTool(sessionId, "get_map_state", {
    includeCells: opts.cells,
    includeEmptyTiles: opts.emptyTiles,
  });
  if (!response.ok) {
    exit(ExitCode.BackendFailure, response.error?.message ?? "Failed to get map state");
  }
  printJson({ ok: true, tick: response.tick, kind: "selection", data: response.data });
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
