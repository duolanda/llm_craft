import {
  ALL_BUILDING_TYPES,
  ALL_UNIT_TYPES,
  BUILDING_TYPES,
  CONTROL_PROVIDER_ONLY_TOOL_NAMES,
  CONTROL_READ_TOOL_NAMES,
  OrchestratePlanInput,
  UnitType,
  unitCanAttack,
} from "@llmcraft/shared";
import { GameplayController } from "../controller/GameplayController";

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolExecution {
  effect: "read" | "action" | "plan";
  result: unknown;
}

type ToolExecutor = (gameplayController: GameplayController, args: any) => AgentToolExecution;

const BUILDABLE_BUILDING_TYPES = ALL_BUILDING_TYPES.filter((buildingType) => buildingType !== BUILDING_TYPES.HQ);
const ATTACK_TARGET_TYPES = [...ALL_UNIT_TYPES, ...ALL_BUILDING_TYPES];
const COMBAT_UNIT_TYPES = ALL_UNIT_TYPES.filter((unitType) => unitCanAttack(unitType));
const ALL_UNIT_SELECTIONS = ["all_combat", "idle_combat", ...ALL_UNIT_TYPES] as const;
const COMBAT_UNIT_SELECTIONS = ["all_combat", "idle_combat", ...COMBAT_UNIT_TYPES] as const;
const BATCH_SHARED_RECOVERY_KEYS = [
  "availableFriendlyUnits",
  "availableAttackers",
  "availableWorkers",
  "availableEnemyTargets",
  "availableEnemyTargetCount",
] as const;
const getUnitIds = (args: Record<string, unknown>): string[] => {
  const ids = Array.isArray(args.unitIds)
    ? args.unitIds.filter((value): value is string => typeof value === "string")
    : typeof args.unitId === "string"
      ? [args.unitId]
      : [];
  return [...new Set(ids)];
};

type UnitSelectionSnapshot = {
  id: string;
  type: UnitType;
  phase: string;
  intent?: { type?: string } | null;
  hasActivePlan?: boolean;
};

type UnitBatchResolution =
  | { ok: true; unitIds: string[]; selection?: string }
  | { ok: false; result: Record<string, unknown> };

const unitSelectionProperties = (selectionValues: readonly string[]): Record<string, unknown> => ({
  unitIds: {
    type: "array",
    minItems: 1,
    uniqueItems: true,
    items: { type: "string" },
    description: "Explicit unit IDs. Pass exactly one of unitIds or selection.",
  },
  selection: {
    type: "string",
    enum: selectionValues,
    description:
      "Dynamic execution-time selection. all_combat selects every living combat unit, including units with active plans; the new immediate order interrupts those plans. idle_combat selects unplanned idle/holding combat units; a unit type selects every living friendly unit of that type. To preserve a specialist or detached force, pass explicit unitIds for the intended main force and omit those units. Pass exactly one of unitIds or selection.",
  },
});

const resolveUnitBatch = (
  gameplayController: GameplayController,
  args: Record<string, unknown>,
  allowedSelections: readonly string[],
): UnitBatchResolution => {
  const hasExplicitIds = args.unitIds !== undefined || args.unitId !== undefined;
  const hasSelection = args.selection !== undefined;
  if (hasExplicitIds && hasSelection) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "conflicting_unit_selection",
        hint: "Pass exactly one of unitIds or selection, not both.",
      },
    };
  }

  if (hasExplicitIds) {
    const unitIds = getUnitIds(args);
    return unitIds.length > 0
      ? { ok: true, unitIds }
      : {
          ok: false,
          result: { ok: false, error: "missing_units", hint: "Pass one or more friendly unit IDs in unitIds." },
        };
  }

  if (typeof args.selection !== "string" || !allowedSelections.includes(args.selection)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: hasSelection ? "invalid_unit_selection" : "missing_units",
        hint: hasSelection
          ? "Use one of validSelections."
          : "Pass one or more friendly unit IDs in unitIds, or use selection.",
        validSelections: allowedSelections,
      },
    };
  }

  const snapshot = gameplayController.getMyUnits({ trackRead: false }).result as {
    tick: number;
    units: UnitSelectionSnapshot[];
  };
  const selectedUnits = snapshot.units.filter((unit) => {
    if (args.selection === "all_combat") return unitCanAttack(unit.type);
    if (args.selection === "idle_combat") {
      return unitCanAttack(unit.type)
        && unit.phase === "idle"
        && unit.hasActivePlan !== true
        && !unit.intent;
    }
    return unit.type === args.selection;
  });
  const unitIds = selectedUnits.map((unit) => unit.id);
  if (unitIds.length === 0) {
    return {
      ok: false,
      result: {
        tick: snapshot.tick,
        ok: false,
        error: "empty_unit_selection",
        hint: "No living friendly units currently match selection.",
        selection: args.selection,
        selectedUnitIds: [],
      },
    };
  }
  return { ok: true, unitIds, selection: args.selection };
};

