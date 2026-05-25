import type { ControlClient } from "../client.js";
import { ExitCode, exit } from "../io/errors.js";
import { printJson } from "../io/json.js";
import { readStdin } from "../io/stdin.js";
import { printBatchResult } from "./batch.js";
import fs from "node:fs";

// --- plan ---

export async function handlePlan(
  client: ControlClient,
  sessionId: string,
  subcommand: string,
  flags: Map<string, string>,
): Promise<void> {
  if (subcommand === "custom") {
    const filePath = flags.get("file");
    if (!filePath) {
      exit(ExitCode.ArgError, "plan custom requires --file <path>");
    }
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      exit(ExitCode.ArgError, `Cannot read file: ${filePath}`);
    }
    let planJson: unknown;
    try {
      planJson = JSON.parse(content);
    } catch {
      exit(ExitCode.StdinParseError, `Invalid JSON in file: ${filePath}`);
    }
    // Just output the plan JSON — no server call
    printJson({
      ok: true,
      tick: 0,
      kind: "plan",
      data: planJson,
    });
    return;
  }

  // Fetch current state for context
  const stateResp = await client.callTool(sessionId, "get_my_state");
  if (!stateResp.ok) {
    exit(ExitCode.BackendFailure, stateResp.error?.message ?? "Failed to get state");
  }
  const stateData = stateResp.data as Record<string, unknown>;
  const unitsResp = await client.callTool(sessionId, "get_my_units");
  if (!unitsResp.ok) {
    exit(ExitCode.BackendFailure, unitsResp.error?.message ?? "Failed to get units");
  }
  const unitsData = unitsResp.data as Record<string, unknown>;
  const units = (unitsData.units as Array<Record<string, unknown>>) ?? [];
  const buildings = (stateData.buildings as Array<Record<string, unknown>>) ?? [];
  const queueData = (stateData.productionQueues as Array<{ buildingId: string; queue: unknown[] }>) ?? [];

  const idleWorkers = units.filter((u) => u.type === "worker" && u.state === "idle");
  const soldierUnits = units.filter((u) => u.type === "soldier");
  const hqBuilding = buildings.find((b) => b.type === "hq");
  const barracksBuildings = buildings.filter((b) => b.type === "barracks");
  const emptyBarracks = barracksBuildings.filter((b) => {
    const q = queueData.find((qd) => qd.buildingId === b.id);
    return !q || q.queue.length === 0;
  });
  const credits = typeof stateData.credits === "number" ? stateData.credits : 0;

  let plan: Record<string, unknown>;

  if (subcommand === "economy") {
    const steps: Array<Record<string, unknown>> = [];
    const unitIds = idleWorkers.map((w) => w.id as string);

    // Step 1: assign all idle workers to mining
    if (idleWorkers.length > 0) {
      steps.push({
        call: "start_harvest_loop",
        args: { unitId: "$unitId" },
        scope: "per_unit",
      });
    }

    // Step 2: build barracks if we have credits and no barracks
    if (barracksBuildings.length === 0 && idleWorkers.length > 0) {
      steps.push({
        call: "build_structure",
        args: { unitId: idleWorkers[0].id as string, buildingType: "barracks", x: 6, y: 6 },
        scope: "global",
        when: { condition: "credits_at_least", amount: 120 },
        until: { condition: "building_exists", buildingType: "barracks" },
        retry: true,
      });
    }

    // Step 3: train workers from HQ when queue is empty
    if (hqBuilding && credits >= 50) {
      steps.push({
        call: "spawn_unit",
        args: { buildingId: "$hq", unitType: "worker" },
        scope: "global",
        when: { condition: "production_queue_empty", buildingType: "hq" },
        retry: true,
      });
    }

    plan = {
      unitIds,
      loop: -1,
      steps,
    };
  } else if (subcommand === "defend") {
    const unitIds = soldierUnits.map((s) => s.id as string);
    if (unitIds.length === 0) {
      exit(ExitCode.BackendFailure, "No soldiers available for defend plan. Train soldiers first.");
    }
    if (!hqBuilding) {
      exit(ExitCode.BackendFailure, "No HQ found for defend plan.");
    }

    plan = {
      unitIds,
      loop: -1,
      steps: [
        {
          call: "attack_move_unit",
          args: { unitId: "$unitId", x: hqBuilding.x as number, y: hqBuilding.y as number },
          scope: "per_unit",
          until: { condition: "near_position", x: hqBuilding.x as number, y: hqBuilding.y as number, distance: 3 },
          maxTicks: 40,
        },
        {
          call: "hold_unit",
          args: { unitId: "$unitId" },
          scope: "per_unit",
        },
      ],
    };
  } else if (subcommand === "attack-hq") {
    const unitIds = soldierUnits.map((s) => s.id as string);
    if (unitIds.length === 0) {
      exit(ExitCode.BackendFailure, "No soldiers available for attack-hq plan. Train soldiers first.");
    }

    // Get map state to find enemy HQ
    const mapResp = await client.callTool(sessionId, "get_map_state", {
      includeCells: false,
      includeEmptyTiles: false,
    });
    if (!mapResp.ok) {
      exit(ExitCode.BackendFailure, mapResp.error?.message ?? "Failed to get map state");
    }
    const mapData = mapResp.data as Record<string, unknown>;
    const mapBuildings = (mapData.buildings as Array<Record<string, unknown>>) ?? [];
    const enemyHQ = mapBuildings.find((b) => b.type === "hq" && b.relation === "enemy");

    if (!enemyHQ) {
      exit(ExitCode.BackendFailure, "No enemy HQ visible on map for attack-hq plan.");
    }

    plan = {
      unitIds,
      loop: 1,
      steps: [
        {
          call: "attack_move_unit",
          args: { unitId: "$unitId", x: enemyHQ.x as number, y: enemyHQ.y as number },
          scope: "per_unit",
          until: { condition: "near_position", x: enemyHQ.x as number, y: enemyHQ.y as number, distance: 2 },
          maxTicks: 60,
        },
        {
          call: "attack",
          args: { unitId: "$unitId", targetId: enemyHQ.id as string },
          scope: "per_unit",
          until: { condition: "target_destroyed", targetId: enemyHQ.id as string },
          retry: true,
        },
      ],
    };
  } else {
    exit(ExitCode.ArgError, `Unknown plan type: ${subcommand || "(none)"}. Valid: economy, defend, attack-hq, custom`);
  }

  printJson({
    ok: true,
    tick: stateResp.tick,
    kind: "plan",
    data: plan,
  });
}

