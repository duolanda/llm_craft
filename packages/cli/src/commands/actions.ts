import type { ControlClient } from "../client.js";
import { ALL_BUILDING_TYPES, ALL_UNIT_TYPES, BUILDING_TYPES, type ControlBatchAction } from "@llmcraft/shared";
import { ExitCode, exit } from "../io/errors.js";
import { printJson } from "../io/json.js";
import { readStdin } from "../io/stdin.js";

const BUILDABLE_BUILDING_TYPES = ALL_BUILDING_TYPES.filter((buildingType) => buildingType !== BUILDING_TYPES.HQ);
const ATTACK_TARGET_TYPES = [...ALL_UNIT_TYPES, ...ALL_BUILDING_TYPES];

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
  const unitId = flags.get("unit");
  const toRaw = flags.get("to");

  if (unitId && toRaw) {
    const { x, y } = parseCoord(toRaw);
    await callAndPrint(client, sessionId, "move_unit", { unitId, x, y });
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

  await callBatchAndPrint(client, sessionId, items.map((item) => ({
    tool: "move_unit",
    args: {
      unitId: item.id as string,
      x: to.x,
      y: to.y,
    },
  })), flags.get("request-id"));
}

// --- attack ---

export async function handleAttack(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const unitId = flags.get("unit");
  const targetId = flags.get("target");

  if (unitId && targetId) {
    await callAndPrint(client, sessionId, "attack", { unitId, targetId });
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
    const actions = pairs.map((pair): ControlBatchAction => {
      const enemy = pair.enemy as Record<string, unknown> | undefined;
      return { tool: "attack", args: { unitId: pair.unitId as string, targetId: enemy?.id as string } };
    });
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

  await callBatchAndPrint(client, sessionId, items.map((item) => ({
    tool: "attack",
    args: { unitId: item.id as string, targetId },
  })), flags.get("request-id"));
}

// --- attack-move ---

export async function handleAttackMove(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const unitId = flags.get("unit");
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

  if (unitId && toRaw) {
    const { x, y } = parseCoord(toRaw);
    const args: Record<string, unknown> = { unitId, x, y };
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

  const actions = items.map((item): ControlBatchAction => {
    const args: Record<string, unknown> = { unitId: item.id as string, x: to.x, y: to.y };
    if (priority) args.priority = priority;
    return { tool: "attack_move_unit", args };
  });
  await callBatchAndPrint(client, sessionId, actions, flags.get("request-id"));
}

// --- gather ---

export async function handleGather(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const unitId = flags.get("unit");
  const resourceRaw = flags.get("resource");

  if (unitId) {
    const args: Record<string, unknown> = { unitId };
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
    exit(ExitCode.ArgError, "gather requires --unit <id> or stdin selection/pairing (from units or nearest)");
  }
  const data = stdinInput.data as Record<string, unknown>;

  // Pairing from transformers (nearest resource)
  if (stdinInput.kind === "pairing") {
    const pairs = (data.pairs as Array<Record<string, unknown>>) ?? [];
    if (pairs.length === 0) {
      exit(ExitCode.ArgError, "gather: stdin pairing has no pairs");
    }
    const actions = pairs.map((pair): ControlBatchAction => {
      const rsrc = pair.resource as Record<string, number> | undefined;
      const args: Record<string, unknown> = { unitId: pair.unitId as string };
      if (rsrc) { args.x = rsrc.x; args.y = rsrc.y; }
      return { tool: "start_harvest_loop", args };
    });
    await callBatchAndPrint(client, sessionId, actions, flags.get("request-id"));
    return;
  }

  // Selection
  const items = (data.units as Array<Record<string, unknown>>) ?? [];
  if (items.length === 0) {
    exit(ExitCode.ArgError, "gather: stdin selection has no units");
  }

  const resourcePos = resourceRaw ? parseCoord(resourceRaw) : undefined;
  const actions = items.map((item): ControlBatchAction => {
    const args: Record<string, unknown> = { unitId: item.id as string };
    if (resourcePos) { args.x = resourcePos.x; args.y = resourcePos.y; }
    return { tool: "start_harvest_loop", args };
  });
  await callBatchAndPrint(client, sessionId, actions, flags.get("request-id"));
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
  if (!ALL_UNIT_TYPES.includes(unitType as typeof ALL_UNIT_TYPES[number])) {
    exit(ExitCode.ArgError, `train requires unit type (${ALL_UNIT_TYPES.join(", ")}), got: ${subcommand || "(none)"}`);
  }

  const buildingId = flags.get("building");

  if (buildingId) {
    await callAndPrint(client, sessionId, "spawn_unit", { buildingId, unitType });
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
      unitType,
    },
  })), flags.get("request-id"));
}

// --- hold ---

export async function handleHold(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const unitId = flags.get("unit");

  if (unitId) {
    await callAndPrint(client, sessionId, "hold_unit", { unitId });
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

  await callBatchAndPrint(client, sessionId, items.map((item) => ({
    tool: "hold_unit",
    args: { unitId: item.id as string },
  })), flags.get("request-id"));
}