const getBuildingIds = (args: Record<string, unknown>): string[] => {
  const ids = Array.isArray(args.buildingIds)
    ? args.buildingIds.filter((value): value is string => typeof value === "string")
    : typeof args.buildingId === "string"
      ? [args.buildingId]
      : [];
  return [...new Set(ids)];
};

const executeUnitBatch = (
  gameplayController: GameplayController,
  args: Record<string, unknown>,
  execute: (unitId: string) => AgentToolExecution,
  allowedSelections: readonly string[] = ALL_UNIT_SELECTIONS,
): AgentToolExecution => {
  const resolution = resolveUnitBatch(gameplayController, args, allowedSelections);
  if (!resolution.ok) {
    return {
      effect: "action",
      result: resolution.result,
    };
  }
  const { unitIds } = resolution;
  const results: Array<{ unitId: string; ok?: unknown; [key: string]: unknown }> = unitIds.map((unitId) => {
    const execution = execute(unitId);
    const result = execution.result && typeof execution.result === "object"
      ? execution.result as Record<string, unknown>
      : { value: execution.result };
    return { unitId, ...result };
  });
  const recoveryContext: Record<string, unknown> = {};
  for (const result of results) {
    for (const key of BATCH_SHARED_RECOVERY_KEYS) {
      if (recoveryContext[key] === undefined && result[key] !== undefined) {
        recoveryContext[key] = result[key];
      }
      delete result[key];
    }
  }
  const failures = results.filter((result) => result.ok === false);
  const errorCodes = [...new Set(failures
    .map((result) => typeof result.error === "string" ? result.error : "action_failed"))];
  const error = failures.length === 0
    ? undefined
    : failures.length === results.length && errorCodes.length === 1
      ? errorCodes[0]
      : "partial_failure";
  const firstHint = failures.find((result) => typeof result.hint === "string")?.hint;
  return {
    effect: "action",
    result: {
      tick: results.find((result) => typeof result.tick === "number")?.tick,
      ok: failures.length === 0,
      ...(error ? {
        error,
        message: `${failures.length} of ${results.length} unit actions failed: ${errorCodes.join(", ")}.`,
        ...(typeof firstHint === "string" ? { hint: firstHint } : {}),
        failedUnitIds: failures.map((result) => result.unitId),
      } : {}),
      results,
      ...(resolution.selection ? {
        selection: resolution.selection,
        selectedUnitIds: unitIds,
      } : {}),
      ...recoveryContext,
    },
  };
};

const executeAttackBatch = (
  gameplayController: GameplayController,
  args: Record<string, unknown>,
): AgentToolExecution => {
  const requestedTargetId = String(args.targetId);
  let actualTargetId = requestedTargetId;
  const execution = executeUnitBatch(
    gameplayController,
    args,
    (unitId) => {
      const item = gameplayController.attackTarget(unitId, actualTargetId);
      const result = item.result && typeof item.result === "object"
        ? item.result as Record<string, unknown>
        : {};
      if (
        result.ok === true
        && typeof result.retargetedFrom === "string"
        && typeof result.targetId === "string"
      ) {
        actualTargetId = result.targetId;
      }
      return item;
    },
    COMBAT_UNIT_SELECTIONS,
  );
  if (actualTargetId === requestedTargetId || !execution.result || typeof execution.result !== "object") {
    return execution;
  }
  return {
    ...execution,
    result: {
      ...(execution.result as Record<string, unknown>),
      targetId: actualTargetId,
      retargetedFrom: requestedTargetId,
    },
  };
};

