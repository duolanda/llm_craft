import {
  AgentPlanAttemptRecord,
  AgentPlanRecord,
  AgentPlanWaitingDiagnostic,
  Building,
  Command,
  CommandProvenance,
  getBuildingCost,
  getDistanceToBuildingFootprint,
  isBuildableBuildingType,
  isBuildingType,
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
  record: Omit<AgentPlanRecord, "currentStepIndex" | "status" | "currentStep" | "waitingReason" | "waiting" | "lastAttempt">;
  currentStepIndex: number;
  completedLoops: number;
  status: AgentPlanRecord["status"];
  stepStartedTick?: number;
  issuedGlobalStep?: boolean;
  issuedUnitIds: Set<string>;
  waitingReason?: string;
  waiting?: AgentPlanWaitingDiagnostic;
  lastAttempt?: AgentPlanAttemptRecord;
}

export interface PlanToolContext {
  args: Record<string, unknown>;
  step: PlanStep;
  unit?: Unit;
  snapshot: PlanSnapshot;
  planUnitIds: string[];
  commandAlreadyIssued: boolean;
}

export interface PlanToolHandler {
  defaultScope: PlanStepScope;
  defaultRetry?: boolean;
  untilRequiresIssuedCommand?: boolean;
  estimateCost?(context: PlanToolContext): number;
  createCommand(context: PlanToolContext): Command | null;
  diagnoseWait?(context: PlanToolContext): AgentPlanWaitingDiagnostic;
  validateArgs(args: Record<string, unknown>): boolean;
}

export type PlanToolHandlers = Partial<Record<PlanCallToolName, PlanToolHandler>>;

export class MissionRuntime {
  private plans = new Map<string, InternalPlan>();
  private planCounter = 0;

  constructor(private readonly toolHandlers: PlanToolHandlers) {}

