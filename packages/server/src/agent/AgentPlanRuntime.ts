import {
  AgentPlanAttemptRecord,
  AgentPlanRecord,
  Building,
  Command,
  getBuildingCost,
  getUnitCost,
  isBuildableBuildingType,
  isUnitType,
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
  record: Omit<AgentPlanRecord, "currentStepIndex" | "status" | "currentStep" | "waitingReason" | "lastAttempt">;
  currentStepIndex: number;
  completedLoops: number;
  status: AgentPlanRecord["status"];
  stepStartedTick?: number;
  issuedGlobalStep?: boolean;
  issuedUnitIds: Set<string>;
  waitingReason?: string;
  lastAttempt?: AgentPlanAttemptRecord;
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
  estimateCost?(context: PlanToolContext): number;
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
    let availableCredits = snapshot.myCredits;
    for (const plan of this.plans.values()) {
      if (plan.status !== "active") {
        continue;
      }
      const planCommands = this.advancePlan(plan, {
        ...snapshot,
        myCredits: availableCredits,
      });
      for (const command of planCommands) {
        availableCredits -= this.getCommandCost(command);
        commands.push(command);
      }
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
        plan.waitingReason = undefined;
        plan.status = "completed";
        return [];
      }

      const step = plan.record.steps[plan.currentStepIndex];
      const handler = this.toolHandlers[step.call];
      if (!handler) {
        this.recordAttempt(plan, snapshot.tick, step, "failed", "unsupported plan tool");
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
      this.recordAttempt(plan, snapshot.tick, step, "advanced", `until matched: ${this.describeCondition(step.until)}`);
      this.advanceStep(plan);
      return "advance";
    }

    if (this.isStepExpired(plan, step, snapshot.tick)) {
      this.recordAttempt(plan, snapshot.tick, step, "advanced", "maxTicks expired");
      this.advanceStep(plan);
      return "advance";
    }

    if (step.when && !this.matchesCondition(step.when, step, undefined, snapshot)) {
      this.recordWaiting(plan, snapshot.tick, step, `waiting for when: ${this.describeCondition(step.when)}`);
      return [];
    }

    const shouldRetry = step.retry === true || handler.defaultRetry === true;
    if (plan.issuedGlobalStep && !shouldRetry) {
      if (!step.until) {
        this.recordAttempt(plan, snapshot.tick, step, "advanced", "one-shot global step already issued");
        this.advanceStep(plan);
        return "advance";
      }
      this.recordWaiting(plan, snapshot.tick, step, `waiting for until: ${this.describeCondition(step.until)}`);
      return [];
    }

    const context = {
      args: step.args,
      snapshot,
      planUnitIds: plan.record.unitIds,
    };
    const estimatedCost = handler.estimateCost?.(context) ?? 0;
    if (estimatedCost > snapshot.myCredits) {
      this.recordWaiting(plan, snapshot.tick, step, `waiting for budget: need ${estimatedCost} credits, available ${snapshot.myCredits}`);
      return [];
    }

    const command = handler.createCommand(context);
    if (!command) {
      if (shouldRetry || step.when) {
        this.recordWaiting(plan, snapshot.tick, step, "waiting for command prerequisites");
        return [];
      }
      this.recordAttempt(plan, snapshot.tick, step, "failed", "command prerequisites failed");
      plan.status = "failed";
      return [];
    }

    const commandCost = this.getCommandCost(command);
    if (commandCost > snapshot.myCredits) {
      this.recordWaiting(plan, snapshot.tick, step, `waiting for budget: need ${commandCost} credits, available ${snapshot.myCredits}`);
      return [];
    }

    plan.issuedGlobalStep = true;
    this.recordAttempt(plan, snapshot.tick, step, "command_created", undefined, 1);
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
      this.recordAttempt(plan, snapshot.tick, step, "failed", "no assigned units are alive");
      plan.status = "failed";
      return [];
    }

    if (step.until && units.every((unit) => this.matchesCondition(step.until!, step, unit, snapshot))) {
      this.recordAttempt(plan, snapshot.tick, step, "advanced", `until matched for all units: ${this.describeCondition(step.until)}`);
      this.advanceStep(plan);
      return "advance";
    }

    if (this.isStepExpired(plan, step, snapshot.tick)) {
      this.recordAttempt(plan, snapshot.tick, step, "advanced", "maxTicks expired");
      this.advanceStep(plan);
      return "advance";
    }

    const shouldRetry = step.retry === true || handler.defaultRetry === true;
    const commands: Command[] = [];
    let availableCredits = snapshot.myCredits;
    let waitingReason: string | undefined;
    for (const unit of units) {
      if (step.when && !this.matchesCondition(step.when, step, unit, snapshot)) {
        waitingReason ??= `waiting for when: ${this.describeCondition(step.when)}`;
        continue;
      }
      if (plan.issuedUnitIds.has(unit.id) && !shouldRetry) {
        waitingReason ??= "waiting for other units or step advance";
        continue;
      }

      const context = {
        args: step.args,
        unit,
        snapshot,
        planUnitIds: plan.record.unitIds,
      };
      const estimatedCost = handler.estimateCost?.(context) ?? 0;
      if (estimatedCost > availableCredits) {
        waitingReason = `waiting for budget: need ${estimatedCost} credits, available ${availableCredits}`;
        continue;
      }

      const command = handler.createCommand(context);
      if (!command) {
        waitingReason ??= "waiting for command prerequisites";
        continue;
      }
      const cost = this.getCommandCost(command);
      if (cost > availableCredits) {
        waitingReason = `waiting for budget: need ${cost} credits, available ${availableCredits}`;
        continue;
      }
      availableCredits -= cost;
      plan.issuedUnitIds.add(unit.id);
      commands.push(command);
    }

    if (commands.length > 0) {
      this.recordAttempt(plan, snapshot.tick, step, "command_created", undefined, commands.length);
    } else {
      this.recordWaiting(plan, snapshot.tick, step, waitingReason ?? "waiting for eligible units");
    }

    if (!step.until && !shouldRetry && units.every((unit) => plan.issuedUnitIds.has(unit.id))) {
      this.recordAttempt(plan, snapshot.tick, step, "advanced", "one-shot per-unit step issued for all units", commands.length);
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
    plan.waitingReason = undefined;
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
      case "enemy_building_exists":
        return (
          snapshot.visibleBuildings.filter(
            (building) => building.relation === "enemy" && building.type === condition.buildingType
          ).length >= (condition.count ?? 1)
        );
      case "unit_count_at_least":
        return snapshot.myUnits.filter((candidate) => candidate.type === condition.unitType).length >= condition.count;
      case "enemy_unit_count_at_least":
        return (
          snapshot.visibleUnits.filter(
            (candidate) => candidate.relation === "enemy" && candidate.type === condition.unitType
          ).length >= condition.count
        );
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

  private getCommandCost(command: Command): number {
    if (command.type === "spawn" && isUnitType(command.unitType)) {
      return getUnitCost(command.unitType);
    }
    if (command.type === "build" && isBuildableBuildingType(command.buildingType)) {
      return getBuildingCost(command.buildingType);
    }
    return 0;
  }

  private recordWaiting(plan: InternalPlan, tick: number, step: PlanStep, detail: string): void {
    plan.waitingReason = detail;
    this.recordAttempt(plan, tick, step, "waiting", detail);
  }

  private recordAttempt(
    plan: InternalPlan,
    tick: number,
    step: PlanStep,
    status: AgentPlanAttemptRecord["status"],
    detail?: string,
    commandCount?: number
  ): void {
    if (status !== "waiting") {
      plan.waitingReason = undefined;
    }
    plan.lastAttempt = {
      tick,
      stepIndex: plan.currentStepIndex,
      call: step.call,
      status,
      ...(detail ? { detail } : {}),
      ...(commandCount !== undefined ? { commandCount } : {}),
    };
  }

  private describeCondition(condition: PlanStepCondition): string {
    return JSON.stringify(condition);
  }

  private summarizePlan(plan: InternalPlan): AgentPlanRecord {
    return {
      ...plan.record,
      currentStepIndex: plan.currentStepIndex,
      status: plan.status,
      currentStep: plan.record.steps[plan.currentStepIndex],
      waitingReason: plan.waitingReason,
      lastAttempt: plan.lastAttempt,
    };
  }
}
