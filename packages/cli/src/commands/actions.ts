import type { ControlClient } from "../client.js";
import { ExitCode, exit } from "../io/errors.js";
import { printJson } from "../io/json.js";
import { readStdin } from "../io/stdin.js";
import { printBatchResult } from "./batch.js";

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

  const results: unknown[] = [];
  for (const item of items) {
    const resp = await client.callTool(sessionId, "move_unit", {
      unitId: item.id as string,
      x: to.x,
      y: to.y,
    });
    results.push(resp);
  }
  printBatchResult(stdinInput.tick, results);
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
    const results: unknown[] = [];
    for (const pair of pairs) {
      const enemy = pair.enemy as Record<string, unknown> | undefined;
      const resp = await client.callTool(sessionId, "attack", {
        unitId: pair.unitId as string,
        targetId: enemy?.id as string,
      });
      results.push(resp);
    }
    printBatchResult(stdinInput.tick, results);
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

  const results: unknown[] = [];
  for (const item of items) {
    const resp = await client.callTool(sessionId, "attack", {
      unitId: item.id as string,
      targetId,
    });
    results.push(resp);
  }
  printBatchResult(stdinInput.tick, results);
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
  const validPriorities = ["soldier", "worker"] as const;

  let priority: string[] | undefined;
  if (priorityRaw) {
    priority = priorityRaw.split(",").map((s) => s.trim());
    for (const p of priority) {
      if (!validPriorities.includes(p as typeof validPriorities[number])) {
        exit(ExitCode.ArgError, `Invalid priority: ${p}. Valid: soldier, worker`);
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

  const results: unknown[] = [];
  for (const item of items) {
    const args: Record<string, unknown> = { unitId: item.id as string, x: to.x, y: to.y };
    if (priority) args.priority = priority;
    const resp = await client.callTool(sessionId, "attack_move_unit", args);
    results.push(resp);
  }
  printBatchResult(stdinInput.tick, results);
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
    const results: unknown[] = [];
    for (const pair of pairs) {
      const rsrc = pair.resource as Record<string, number> | undefined;
      const args: Record<string, unknown> = { unitId: pair.unitId as string };
      if (rsrc) { args.x = rsrc.x; args.y = rsrc.y; }
      const resp = await client.callTool(sessionId, "start_harvest_loop", args);
      results.push(resp);
    }
    printBatchResult(stdinInput.tick, results);
    return;
  }

  // Selection
  const items = (data.units as Array<Record<string, unknown>>) ?? [];
  if (items.length === 0) {
    exit(ExitCode.ArgError, "gather: stdin selection has no units");
  }

  const resourcePos = resourceRaw ? parseCoord(resourceRaw) : undefined;
  const results: unknown[] = [];
  for (const item of items) {
    const args: Record<string, unknown> = { unitId: item.id as string };
    if (resourcePos) { args.x = resourcePos.x; args.y = resourcePos.y; }
    const resp = await client.callTool(sessionId, "start_harvest_loop", args);
    results.push(resp);
  }
  printBatchResult(stdinInput.tick, results);
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
  const validTypes = ["barracks"];
  if (!validTypes.includes(buildingType)) {
    exit(ExitCode.ArgError, `Unknown building type: ${buildingType}. Valid: barracks`);
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

  const results: unknown[] = [];
  for (const item of items) {
    const resp = await client.callTool(sessionId, "build_structure", {
      unitId: item.id as string,
      buildingType,
      x,
      y,
    });
    results.push(resp);
  }
  printBatchResult(stdinInput.tick, results);
}

// --- train ---

export async function handleTrain(
  client: ControlClient,
  sessionId: string,
  subcommand: string,
  flags: Map<string, string>,
): Promise<void> {
  const unitType = subcommand;
  const validTypes = ["worker", "soldier"];
  if (!validTypes.includes(unitType)) {
    exit(ExitCode.ArgError, `train requires unit type (worker or soldier), got: ${subcommand || "(none)"}`);
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

  const results: unknown[] = [];
  for (const item of items) {
    const resp = await client.callTool(sessionId, "spawn_unit", {
      buildingId: item.id as string,
      unitType,
    });
    results.push(resp);
  }
  printBatchResult(stdinInput.tick, results);
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

  const results: unknown[] = [];
  for (const item of items) {
    const resp = await client.callTool(sessionId, "hold_unit", {
      unitId: item.id as string,
    });
    results.push(resp);
  }
  printBatchResult(stdinInput.tick, results);
}
