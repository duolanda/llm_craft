import { OrchestratePlanInput } from "@llmcraft/shared";
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

const tools: Array<AgentToolDefinition & { execute: ToolExecutor }> = [
  {
    name: "get_map_state",
    description:
      "Read the full visible battlefield. By default returns a compact no-axis ASCII tactical map plus visible unit/building lists with coordinates. Set includeCells=true only when you need terrain cells; set includeEmptyTiles=true only when you explicitly need the full grid including empty cells.",
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
    description: "Read active orchestration plans currently attached to my units.",
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
    description: "Queue a move command for one unit. Use this for workers or precise repositioning; for combat advances through enemy units, prefer attack_move_unit.",
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
      "Queue an area combat move for one combat unit: move toward x/y while automatically attacking enemy units encountered. This is for crossing contested ground, not for focusing a specific target or attacking buildings.",
    parameters: {
      type: "object",
      required: ["unitId", "x", "y"],
      properties: {
        unitId: { type: "string" },
        x: { type: "integer" },
        y: { type: "integer" },
        priority: {
          type: "array",
          items: { type: "string", enum: ["soldier", "worker"] },
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
      "Order one combat unit to attack one enemy target id. If the target is alive, the unit will move toward it until in range and then attack. If the target has died but was seen before, the unit will move to the target's last known position without attacking. Do not pass coordinates.",
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
        unitType: { type: "string", enum: ["worker", "soldier"] },
      },
      additionalProperties: false,
    },
    execute: (bridge, args) => bridge.spawnUnit(String(args.buildingId), args.unitType),
  },
  {
    name: "build_structure",
    description: "Queue a build command for one worker. Barracks must be placed on an empty tile and leave one empty ring around your HQ; if placement fails, the error hint will suggest valid nearby tiles.",
    parameters: {
      type: "object",
      required: ["unitId", "buildingType", "x", "y"],
      properties: {
        unitId: { type: "string" },
        buildingType: { type: "string", enum: ["barracks"] },
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
    name: "orchestrate_plan",
    description: [
      "Register a flat orchestration plan for one or more units using steps, conditions, and looping.",
      "Use this only for simple, clear, repeatable behavior. If immediate commands are more direct or you are unsure the DSL fits, prefer immediate commands.",
      "Rules:",
      "- The plan is a flat steps list, not code.",
      "- Every step must use the new { do: ... } shape, never legacy { type: ... }.",
      "- Supported steps only: move_to, hold_position, wait_until, branch, stop.",
      "- Supported conditions only: cargo_full, cargo_empty, hq_in_range, enemy_in_range.",
      "- Do not invent hidden APIs, extra step kinds, or old DSL keywords such as move_to_resource, move_to_hq, deliver_credits, spawn_soldier.",
      "- Do not use this for routine mining; use start_harvest_loop for workers assigned to economy.",
      "- Do not re-register the same plan every run if the unit already has an active plan that is still appropriate.",
      "- loop = -1 means infinite loop.",
      "- wait_until can only wait for supported fixed conditions.",
      "- branch can only use a supported condition and then/else step arrays.",
      "Combat pressure example:",
      JSON.stringify({
        unitIds: ["soldier_1", "soldier_2"],
        loop: 3,
        steps: [
          { do: "move_to", x: 17, y: 10, formation: "spread" },
          { do: "wait_until", condition: "enemy_in_range", maxTicks: 4 },
          { do: "hold_position" },
        ],
      }),
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["unitIds", "steps"],
      properties: {
        unitIds: { type: "array", items: { type: "string" } },
        replaceExisting: { type: "boolean" },
        loop: { type: "integer" },
        steps: {
          type: "array",
          items: {
            type: "object",
            required: ["do"],
            properties: {
              do: {
                type: "string",
                enum: ["move_to", "hold_position", "wait_until", "branch", "stop"],
              },
              x: { type: "integer" },
              y: { type: "integer" },
              formation: { type: "string", enum: ["direct", "spread"] },
              condition: {},
              maxTicks: { type: "integer" },
              if: {},
              then: { type: "array", items: { type: "object" } },
              else: { type: "array", items: { type: "object" } },
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

export function getAgentToolDefinitions(): AgentToolDefinition[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function executeAgentTool(bridge: GameAgentBridge, name: string, args: unknown): AgentToolExecution {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.execute(bridge, args);
}
