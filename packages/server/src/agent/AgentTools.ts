import {
  ALL_BUILDING_TYPES,
  ALL_UNIT_TYPES,
  BUILDING_TYPES,
  CONTROL_PROVIDER_ONLY_TOOL_NAMES,
  CONTROL_READ_TOOL_NAMES,
  OrchestratePlanInput,
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

const executeUnitBatch = (
  gameplayController: GameplayController,
  args: Record<string, unknown>,
  execute: (unitId: string) => AgentToolExecution,
): AgentToolExecution => {
  const unitIds = getUnitIds(args);
  if (unitIds.length === 0) {
    return {
      effect: "action",
      result: { ok: false, error: "missing_units", hint: "Pass one or more friendly unit IDs in unitIds." },
    };
  }
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
  return {
    effect: "action",
    result: {
      tick: results.find((result) => typeof result.tick === "number")?.tick,
      ok: results.every((result) => result.ok !== false),
      results,
      ...recoveryContext,
    },
  };
};

const tools: Array<AgentToolDefinition & { execute: ToolExecutor }> = [
  {
    name: "get_map_state",
    description:
      "Read the full battlefield as structured unit, building, and resource lists. Set includeCells=true only when you need terrain cells; set includeEmptyTiles=true only when you explicitly need all grid cells including empty cells.",
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
    description: "Read my controllable units plus role+intent groups, so idle/holding combat forces are visible without manually counting the unit list.",
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
    description: "Read active orchestration plans currently attached to my units, including currentStep, structured waiting diagnostics, and lastAttempt.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (gameplayController) => gameplayController.getActivePlansTool(),
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
      "Queue the same move destination for one or more selected units. Blocked destinations are resolved to nearby reachable tiles when possible.",
    parameters: {
      type: "object",
      required: ["unitIds", "x", "y"],
      properties: {
        unitIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
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
      "Queue the same targetless combat advance for one or more selected combat units. Each unit receives a nearby reachable destination when the requested tile is occupied and automatically fights enemies acquired within its own vision while advancing.",
    parameters: {
      type: "object",
      required: ["unitIds", "x", "y"],
      properties: {
        unitIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
        x: { type: "integer" },
        y: { type: "integer" },
        priority: {
          type: "array",
          items: { type: "string", enum: ATTACK_TARGET_TYPES },
        },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => executeUnitBatch(
      gameplayController,
      args,
      (unitId) => gameplayController.attackMoveUnit(unitId, { x: Number(args.x), y: Number(args.y) }, args.priority),
    ),
  },
  {
    name: "attack",
    description:
      "Order one or more selected combat units to attack one enemy target ID. Units move into range and keep attacking while the target exists. A missing target result includes compact current alternatives.",
    parameters: {
      type: "object",
      required: ["unitIds", "targetId"],
      properties: {
        unitIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
        targetId: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => executeUnitBatch(
      gameplayController,
      args,
      (unitId) => gameplayController.attackTarget(unitId, String(args.targetId)),
    ),
  },
  {
    name: "spawn_unit",
    description: "Queue a production command for one building.",
    parameters: {
      type: "object",
      required: ["buildingId", "unitType"],
      properties: {
        buildingId: { type: "string" },
        unitType: { type: "string", enum: ALL_UNIT_TYPES },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => gameplayController.spawnUnit(String(args.buildingId), args.unitType),
  },
  {
    name: "build_structure",
    description: "Assign one worker to construct a building. Omit x/y to select a legal site automatically; refinery auto-placement favors sites that shorten resource delivery routes. If the worker is not adjacent to the full footprint, it moves there and starts construction when ready. A worker that was harvesting resumes that loop after construction. War factories require a completed barracks first.",
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
      "Assign one friendly worker to the built-in mining loop. The worker delivers to the nearest completed HQ or refinery. Omit x/y to auto-select a deposit using recurring delivery distance, initial travel, and current assignments; specify x/y only when intentionally overriding that choice. Multiple workers may share one deposit. Do not repeatedly reissue unless the worker is idle, blocked, or needs reassignment.",
    parameters: {
      type: "object",
      required: ["unitId"],
      properties: {
        unitId: { type: "string" },
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
        return gameplayController.startHarvestLoop(String(args.unitId), { x: Number(args.x), y: Number(args.y) });
      }
      return gameplayController.startHarvestLoop(String(args.unitId), position);
    },
  },
  {
    name: "hold_unit",
    description: "Queue a hold-position command for one unit.",
    parameters: {
      type: "object",
      required: ["unitId"],
      properties: {
        unitId: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: (gameplayController, args) => gameplayController.holdUnit(String(args.unitId)),
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
      "Register a flat orchestration plan for one or more units using existing action-tool calls, optional until conditions, and looping.",
      "Prefer this for durable multi-tick intentions that would otherwise require repeated economy, production, move, or attack tool calls.",
      "Rules:",
      "- Step shape: { call: existing_action_tool_name, args: {...}, scope: \"per_unit\"|\"global\", when: {...}, until: {...}, retry: true/false, maxTicks: number }.",
      "- Supported call tools in plans: move_unit, attack_move_unit, attack, spawn_unit, build_structure, start_harvest_loop, hold_unit.",
      "- scope=per_unit applies the step to each unitId; scope=global runs the step once. Tool defaults are usually per_unit for unit actions and global for production/building actions.",
      "- In per_unit call args, use unitId: \"$unitId\" or omit unitId to apply the step to each unit in unitIds.",
      "- In global production args, buildingId can be \"$hq\", \"$barracks\", \"$war_factory\", or \"$refinery\" to resolve the current friendly building at execution time.",
      "- when waits before trying the call; until marks the step complete. Supported conditions: arrived, enemy_in_range, hq_in_range, near_position, worker_adjacent_to_build_footprint, target_in_range, target_destroyed, credits_at_least, building_exists, enemy_building_exists, unit_count_at_least, enemy_unit_count_at_least, production_queue_empty.",
      "- Plan spawn_unit/build_structure steps automatically wait when current credits cannot pay the requested unit or building; build_structure also waits until the worker is adjacent to the requested footprint.",
      "- Multiple active plans share the same-tick available credits. Earlier paid spawn/build steps reserve credits, so later paid steps wait when the remaining credits cannot cover them.",
      "- Use get_active_plans to inspect currentStep, waiting.code/message/details, and lastAttempt before deciding a plan is stuck or re-registering a similar plan.",
      "- retry=true reissues the call while until is false; attack defaults to durable retry behavior.",
      "- Do not use this for routine mining; use start_harvest_loop for workers assigned to economy.",
      "- Do not re-register the same plan every run if the unit already has an active plan that is still appropriate.",
      "- loop = -1 means infinite loop.",
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["unitIds", "steps"],
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
                enum: ["move_unit", "attack_move_unit", "attack", "spawn_unit", "build_structure", "start_harvest_loop", "hold_unit"],
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
