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
    description: "Read the full visible battlefield as map cells grouped by coordinate. Each returned cell includes x/y, the tile type, and optional unit/building occupants. By default only non-empty/interesting cells are returned; set includeEmptyTiles=true when you explicitly need the full grid including empty and obstacle tiles.",
    parameters: {
      type: "object",
      properties: {
        includeEmptyTiles: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: (bridge, args) => bridge.getMapState({ includeEmptyTiles: args?.includeEmptyTiles === true }),
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
    description: "Queue a move command for one unit.",
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
    name: "attack_unit",
    description: "Queue a direct attack command for one unit against one target id.",
    parameters: {
      type: "object",
      required: ["unitId", "targetId"],
      properties: {
        unitId: { type: "string" },
        targetId: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: (bridge, args) => bridge.attackUnit(String(args.unitId), String(args.targetId)),
  },
  {
    name: "attack_in_range",
    description: "Queue an attack-in-range command for one unit, optionally with a priority list. Recommended priority when pushing to finish the game: [\"hq\", \"soldier\", \"worker\", \"barracks\"].",
    parameters: {
      type: "object",
      required: ["unitId"],
      properties: {
        unitId: { type: "string" },
        priority: {
          type: "array",
          items: { type: "string", enum: ["hq", "soldier", "worker", "barracks"] },
        },
      },
      additionalProperties: false,
    },
    execute: (bridge, args) => bridge.attackInRange(String(args.unitId), args.priority),
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
      "- Supported steps only: move_to, attack_in_range, hold_position, wait_until, branch, stop.",
      "- Supported conditions only: cargo_full, cargo_empty, hq_in_range, enemy_in_range.",
      "- Do not invent hidden APIs, extra step kinds, or old DSL keywords such as move_to_resource, move_to_hq, deliver_credits, spawn_soldier.",
      "- loop = -1 means infinite loop.",
      "- wait_until can only wait for supported fixed conditions.",
      "- branch can only use a supported condition and then/else step arrays.",
      "Mining example:",
      JSON.stringify({
        unitIds: ["unit_1"],
        loop: -1,
        steps: [
          { do: "move_to", x: 2, y: 7 },
          { do: "wait_until", condition: "cargo_full" },
          { do: "move_to", x: 2, y: 9 },
          { do: "wait_until", condition: "cargo_empty" },
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
                enum: ["move_to", "attack_in_range", "hold_position", "wait_until", "branch", "stop"],
              },
              x: { type: "integer" },
              y: { type: "integer" },
              formation: { type: "string", enum: ["direct", "spread"] },
              priority: {
                type: "array",
                items: { type: "string", enum: ["hq", "soldier", "worker", "barracks"] },
              },
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
