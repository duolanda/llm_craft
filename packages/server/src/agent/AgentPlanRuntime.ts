import {
  AgentPlanRecord,
  Building,
  Command,
  OrchestratePlanInput,
  PlanCallToolName,
  PlanStep,
  PlanStepCondition,
  PlanStepScope,
  Position,
  Unit,
} from "@llmcraft/shared";

interface PlanSnapshot {
  tick: number;
  myCredits: number;
  myUnits: Unit[];
  myBuildings: Building[];
  visibleUnits: Array<Unit & { relation: "self" | "enemy" }>;
  visibleBuildings: Array<Building & { relation: "self" | "enemy" }>;
}

interface InternalPlan {
  record: Omit<AgentPlanRecord, "currentStepIndex" | "status">;
  currentStepIndex: number;
  completedLoops: number;
  status: AgentPlanRecord["status"];
  stepStartedTick?: number;
  issuedGlobalStep?: boolean;
  issuedUnitIds: Set<string>;
}

export interface PlanToolContext {
  args: Record<string, unknown>;
  unit?: Unit;
  snapshot: PlanSnapshot;
  planUnitIds: string[];
}

export interface PlanToolHandler {
  defaultScope: PlanStepScope;
  defaultRetry?: boolean;
  createCommand(context: PlanToolContext): Command | null;
  validateArgs(args: Record<string, unknown>): boolean;
}

export type PlanToolHandlers = Partial<Record<PlanCallToolName, PlanToolHandler>>;

export class AgentPlanRuntime {
  private plans = new Map<string, InternalPlan>();
  private planCounter = 0;

  constructor(private readonly toolHandlers: PlanToolHandlers) {}

  register(input: OrchestratePlanInput): AgentPlanRecord {
    const loop = input.loop ?? 1;
    if (loop === 0) {
      throw new Error("orchestrate_plan loop cannot be 0");
    }

    const planId = `plan_${++this.planCounter}`;
    const internal: InternalPlan = {
      record: {
        planId,
        unitIds: [...input.unitIds],
        scope: input.scope,
        loop,
        steps: structuredClone(input.steps),
      },
      currentStepIndex: 0,
      completedLoops: 0,
      status: "active",
      issuedUnitIds: new Set(),
    };

    if (input.replaceExisting) {
      for (const unitId of input.unitIds) {
        this.interruptUnit(unitId);
      }
    }

    this.plans.set(planId, internal);
    return this.summarizePlan(internal);
  }

  interruptUnit(unitId: string): void {
    for (const plan of this.plans.values()) {
      if (plan.record.unitIds.includes(unitId) && plan.status === "active") {
        plan.status = "interrupted";
      }
    }
  }

  getActivePlans(): AgentPlanRecord[] {
    return [...this.plans.values()]
      .map((plan) => this.summarizePlan(plan))
      .filter((plan) => plan.status === "active");
  }

  getAllPlans(): AgentPlanRecord[] {
    return [...this.plans.values()].map((plan) => this.summarizePlan(plan));
  }

  advance(snapshot: PlanSnapshot): Command[] {
    const commands: Command[] = [];
    for (const plan of this.plans.values()) {
      if (plan.status !== "active") {
        continue;
      }
      commands.push(...this.advancePlan(plan, snapshot));
    }
    return commands;
  }

  private advancePlan(plan: InternalPlan, snapshot: PlanSnapshot): Command[] {
    let guard = 0;
    while (guard < 8) {
      guard++;
      if (plan.currentStepIndex >= plan.record.steps.length) {
        if (plan.record.loop === -1 || plan.completedLoops + 1 < plan.record.loop) {
          plan.completedLoops++;
          plan.currentStepIndex = 0;
          this.resetStepState(plan);
          continue;
        }
        plan.status = "completed";
        return [];
      }

      const step = plan.record.steps[plan.currentStepIndex];
      const handler = this.toolHandlers[step.call];
      if (!handler) {
        plan.status = "failed";
        return [];
      }

      const scope = step.scope ?? plan.record.scope ?? handler.defaultScope;
      const produced = scope === "global"
        ? this.advanceGlobalStep(plan, step, handler, snapshot)
        : this.advancePerUnitStep(plan, step, handler, snapshot);

      if (produced === "advance") {
        continue;
      }
      return produced;
    }
    return [];
  }

