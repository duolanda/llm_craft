import type { ControlClient } from "../client.js";
import { ExitCode, exit } from "../io/errors.js";
import { printJson } from "../io/json.js";

// --- shared filter helpers ---

interface HasCoord {
  x: number;
  y: number;
}

function chebyshev(a: HasCoord, b: HasCoord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function parseCoord(raw: string): { x: number; y: number } {
  const parts = raw.split(",");
  if (parts.length !== 2) {
    exit(ExitCode.ArgError, `Invalid coordinate: ${raw}. Expected x,y`);
  }
  const x = parseInt(parts[0], 10);
  const y = parseInt(parts[1], 10);
  if (isNaN(x) || isNaN(y)) {
    exit(ExitCode.ArgError, `Invalid coordinate: ${raw}. Expected x,y`);
  }
  return { x, y };
}

interface SelectFlags {
  type?: string;
  idle?: boolean;
  planned?: boolean;
  unplanned?: boolean;
  ready?: boolean;
  near?: { x: number; y: number };
  limit?: number;
}

function parseSelectFlags(flags: Map<string, string>): SelectFlags {
  const result: SelectFlags = {};
  if (flags.has("type")) {
    result.type = flags.get("type")!;
  }
  result.idle = flags.has("idle");
  result.planned = flags.has("planned");
  result.unplanned = flags.has("unplanned");
  result.ready = flags.has("ready");
  if (flags.has("near")) {
    result.near = parseCoord(flags.get("near")!);
  }
  if (flags.has("limit")) {
    result.limit = parseInt(flags.get("limit")!, 10);
  }
  return result;
}

function filterByType<T extends { type: string }>(items: T[], type?: string): T[] {
  if (!type) return items;
  return items.filter((item) => item.type === type);
}

interface NearSorted<T> {
  item: T;
  dist: number;
}

function filterByNear<T extends HasCoord>(items: T[], near?: { x: number; y: number }): NearSorted<T>[] {
  if (!near) return items.map((item) => ({ item, dist: 0 }));
  return items
    .map((item) => ({ item, dist: chebyshev(item, near) }))
    .sort((a, b) => a.dist - b.dist);
}

function applyLimit<T>(items: T[], limit?: number): T[] {
  if (!limit) return items;
  return items.slice(0, limit);
}

function toSelection(tick: number, key: string, data: unknown) {
  return { ok: true, tick, kind: "selection" as const, data: { [key]: data } };
}

// --- unit helpers ---

interface UnitSummary {
  id: string;
  type: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: string;
  hasActivePlan?: boolean;
  relation?: string;
}

// --- commands ---

export async function handleUnits(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const opts = parseSelectFlags(flags);

  const resp = await client.callTool(sessionId, "get_my_units");
  if (!resp.ok) {
    exit(ExitCode.BackendFailure, resp.error?.message ?? "Failed to get units");
  }
  const data = resp.data as Record<string, unknown>;
  let units = (data.units as UnitSummary[]) ?? [];

  units = filterByType(units, opts.type);

  if (opts.idle) {
    units = units.filter((u) => u.state === "idle");
  }
  if (opts.planned) {
    units = units.filter((u) => u.hasActivePlan === true);
  }
  if (opts.unplanned) {
    units = units.filter((u) => !u.hasActivePlan);
  }

  if (opts.near) {
    units = filterByNear(units, opts.near).map((e) => e.item);
  }
  units = applyLimit(units, opts.limit);

  printJson(toSelection(resp.tick, "units", units));
}

export async function handleBuildings(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const opts = parseSelectFlags(flags);

  const resp = await client.callTool(sessionId, "get_my_state");
  if (!resp.ok) {
    exit(ExitCode.BackendFailure, resp.error?.message ?? "Failed to get buildings");
  }
  const data = resp.data as Record<string, unknown>;
  let buildings = (data.buildings as UnitSummary[]) ?? [];
  const queues = (data.productionQueues as Array<{ buildingId: string; queue: unknown[] }>) ?? [];

  buildings = filterByType(buildings, opts.type);

  if (opts.ready) {
    const emptyQueueIds = new Set(
      queues.filter((q) => q.queue.length === 0).map((q) => q.buildingId),
    );
    buildings = buildings.filter((b) => emptyQueueIds.has(b.id));
  }

  if (opts.near) {
    buildings = filterByNear(buildings, opts.near).map((e) => e.item);
  }
  buildings = applyLimit(buildings, opts.limit);

  printJson(toSelection(resp.tick, "buildings", buildings));
}

export async function handleEnemies(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const opts = parseSelectFlags(flags);

  const resp = await client.callTool(sessionId, "get_map_state", {
    includeCells: false,
    includeEmptyTiles: false,
  });
  if (!resp.ok) {
    exit(ExitCode.BackendFailure, resp.error?.message ?? "Failed to get map state");
  }
  const data = resp.data as Record<string, unknown>;
  const mapUnits = (data.units as UnitSummary[]) ?? [];
  const mapBuildings = (data.buildings as UnitSummary[]) ?? [];

  // Combine enemy units and buildings
  let enemies: UnitSummary[] = [
    ...mapUnits.filter((u) => u.relation === "enemy"),
    ...mapBuildings.filter((b) => b.relation === "enemy"),
  ];

  enemies = filterByType(enemies, opts.type);

  if (opts.near) {
    enemies = filterByNear(enemies, opts.near).map((e) => e.item);
  }
  enemies = applyLimit(enemies, opts.limit);

  printJson(toSelection(resp.tick, "enemies", enemies));
}

interface CellSummary {
  x: number;
  y: number;
  tile: string;
}

export async function handleResources(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const opts = parseSelectFlags(flags);

  const resp = await client.callTool(sessionId, "get_map_state", {
    includeCells: true,
    includeEmptyTiles: false,
  });
  if (!resp.ok) {
    exit(ExitCode.BackendFailure, resp.error?.message ?? "Failed to get map state");
  }
  const data = resp.data as Record<string, unknown>;
  const cells = (data.cells as CellSummary[]) ?? [];

  let resources = cells.filter((c) => c.tile === "resource");

  if (opts.near) {
    resources = filterByNear(resources, opts.near).map((e) => e.item);
  }
  resources = applyLimit(resources, opts.limit);

  printJson(toSelection(resp.tick, "resources", resources));
}
