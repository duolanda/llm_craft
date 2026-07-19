import type { CommandBudgetPolicy, MatchDefinition } from "@llmcraft/shared";

export type { CommandBudgetPolicy } from "@llmcraft/shared";

export const DEFAULT_COMMAND_BUDGET_POLICY: Readonly<CommandBudgetPolicy> = Object.freeze({
  maxCommandsPerActorPerTick: 100,
  maxPathCommandsPerTick: 4,
});

/**
 * MatchDefinition v1 predates explicit budgets. Its semantics are frozen to
 * the historical defaults so old traces remain reproducible.
 */
export function resolveCommandBudgetPolicy(definition: MatchDefinition): CommandBudgetPolicy {
  return definition.definitionVersion === 2
    ? structuredClone(definition.rules.commandBudget)
    : { ...DEFAULT_COMMAND_BUDGET_POLICY };
}

/**
 * Reserves an equal pathfinding share for every actor with demand, then lends
 * unused capacity one slot at a time. The lending order rotates by tick so a
 * stable actor sort cannot create a permanent first-player advantage.
 */
export function allocateFairPathBudgets(
  demandByActor: ReadonlyMap<string, number>,
  totalBudget: number,
  tick: number,
): Map<string, number> {
  const actors = [...demandByActor.entries()]
    .filter(([, demand]) => demand > 0)
    .map(([actorId]) => actorId)
    .sort((left, right) => left.localeCompare(right));
  const allocation = new Map<string, number>();
  if (actors.length === 0 || totalBudget <= 0) return allocation;

  const equalShare = Math.floor(totalBudget / actors.length);
  let remaining = totalBudget;
  for (const actorId of actors) {
    const reserved = Math.min(demandByActor.get(actorId) ?? 0, equalShare);
    allocation.set(actorId, reserved);
    remaining -= reserved;
  }

  const rotation = ((tick % actors.length) + actors.length) % actors.length;
  const lendingOrder = [...actors.slice(rotation), ...actors.slice(0, rotation)];
  while (remaining > 0) {
    let lent = false;
    for (const actorId of lendingOrder) {
      if (remaining <= 0) break;
      const demand = demandByActor.get(actorId) ?? 0;
      const current = allocation.get(actorId) ?? 0;
      if (current >= demand) continue;
      allocation.set(actorId, current + 1);
      remaining--;
      lent = true;
    }
    if (!lent) break;
  }
  return allocation;
}