  private advanceGlobalStep(
    plan: InternalPlan,
    step: PlanStep,
    handler: PlanToolHandler,
    snapshot: PlanSnapshot
  ): Command[] | "advance" {
    this.ensureStepStarted(plan, snapshot.tick);

    if (step.until && this.matchesCondition(step.until, step, undefined, snapshot)) {
      this.advanceStep(plan);
      return "advance";
    }

    if (this.isStepExpired(plan, step, snapshot.tick)) {
      this.advanceStep(plan);
      return "advance";
    }

    if (step.when && !this.matchesCondition(step.when, step, undefined, snapshot)) {
      return [];
    }

    const shouldRetry = step.retry === true || handler.defaultRetry === true;
    if (plan.issuedGlobalStep && !shouldRetry) {
      if (!step.until) {
        this.advanceStep(plan);
        return "advance";
      }
      return [];
    }

    const command = handler.createCommand({
      args: step.args,
      snapshot,
      planUnitIds: plan.record.unitIds,
    });
    if (!command) {
      if (shouldRetry || step.when) {
        return [];
      }
      plan.status = "failed";
      return [];
    }

    plan.issuedGlobalStep = true;
    if (!step.until && !shouldRetry) {
      this.advanceStep(plan);
    }
    return [command];
  }

  private advancePerUnitStep(
    plan: InternalPlan,
    step: PlanStep,
    handler: PlanToolHandler,
    snapshot: PlanSnapshot
  ): Command[] | "advance" {
    this.ensureStepStarted(plan, snapshot.tick);

    const units = plan.record.unitIds
      .map((unitId) => snapshot.myUnits.find((candidate) => candidate.id === unitId))
      .filter((unit): unit is Unit => Boolean(unit && unit.exists));
    if (units.length === 0) {
      plan.status = "failed";
      return [];
    }

    if (step.until && units.every((unit) => this.matchesCondition(step.until!, step, unit, snapshot))) {
      this.advanceStep(plan);
      return "advance";
    }

    if (this.isStepExpired(plan, step, snapshot.tick)) {
      this.advanceStep(plan);
      return "advance";
    }

    const shouldRetry = step.retry === true || handler.defaultRetry === true;
    const commands: Command[] = [];
    for (const unit of units) {
      if (step.when && !this.matchesCondition(step.when, step, unit, snapshot)) {
        continue;
      }
      if (plan.issuedUnitIds.has(unit.id) && !shouldRetry) {
        continue;
      }

      const command = handler.createCommand({
        args: step.args,
        unit,
        snapshot,
        planUnitIds: plan.record.unitIds,
      });
      if (!command) {
        continue;
      }
      plan.issuedUnitIds.add(unit.id);
      commands.push(command);
    }

    if (!step.until && !shouldRetry && units.every((unit) => plan.issuedUnitIds.has(unit.id))) {
      this.advanceStep(plan);
    }

    return commands;
  }

  private ensureStepStarted(plan: InternalPlan, tick: number): void {
    if (plan.stepStartedTick === undefined) {
      plan.stepStartedTick = tick;
      plan.issuedGlobalStep = false;
      plan.issuedUnitIds.clear();
    }
  }

  private isStepExpired(plan: InternalPlan, step: PlanStep, tick: number): boolean {
    return step.maxTicks !== undefined && plan.stepStartedTick !== undefined && tick - plan.stepStartedTick >= step.maxTicks;
  }

  private advanceStep(plan: InternalPlan): void {
    plan.currentStepIndex++;
    this.resetStepState(plan);
  }

  private resetStepState(plan: InternalPlan): void {
    plan.stepStartedTick = undefined;
    plan.issuedGlobalStep = false;
    plan.issuedUnitIds.clear();
  }

