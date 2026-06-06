import {
  ALL_BUILDING_TYPES,
  ALL_UNIT_TYPES,
  BUILDING_TYPES,
  CONTROL_PROVIDER_ONLY_TOOL_NAMES,
  CONTROL_READ_TOOL_NAMES,
  DEFAULT_MAP_LAYOUT,
  OrchestratePlanInput,
} from "@llmcraft/shared";
import { GameAgentBridge } from "./GameAgentBridge";

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolExecution {
  effect: "read" | "action" | "plan";
  result: unknown;
}

type ToolExecutor = (bridge: GameAgentBridge, args: any) => AgentToolExecution;

const BUILDABLE_BUILDING_TYPES = ALL_BUILDING_TYPES.filter((buildingType) => buildingType !== BUILDING_TYPES.HQ);
const ATTACK_TARGET_TYPES = [...ALL_UNIT_TYPES, ...ALL_BUILDING_TYPES];
const OPENING_BARRACKS_SITE = {
  x: DEFAULT_MAP_LAYOUT.player1Hq.x + 2,
  y: DEFAULT_MAP_LAYOUT.player1Hq.y,
};

const tools: Array<AgentToolDefinition & { execute: ToolExecutor }> = [
  {
    name: "get_map_state",
    description:
      "Read the currently visible battlefield under basic fog of war. By default returns a compact no-axis ASCII tactical map with ? for unseen tiles plus visible unit/building lists with coordinates. Set includeCells=true only when you need visible terrain cells; set includeEmptyTiles=true only when you explicitly need all visible grid cells including empty cells.",
    parameters: {
      type: "object",
      properties: {
        includeCells: { type: "boolean" },
        includeEmptyTiles: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: (bridge, args) =>
      bridge.getMapState({
        includeCells: args?.includeCells === true,
        includeEmptyTiles: args?.includeEmptyTiles === true,
      }),
  },
  {
    name: "get_my_state",
    description: "Read my economy, HQ, buildings, and production capability.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (bridge) => bridge.getMyState(),
  },
  {
    name: "get_my_units",
    description: "Read my controllable units with state and carry status.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (bridge) => bridge.getMyUnits(),
  },
  {
    name: "get_active_plans",
    description: "Read active orchestration plans currently attached to my units, including currentStep, waitingReason, and lastAttempt diagnostics.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (bridge) => bridge.getActivePlansTool(),
  },
  {
    name: "get_recent_events",
    description: "Read recent AI-facing command feedback and important events.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (bridge) => bridge.getRecentEvents(),
  },
  {
    name: "move_unit",
    description:
      "Queue a move command for one unit. Use this for workers or precise repositioning. For combat units, use attack when you know a target id; use attack_move_unit only when you need to cross dangerous ground without a specific target.",
    parameters: {
      type: "object",
      required: ["unitId", "x", "y"],
      properties: {
        unitId: { type: "string" },
        x: { type: "integer" },
        y: { type: "integer" },
      },
      additionalProperties: false,
    },
    execute: (bridge, args) => bridge.moveUnit(String(args.unitId), { x: Number(args.x), y: Number(args.y) }),
  },
  {
    name: "attack_move_unit",
    description:
      "Queue a targetless combat move for one combat unit: move toward x/y while automatically attacking role-appropriate enemy targets encountered before arrival. Defaults are role-aware: riflemen prefer infantry, rocket soldiers prefer vehicles, and light tanks prefer structures. Once the unit reaches the destination, this order ends. If an enemy HQ, barracks, or specific unit id is visible, prefer attack instead.",
    parameters: {
      type: "object",
      required: ["unitId", "x", "y"],
      properties: {
        unitId: { type: "string" },
        x: { type: "integer" },
        y: { type: "integer" },
        priority: {
          type: "array",
          items: { type: "string", enum: ATTACK_TARGET_TYPES },
        },
      },
      additionalProperties: false,
    },
    execute: (bridge, args) =>
      bridge.attackMoveUnit(String(args.unitId), { x: Number(args.x), y: Number(args.y) }, args.priority),
  },
  {
    name: "attack",
    description:
      "Order one combat unit to attack one enemy target id. This is the default combat command whenever a visible target id exists, including far-away HQ or barracks targets: the unit will move toward the target until in range and then keep attacking. If the target has died but was seen before, the unit will move to the target's last known position without attacking. Do not pass coordinates.",
    parameters: {
      type: "object",
      required: ["unitId", "targetId"],
      properties: {
        unitId: { type: "string" },
        targetId: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: (bridge, args) => bridge.attackTarget(String(args.unitId), String(args.targetId)),
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
    execute: (bridge, args) => bridge.spawnUnit(String(args.buildingId), args.unitType),
  },
  {
    name: "build_structure",
    description: "Queue a build command for one worker. Buildable structures must be placed on an empty tile and leave one empty ring around your HQ; if placement fails, the error hint will suggest valid nearby tiles.",
    parameters: {
      type: "object",
      required: ["unitId", "buildingType", "x", "y"],
      properties: {
        unitId: { type: "string" },
        buildingType: { type: "string", enum: BUILDABLE_BUILDING_TYPES },
        x: { type: "integer" },
        y: { type: "integer" },
      },
      additionalProperties: false,
    },
    execute: (bridge, args) =>
      bridge.buildStructure(String(args.unitId), args.buildingType, { x: Number(args.x), y: Number(args.y) }),
  },
  {
    name: "start_harvest_loop",
    description:
      "Assign one friendly worker to the built-in mining loop. Prefer this for routine economy instead of hand-writing mining with orchestrate_plan. Omit x/y to auto-pick the nearest resource; once accepted, do not repeatedly reissue it unless the worker is idle, blocked, or needs reassignment.",
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
    execute: (bridge, args) => {
      const hasX = args?.x !== undefined;
      const hasY = args?.y !== undefined;
      const position = hasX && hasY ? { x: Number(args.x), y: Number(args.y) } : undefined;
      if (hasX !== hasY) {
        return bridge.startHarvestLoop(String(args.unitId), { x: Number(args.x), y: Number(args.y) });
      }
      return bridge.startHarvestLoop(String(args.unitId), position);
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
    execute: (bridge, args) => bridge.holdUnit(String(args.unitId)),
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
      "- In global production args, buildingId can be \"$hq\", \"$barracks\", or \"$war_factory\" to resolve the current friendly building at execution time.",
      "- when waits before trying the call; until marks the step complete. Supported conditions: arrived, enemy_in_range, hq_in_range, near_position, target_in_range, target_destroyed, credits_at_least, building_exists, enemy_building_exists, unit_count_at_least, enemy_unit_count_at_least, production_queue_empty.",
      "- Plan spawn_unit/build_structure steps automatically wait when current credits cannot pay the requested unit or building; they do not emit unaffordable commands just to retry.",
      "- Multiple active plans share the same tick budget. Earlier paid spawn/build steps reserve credits, so later paid steps wait when the remaining budget cannot cover them.",
      "- Use get_active_plans to inspect currentStep, waitingReason, and lastAttempt before deciding a plan is stuck or re-registering a similar plan.",
      "- retry=true reissues the call while until is false; attack defaults to durable retry behavior.",
      "- Do not use this for routine mining; use start_harvest_loop for workers assigned to economy.",
      "- Do not re-register the same plan every run if the unit already has an active plan that is still appropriate.",
      "- loop = -1 means infinite loop.",
      "Opening example: assign two workers to mining, wait for barracks money, build barracks, then train riflemen:",
      JSON.stringify({
        unitIds: ["worker_1", "worker_2"],
        loop: 1,
        steps: [
          { call: "start_harvest_loop", args: { unitId: "$unitId" }, scope: "per_unit" },
          {
            call: "build_structure",
            args: { unitId: "worker_1", buildingType: "barracks", x: OPENING_BARRACKS_SITE.x, y: OPENING_BARRACKS_SITE.y },
            scope: "global",
            when: { condition: "credits_at_least", amount: 120 },
            until: { condition: "building_exists", buildingType: "barracks" },
            retry: true,
          },
          {
            call: "spawn_unit",
            args: { buildingId: "$barracks", unitType: "rifleman" },
            scope: "global",
            when: { condition: "production_queue_empty", buildingType: "barracks" },
            until: { condition: "unit_count_at_least", unitType: "rifleman", count: 4 },
            retry: true,
          },
        ],
      }),
      "Combat assault example: move-attack a squad near the enemy HQ, then focus the HQ:",
      JSON.stringify({
        unitIds: ["soldier_1", "soldier_2"],
        loop: 1,
        steps: [
          {
            call: "attack_move_unit",
            args: { unitId: "$unitId", x: DEFAULT_MAP_LAYOUT.player2Hq.x, y: DEFAULT_MAP_LAYOUT.player2Hq.y },
            until: { condition: "near_position", x: DEFAULT_MAP_LAYOUT.player2Hq.x, y: DEFAULT_MAP_LAYOUT.player2Hq.y, distance: 2 },
            maxTicks: 80,
          },
          {
            call: "attack",
            args: { unitId: "$unitId", targetId: "building_enemy_hq" },
            until: { condition: "target_destroyed", targetId: "building_enemy_hq" },
            retry: true,
          },
        ],
      }),
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
    execute: (bridge, args) => bridge.orchestratePlan(args as OrchestratePlanInput),
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

export function executeAgentTool(bridge: GameAgentBridge, name: string, args: unknown): AgentToolExecution {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.execute(bridge, args);
}