const executeBuildingBatch = (
  gameplayController: GameplayController,
  args: Record<string, unknown>,
  execute: (buildingId: string) => AgentToolExecution,
): AgentToolExecution => {
  const buildingIds = getBuildingIds(args);
  if (buildingIds.length === 0) {
    return {
      effect: "action",
      result: { ok: false, error: "missing_buildings", hint: "Pass one or more friendly production building IDs in buildingIds." },
    };
  }
  const results: Array<{ buildingId: string; ok?: unknown; error?: unknown; tick?: unknown; [key: string]: unknown }> = buildingIds.map((buildingId) => {
    const execution = execute(buildingId);
    const result = execution.result && typeof execution.result === "object"
      ? execution.result as Record<string, unknown>
      : { value: execution.result };
    return { buildingId, ...result };
  });
  const failures = results.filter((result) => result.ok === false);
  const errorCodes = [...new Set(failures.map((result) => typeof result.error === "string" ? result.error : "action_failed"))];
  return {
    effect: "action",
    result: {
      tick: results.find((result) => typeof result.tick === "number")?.tick,
      ok: failures.length === 0,
      ...(failures.length > 0 ? {
        error: failures.length === results.length && errorCodes.length === 1 ? errorCodes[0] : "partial_failure",
        message: `${failures.length} of ${results.length} building actions failed: ${errorCodes.join(", ")}.`,
        failedBuildingIds: failures.map((result) => result.buildingId),
      } : {}),
      results,
    },
  };
};

