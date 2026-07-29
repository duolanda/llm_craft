import type { ControlClient } from "../client.js";
import {
  BUILDING_TYPES,
  UNIT_TYPES,
  getBuildingCost,
  getBuildingFootprint,
  getCombatUnitTypes,
  type BuildingType,
  type ControlBatchAction,
} from "@llmcraft/shared";
import { ExitCode, exit } from "../io/errors.js";
import { printJson } from "../io/json.js";
import { readStdin } from "../io/stdin.js";
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
  const combatUnitTypes = new Set(getCombatUnitTypes());
  const combatUnits = units.filter((u) => typeof u.type === "string" && combatUnitTypes.has(u.type as any));
  const hqBuilding = buildings.find((b) => b.type === "hq");
  const barracksBuildings = buildings.filter((b) => b.type === "barracks");
  const warFactoryBuildings = buildings.filter((b) => b.type === "war_factory");
  const emptyBarracks = barracksBuildings.filter((b) => {
    const q = queueData.find((qd) => qd.buildingId === b.id);
    return !q || q.queue.length === 0;
  });
  const hqX = typeof hqBuilding?.x === "number" ? hqBuilding.x : 0;
  const hqY = typeof hqBuilding?.y === "number" ? hqBuilding.y : 0;
  const buildDirection = hqBuilding?.playerId === "player_2" ? -1 : 1;
  const techStatus = stateData.techStatus as {
    recommendedStructures?: Array<{
      buildingType?: BuildingType;
      suggestedSites?: Array<{ x?: number; y?: number }>;
    }>;
  } | undefined;

  const getBuildSite = (buildingType: BuildingType, yOffset = 0) => {
    const suggestion = techStatus?.recommendedStructures
      ?.find((entry) => entry.buildingType === buildingType)
      ?.suggestedSites?.find((site) => Number.isInteger(site.x) && Number.isInteger(site.y));
    if (suggestion) {
      return { x: Number(suggestion.x), y: Number(suggestion.y) };
    }
    const hqFootprint = getBuildingFootprint(BUILDING_TYPES.HQ);
    const buildingFootprint = getBuildingFootprint(buildingType);
    const centerDistance = Math.floor(hqFootprint.width / 2) + Math.floor(buildingFootprint.width / 2) + 2;
    return {
      x: hqX + buildDirection * centerDistance,
      y: hqY + yOffset,
    };
  };
  const createBuildSteps = (
    workerId: string,
    buildingType: BuildingType,
    site: { x: number; y: number },
  ): Array<Record<string, unknown>> => {
    const footprint = getBuildingFootprint(buildingType);
    const stagingX = site.x - buildDirection * (Math.floor(footprint.width / 2) + 1);
    return [
      {
        call: "move_unit",
        args: { unitId: workerId, x: stagingX, y: site.y },
        scope: "global",
      },
      {
        call: "build_structure",
        args: { unitId: workerId, buildingType, x: site.x, y: site.y },
        scope: "global",
        when: { condition: "credits_at_least", amount: getBuildingCost(buildingType) },
        until: { condition: "building_exists", buildingType },
        retry: true,
      },
    ];
  };

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
      steps.push(...createBuildSteps(
        idleWorkers[0].id as string,
        BUILDING_TYPES.BARRACKS,
        getBuildSite(BUILDING_TYPES.BARRACKS),
      ));
    }

    if (barracksBuildings.length > 0 && warFactoryBuildings.length === 0 && idleWorkers.length > 0) {
      steps.push(...createBuildSteps(
        idleWorkers[0].id as string,
        BUILDING_TYPES.WAR_FACTORY,
        getBuildSite(BUILDING_TYPES.WAR_FACTORY, 8),
      ));
    }

    plan = {
      unitIds,
      loop: -1,
      steps,
    };
  } else if (subcommand === "tech") {
    const unitIds = idleWorkers.map((worker) => worker.id as string);
    if (unitIds.length === 0) {
      exit(ExitCode.BackendFailure, "No idle workers available for tech plan.");
    }

    const barracksSite = getBuildSite(BUILDING_TYPES.BARRACKS);
    const factorySite = getBuildSite(BUILDING_TYPES.WAR_FACTORY, 8);
    const steps: Array<Record<string, unknown>> = [
      {
        call: "start_harvest_loop",
        args: { unitId: "$unitId" },
        scope: "per_unit",
      },
    ];

    if (barracksBuildings.length === 0) {
      steps.push(...createBuildSteps(unitIds[0], BUILDING_TYPES.BARRACKS, barracksSite));
    }

    if (warFactoryBuildings.length === 0) {
      steps.push(...createBuildSteps(unitIds[0], BUILDING_TYPES.WAR_FACTORY, factorySite));
    }

    plan = {
      unitIds,
      loop: 1,
      steps,
    };
  } else if (subcommand === "defend") {
    const unitIds = combatUnits.map((unit) => unit.id as string);
    if (unitIds.length === 0) {
      exit(ExitCode.BackendFailure, "No combat units available for defend plan. Train soldiers, riflemen, rocket soldiers, or light tanks first.");
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
    const unitIds = combatUnits.map((unit) => unit.id as string);
    if (unitIds.length === 0) {
      exit(ExitCode.BackendFailure, "No combat units available for attack-hq plan. Train soldiers, riflemen, rocket soldiers, or light tanks first.");
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
          until: { condition: "hq_in_range" },
          maxTicks: 180,
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
    exit(ExitCode.ArgError, `Unknown plan type: ${subcommand || "(none)"}. Valid: economy, tech, defend, attack-hq, custom`);
  }

  printJson({
    ok: true,
    tick: stateResp.tick,
    kind: "plan",
    data: plan,
  });
}

// --- orchestrate ---

const ACTION_TOOL_ALIASES: Record<string, string> = {
  move: "move_unit",
  "attack-move": "attack_move_unit",
  build: "build_structure",
  train: "spawn_unit",
  gather: "start_harvest_loop",
  hold: "hold_unit",
};

function normalizeBatchAction(action: ControlBatchAction): ControlBatchAction {
  const tool = ACTION_TOOL_ALIASES[action.tool] ?? action.tool;
  const args = { ...(action.args ?? {}) };
  if (tool === "build_structure" && args.unitId === undefined && typeof args.workerId === "string") {
    args.unitId = args.workerId;
    delete args.workerId;
  }
  if (tool === "spawn_unit" && args.units === undefined && typeof args.unitType === "string") {
    args.units = [{ unitType: args.unitType, count: Number(args.count ?? 1) }];
    delete args.unitType;
    delete args.count;
  }
  return { tool, args };
}

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
    exit(ExitCode.ArgError, "orchestrate requires a tool-call batch ({ actions: [...] }) or legacy plan input on stdin.");
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
  const actions = ((data.actions as ControlBatchAction[]) ?? []).map(normalizeBatchAction);
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

  const response = await client.callActionBatch(
    sessionId,
    toExecute,
    flags.get("request-id"),
  );
  printJson(response);
  if (!response.ok) {
    process.exit(ExitCode.BackendFailure);
  }
}
