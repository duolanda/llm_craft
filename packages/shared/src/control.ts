export const CONTROL_PROVIDER_ONLY_TOOL_NAMES = ["spawn_agent"] as const;

export const CONTROL_READ_TOOL_NAMES = [
  "get_map_state",
  "get_my_state",
  "get_my_units",
  "get_army_summary",
  "get_active_plans",
  "get_recent_events",
] as const;

export type ControlProviderOnlyToolName = typeof CONTROL_PROVIDER_ONLY_TOOL_NAMES[number];
export type ControlReadToolName = typeof CONTROL_READ_TOOL_NAMES[number];
