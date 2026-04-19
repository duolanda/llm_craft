import {
  AgentPlanRecord,
  Building,
  BuildingType,
  Command,
  OrchestratePlanInput,
  PlanCondition,
  PlanStep,
  PlayerId,
  Position,
  Unit,
} from "@llmcraft/shared";

interface PlanSnapshot {
  tick: number;
  myUnits: Unit[];
  myBuildings: Building[];
  visibleUnits: Array<Unit & { relation: "self" | "enemy" }>;
  visibleBuildings: Array<Building & { relation: "self" | "enemy" }>;
}

interface UnitPlanState {
  unitId: string;
  steps: PlanStep[];
  currentStepIndex: number;
  completedLoops: number;
  waitStartedTick?: number;
  status: AgentPlanRecord["status"];
}

interface InternalPlan {
  record: Omit<AgentPlanRecord, "currentStepIndex" | "status">;
  unitStates: Map<string, UnitPlanState>;
}

interface PlanCommandFactory {
  move(unitId: string, position: Position): Command;
  attackInRange(unitId: string, priority?: Array<"hq" | "soldier" | "worker" | "barracks">): Command;
  hold(unitId: string): Command;
}

export class AgentPlanRuntime {
  private plans = new Map<string, InternalPlan>();
  private commandFactory: PlanCommandFactory;
  private planCounter = 0;

  constructor(commandFactory: PlanCommandFactory) {
    this.commandFactory = commandFactory;
  }

  register(input: OrchestratePlanInput): AgentPlanRecord {
    const loop = input.loop ?? 1;
    if (loop === 0) {
      throw new Error("orchestrate_plan loop cannot be 0");
    }

    const planId = `plan_${++this.planCounter}`;
    const unitStates = new Map<string, UnitPlanState>();
    for (const unitId of input.unitIds) {
      unitStates.set(unitId, {
        unitId,
        steps: structuredClone(input.steps),
        currentStepIndex: 0,
        completedLoops: 0,
        status: "active",
      });
    }

    const internal: InternalPlan = {
      record: {
        planId,
        unitIds: [...input.unitIds],
        loop,
        steps: structuredClone(input.steps),
      },
      unitStates,
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
      const state = plan.unitStates.get(unitId);
      if (state && state.status === "active") {
        state.status = "interrupted";
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
      for (const state of plan.unitStates.values()) {
        if (state.status !== "active") {
          continue;
        }

        const unit = snapshot.myUnits.find((candidate) => candidate.id === state.unitId);
        if (!unit || !unit.exists) {
          state.status = "failed";
          continue;
        }

        const produced = this.advanceUnit(plan.record.loop, state, unit, snapshot);
        commands.push(...produced);
      }
    }
    return commands;
  }

  private advanceUnit(loop: number, state: UnitPlanState, unit: Unit, snapshot: PlanSnapshot): Command[] {
    let guard = 0;
    while (guard < 8) {
      guard++;
      if (state.currentStepIndex >= state.steps.length) {
        if (loop === -1 || state.completedLoops + 1 < loop) {
          state.completedLoops++;
          state.currentStepIndex = 0;
          state.waitStartedTick = undefined;
          continue;
        }
        state.status = "completed";
        return [];
      }

      const step = state.steps[state.currentStepIndex];
      if (!step) {
        state.status = "failed";
        return [];
      }

      switch (step.do) {
        case "move_to": {
          state.waitStartedTick = undefined;
          const target = this.resolveMoveTarget(step, state, unit, snapshot);
          if (unit.x === target.x && unit.y === target.y) {
            state.currentStepIndex++;
            continue;
          }

          if (unit.pathTarget?.x === target.x && unit.pathTarget?.y === target.y) {
            return [];
          }

          return [this.commandFactory.move(unit.id, target)];
        }

        case "attack_in_range": {
          state.currentStepIndex++;
          state.waitStartedTick = undefined;
          return [this.commandFactory.attackInRange(unit.id, step.priority)];
        }

        case "hold_position": {
          state.currentStepIndex++;
          state.waitStartedTick = undefined;
          return [this.commandFactory.hold(unit.id)];
        }

        case "wait_until": {
          if (this.matchesCondition(step.condition, unit, snapshot)) {
            state.currentStepIndex++;
            state.waitStartedTick = undefined;
            continue;
          }

          if (state.waitStartedTick === undefined) {
            state.waitStartedTick = snapshot.tick;
          }

          if (step.maxTicks !== undefined && snapshot.tick - state.waitStartedTick >= step.maxTicks) {
            state.currentStepIndex++;
            state.waitStartedTick = undefined;
            continue;
          }

          return [];
        }

        case "branch": {
          const branchSteps = this.matchesCondition(step.if, unit, snapshot) ? step.then : step.else ?? [];
          state.steps.splice(state.currentStepIndex, 1, ...structuredClone(branchSteps));
          continue;
        }

        case "stop": {
          state.status = "completed";
          return [];
        }

        default: {
          state.status = "failed";
          return [];
        }
      }
    }

    return [];
  }

  private resolveMoveTarget(
    step: Extract<PlanStep, { do: "move_to" }>,
    state: UnitPlanState,
    unit: Unit,
    snapshot: PlanSnapshot
  ): Position {
    if (step.formation !== "spread") {
      return { x: step.x, y: step.y };
    }

    const myHQ = snapshot.myBuildings.find((building) => building.type === "hq");
    const enemyHQ = snapshot.visibleBuildings.find(
      (building) => building.relation === "enemy" && building.type === ("hq" as BuildingType)
    );
    const anchor = enemyHQ ?? myHQ;
    if (!anchor) {
      return { x: step.x, y: step.y };
    }

    const offset = Number.parseInt(state.unitId.replace(/\D+/g, ""), 10) || 0;
    const direction = anchor.x >= unit.x ? -1 : 1;
    return {
      x: step.x + (offset % 2 === 0 ? direction : 0),
      y: step.y + (offset % 2 === 1 ? (offset % 4 === 1 ? 1 : -1) : 0),
    };
  }

  private matchesCondition(condition: PlanCondition, unit: Unit, snapshot: PlanSnapshot): boolean {
    if (typeof condition === "string") {
      switch (condition) {
        case "cargo_full":
          return unit.carryingCredits >= unit.carryCapacity;
        case "cargo_empty":
          return unit.carryingCredits <= 0;
        case "hq_in_range":
          return snapshot.visibleBuildings.some(
            (building) =>
              building.relation === "enemy" &&
              building.type === "hq" &&
              Math.max(Math.abs(unit.x - building.x), Math.abs(unit.y - building.y)) <= unit.attackRange
          );
        case "enemy_in_range":
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
        default:
          return false;
      }
    }

    if ("all" in condition) {
      return condition.all.every((entry) => this.matchesCondition(entry, unit, snapshot));
    }
    if ("any" in condition) {
      return condition.any.some((entry) => this.matchesCondition(entry, unit, snapshot));
    }
    return !this.matchesCondition(condition.not, unit, snapshot);
  }

  private summarizePlan(plan: InternalPlan): AgentPlanRecord {
    const firstState = [...plan.unitStates.values()][0];
    const statuses = [...plan.unitStates.values()].map((state) => state.status);
    const status = statuses.includes("active")
      ? "active"
      : statuses.includes("failed")
        ? "failed"
        : statuses.includes("interrupted")
          ? "interrupted"
          : "completed";

    return {
      ...plan.record,
      currentStepIndex: firstState?.currentStepIndex ?? 0,
      status,
    };
  }
}
