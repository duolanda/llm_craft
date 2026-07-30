import type { Unit, UnitIntent } from "@llmcraft/shared";

/** Authoritative unit representation; client-facing intent is a projection. */
export type WorldUnit = Omit<Unit, "intent"> & {
  order?: UnitIntent;
};