const tools: Array<AgentToolDefinition & { execute: ToolExecutor }> = [
  {
    name: "get_map_state",
    description:
      "Read the full battlefield as structured unit, building, and resource lists. Unit phase is instantaneous, not a durable assignment. Set includeCells=true only when you need terrain cells; set includeEmptyTiles=true only when you explicitly need all grid cells including empty cells.",
    parameters: {
      type: "object",
      properties: {
        includeCells: { type: "boolean" },
        includeEmptyTiles: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) =>
      gameplayController.getMapState({
        includeCells: args?.includeCells === true,
        includeEmptyTiles: args?.includeEmptyTiles === true,
      }),
  },
  {
    name: "get_my_state",
    description: "Read my economy, HQ, buildings, production queues, technology facts, costs, and legal build-site options.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (gameplayController) => gameplayController.getMyState(),
  },
  {
    name: "get_my_units",
    description: "Read my controllable units plus role+intent groups. phase is the instantaneous simulation phase; intent is the durable assignment, so phase=idle with intent=harvest_loop is still assigned.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (gameplayController) => gameplayController.getMyUnits(),
  },
  {
    name: "get_army_summary",
    description:
      "Read a compact factual combat summary: own/enemy unit mix, ready vs reloading combat units, and the largest nearby group.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (gameplayController) => gameplayController.getArmySummary(),
  },
  {
    name: "get_active_plans",
    description: "Read active orchestration plans currently attached to my units, including planId, currentStep, structured waiting diagnostics, and lastAttempt. Pass unwanted plan IDs directly to cancel_plan.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (gameplayController) => gameplayController.getActivePlansTool(),
  },
  {
    name: "cancel_plan",
    description: "Immediately stop one or more active orchestration plans by planId. This does not cancel production orders; use cancel_production for production queue orderIds.",
    parameters: {
      type: "object",
      required: ["planIds"],
      properties: {
        planIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => gameplayController.cancelPlan({ planIds: args.planIds }),
  },
  {
    name: "get_recent_events",
    description: "Read recent AI-facing command feedback and important events.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (gameplayController) => gameplayController.getRecentEvents(),
  },
  {
    name: "move_unit",
    description:
      "Queue the same move destination for explicitly listed units or a dynamic execution-time selection. Pass exactly one of unitIds or selection. Blocked destinations are resolved to nearby reachable tiles when possible.",
    parameters: {
      type: "object",
      required: ["x", "y"],
      properties: {
        ...unitSelectionProperties(ALL_UNIT_SELECTIONS),
        x: { type: "integer" },
        y: { type: "integer" },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => executeUnitBatch(
      gameplayController,
      args,
      (unitId) => gameplayController.moveUnit(unitId, { x: Number(args.x), y: Number(args.y) }),
    ),
  },
  {
    name: "attack_move_unit",
    description:
      "Queue the same targetless combat advance for explicitly listed combat units or a dynamic execution-time combat selection. Pass exactly one of unitIds or selection. Each unit receives a nearby reachable destination when the requested tile is occupied and automatically fights enemies acquired within its own vision while advancing. Optional priority entries move those target types ahead of the unit's defaults; omitted target types remain valid fallback targets.",
    parameters: {
      type: "object",
      required: ["x", "y"],
      properties: {
        ...unitSelectionProperties(COMBAT_UNIT_SELECTIONS),
        x: { type: "integer" },
        y: { type: "integer" },
        priority: {
          type: "array",
          description: "Target ordering override. Listed types are tried first; omitted types retain their default relative order and remain attackable.",
          items: { type: "string", enum: ATTACK_TARGET_TYPES },
        },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => executeUnitBatch(
      gameplayController,
      args,
      (unitId) => gameplayController.attackMoveUnit(unitId, { x: Number(args.x), y: Number(args.y) }, args.priority),
      COMBAT_UNIT_SELECTIONS,
    ),
  },
  {
    name: "attack",
    description:
      "Order explicitly listed combat units or a dynamic execution-time combat selection to attack one enemy target ID. Pass exactly one of unitIds or selection. Units pursue the target across the map, move into weapon range, and keep attacking. If an observed target dies before execution, the batch chooses one current replacement target and every selected attacker pursues it regardless of current weapon or vision range.",
    parameters: {
      type: "object",
      required: ["targetId"],
      properties: {
        ...unitSelectionProperties(COMBAT_UNIT_SELECTIONS),
        targetId: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => executeAttackBatch(gameplayController, args),
  },
  {
    name: "spawn_unit",
    description: "Append a finite ordered batch to one building's production queue. The building completes entries strictly in array order. Production charges credits gradually each tick and pauses without losing progress when credits, a required technology building, or a player-wide unit limit is unavailable. If technology is destroyed, the active unit completes and later locked units wait for rebuilding. Each building may keep at most 100 pending units of each unit type; the T3 commando instead has a player-wide committed limit of 1. Use get_production_queue to inspect unlocks, order IDs, and progress.",
    parameters: {
      type: "object",
      required: ["buildingId", "units"],
      properties: {
        buildingId: { type: "string" },
        units: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["unitType", "count"],
            properties: {
              unitType: { type: "string", enum: ALL_UNIT_TYPES },
              count: { type: "integer", minimum: 1, maximum: 100 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => gameplayController.spawnUnit(
      String(args.buildingId),
      Array.isArray(args.units)
        ? args.units.map((request: Record<string, unknown>) => ({
            unitType: request.unitType,
            count: Number(request.count),
          }))
        : [],
    ),
  },
  {
    name: "get_production_queue",
    description: "Inspect production queues, active per-unit progress/payment status, pending counts, and stable order IDs. Omit buildingIds to inspect every friendly production building.",
    parameters: {
      type: "object",
      properties: {
        buildingIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => gameplayController.getProductionQueue(
      Array.isArray(args.buildingIds) ? getBuildingIds(args) : undefined,
    ),
  },
  {
    name: "cancel_production",
    description: "Cancel production without waiting. Pass orderIds to cancel selected queued batches, or buildingIds to clear whole building queues. Exactly one mode is allowed. Credits already paid toward each unfinished active unit are refunded; queued units that have not started cost nothing.",
    parameters: {
      type: "object",
      properties: {
        orderIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
        buildingIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => gameplayController.cancelProduction({
      orderIds: Array.isArray(args.orderIds) ? args.orderIds.map(String) : undefined,
      buildingIds: Array.isArray(args.buildingIds) ? getBuildingIds(args) : undefined,
    }),
  },
  {
    name: "set_rally_point",
    description: "Set one persistent rally destination for one or more production buildings. mode=move gives newly produced units an ordinary move order; mode=attack_move makes combat units fight enemies encountered while traveling. HQ worker rallies only support move. Omit both x and y to clear the rally point.",
    parameters: {
      type: "object",
      required: ["buildingIds"],
      properties: {
        buildingIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
        x: { type: "integer" },
        y: { type: "integer" },
        mode: { type: "string", enum: ["move", "attack_move"], default: "move" },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => {
      const hasX = args.x !== undefined;
      const hasY = args.y !== undefined;
      if (hasX !== hasY) {
        return {
          effect: "action" as const,
          result: { ok: false, error: "invalid_position", hint: "Pass both x and y to set a rally point, or omit both to clear it." },
        };
      }
      const position = hasX ? { x: Number(args.x), y: Number(args.y) } : undefined;
      const mode = args.mode === "attack_move" ? "attack_move" : "move";
      return executeBuildingBatch(
        gameplayController,
        args,
        (buildingId) => gameplayController.setRallyPoint(buildingId, position, mode),
      );
    },
  },
  {
    name: "build_structure",
    description: "Assign one worker to construct a building. Omit x/y to select a legal site automatically; refinery auto-placement favors sites that shorten resource delivery routes. If the worker is not adjacent to the full footprint, it moves there and starts construction when ready. A worker that was harvesting resumes that loop after construction. Build prerequisites are enforced: barracks unlocks the T2 war factory and machine-gun turret; war factory unlocks the anti-tank turret and T3 tech center.",
    parameters: {
      type: "object",
      required: ["unitId", "buildingType"],
      properties: {
        unitId: { type: "string" },
        buildingType: { type: "string", enum: BUILDABLE_BUILDING_TYPES },
        x: { type: "integer" },
        y: { type: "integer" },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) =>
      gameplayController.buildStructure(
        String(args.unitId),
        args.buildingType,
        args.x === undefined || args.y === undefined ? undefined : { x: Number(args.x), y: Number(args.y) },
      ),
  },
  {
    name: "start_harvest_loop",
    description:
      "Assign one or more friendly workers to the built-in mining loop. The worker delivers to the nearest completed HQ or refinery. Omit x/y to auto-select deposits using recurring delivery distance, initial travel, and current assignments; specify x/y only when intentionally assigning every selected worker to one deposit. Multiple workers may share one deposit. A worker with harvest_loop intent is already assigned even when its instantaneous phase is idle; repeated identical calls return already_active without restarting it. Reissue only after path_blocked or for deliberate reassignment.",
    parameters: {
      type: "object",
      required: ["unitIds"],
      properties: {
        unitIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
        x: { type: "integer" },
        y: { type: "integer" },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => {
      const hasX = args?.x !== undefined;
      const hasY = args?.y !== undefined;
      const position = hasX && hasY ? { x: Number(args.x), y: Number(args.y) } : undefined;
      if (hasX !== hasY) {
        return {
          effect: "action",
          result: {
            ok: false,
            error: "invalid_resource_target",
            hint: "Pass both x and y, or omit both for automatic resource selection.",
          },
        };
      }
      return executeUnitBatch(
        gameplayController,
        args,
        (unitId) => gameplayController.startHarvestLoop(unitId, position),
      );
    },
  },
  {
    name: "stop_unit",
    description:
      "Cancel current orders for explicitly listed units or a dynamic execution-time selection and return them to normal idle behavior. Idle combat units may automatically acquire and pursue enemies within their own vision. Pass exactly one of unitIds or selection.",
    parameters: {
      type: "object",
      properties: {
        ...unitSelectionProperties(ALL_UNIT_SELECTIONS),
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => executeUnitBatch(
      gameplayController,
      args,
      (unitId) => gameplayController.stopUnit(unitId),
    ),
  },
  {
    name: "hold_unit",
    description: "Cancel current orders and make explicitly listed units or a dynamic execution-time selection hold position. Holding combat units fire at enemies currently inside weapon range but never pursue them. Pass exactly one of unitIds or selection.",
    parameters: {
      type: "object",
      properties: {
        ...unitSelectionProperties(ALL_UNIT_SELECTIONS),
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => executeUnitBatch(
      gameplayController,
      args,
      (unitId) => gameplayController.holdUnit(unitId),
    ),
  },
  {
    name: "spawn_agent",
    description: [
      "Spawn a background sub-agent to execute a localized task that you have already decomposed from the overall plan.",
      "Use this ONLY when:",
      "- You have already finished overall strategic planning, scouting, and situation assessment.",
      "- The task is a self-contained execution step that does not require further strategy decisions.",
      "- You are assigning non-overlapping units or buildings to the sub-agent.",
      "Do NOT use this for:",
      "- Strategic analysis, tactical evaluation, or plan review.",
      "- Getting a second opinion on your strategy.",
      "- Asking the sub-agent to formulate or refine the overall plan.",
      "The sub-agent runs in the background and you will not wait for its final result.",
      "You will receive a taskId immediately; the sub-agent's final result will appear in a later message.",
      "Constraints:",
      "- Sub-agents can use all game tools EXCEPT spawn_agent.",
      "- Sub-agents are execution workers, not strategic planners.",
      "- Assign non-overlapping unitIds and buildingIds to avoid conflicts.",
      "- If the task is impossible to execute, the sub-agent will report why and stop.",
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["description", "objective"],
      properties: {
        description: {
          type: "string",
          description: "Short label for this sub-agent task, e.g. 'defend HQ with soldiers 1-3'.",
        },
        objective: {
          type: "string",
          description: "The specific execution objective. Include concrete steps, target locations, and success criteria.",
        },
        assignedUnits: {
          type: "array",
          items: { type: "string" },
          description: "Unit IDs assigned exclusively to this sub-agent.",
        },
        assignedBuildings: {
          type: "array",
          items: { type: "string" },
          description: "Building IDs assigned exclusively to this sub-agent.",
        },
        constraints: {
          type: "string",
          description: "Additional constraints, e.g. 'do not engage enemy HQ'.",
        },
        successCriteria: {
          type: "string",
          description: "Explicit criteria that defines when this task is complete.",
        },
      },
      additionalProperties: false,
    },
    execute: () => ({
      effect: "read" as const,
      result: { ok: false, error: "spawn_agent must be handled by the provider" },
    }),
  },
  {
    name: "orchestrate_plan",
    description: [
      "Register a durable plan using the same parameter shapes as existing action tools, optional completion conditions, and looping.",
      "Prefer this for durable multi-tick intentions that would otherwise require repeated economy, move, build, or attack tool calls.",
      "Rules:",
      "- Step shape: { call: existing_action_tool_name, args: {...}, scope: \"per_unit\"|\"global\", when: {...}, until: {...}, retry: true/false, maxTicks: number }.",
      "- Supported call tools in plans: move_unit, attack_move_unit, attack, build_structure, start_harvest_loop, stop_unit, hold_unit. Production is intentionally managed by spawn_unit/get_production_queue/cancel_production instead of plans.",
      "- unitIds is only required for per_unit steps. Global building plans may omit it.",
      "- scope=per_unit applies the step to each unitId; scope=global runs the step once. Tool defaults are usually per_unit for unit actions and global for building actions.",
      "- In per_unit call args, use unitId: \"$unitId\" or omit unitId to apply the step to each unit in unitIds.",
      "- when waits before trying the call; until marks the step complete. Supported conditions: arrived, enemy_in_range, hq_in_range, near_position, worker_adjacent_to_build_footprint, target_in_range, target_destroyed, credits_at_least, building_exists, enemy_building_exists, unit_count_at_least, enemy_unit_count_at_least, production_queue_empty.",
      "- Plan build_structure steps automatically wait for credits, select a site when x/y are omitted, move the worker, and immediately reselect if the footprint becomes occupied.",
      "- Multiple active plans share the same-tick available credits. Earlier paid build steps reserve credits, so later paid steps wait when the remaining credits cannot cover them.",
      "- Use get_active_plans to inspect currentStep, waiting.code/message/details, and lastAttempt before deciding a plan is stuck or re-registering a similar plan.",
      "- retry=true reissues the call while until is false; attack defaults to durable retry behavior.",
      "- A new immediate unit action takes precedence and interrupts any active plan attached to the selected units. all_combat includes planned units; use explicit main-force unitIds when a specialist or detached force must keep its plan.",
      "- For route-sensitive maneuvers such as flanking, split-front advances, converging attacks, or avoiding a frontal engagement, give each detachment explicit unitIds and a separate plan with multiple move or attack-move steps. Start with a route-entry waypoint on your own side, then advance along the chosen route. A single distant waypoint constrains only the destination, not the route taken.",
      "- Do not use this for routine mining; use start_harvest_loop for workers assigned to economy.",
      "- Do not re-register the same plan every run if the unit already has an active plan that is still appropriate.",
      "- loop = -1 means infinite loop.",
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["steps"],
      properties: {
        unitIds: { type: "array", items: { type: "string" } },
        replaceExisting: { type: "boolean" },
        scope: { type: "string", enum: ["global", "per_unit"] },
        loop: { type: "integer" },
        steps: {
          type: "array",
          items: {
            type: "object",
            required: ["call", "args"],
            properties: {
              call: {
                type: "string",
                enum: ["move_unit", "attack_move_unit", "attack", "build_structure", "start_harvest_loop", "stop_unit", "hold_unit"],
              },
              scope: { type: "string", enum: ["global", "per_unit"] },
              args: {
                type: "object",
                properties: {
                  unitId: { type: "string" },
                  buildingId: { type: "string" },
                  buildingType: { type: "string", enum: ALL_BUILDING_TYPES },
                  unitType: { type: "string", enum: ALL_UNIT_TYPES },
                  x: { type: "integer" },
                  y: { type: "integer" },
                  targetId: { type: "string" },
                  priority: {
                    type: "array",
                    description: "Target ordering override. Listed types are tried first; omitted types remain valid fallback targets.",
                    items: { type: "string", enum: ATTACK_TARGET_TYPES },
                  },
                },
                additionalProperties: false,
              },
              when: {
                type: "object",
                required: ["condition"],
                properties: {
                  condition: {
                    type: "string",
                    enum: [
                      "arrived",
                      "enemy_in_range",
                      "hq_in_range",
                      "near_position",
                      "worker_adjacent_to_build_footprint",
                      "target_in_range",
                      "target_destroyed",
                      "credits_at_least",
                      "building_exists",
                      "enemy_building_exists",
                      "unit_count_at_least",
                      "enemy_unit_count_at_least",
                      "production_queue_empty",
                    ],
                  },
                  x: { type: "integer" },
                  y: { type: "integer" },
                  distance: { type: "integer" },
                  targetId: { type: "string" },
                  amount: { type: "integer" },
                  buildingId: { type: "string" },
                  buildingType: { type: "string", enum: ALL_BUILDING_TYPES },
                  unitType: { type: "string", enum: ALL_UNIT_TYPES },
                  count: { type: "integer" },
                },
                additionalProperties: false,
              },
              until: {
                type: "object",
                required: ["condition"],
                properties: {
                  condition: {
                    type: "string",
                    enum: [
                      "arrived",
                      "enemy_in_range",
                      "hq_in_range",
                      "near_position",
                      "worker_adjacent_to_build_footprint",
                      "target_in_range",
                      "target_destroyed",
                      "credits_at_least",
                      "building_exists",
                      "enemy_building_exists",
                      "unit_count_at_least",
                      "enemy_unit_count_at_least",
                      "production_queue_empty",
                    ],
                  },
                  x: { type: "integer" },
                  y: { type: "integer" },
                  distance: { type: "integer" },
                  targetId: { type: "string" },
                  amount: { type: "integer" },
                  buildingId: { type: "string" },
                  buildingType: { type: "string", enum: ALL_BUILDING_TYPES },
                  unitType: { type: "string", enum: ALL_UNIT_TYPES },
                  count: { type: "integer" },
                },
                additionalProperties: false,
              },
              retry: { type: "boolean" },
              maxTicks: { type: "integer" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => gameplayController.orchestratePlan(args as OrchestratePlanInput),
  },
];

const providerOnlyToolNames = new Set<string>(CONTROL_PROVIDER_ONLY_TOOL_NAMES);
const readToolNames = new Set<string>(CONTROL_READ_TOOL_NAMES);

export function getAgentToolDefinitions(): AgentToolDefinition[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function getAgentToolNames(): string[] {
  return tools.map((tool) => tool.name);
}

export function getControlAgentToolNames(): string[] {
  return getAgentToolNames().filter((name) => !providerOnlyToolNames.has(name));
}

export function getControlReadToolNames(): string[] {
  return getControlAgentToolNames().filter((name) => readToolNames.has(name));
}

export function getControlActionToolNames(): string[] {
  return getControlAgentToolNames().filter((name) => !readToolNames.has(name) && name !== "orchestrate_plan");
}

export function executeAgentTool(gameplayController: GameplayController, name: string, args: unknown): AgentToolExecution {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.execute(gameplayController, args);
}
