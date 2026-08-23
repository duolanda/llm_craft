import type { ControlClient } from "../client.js";
import {
  ALL_BUILDING_TYPES,
  ALL_UNIT_TYPES,
  BUILDING_TYPES,
  getProductionOptions,
  type ControlBatchAction,
  type UnitType,
} from "@llmcraft/shared";
import { ExitCode, exit } from "../io/errors.js";
import { printJson } from "../io/json.js";
import { readStdin } from "../io/stdin.js";

const BUILDABLE_BUILDING_TYPES = ALL_BUILDING_TYPES.filter((buildingType) => buildingType !== BUILDING_TYPES.HQ);
const ATTACK_TARGET_TYPES = [...ALL_UNIT_TYPES, ...ALL_BUILDING_TYPES];
const TRAINABLE_UNIT_TYPES = [...new Set(ALL_BUILDING_TYPES.flatMap((buildingType) => getProductionOptions(buildingType)))] as UnitType[];

function getFlagUnitIds(flags: Map<string, string>): string[] {
  const values = [flags.get("unit"), flags.get("units")]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function getFlagBuildingIds(flags: Map<string, string>): string[] {
  const values = [flags.get("building"), flags.get("buildings")]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
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

async function callAndPrint(
  client: ControlClient,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  const resp = await client.callTool(sessionId, toolName, args);
  printJson(resp);
  if (!resp.ok) {
    process.exit(ExitCode.BackendFailure);
  }
}

async function callBatchAndPrint(
  client: ControlClient,
  sessionId: string,
  actions: ControlBatchAction[],
  requestId?: string,
): Promise<void> {
  const resp = await client.callActionBatch(sessionId, actions, requestId);
  printJson(resp);
  if (!resp.ok) process.exit(ExitCode.BackendFailure);
}

// --- move ---

export async function handleMove(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const unitIds = getFlagUnitIds(flags);
  const toRaw = flags.get("to");

  if (unitIds.length > 0 && toRaw) {
    const { x, y } = parseCoord(toRaw);
    await callAndPrint(client, sessionId, "move_unit", { unitIds, x, y });
    return;
  }

  const stdinInput = await readStdin();
  if (!stdinInput || stdinInput.kind !== "selection") {
    exit(ExitCode.ArgError, "move requires --unit <id> --to x,y or stdin selection (from units)");
  }
  const data = stdinInput.data as Record<string, unknown>;
  const items = (data.units as Array<Record<string, unknown>>) ?? [];
  if (items.length === 0) {
    exit(ExitCode.ArgError, "move: stdin selection has no units");
  }

  if (!toRaw) {
    exit(ExitCode.ArgError, "move with stdin requires --to x,y");
  }
  const to = parseCoord(toRaw);

  await callBatchAndPrint(client, sessionId, [{
    tool: "move_unit",
    args: {
      unitIds: items.map((item) => item.id as string),
      x: to.x,
      y: to.y,
    },
  }], flags.get("request-id"));
}

// --- attack ---

export async function handleAttack(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const unitIds = getFlagUnitIds(flags);
  const targetId = flags.get("target");

  if (unitIds.length > 0 && targetId) {
    await callAndPrint(client, sessionId, "attack", { unitIds, targetId });
    return;
  }

  const stdinInput = await readStdin();
  if (!stdinInput || (stdinInput.kind !== "selection" && stdinInput.kind !== "pairing")) {
    exit(ExitCode.ArgError, "attack requires --unit <id> --target <id> or stdin selection (from units)");
  }
  const data = stdinInput.data as Record<string, unknown>;

  // Pairing from transformers (target enemy-hq, target weakest)
  if (stdinInput.kind === "pairing") {
    const pairs = (data.pairs as Array<Record<string, unknown>>) ?? [];
    if (pairs.length === 0) {
      exit(ExitCode.ArgError, "attack: stdin pairing has no pairs");
    }
    const pairsByTarget = new Map<string, string[]>();
    for (const pair of pairs) {
      const enemy = pair.enemy as Record<string, unknown> | undefined;
      const pairedTargetId = enemy?.id as string;
      const ids = pairsByTarget.get(pairedTargetId) ?? [];
      ids.push(pair.unitId as string);
      pairsByTarget.set(pairedTargetId, ids);
    }
    const actions = [...pairsByTarget].map(([pairedTargetId, pairedUnitIds]): ControlBatchAction => ({
      tool: "attack",
      args: { unitIds: pairedUnitIds, targetId: pairedTargetId },
    }));
    await callBatchAndPrint(client, sessionId, actions, flags.get("request-id"));
    return;
  }

  // Selection
  const items = (data.units as Array<Record<string, unknown>>) ?? [];
  if (items.length === 0) {
    exit(ExitCode.ArgError, "attack: stdin selection has no units");
  }

  if (!targetId) {
    exit(ExitCode.ArgError, "attack with stdin requires --target <id>");
  }

  await callBatchAndPrint(client, sessionId, [{
    tool: "attack",
    args: { unitIds: items.map((item) => item.id as string), targetId },
  }], flags.get("request-id"));
}

// --- attack-move ---

export async function handleAttackMove(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const unitIds = getFlagUnitIds(flags);
  const toRaw = flags.get("to");
  const priorityRaw = flags.get("priority");

  let priority: string[] | undefined;
  if (priorityRaw) {
    priority = priorityRaw.split(",").map((s) => s.trim());
    for (const p of priority) {
      if (!ATTACK_TARGET_TYPES.includes(p as typeof ATTACK_TARGET_TYPES[number])) {
        exit(ExitCode.ArgError, `Invalid priority: ${p}. Valid: ${ATTACK_TARGET_TYPES.join(", ")}`);
      }
    }
  }

  if (unitIds.length > 0 && toRaw) {
    const { x, y } = parseCoord(toRaw);
    const args: Record<string, unknown> = { unitIds, x, y };
    if (priority) args.priority = priority;
    await callAndPrint(client, sessionId, "attack_move_unit", args);
    return;
  }

  const stdinInput = await readStdin();
  if (!stdinInput || stdinInput.kind !== "selection") {
    exit(ExitCode.ArgError, "attack-move requires --unit <id> --to x,y or stdin selection (from units)");
  }
  const data = stdinInput.data as Record<string, unknown>;
  const items = (data.units as Array<Record<string, unknown>>) ?? [];
  if (items.length === 0) {
    exit(ExitCode.ArgError, "attack-move: stdin selection has no units");
  }

  if (!toRaw) {
    exit(ExitCode.ArgError, "attack-move with stdin requires --to x,y");
  }
  const to = parseCoord(toRaw);

  const args: Record<string, unknown> = {
    unitIds: items.map((item) => item.id as string),
    x: to.x,
    y: to.y,
  };
  if (priority) args.priority = priority;
  await callBatchAndPrint(client, sessionId, [{ tool: "attack_move_unit", args }], flags.get("request-id"));
}

// --- gather ---

export async function handleGather(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const unitIds = getFlagUnitIds(flags);
  const resourceRaw = flags.get("resource");

  if (unitIds.length > 0) {
    const args: Record<string, unknown> = { unitIds };
    if (resourceRaw) {
      const { x, y } = parseCoord(resourceRaw);
      args.x = x;
      args.y = y;
    }
    await callAndPrint(client, sessionId, "start_harvest_loop", args);
    return;
  }

  const stdinInput = await readStdin();
  if (!stdinInput || (stdinInput.kind !== "selection" && stdinInput.kind !== "pairing")) {
    exit(ExitCode.ArgError, "gather requires --unit/--units <ids> or stdin selection/pairing (from units or nearest)");
  }
  const data = stdinInput.data as Record<string, unknown>;

  // Pairing from transformers (nearest resource)
  if (stdinInput.kind === "pairing") {
    const pairs = (data.pairs as Array<Record<string, unknown>>) ?? [];
    if (pairs.length === 0) {
      exit(ExitCode.ArgError, "gather: stdin pairing has no pairs");
    }
    const grouped = new Map<string, { unitIds: string[]; resource?: { x: number; y: number } }>();
    for (const pair of pairs) {
      const rsrc = pair.resource as Record<string, number> | undefined;
      const key = rsrc ? `${rsrc.x},${rsrc.y}` : "auto";
      const group = grouped.get(key) ?? {
        unitIds: [],
        ...(rsrc ? { resource: { x: rsrc.x, y: rsrc.y } } : {}),
      };
      group.unitIds.push(String(pair.unitId));
      grouped.set(key, group);
    }
    const actions = [...grouped.values()].map((group): ControlBatchAction => ({
      tool: "start_harvest_loop",
      args: {
        unitIds: group.unitIds,
        ...(group.resource ?? {}),
      },
    }));
    await callBatchAndPrint(client, sessionId, actions, flags.get("request-id"));
    return;
  }

  // Selection
  const items = (data.units as Array<Record<string, unknown>>) ?? [];
  if (items.length === 0) {
    exit(ExitCode.ArgError, "gather: stdin selection has no units");
  }

  const resourcePos = resourceRaw ? parseCoord(resourceRaw) : undefined;
  await callBatchAndPrint(client, sessionId, [{
    tool: "start_harvest_loop",
    args: {
      unitIds: items.map((item) => String(item.id)),
      ...(resourcePos ?? {}),
    },
  }], flags.get("request-id"));
}

// --- build ---

export async function handleBuild(
  client: ControlClient,
  sessionId: string,
  subcommand: string,
  flags: Map<string, string>,
): Promise<void> {
  if (!subcommand) {
    exit(ExitCode.ArgError, "build requires a building type (e.g., build barracks)");
  }
  const buildingType = subcommand;
  if (!BUILDABLE_BUILDING_TYPES.includes(buildingType as typeof BUILDABLE_BUILDING_TYPES[number])) {
    exit(ExitCode.ArgError, `Unknown building type: ${buildingType}. Valid: ${BUILDABLE_BUILDING_TYPES.join(", ")}`);
  }

  const unitId = flags.get("unit");
  const atRaw = flags.get("at");

  if (unitId && atRaw) {
    const { x, y } = parseCoord(atRaw);
    await callAndPrint(client, sessionId, "build_structure", { unitId, buildingType, x, y });
    return;
  }

  const stdinInput = await readStdin();
  if (!stdinInput || stdinInput.kind !== "selection") {
    exit(
      ExitCode.ArgError,
      `build ${buildingType} requires --unit <workerId> --at x,y or stdin selection (from units) with --at x,y`,
    );
  }
  const data = stdinInput.data as Record<string, unknown>;
  const items = (data.units as Array<Record<string, unknown>>) ?? [];
  if (items.length === 0) {
    exit(ExitCode.ArgError, `build ${buildingType}: stdin selection has no units`);
  }

  if (!atRaw) {
    exit(ExitCode.ArgError, `build ${buildingType} with stdin requires --at x,y`);
  }
  const { x, y } = parseCoord(atRaw);

  await callBatchAndPrint(client, sessionId, items.map((item) => ({
    tool: "build_structure",
    args: {
      unitId: item.id as string,
      buildingType,
      x,
      y,
    },
  })), flags.get("request-id"));
}

// --- train ---

export async function handleTrain(
  client: ControlClient,
  sessionId: string,
  subcommand: string,
  flags: Map<string, string>,
): Promise<void> {
  const unitType = subcommand;
  if (!TRAINABLE_UNIT_TYPES.includes(unitType as UnitType)) {
    exit(ExitCode.ArgError, `train requires a currently producible unit type (${TRAINABLE_UNIT_TYPES.join(", ")}), got: ${subcommand || "(none)"}`);
  }

  const buildingId = flags.get("building");
  const count = Number(flags.get("count") ?? "1");
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    exit(ExitCode.ArgError, "train --count must be an integer from 1 to 100");
  }

  if (buildingId) {
    await callAndPrint(client, sessionId, "spawn_unit", {
      buildingId,
      units: [{ unitType, count }],
    });
    return;
  }

  const stdinInput = await readStdin();
  if (!stdinInput || stdinInput.kind !== "selection") {
    exit(
      ExitCode.ArgError,
      `train ${unitType} requires --building <id> or stdin selection (from buildings)`,
    );
  }
  const data = stdinInput.data as Record<string, unknown>;
  const items = (data.buildings as Array<Record<string, unknown>>) ?? [];
  if (items.length === 0) {
    exit(ExitCode.ArgError, `train ${unitType}: stdin selection has no buildings`);
  }

  await callBatchAndPrint(client, sessionId, items.map((item) => ({
    tool: "spawn_unit",
    args: {
      buildingId: item.id as string,
      units: [{ unitType, count }],
    },
  })), flags.get("request-id"));
}

// --- stop / hold ---

export async function handleStop(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const unitIds = getFlagUnitIds(flags);

  if (unitIds.length > 0) {
    await callAndPrint(client, sessionId, "stop_unit", { unitIds });
    return;
  }

  const stdinInput = await readStdin();
  if (!stdinInput || stdinInput.kind !== "selection") {
    exit(ExitCode.ArgError, "stop requires --unit <id> or stdin selection (from units)");
  }
  const data = stdinInput.data as Record<string, unknown>;
  const items = (data.units as Array<Record<string, unknown>>) ?? [];
  if (items.length === 0) {
    exit(ExitCode.ArgError, "stop: stdin selection has no units");
  }

  await callBatchAndPrint(client, sessionId, [{
    tool: "stop_unit",
    args: { unitIds: items.map((item) => item.id as string) },
  }], flags.get("request-id"));
}

export async function handleHold(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const unitIds = getFlagUnitIds(flags);

  if (unitIds.length > 0) {
    await callAndPrint(client, sessionId, "hold_unit", { unitIds });
    return;
  }

  const stdinInput = await readStdin();
  if (!stdinInput || stdinInput.kind !== "selection") {
    exit(ExitCode.ArgError, "hold requires --unit <id> or stdin selection (from units)");
  }
  const data = stdinInput.data as Record<string, unknown>;
  const items = (data.units as Array<Record<string, unknown>>) ?? [];
  if (items.length === 0) {
    exit(ExitCode.ArgError, "hold: stdin selection has no units");
  }

  await callBatchAndPrint(client, sessionId, [{
    tool: "hold_unit",
    args: { unitIds: items.map((item) => item.id as string) },
  }], flags.get("request-id"));
}

export async function handleProductionQueue(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const buildingIds = getFlagBuildingIds(flags);
  await callAndPrint(client, sessionId, "get_production_queue", {
    ...(buildingIds.length > 0 ? { buildingIds } : {}),
  });
}

export async function handleCancelProduction(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const buildingIds = getFlagBuildingIds(flags);
  const orderIds = [flags.get("order"), flags.get("orders")]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if ((buildingIds.length === 0) === (orderIds.length === 0)) {
    exit(ExitCode.ArgError, "cancel-production requires either --building/--buildings or --order/--orders");
  }
  await callAndPrint(client, sessionId, "cancel_production", {
    ...(buildingIds.length > 0 ? { buildingIds } : { orderIds: [...new Set(orderIds)] }),
  });
}

// --- rally ---

export async function handleRally(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const flagBuildingIds = getFlagBuildingIds(flags);
  const toRaw = flags.get("to");
  const position = toRaw ? parseCoord(toRaw) : undefined;
  const rawMode = flags.get("mode") ?? "move";
  const mode = rawMode === "attack-move" ? "attack_move" : rawMode;
  if (mode !== "move" && mode !== "attack_move") {
    exit(ExitCode.ArgError, "rally --mode must be move or attack-move");
  }

  if (flagBuildingIds.length > 0) {
    await callAndPrint(client, sessionId, "set_rally_point", {
      buildingIds: flagBuildingIds,
      ...(position ?? {}),
      ...(position ? { mode } : {}),
    });
    return;
  }

  const stdinInput = await readStdin();
  if (!stdinInput || stdinInput.kind !== "selection") {
    exit(ExitCode.ArgError, "rally requires --building <id> [--to x,y] [--mode move|attack-move] or stdin selection; omit --to to clear");
  }
  const data = stdinInput.data as Record<string, unknown>;
  const items = (data.buildings as Array<Record<string, unknown>>) ?? [];
  if (items.length === 0) {
    exit(ExitCode.ArgError, "rally: stdin selection has no buildings");
  }
  await callAndPrint(client, sessionId, "set_rally_point", {
    buildingIds: items.map((item) => String(item.id)),
    ...(position ?? {}),
    ...(position ? { mode } : {}),
  });
}