  private matchesCondition(
    condition: PlanStepCondition,
    step: PlanStep,
    unit: Unit | undefined,
    snapshot: PlanSnapshot
  ): boolean {
    switch (condition.condition) {
      case "arrived": {
        if (!unit) {
          return false;
        }
        const args = this.resolveUnitArgs(step.args, unit.id);
        return Number.isInteger(args.x) && Number.isInteger(args.y) && unit.x === Number(args.x) && unit.y === Number(args.y);
      }
      case "enemy_in_range":
        return Boolean(unit && this.isAnyEnemyInRange(unit, snapshot));
      case "hq_in_range":
        return Boolean(unit && this.isEnemyHqInRange(unit, snapshot));
      case "near_position":
        return Boolean(unit && Math.max(Math.abs(unit.x - condition.x), Math.abs(unit.y - condition.y)) <= (condition.distance ?? 1));
      case "target_in_range": {
        if (!unit) {
          return false;
        }
        const target = this.findVisibleTarget(condition.targetId, snapshot);
        return Boolean(target && Math.max(Math.abs(unit.x - target.x), Math.abs(unit.y - target.y)) <= unit.attackRange);
      }
      case "target_destroyed":
        return this.findVisibleTarget(condition.targetId, snapshot) === null;
      case "credits_at_least":
        return snapshot.myCredits >= condition.amount;
      case "building_exists":
        return snapshot.myBuildings.filter((building) => building.type === condition.buildingType).length >= (condition.count ?? 1);
      case "unit_count_at_least":
        return snapshot.myUnits.filter((candidate) => candidate.type === condition.unitType).length >= condition.count;
      case "production_queue_empty": {
        const building = this.findFriendlyBuildingForCondition(condition, snapshot);
        return Boolean(building && building.productionQueue.length === 0);
      }
      default:
        return false;
    }
  }

  private resolveUnitArgs(args: Record<string, unknown>, unitId: string): Record<string, unknown> {
    if (args.unitId === "$unitId" || args.unitId === undefined) {
      return { ...args, unitId };
    }
    return args;
  }

  private findFriendlyBuildingForCondition(
    condition: Extract<PlanStepCondition, { condition: "production_queue_empty" }>,
    snapshot: PlanSnapshot
  ): Building | null {
    if (condition.buildingId) {
      return snapshot.myBuildings.find((building) => building.id === condition.buildingId) ?? null;
    }
    if (condition.buildingType) {
      return snapshot.myBuildings.find((building) => building.type === condition.buildingType) ?? null;
    }
    return null;
  }

  private findVisibleTarget(targetId: string, snapshot: PlanSnapshot): (Unit | Building) & { relation: "self" | "enemy" } | null {
    return (
      snapshot.visibleUnits.find((candidate) => candidate.id === targetId) ??
      snapshot.visibleBuildings.find((candidate) => candidate.id === targetId) ??
      null
    );
  }

  private isEnemyHqInRange(unit: Unit, snapshot: PlanSnapshot): boolean {
    return snapshot.visibleBuildings.some(
      (building) =>
        building.relation === "enemy" &&
        building.type === "hq" &&
        Math.max(Math.abs(unit.x - building.x), Math.abs(unit.y - building.y)) <= unit.attackRange
    );
  }

  private isAnyEnemyInRange(unit: Unit, snapshot: PlanSnapshot): boolean {
    return (
      snapshot.visibleUnits.some(
        (enemy) =>
          enemy.relation === "enemy" &&
          Math.max(Math.abs(unit.x - enemy.x), Math.abs(unit.y - enemy.y)) <= unit.attackRange
      ) ||
      snapshot.visibleBuildings.some(
        (enemy) =>
          enemy.relation === "enemy" &&
          Math.max(Math.abs(unit.x - enemy.x), Math.abs(unit.y - enemy.y)) <= unit.attackRange
      )
    );
  }

  private summarizePlan(plan: InternalPlan): AgentPlanRecord {
    return {
      ...plan.record,
      currentStepIndex: plan.currentStepIndex,
      status: plan.status,
    };
  }
}