  register(input: OrchestratePlanInput, provenance?: CommandProvenance): AgentPlanRecord {
    const loop = input.loop ?? 1;
    if (loop === 0) {
      throw new Error("orchestrate_plan loop cannot be 0");
    }

    const planId = `plan_${++this.planCounter}`;
    const unitIds = input.unitIds ?? [];
    const internal: InternalPlan = {
      record: {
        planId,
        missionId: planId,
        controllerId: provenance?.controllerId,
        createdByTurnId: provenance?.turnId,
        unitIds: [...unitIds],
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
      for (const unitId of unitIds) {
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

  cancel(planIds: readonly string[]): {
    cancelledPlanIds: string[];
    inactivePlanIds: string[];
    unknownPlanIds: string[];
  } {
    const cancelledPlanIds: string[] = [];
    const inactivePlanIds: string[] = [];
    const unknownPlanIds: string[] = [];

    for (const planId of [...new Set(planIds)]) {
      const plan = this.plans.get(planId);
      if (!plan) {
        unknownPlanIds.push(planId);
        continue;
      }
      if (plan.status !== "active") {
        inactivePlanIds.push(planId);
        continue;
      }
      plan.status = "interrupted";
      plan.waitingReason = undefined;
      plan.waiting = undefined;
      cancelledPlanIds.push(planId);
    }

    return { cancelledPlanIds, inactivePlanIds, unknownPlanIds };
  }

  failMission(missionId: string, tick: number, detail: string): boolean {
    const plan = [...this.plans.values()].find(
      (candidate) =>
        candidate.status === "active" &&
        (candidate.record.missionId ?? candidate.record.planId) === missionId,
    );
    if (!plan) {
      return false;
    }
    const step = plan.record.steps[plan.currentStepIndex];
    if (step) {
      this.recordAttempt(plan, tick, step, "failed", detail);
    }
    plan.waitingReason = undefined;
    plan.waiting = undefined;
    plan.status = "failed";
    return true;
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
        plan.waiting = undefined;
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
    snapshot: PlanSnapshot,
  ): Command[] | "advance" {
    this.ensureStepStarted(plan, snapshot.tick);
    const unit = this.resolveGlobalStepUnit(plan, step, snapshot);
    const requestedUnitId = typeof step.args.unitId === "string" && step.args.unitId !== "$unitId"
      ? step.args.unitId
      : undefined;
    const expectsAssignedUnit = requestedUnitId !== undefined || plan.record.unitIds.length > 0;
    if (expectsAssignedUnit && !unit) {
      const missingIds = requestedUnitId ? [requestedUnitId] : plan.record.unitIds;
      this.recordAttempt(
        plan,
        snapshot.tick,
        step,
        "failed",
        `assigned unit is no longer alive: ${missingIds.join(", ")}`,
      );
      plan.status = "failed";
      return [];
    }

    const canEvaluateUntil = !handler.untilRequiresIssuedCommand || plan.issuedGlobalStep === true;
    if (step.until && canEvaluateUntil && this.matchesCondition(step.until, step, unit, snapshot)) {
      this.recordAttempt(plan, snapshot.tick, step, "advanced", `until matched: ${this.describeCondition(step.until)}`);
      this.advanceStep(plan);
      return "advance";
    }

    if (this.isStepExpired(plan, step, snapshot.tick)) {
      this.recordAttempt(plan, snapshot.tick, step, "advanced", "maxTicks expired");
      this.advanceStep(plan);
      return "advance";
    }

    if (step.when && !this.matchesCondition(step.when, step, unit, snapshot)) {
      this.recordWaiting(plan, snapshot.tick, step, {
        code: "condition_not_met",
        message: `Waiting for condition: ${this.describeCondition(step.when)}.`,
        details: { condition: step.when },
      });
      return [];
    }

    const shouldRetry = step.retry === true || handler.defaultRetry === true;
    if (plan.issuedGlobalStep && !shouldRetry) {
      if (!step.until) {
        this.recordAttempt(plan, snapshot.tick, step, "advanced", "one-shot global step already issued");
        this.advanceStep(plan);
        return "advance";
      }
      this.recordWaiting(plan, snapshot.tick, step, {
        code: "completion_condition_not_met",
        message: `Command was issued; waiting for completion condition: ${this.describeCondition(step.until)}.`,
        details: { condition: step.until },
      });
      return [];
    }

    const context = {
      args: step.args,
      step,
      unit,
      snapshot,
      planUnitIds: plan.record.unitIds,
      commandAlreadyIssued: plan.issuedGlobalStep === true,
    };
    const estimatedCost = handler.estimateCost?.(context) ?? 0;
    if (estimatedCost > snapshot.myCredits) {
      this.recordWaiting(plan, snapshot.tick, step, this.creditWait(estimatedCost, snapshot.myCredits));
      return [];
    }

    const command = handler.createCommand(context);
    if (!command) {
      if (shouldRetry || step.when) {
        this.recordWaiting(plan, snapshot.tick, step, handler.diagnoseWait?.(context) ?? {
          code: "command_unavailable",
          message: `The ${step.call} command cannot be created from the current unit and arguments.`,
        });
        return [];
      }
      this.recordAttempt(plan, snapshot.tick, step, "failed", "command prerequisites failed");
      plan.status = "failed";
      return [];
    }
    const commandCost = this.getCommandCost(command);
    if (commandCost > snapshot.myCredits) {
      this.recordWaiting(plan, snapshot.tick, step, this.creditWait(commandCost, snapshot.myCredits));
      return [];
    }

    plan.issuedGlobalStep = true;
    this.recordAttempt(plan, snapshot.tick, step, "command_created", undefined, 1);
    if (!step.until && !shouldRetry) {
      this.advanceStep(plan);
    }
    return [this.decorateMissionCommand(command, plan)];
  }

  private resolveGlobalStepUnit(
    plan: InternalPlan,
    step: PlanStep,
    snapshot: PlanSnapshot,
  ): Unit | undefined {
    const requestedUnitId = step.args.unitId;
    if (typeof requestedUnitId === "string" && requestedUnitId !== "$unitId") {
      return snapshot.myUnits.find((unit) => unit.id === requestedUnitId && unit.exists);
    }
    return plan.record.unitIds
      .map((unitId) => snapshot.myUnits.find((unit) => unit.id === unitId && unit.exists))
      .find((unit): unit is Unit => Boolean(unit));
  }

  private advancePerUnitStep(
    plan: InternalPlan,
    step: PlanStep,
    handler: PlanToolHandler,
    snapshot: PlanSnapshot,
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

    const canEvaluateUntil =
      !handler.untilRequiresIssuedCommand ||
      units.every((unit) => plan.issuedUnitIds.has(unit.id));
    if (step.until && canEvaluateUntil && units.every((unit) => this.matchesCondition(step.until!, step, unit, snapshot))) {
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
    let waiting: AgentPlanWaitingDiagnostic | undefined;
    for (const unit of units) {
      if (step.when && !this.matchesCondition(step.when, step, unit, snapshot)) {
        waiting ??= {
          code: "condition_not_met",
          message: `Waiting for condition: ${this.describeCondition(step.when)}.`,
          details: { condition: step.when, unitId: unit.id },
        };
        continue;
      }
      if (plan.issuedUnitIds.has(unit.id) && !shouldRetry) {
        waiting ??= {
          code: "other_units_pending",
          message: "This unit already received the one-shot command; waiting for the remaining assigned units.",
          details: { unitId: unit.id },
        };
        continue;
      }

      const context = {
        args: step.args,
        step,
        unit,
        snapshot,
        planUnitIds: plan.record.unitIds,
        commandAlreadyIssued: plan.issuedUnitIds.has(unit.id),
      };
      const estimatedCost = handler.estimateCost?.(context) ?? 0;
      if (estimatedCost > availableCredits) {
        waiting = this.creditWait(estimatedCost, availableCredits);
        continue;
      }

      const command = handler.createCommand(context);
      if (!command) {
        waiting ??= handler.diagnoseWait?.(context) ?? {
          code: "command_unavailable",
          message: `The ${step.call} command cannot be created for unit ${unit.id}.`,
          details: { unitId: unit.id },
        };
        continue;
      }
      const cost = this.getCommandCost(command);
      if (cost > availableCredits) {
        waiting = this.creditWait(cost, availableCredits);
        continue;
      }
      availableCredits -= cost;
      plan.issuedUnitIds.add(unit.id);
      commands.push(this.decorateMissionCommand(command, plan));
    }

    if (commands.length > 0) {
      this.recordAttempt(plan, snapshot.tick, step, "command_created", undefined, commands.length);
    } else {
      this.recordWaiting(plan, snapshot.tick, step, waiting ?? {
        code: "no_eligible_units",
        message: "No assigned unit is currently eligible for this step.",
      });
    }

    if (!step.until && !shouldRetry && units.every((unit) => plan.issuedUnitIds.has(unit.id))) {
      this.recordAttempt(plan, snapshot.tick, step, "advanced", "one-shot per-unit step issued for all units", commands.length);
      this.advanceStep(plan);
    }

    return commands;
  }

  private decorateMissionCommand(command: Command, plan: InternalPlan): Command {
    return {
      ...command,
      provenance: {
        controllerId: plan.record.controllerId ?? command.provenance?.controllerId ?? command.playerId,
        source: "mission",
        turnId: plan.record.createdByTurnId,
        missionId: plan.record.missionId ?? plan.record.planId,
      },
    };
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
    plan.waiting = undefined;
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
        return (
          Number.isInteger(args.x) &&
          Number.isInteger(args.y) &&
          Math.max(Math.abs(unit.x - Number(args.x)), Math.abs(unit.y - Number(args.y))) <= 0.35
        );
      }
      case "enemy_in_range":
        return Boolean(unit && this.isAnyEnemyInRange(unit, snapshot));
      case "hq_in_range":
        return Boolean(unit && this.isEnemyHqInRange(unit, snapshot));
      case "near_position":
        return Boolean(unit && Math.max(Math.abs(unit.x - condition.x), Math.abs(unit.y - condition.y)) <= (condition.distance ?? 1));
      case "worker_adjacent_to_build_footprint": {
        if (!unit || unit.type !== "worker") return false;
        const distance = getDistanceToBuildingFootprint(
          condition.buildingType,
          condition.x,
          condition.y,
          unit.x,
          unit.y,
        );
        return distance > 0 && distance <= 1;
      }
      case "target_in_range": {
        if (!unit) {
          return false;
        }
        const target = this.findVisibleTarget(condition.targetId, snapshot);
        if (!target) {
          return false;
        }
        const distance = isBuildingType(target.type)
          ? getDistanceToBuildingFootprint(target.type, target.x, target.y, unit.x, unit.y)
          : Math.max(Math.abs(unit.x - target.x), Math.abs(unit.y - target.y));
        return distance <= unit.attackRange;
      }
      case "target_destroyed":
        return this.findVisibleTarget(condition.targetId, snapshot) === null;
      case "credits_at_least":
        return snapshot.myCredits >= condition.amount;
      case "building_exists": {
        const stepX = step.call === "build_structure" && Number.isInteger(step.args.x)
          ? Number(step.args.x)
          : undefined;
        const stepY = step.call === "build_structure" && Number.isInteger(step.args.y)
          ? Number(step.args.y)
          : undefined;
        const x = condition.x ?? stepX;
        const y = condition.y ?? stepY;
        return snapshot.myBuildings.filter(
          (building) =>
            building.type === condition.buildingType &&
            (x === undefined || y === undefined || (building.x === x && building.y === y)),
        ).length >= (condition.count ?? 1);
      }
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
        const building = this.findFriendlyBuildingForCondition(condition, step, snapshot);
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
    step: PlanStep,
    snapshot: PlanSnapshot
  ): Building | null {
    if (condition.buildingId) {
      return snapshot.myBuildings.find((building) => building.id === condition.buildingId) ?? null;
    }
    if (condition.buildingType) {
      return snapshot.myBuildings.find((building) => building.type === condition.buildingType) ?? null;
    }
    if (typeof step.args.buildingId === "string" && !step.args.buildingId.startsWith("$")) {
      return snapshot.myBuildings.find((building) => building.id === step.args.buildingId) ?? null;
    }
    const placeholderTypes: Record<string, Building["type"]> = {
      $hq: "hq",
      $barracks: "barracks",
      $war_factory: "war_factory",
      $refinery: "refinery",
    };
    const placeholderType = typeof step.args.buildingId === "string"
      ? placeholderTypes[step.args.buildingId]
      : undefined;
    const inferredType = placeholderType ?? (isBuildingType(step.args.buildingType) ? step.args.buildingType : undefined);
    if (inferredType) {
      return snapshot.myBuildings.find((building) => building.type === inferredType) ?? null;
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
        getDistanceToBuildingFootprint(building.type, building.x, building.y, unit.x, unit.y) <= unit.attackRange
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
          getDistanceToBuildingFootprint(enemy.type, enemy.x, enemy.y, unit.x, unit.y) <= unit.attackRange
      )
    );
  }

  private getCommandCost(command: Command): number {
    if (command.type === "build" && isBuildableBuildingType(command.buildingType)) {
      return getBuildingCost(command.buildingType);
    }
    return 0;
  }

  private creditWait(required: number, available: number): AgentPlanWaitingDiagnostic {
    return {
      code: "insufficient_credits",
      message: `Need ${required} credits; ${available} available.`,
      details: { requiredCredits: required, availableCredits: available },
    };
  }

  private recordWaiting(
    plan: InternalPlan,
    tick: number,
    step: PlanStep,
    waiting: AgentPlanWaitingDiagnostic,
  ): void {
    plan.waitingReason = waiting.message;
    plan.waiting = waiting;
    this.recordAttempt(plan, tick, step, "waiting", waiting.message, undefined, waiting);
  }

  private recordAttempt(
    plan: InternalPlan,
    tick: number,
    step: PlanStep,
    status: AgentPlanAttemptRecord["status"],
    detail?: string,
    commandCount?: number,
    waiting?: AgentPlanWaitingDiagnostic,
  ): void {
    if (status !== "waiting") {
      plan.waitingReason = undefined;
      plan.waiting = undefined;
    }
    plan.lastAttempt = {
      tick,
      stepIndex: plan.currentStepIndex,
      call: step.call,
      status,
      ...(detail ? { detail } : {}),
      ...(waiting ? { waiting } : {}),
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
      waiting: plan.waiting,
      lastAttempt: plan.lastAttempt,
    };
  }
}

/** @deprecated Use MissionRuntime. */
export { MissionRuntime as AgentPlanRuntime };