// --- orchestrate ---

export async function handleOrchestrate(
  client: ControlClient,
  sessionId: string,
  flags: Map<string, string>,
): Promise<void> {
  const dryRun = flags.has("dry-run");
  const maxActions = flags.has("max-actions")
    ? parseInt(flags.get("max-actions")!, 10)
    : undefined;

  const stdinInput = await readStdin();
  if (!stdinInput || (stdinInput.kind !== "plan" && stdinInput.kind !== "actions")) {
    exit(ExitCode.ArgError, "orchestrate requires stdin input (kind=plan or kind=actions). Pipe from 'plan' or a batch.");
  }
  const data = stdinInput.data as Record<string, unknown>;

  if (stdinInput.kind === "plan") {
    if (dryRun) {
      printJson({
        ok: true,
        tick: stdinInput.tick,
        kind: "plan_result",
        data: { dryRun: true, plan: data },
      });
      return;
    }

    const resp = await client.callTool(sessionId, "orchestrate_plan", {
      unitIds: data.unitIds,
      loop: data.loop ?? 1,
      steps: data.steps,
      replaceExisting: true,
    });
    if (!resp.ok) {
      printJson(resp);
      exit(ExitCode.BackendFailure, resp.error?.message ?? "Failed to orchestrate plan");
    }
    printJson(resp);
    return;
  }

  // kind === "actions"
  const actions = (data.actions as Array<{ tool: string; args: Record<string, unknown> }>) ?? [];
  if (actions.length === 0) {
    exit(ExitCode.ArgError, "orchestrate: actions input has no actions");
  }

  const toExecute = maxActions ? actions.slice(0, maxActions) : actions;

  if (dryRun) {
    printJson({
      ok: true,
      tick: stdinInput.tick,
      kind: "batch_result",
      data: { dryRun: true, actions: toExecute },
    });
    return;
  }

  const results: unknown[] = [];
  for (const action of toExecute) {
    const resp = await client.callTool(sessionId, action.tool, action.args);
    results.push(resp);
  }

  printBatchResult(stdinInput.tick, results);
}
