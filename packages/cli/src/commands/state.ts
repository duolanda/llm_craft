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

function renderAsciiMap(data: Record<string, unknown>): string {
  const width = typeof data.width === "number" ? data.width : 0;
  const height = typeof data.height === "number" ? data.height : 0;
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => "."));
  const place = (x: unknown, y: unknown, symbol: string) => {
    if (typeof x !== "number" || typeof y !== "number" || y < 0 || y >= height || x < 0 || x >= width) {
      return;
    }
    grid[y]![x] = symbol;
  };
  for (const cell of (data.cells as Array<Record<string, unknown>> | undefined) ?? []) {
    if (cell.tile === "obstacle") place(cell.x, cell.y, "#");
    if (cell.tile === "resource") place(cell.x, cell.y, "*");
  }
  for (const resource of (data.resources as Array<Record<string, unknown>> | undefined) ?? []) {
    place(resource.x, resource.y, "*");
  }
  const symbolFor = (type: unknown, relation: unknown) => {
    const symbol =
      type === "hq" ? "H" :
        type === "barracks" ? "B" :
          type === "war_factory" ? "F" :
            type === "refinery" ? "D" :
              type === "light_tank" ? "T" :
                type === "rocket_soldier" ? "R" :
                  type === "rifleman" ? "I" :
                    type === "soldier" ? "S" :
                      type === "worker" ? "W" : "?";
    return relation === "enemy" ? symbol.toLowerCase() : symbol;
  };
  for (const building of (data.buildings as Array<Record<string, unknown>> | undefined) ?? []) {
    place(building.x, building.y, symbolFor(building.type, building.relation));
  }
  for (const unit of (data.units as Array<Record<string, unknown>> | undefined) ?? []) {
    place(unit.x, unit.y, symbolFor(unit.type, unit.relation));
  }
  return grid.map((row) => row.join("")).join("\n");
}

export async function handleState(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const opts = getFlags(flags);

  if (opts.compact || opts.ascii) {
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
        asciiMap: renderAsciiMap(data),
        ...(opts.cells && data.cells ? { cells: data.cells } : {}),
        winner: stateData.winner ?? null,
        ...(stateData.status ? { status: stateData.status } : {}),
        ...(stateData.ready ? { ready: stateData.ready } : {}),
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
