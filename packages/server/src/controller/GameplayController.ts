import {
  AgentMapState,
  AgentMapStateBuilding,
  AgentMapStateCell,
  AgentMapStateResource,
  AgentMapStateUnit,
  AgentPlanWaitingDiagnostic,
  AgentUnitGroup,
  AgentPlanRecord,
  AttackTargetType,
  BUILDING_TYPES,
  Building,
  BuildingType,
  Command,
  CommandProvenance,
  ECONOMY_RULES,
  OrchestratePlanInput,
  PlanCallToolName,
  PlanStep,
  PlanStepScope,
  PlayerId,
  Position,
  LOG_TYPES,
  RESULT_TYPES,
  TILE_TYPES,
  UNIT_TYPES,
  Unit,
  UnitType,
  UnitIntent,
  canBuildingProduce,
  getDefaultAttackMovePriority,
  getBuildingCost,
  getBuildingConstructionTicks,
  getBuildingFootprintCells,
  getDistanceToBuildingFootprint,
  getProducerBuildingType,
  getUnitCost,
  getProductionOptions,
  isBuildableBuildingType,
  isBuildingType,
  isUnitType,
  unitCanAttack,
} from "@llmcraft/shared";
import { AgentReadState, Game } from "../Game";
import { PlanToolContext, PlanToolHandlers } from "../agent/AgentPlanRuntime";
import { MissionRuntime } from "../agent/MissionRuntime";
import type { AgentToolExecutionContext } from "../LLMProvider";
import { ObservationProjection } from "../agent/ObservationProjection";
import { AgentPolicy } from "../agent/AgentPolicy";

type ToolEffect = "read" | "action" | "plan";
export interface ExecutedToolResult {
  effect: ToolEffect;
  result: unknown;
}

export interface GameplayControllerOptions {
  submitCommands?: (
    commands: readonly Command[],
    options?: { clientRequestId?: string },
  ) => void | { duplicate: boolean };
}

interface SuggestedBuildSite extends Position {
  workerPosition: Position;
  estimatedRouteSaving?: number;
  nearbyResources?: Array<{
    x: number;
    y: number;
    remaining: number;
    assignedHarvesters: number;
    currentDeliveryDistance: number;
    newDeliveryDistance: number;
  }>;
}

interface BuildOccupancyIndex {
  unitIdsByCell: Map<string, string[]>;
  buildingCells: Set<string>;
}

const PLAN_CALL_TOOL_NAMES = [
  "move_unit",
  "attack_move_unit",
  "attack",
  "spawn_unit",
  "build_structure",
  "start_harvest_loop",
  "hold_unit",
] as const satisfies readonly PlanCallToolName[];
const PLAN_UNTIL_CONDITIONS = [
  "arrived",
  "enemy_in_range",
  "hq_in_range",
  "near_position",
  "worker_adjacent_to_build_footprint",
  "target_in_range",
  "target_destroyed",
  "credits_at_least",
  "building_exists",
  "enemy_building_exists",
  "unit_count_at_least",
  "enemy_unit_count_at_least",
  "production_queue_empty",
] as const;

type AttackOrderResolution =
  | { ok: true; command: Command; mode: "attack" | "move_to_target"; completedAfterCommand: boolean }
  | { ok: false; error: string; hint: string };

const isBuildingComplete = (building: Building): boolean => building.exists && !building.constructionProgress;

/**
 * The shared gameplay control plane used by LLM, CLI, and built-in CPU adapters.
 *
 * It translates observations and tool-shaped actions into game commands. Match
 * lifecycle control (warmup/start/stop/observe) belongs to MatchRuntime and
 * MatchRegistry, not to this class.
 */
export class GameplayController {
  private issuedCommands: Command[] = [];
  private runPlanRecords: AgentPlanRecord[] = [];
  private commandCounter = 0;
  private lastReadTick: number | null = null;
  private readonly observationProjection: ObservationProjection;
  private readonly policy = new AgentPolicy();
  private missionRuntime: MissionRuntime;
  private commandProvenance: CommandProvenance | null = null;
  private readonly planToolHandlers: PlanToolHandlers;
  private attackOrders = new Map<string, { unitId: string; targetId: string }>();
  private consumedMissionFailureKeys = new Set<string>();
  private readonly submitCommands: NonNullable<GameplayControllerOptions["submitCommands"]>;
  private readonly completedCommandBatches = new Map<string, {
    fingerprint: string;
    value: unknown;
  }>();
  private readonly pendingBuildResumeOrders = new Map<string, UnitIntent>();
  private readonly knownEnemyTargetIds = new Set<string>();

  constructor(
    private readonly game: Game,
    private readonly playerId: PlayerId,
    options: GameplayControllerOptions = {},
  ) {
    this.submitCommands = options.submitCommands ?? ((commands) => {
      for (const command of commands) this.game.queueCommand(command);
      return { duplicate: false };
    });
    this.planToolHandlers = this.createPlanToolHandlers();
    this.missionRuntime = new MissionRuntime(this.planToolHandlers);
    this.observationProjection = new ObservationProjection(game);
  }

  beginRun(provenance?: CommandProvenance): void {
    this.issuedCommands = [];
    this.runPlanRecords = [];
    this.lastReadTick = null;
    this.observationProjection.invalidate();
    this.commandProvenance = provenance ? structuredClone(provenance) : null;
  }

  beginToolCall(provenance?: CommandProvenance): void {
    this.issuedCommands = [];
    this.runPlanRecords = [];
    this.observationProjection.invalidate();
    this.commandProvenance = provenance ? structuredClone(provenance) : null;
  }

  setCommandProvenance(context: AgentToolExecutionContext): void {
    this.commandProvenance = {
      controllerId: context.controllerId ?? `llm:${this.playerId}`,
      source: context.source ?? "macro_tool",
      ...(context.turnId ? { turnId: context.turnId } : {}),
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      ...(context.parentControllerId ? { parentControllerId: context.parentControllerId } : {}),
    };
  }

  runIdempotentBatch<T>(
    options: { clientRequestId?: string; fingerprint?: string },
    execute: () => T,
  ): { value: T; duplicate: boolean } {
    const completed = options.clientRequestId
      ? this.completedCommandBatches.get(options.clientRequestId)
      : undefined;
    if (completed) {
      if (completed.fingerprint !== (options.fingerprint ?? "")) {
        throw new Error(`clientRequestId ${options.clientRequestId} was already used for a different action batch.`);
      }
      return { value: structuredClone(completed.value) as T, duplicate: true };
    }
    const value = execute();
    if (options.clientRequestId) {
      this.completedCommandBatches.set(options.clientRequestId, {
        fingerprint: options.fingerprint ?? "",
        value: structuredClone(value),
      });
    }
    return { value, duplicate: false };
  }

  takeIssuedCommands(): Command[] {
    const commands = [...this.issuedCommands];
    this.issuedCommands = [];
    return commands;
  }

  takeRunPlans(): AgentPlanRecord[] {
    const plans = [...this.runPlanRecords];
    this.runPlanRecords = [];
    return plans;
  }

  handleCommittedTick(): Command[] {
    this.observationProjection.invalidate();
    this.consumeMissionCommandFailures();
    const missionCommands = this.missionRuntime.advance(this.getPlanSnapshot());
    const previousProvenance = this.commandProvenance;
    this.commandProvenance = {
      controllerId: previousProvenance?.controllerId ?? `mission:${this.playerId}`,
      source: "tactical",
      ...(previousProvenance?.turnId ? { turnId: previousProvenance.turnId } : {}),
      ...(previousProvenance?.parentControllerId
        ? { parentControllerId: previousProvenance.parentControllerId }
        : {}),
    };
    const tacticalCommands = this.advanceAttackOrders();
    this.commandProvenance = previousProvenance;
    return [...missionCommands, ...tacticalCommands];
  }

  getActivePlans(): AgentPlanRecord[] {
    return this.missionRuntime.getActivePlans();
  }

  private getReadState(): AgentReadState {
    const state = this.observationProjection.read();
    for (const player of state.players) {
      if (player.id === this.playerId) continue;
      for (const candidate of [...player.units, ...player.buildings]) {
        if (candidate.exists) this.knownEnemyTargetIds.add(candidate.id);
      }
    }
    return state;
  }

  getMapState(args?: { includeCells?: boolean; includeEmptyTiles?: boolean; trackRead?: boolean }): ExecutedToolResult {
    const state = this.getReadState();
    this.trackRead(state.tick, args?.trackRead);
    const includeCells = args?.includeCells === true || args?.includeEmptyTiles === true;
    const includeEmptyTiles = args?.includeEmptyTiles === true;
    const cells = new Map<string, AgentMapStateCell>();
    const units: AgentMapStateUnit[] = [];
    const buildings: AgentMapStateBuilding[] = [];
    const resources: AgentMapStateResource[] = [];
    const getOrCreateCell = (x: number, y: number): AgentMapStateCell => {
      const key = `${x},${y}`;
      const existing = cells.get(key);
      if (existing) {
        return existing;
      }
      const tile = state.tiles[y]?.[x];
      const created: AgentMapStateCell = {
        x,
        y,
        tile: tile?.type ?? "empty",
        ...(tile?.resourceRemaining !== undefined
          ? { resourceRemaining: tile.resourceRemaining }
          : {}),
      };
      cells.set(key, created);
      return created;
    };

    if (includeCells) {
      for (const row of state.tiles) {
        for (const tile of row) {
          if (includeEmptyTiles || tile.type !== "empty") {
            getOrCreateCell(tile.x, tile.y);
          }
        }
      }
    }

    for (const row of state.tiles) {
      for (const tile of row) {
        if (tile.type === TILE_TYPES.RESOURCE) {
          resources.push({
            x: tile.x,
            y: tile.y,
            remaining: tile.resourceRemaining ?? 0,
          });
        }
      }
    }

    for (const player of state.players) {
      const relation = player.id === this.playerId ? "self" : "enemy";
      for (const unit of player.units.filter((candidate) => candidate.exists)) {
        const mapUnit = {
          id: unit.id,
          type: unit.type,
          x: unit.x,
          y: unit.y,
          hp: unit.hp,
          maxHp: unit.maxHp,
          state: unit.state,
          relation,
        } satisfies AgentMapStateUnit;
        units.push(mapUnit);
        if (includeCells) {
          const cell = getOrCreateCell(unit.x, unit.y);
          cell.unit = mapUnit;
        }
      }
      for (const building of player.buildings.filter((candidate) => candidate.exists)) {
        const mapBuilding = {
          id: building.id,
          type: building.type,
          x: building.x,
          y: building.y,
          hp: building.hp,
          maxHp: building.maxHp,
          relation,
          constructionProgress: building.constructionProgress,
        } satisfies AgentMapStateBuilding;
        buildings.push(mapBuilding);
        if (includeCells) {
          const cell = getOrCreateCell(building.x, building.y);
          cell.building = mapBuilding;
        }
      }
    }

    const result: AgentMapState = {
      tick: state.tick,
      width: state.tiles[0]?.length ?? 0,
      height: state.tiles.length,
      units,
      buildings,
      resources,
    };
    if (includeCells) {
      result.cells = Array.from(cells.values());
    }
    return {
      effect: "read",
      result,
    };
  }

  private createPlanToolHandlers(): PlanToolHandlers {
    return {
      move_unit: {
        defaultScope: "per_unit",
        validateArgs: (args) => this.hasOptionalPlanUnitId(args) && Number.isInteger(args.x) && Number.isInteger(args.y),
        createCommand: (context) => {
          const unitId = this.resolvePlanUnitId(context);
          if (context.unit?.state === "moving" && context.unit.intent?.type === "move") {
            return null;
          }
          return unitId && Number.isInteger(context.args.x) && Number.isInteger(context.args.y)
            ? this.createCommand("move", { unitId, position: { x: Number(context.args.x), y: Number(context.args.y) } })
            : null;
        },
        diagnoseWait: (context) => this.diagnosePlanWait("move_unit", context),
      },
      attack_move_unit: {
        defaultScope: "per_unit",
        validateArgs: (args) =>
          this.hasOptionalPlanUnitId(args) && Number.isInteger(args.x) && Number.isInteger(args.y) && this.isOptionalTargetPriority(args.priority),
        createCommand: (context) => {
          const unitId = this.resolvePlanUnitId(context);
          if (!unitId || !Number.isInteger(context.args.x) || !Number.isInteger(context.args.y)) {
            return null;
          }
          if (context.unit?.intent?.type === "attack_move") {
            return null;
          }
          return this.createCommand("attack_move", {
            unitId,
            position: { x: Number(context.args.x), y: Number(context.args.y) },
            targetPriority: this.resolveTargetPriority(context.args.priority),
          });
        },
        diagnoseWait: (context) => this.diagnosePlanWait("attack_move_unit", context),
      },
      attack: {
        defaultScope: "per_unit",
        defaultRetry: true,
        validateArgs: (args) => this.hasOptionalPlanUnitId(args) && typeof args.targetId === "string",
        createCommand: (context) => {
          const unitId = this.resolvePlanUnitId(context);
          if (!unitId || typeof context.args.targetId !== "string") {
            return null;
          }
          if (
            context.unit?.intent?.type === "attack"
            && context.unit.intent.targetId === context.args.targetId
          ) {
            return null;
          }
          if (context.unit?.state === "moving" && context.unit.intent?.type === "move") {
            return null;
          }
          const resolution = this.resolveAttackOrderCommand(unitId, context.args.targetId);
          if (resolution.ok && resolution.mode === "attack" && this.isAttackReloading(context.unit)) {
            return null;
          }
          return resolution.ok ? resolution.command : null;
        },
        diagnoseWait: (context) => this.diagnosePlanWait("attack", context),
      },
      spawn_unit: {
        defaultScope: "global",
        defaultRetry: true,
        validateArgs: (args) =>
          (args.buildingId === undefined || typeof args.buildingId === "string") &&
          (args.buildingType === undefined || isBuildingType(args.buildingType)) &&
          isUnitType(args.unitType),
        estimateCost: (context) => isUnitType(context.args.unitType) ? getUnitCost(context.args.unitType) : 0,
        createCommand: (context) => {
          const unitType = context.args.unitType;
          if (!isUnitType(unitType)) {
            return null;
          }
          const fallbackType = getProducerBuildingType(unitType);
          if (!fallbackType) {
            return null;
          }
          if (context.snapshot.myCredits < getUnitCost(unitType)) {
            return null;
          }
          const buildingId = this.resolvePlanBuildingId(context, fallbackType);
          const building = context.snapshot.myBuildings.find((candidate) => candidate.id === buildingId);
          if (!building || building.productionQueue.length > 0) {
            return null;
          }
          return this.createCommand("spawn", { buildingId: building.id, unitType });
        },
        diagnoseWait: (context) => this.diagnosePlanWait("spawn_unit", context),
      },
      build_structure: {
        defaultScope: "global",
        defaultRetry: true,
        validateArgs: (args) =>
          this.hasOptionalPlanUnitId(args) &&
          isBuildableBuildingType(args.buildingType) &&
          Number.isInteger(args.x) &&
          Number.isInteger(args.y),
        estimateCost: (context) => isBuildableBuildingType(context.args.buildingType) ? getBuildingCost(context.args.buildingType) : 0,
        createCommand: (context) => {
          const unitId = this.resolvePlanUnitId(context);
          if (!isBuildableBuildingType(context.args.buildingType) || context.snapshot.myCredits < getBuildingCost(context.args.buildingType)) {
            return null;
          }
          const worker = context.snapshot.myUnits.find((unit) => unit.id === unitId && unit.exists && unit.type === UNIT_TYPES.WORKER);
          const position = { x: Number(context.args.x), y: Number(context.args.y) };
          if (
            !worker ||
            worker.constructingBuildingId ||
            (context.args.buildingType === BUILDING_TYPES.WAR_FACTORY &&
              !context.snapshot.myBuildings.some((building) => building.type === BUILDING_TYPES.BARRACKS && isBuildingComplete(building))) ||
            !Number.isInteger(position.x) ||
            !Number.isInteger(position.y) ||
            !this.isWorkerAdjacentToBuildFootprint(worker, context.args.buildingType, position)
          ) {
            return null;
          }
          return unitId && isBuildableBuildingType(context.args.buildingType) && Number.isInteger(context.args.x) && Number.isInteger(context.args.y)
            ? this.createCommand("build", {
                unitId,
                buildingType: context.args.buildingType,
                position,
                resumeWorkerOrder: this.pendingBuildResumeOrders.get(unitId),
              })
            : null;
        },
        diagnoseWait: (context) => this.diagnosePlanWait("build_structure", context),
      },
      start_harvest_loop: {
        defaultScope: "per_unit",
        validateArgs: (args) =>
          this.hasOptionalPlanUnitId(args) &&
          ((args.x === undefined && args.y === undefined) || (Number.isInteger(args.x) && Number.isInteger(args.y))),
        createCommand: (context) => {
          const unitId = this.resolvePlanUnitId(context);
          if (!unitId) {
            return null;
          }
          const hasPosition = Number.isInteger(context.args.x) && Number.isInteger(context.args.y);
          return this.createCommand("harvest_loop", {
            unitId,
            position: hasPosition ? { x: Number(context.args.x), y: Number(context.args.y) } : undefined,
          });
        },
        diagnoseWait: (context) => this.diagnosePlanWait("start_harvest_loop", context),
      },
      hold_unit: {
        defaultScope: "per_unit",
        validateArgs: (args) => this.hasOptionalPlanUnitId(args),
        createCommand: (context) => {
          const unitId = this.resolvePlanUnitId(context);
          return unitId ? this.createCommand("hold", { unitId }) : null;
        },
        diagnoseWait: (context) => this.diagnosePlanWait("hold_unit", context),
      },
    };
  }

  private diagnosePlanWait(call: PlanCallToolName, context: PlanToolContext): AgentPlanWaitingDiagnostic {
    const unitId = this.resolvePlanUnitId(context);
    const unit = unitId
      ? context.snapshot.myUnits.find((candidate) => candidate.id === unitId && candidate.exists)
      : undefined;
    const unitDetails = unitId ? { unitId } : undefined;

    if (["move_unit", "attack_move_unit", "attack", "start_harvest_loop", "hold_unit"].includes(call) && !unit) {
      return {
        code: "assigned_unit_missing",
        message: `Assigned unit ${unitId ?? "(unresolved)"} is not alive or does not exist.`,
        details: unitDetails,
      };
    }

    if (call === "move_unit") {
      if (unit?.state === "moving" && unit.intent?.type === "move") {
        return {
          code: "unit_moving",
          message: `Unit ${unit.id} is already moving; the plan is active and does not need replacement.`,
          details: { unitId: unit.id, intent: unit.intent },
        };
      }
    }

    if (call === "attack_move_unit" && unit?.intent?.type === "attack_move") {
      return {
        code: "same_order_active",
        message: `Unit ${unit.id} is already executing an attack-move order; the plan is active and does not need replacement.`,
        details: { unitId: unit.id, intent: unit.intent },
      };
    }

    if (call === "attack") {
      const targetId = typeof context.args.targetId === "string" ? context.args.targetId : undefined;
      if (unit?.intent?.type === "attack" && unit.intent.targetId === targetId) {
        return {
          code: "same_order_active",
          message: `Unit ${unit.id} is already attacking ${targetId}; the plan is active and does not need replacement.`,
          details: { unitId: unit.id, targetId },
        };
      }
      if (unit?.state === "moving" && unit.intent?.type === "move") {
        return {
          code: "unit_moving_to_target",
          message: `Unit ${unit.id} is moving into range of ${targetId}; the plan is active and does not need replacement.`,
          details: { unitId: unit.id, targetId, intent: unit.intent },
        };
      }
      const targetExists = [...context.snapshot.visibleUnits, ...context.snapshot.visibleBuildings]
        .some((candidate) => candidate.relation === "enemy" && candidate.id === targetId);
      if (!targetExists) {
        return {
          code: "target_missing",
          message: `No living enemy target matches ${targetId ?? "the requested target ID"}.`,
          details: { targetId },
        };
      }
      if (unit && this.isAttackReloading(unit)) {
        return {
          code: "attack_reloading",
          message: `Unit ${unit.id} is reloading and can attack again at tick ${unit.nextAttackTick}.`,
          details: { unitId: unit.id, readyTick: unit.nextAttackTick },
        };
      }
    }

    if (call === "spawn_unit") {
      const unitType = context.args.unitType;
      const fallbackType = isUnitType(unitType) ? getProducerBuildingType(unitType) : null;
      const buildingId = fallbackType ? this.resolvePlanBuildingId(context, fallbackType) : null;
      const building = context.snapshot.myBuildings.find((candidate) => candidate.id === buildingId);
      if (!building) {
        return {
          code: "producer_missing",
          message: `No completed production building is available for ${String(unitType)}.`,
          details: { unitType, requiredBuildingType: fallbackType },
        };
      }
      if (building.productionQueue.length > 0) {
        return {
          code: "production_queue_busy",
          message: `Production building ${building.id} is busy.`,
          details: { buildingId: building.id, productionQueue: building.productionQueue },
        };
      }
    }

    if (call === "build_structure") {
      const worker = unitId
        ? context.snapshot.myUnits.find((candidate) => candidate.id === unitId && candidate.exists && candidate.type === UNIT_TYPES.WORKER)
        : undefined;
      const buildingType = context.args.buildingType;
      const position = { x: Number(context.args.x), y: Number(context.args.y) };
      if (!worker) {
        return {
          code: "builder_missing",
          message: `Assigned builder ${unitId ?? "(unresolved)"} is not a living worker.`,
          details: unitDetails,
        };
      }
      if (worker.constructingBuildingId) {
        return {
          code: "worker_busy",
          message: `Worker ${worker.id} is already constructing ${worker.constructingBuildingId}.`,
          details: { workerId: worker.id, constructingBuildingId: worker.constructingBuildingId },
        };
      }
      if (
        buildingType === BUILDING_TYPES.WAR_FACTORY &&
        !context.snapshot.myBuildings.some((building) => building.type === BUILDING_TYPES.BARRACKS && isBuildingComplete(building))
      ) {
        return {
          code: "missing_prerequisite",
          message: "A completed barracks is required before building a war factory.",
          details: { buildingType, requiredBuildingType: BUILDING_TYPES.BARRACKS },
        };
      }
      if (isBuildableBuildingType(buildingType) && !this.isWorkerAdjacentToBuildFootprint(worker, buildingType, position)) {
        return {
          code: "worker_not_adjacent",
          message: `Worker ${worker.id} has not reached the ${buildingType} footprint yet; the plan is active and does not need replacement.`,
          details: {
            workerId: worker.id,
            workerPosition: { x: worker.x, y: worker.y },
            buildingPosition: position,
          },
        };
      }
    }

    return {
      code: "command_unavailable",
      message: `The ${call} command cannot be created from the current state and arguments.`,
      details: { ...unitDetails, args: context.args },
    };
  }

  private hasOptionalPlanUnitId(args: Record<string, unknown>): boolean {
    return args.unitId === undefined || args.unitId === "$unitId" || typeof args.unitId === "string";
  }

  private resolvePlanUnitId(context: PlanToolContext): string | null {
    const requested = context.args.unitId;
    if (typeof requested === "string" && requested !== "$unitId") {
      return requested;
    }
    if (context.unit) {
      return context.unit.id;
    }
    return context.planUnitIds.find((unitId) => context.snapshot.myUnits.some((unit) => unit.id === unitId && unit.exists)) ?? null;
  }

  private resolvePlanBuildingId(context: PlanToolContext, fallbackType: BuildingType): string | null {
    const requested = context.args.buildingId;
    if (typeof requested === "string" && !requested.startsWith("$")) {
      return requested;
    }
    const placeholderType = this.resolveBuildingPlaceholder(requested);
    const type = placeholderType ?? (isBuildingType(context.args.buildingType) ? context.args.buildingType : fallbackType);
    return context.snapshot.myBuildings.find((building) => building.type === type && isBuildingComplete(building))?.id ?? null;
  }

  private resolveBuildingPlaceholder(value: unknown): BuildingType | null {
    if (value === "$hq") {
      return BUILDING_TYPES.HQ;
    }
    if (value === "$barracks") {
      return BUILDING_TYPES.BARRACKS;
    }
    if (value === "$war_factory") {
      return BUILDING_TYPES.WAR_FACTORY;
    }
    if (value === "$refinery") {
      return BUILDING_TYPES.REFINERY;
    }
    return null;
  }

  private resolveTargetPriority(value: unknown): AttackTargetType[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const priority = value.filter((entry): entry is AttackTargetType => isUnitType(entry) || isBuildingType(entry));
    return priority.length > 0 ? priority : undefined;
  }

  getMyState(args?: { trackRead?: boolean }): ExecutedToolResult {
    const state = this.getReadState();
    this.trackRead(state.tick, args?.trackRead);
    const me = state.players.find((player) => player.id === this.playerId)!;
    const enemies = state.players.filter((player) => player.id !== this.playerId);
    const myBuildings = me.buildings.filter((building) => building.exists);
    const completedMyBuildings = myBuildings.filter(isBuildingComplete);
    const myUnits = me.units.filter((unit) => unit.exists);
    const enemyBuildings = enemies.flatMap((player) => player.buildings.filter((building) => building.exists));
    const enemyUnits = enemies.flatMap((player) => player.units.filter((unit) => unit.exists));
    const hq = completedMyBuildings.find((building) => building.type === BUILDING_TYPES.HQ) ?? null;
    const countUnits = (unitType: UnitType) => myUnits.filter((unit) => unit.type === unitType).length;
    const countBuildings = (buildingType: BuildingType) => completedMyBuildings.filter((building) => building.type === buildingType).length;
    const hasBarracks = countBuildings(BUILDING_TYPES.BARRACKS) > 0;
    const enemyHasWarFactory = enemyBuildings.some((building) => building.type === BUILDING_TYPES.WAR_FACTORY);
    const enemyVehicleCount = enemyUnits.filter((unit) => unit.type === UNIT_TYPES.LIGHT_TANK).length;
    const enemyRocketCount = enemyUnits.filter((unit) => unit.type === UNIT_TYPES.ROCKET_SOLDIER).length;
    const workers = myUnits.filter((unit) => unit.type === UNIT_TYPES.WORKER);
    const activeHarvesters = workers.filter((unit) => unit.intent?.type === "harvest_loop");
    const idleWorkers = workers.filter((unit) => unit.state === "idle" && unit.intent?.type !== "harvest_loop");
    const resourceAssignments = state.tiles
      .flat()
      .filter((tile) => tile.type === TILE_TYPES.RESOURCE)
      .map((tile) => {
        const assignedHarvesters = activeHarvesters.filter((unit) =>
          unit.intent?.type === "harvest_loop" &&
          unit.intent.targetX === tile.x &&
          unit.intent.targetY === tile.y
        ).length;
        const distanceToHq = hq ? Math.max(Math.abs(tile.x - hq.x), Math.abs(tile.y - hq.y)) : null;
        return {
          x: tile.x,
          y: tile.y,
          assignedHarvesters,
          distanceToHq,
        };
      })
      .sort((a, b) => {
        if (a.assignedHarvesters !== b.assignedHarvesters) {
          return b.assignedHarvesters - a.assignedHarvesters;
        }
        const aDistance = a.distanceToHq ?? Number.POSITIVE_INFINITY;
        const bDistance = b.distanceToHq ?? Number.POSITIVE_INFINITY;
        if (aDistance !== bDistance) {
          return aDistance - bDistance;
        }
        return a.y - b.y || a.x - b.x;
      });
    const availableBuilders = workers.filter((worker) => !worker.constructingBuildingId);
    const buildOptions = [
      BUILDING_TYPES.BARRACKS,
      BUILDING_TYPES.WAR_FACTORY,
      BUILDING_TYPES.REFINERY,
    ].map((buildingType) => {
      const prerequisiteMet = buildingType !== BUILDING_TYPES.WAR_FACTORY || hasBarracks;
      const cost = getBuildingCost(buildingType);
      return {
        buildingType,
        cost,
        constructionTicks: getBuildingConstructionTicks(buildingType),
        prerequisiteMet,
        affordable: me.resources.credits >= cost,
        availableBuilderIds: availableBuilders.map((worker) => worker.id),
      };
    });
    return {
      effect: "read",
      result: {
        tick: state.tick,
        credits: me.resources.credits,
        hq,
        buildings: myBuildings,
        productionQueues: myBuildings
          .map((building) => ({ buildingId: building.id, queue: building.productionQueue, progress: building.productionProgress ?? null })),
        canBuildBarracks: me.resources.credits >= getBuildingCost(BUILDING_TYPES.BARRACKS),
        canBuildWarFactory: hasBarracks && me.resources.credits >= getBuildingCost(BUILDING_TYPES.WAR_FACTORY),
        canBuildRefinery: me.resources.credits >= getBuildingCost(BUILDING_TYPES.REFINERY),
        canSpawnWorker: me.resources.credits >= getUnitCost(UNIT_TYPES.WORKER),
        canSpawnSoldier: me.resources.credits >= getUnitCost(UNIT_TYPES.SOLDIER),
        canSpawnRifleman: me.resources.credits >= getUnitCost(UNIT_TYPES.RIFLEMAN),
        canSpawnRocketSoldier: me.resources.credits >= getUnitCost(UNIT_TYPES.ROCKET_SOLDIER),
        canSpawnLightTank: me.resources.credits >= getUnitCost(UNIT_TYPES.LIGHT_TANK),
        economyStatus: {
          workers: workers.length,
          activeHarvesters: activeHarvesters.length,
          idleWorkers: idleWorkers.length,
          carryingCredits: workers.reduce((sum, unit) => sum + unit.carryingCredits, 0),
          resourceAssignments,
        },
        unitCosts: {
          [UNIT_TYPES.WORKER]: getUnitCost(UNIT_TYPES.WORKER),
          [UNIT_TYPES.SOLDIER]: getUnitCost(UNIT_TYPES.SOLDIER),
          [UNIT_TYPES.RIFLEMAN]: getUnitCost(UNIT_TYPES.RIFLEMAN),
          [UNIT_TYPES.ROCKET_SOLDIER]: getUnitCost(UNIT_TYPES.ROCKET_SOLDIER),
          [UNIT_TYPES.LIGHT_TANK]: getUnitCost(UNIT_TYPES.LIGHT_TANK),
        },
        buildingCosts: {
          [BUILDING_TYPES.BARRACKS]: getBuildingCost(BUILDING_TYPES.BARRACKS),
          [BUILDING_TYPES.WAR_FACTORY]: getBuildingCost(BUILDING_TYPES.WAR_FACTORY),
          [BUILDING_TYPES.REFINERY]: getBuildingCost(BUILDING_TYPES.REFINERY),
        },
        buildingConstructionTicks: {
          [BUILDING_TYPES.BARRACKS]: getBuildingConstructionTicks(BUILDING_TYPES.BARRACKS),
          [BUILDING_TYPES.WAR_FACTORY]: getBuildingConstructionTicks(BUILDING_TYPES.WAR_FACTORY),
          [BUILDING_TYPES.REFINERY]: getBuildingConstructionTicks(BUILDING_TYPES.REFINERY),
        },
        buildOptions,
        techStatus: {
          own: {
            workers: countUnits(UNIT_TYPES.WORKER),
            combatUnits:
              countUnits(UNIT_TYPES.SOLDIER) +
              countUnits(UNIT_TYPES.RIFLEMAN) +
              countUnits(UNIT_TYPES.ROCKET_SOLDIER) +
              countUnits(UNIT_TYPES.LIGHT_TANK),
            riflemen: countUnits(UNIT_TYPES.RIFLEMAN),
            rocketSoldiers: countUnits(UNIT_TYPES.ROCKET_SOLDIER),
            lightTanks: countUnits(UNIT_TYPES.LIGHT_TANK),
            barracks: countBuildings(BUILDING_TYPES.BARRACKS),
            warFactories: countBuildings(BUILDING_TYPES.WAR_FACTORY),
            refineries: countBuildings(BUILDING_TYPES.REFINERY),
          },
          enemy: {
            hasWarFactory: enemyHasWarFactory,
            lightTanks: enemyVehicleCount,
            rocketSoldiers: enemyRocketCount,
          },
        },
      },
    };
  }

  getMyUnits(args?: { trackRead?: boolean }): ExecutedToolResult {
    const state = this.getReadState();
    this.trackRead(state.tick, args?.trackRead);
    const me = state.players.find((player) => player.id === this.playerId)!;
    const plannedUnitIds = new Set(this.missionRuntime.getActivePlans().flatMap((plan) => plan.unitIds));
    const units = me.units
      .filter((unit) => unit.exists)
      .map((unit) => ({
        ...unit,
        hasActivePlan: plannedUnitIds.has(unit.id),
      }));
    const groupMap = new Map<string, AgentUnitGroup & { xSum: number; ySum: number }>();
    for (const unit of units) {
      const role = unitCanAttack(unit.type) ? "combat" : "worker";
      const intent = unit.intent?.type ?? "none";
      const key = `${role}:${intent}`;
      const group = groupMap.get(key) ?? {
        role,
        intent,
        count: 0,
        unitIds: [],
        types: {},
        hasActivePlanCount: 0,
        xSum: 0,
        ySum: 0,
      };
      group.count += 1;
      group.unitIds.push(unit.id);
      group.types[unit.type] = (group.types[unit.type] ?? 0) + 1;
      group.hasActivePlanCount += unit.hasActivePlan ? 1 : 0;
      group.xSum += unit.x;
      group.ySum += unit.y;
      groupMap.set(key, group);
    }
    const groups = [...groupMap.values()]
      .map(({ xSum, ySum, ...group }) => ({
        ...group,
        center: {
          x: Math.round(xSum / Math.max(1, group.count)),
          y: Math.round(ySum / Math.max(1, group.count)),
        },
      }))
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === "combat" ? -1 : 1;
        if (b.count !== a.count) return b.count - a.count;
        return a.intent.localeCompare(b.intent);
      });
    return {
      effect: "read",
      result: {
        tick: state.tick,
        groups,
        units,
      },
    };
  }

  getRecentEvents(args?: { trackRead?: boolean }): ExecutedToolResult {
    const tick = this.game.getTick();
    this.trackRead(tick, args?.trackRead);
    return {
      effect: "read",
      result: {
        tick,
        events: this.game.getAIFeedback(this.playerId).slice(-20),
      },
    };
  }

  getArmySummary(args?: { trackRead?: boolean }): ExecutedToolResult {
    const state = this.getReadState();
    this.trackRead(state.tick, args?.trackRead);
    const me = state.players.find((player) => player.id === this.playerId)!;
    const enemies = state.players.filter((player) => player.id !== this.playerId);
    const countByType = (units: typeof me.units) =>
      units
        .filter((unit) => unit.exists)
        .reduce<Record<UnitType, number>>((counts, unit) => {
          counts[unit.type] = (counts[unit.type] ?? 0) + 1;
          return counts;
        }, {
          [UNIT_TYPES.WORKER]: 0,
          [UNIT_TYPES.SOLDIER]: 0,
          [UNIT_TYPES.RIFLEMAN]: 0,
          [UNIT_TYPES.ROCKET_SOLDIER]: 0,
          [UNIT_TYPES.LIGHT_TANK]: 0,
        });
    const myUnits = me.units.filter((unit) => unit.exists);
    const enemyUnits = enemies.flatMap((player) => player.units.filter((unit) => unit.exists));
    const combatUnits = myUnits.filter((unit) => unitCanAttack(unit.type));
    const readyCombatUnits = combatUnits.filter((unit) => unit.nextAttackTick === undefined || unit.nextAttackTick <= state.tick);
    const reloadingCombatUnits = combatUnits.filter((unit) => unit.nextAttackTick !== undefined && unit.nextAttackTick > state.tick);
    const myCounts = countByType(myUnits);
    const enemyCounts = countByType(enemyUnits);
    const attackGroup = this.getLargestUnitCluster(combatUnits);
    return {
      effect: "read",
      result: {
        tick: state.tick,
        myCounts,
        enemyCounts,
        combatUnits: combatUnits.length,
        readyCombatUnits: readyCombatUnits.length,
        reloadingCombatUnits: reloadingCombatUnits.length,
        groupedCombatUnits: attackGroup.length,
        largestGroupUnitIds: attackGroup.map((unit) => unit.id),
      },
    };
  }

  getActivePlansTool(args?: { trackRead?: boolean }): ExecutedToolResult {
    const state = this.getReadState();
    this.trackRead(state.tick, args?.trackRead);
    return {
      effect: "read",
      result: {
        tick: state.tick,
        plans: this.getActivePlans(),
      },
    };
  }

  moveUnit(unitId: string, position: Position): ExecutedToolResult {
    const state = this.getReadState();
    const unit = this.getFriendlyUnit(unitId);
    if (!unit) {
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "No living friendly unit matches this unitId; use one of availableFriendlyUnits.",
        availableFriendlyUnits: this.getFriendlyUnitOptions(state),
      });
    }
    if (
      !Number.isInteger(position.x) ||
      !Number.isInteger(position.y) ||
      position.y < 0 ||
      position.y >= state.tiles.length ||
      position.x < 0 ||
      position.x >= (state.tiles[position.y]?.length ?? 0)
    ) {
      return this.actionResult({
        ok: false,
        error: "invalid_position",
        hint: "Choose a target tile inside the map bounds.",
      });
    }

    this.missionRuntime.interruptUnit(unitId);
    this.attackOrders.delete(unitId);
    const command = this.enqueue(this.createCommand("move", { unitId, position }));
    return {
      effect: "action",
      result: this.withActionMetadata({
        ok: true,
        commandId: command.id,
      }),
    };
  }

  attackMoveUnit(unitId: string, position: Position, targetPriority?: AttackTargetType[]): ExecutedToolResult {
    const state = this.getReadState();
    const unit = this.getFriendlyUnit(unitId);
    if (!unit) {
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "No living friendly unit matches this unitId; use one of availableAttackers.",
        availableAttackers: this.getFriendlyUnitOptions(state, (candidate) => unitCanAttack(candidate.type)),
      });
    }

    if (!unitCanAttack(unit.type)) {
      return this.actionResult({
        ok: false,
        error: "invalid_attacker",
        hint: "This unit cannot attack; use one of availableAttackers.",
        availableAttackers: this.getFriendlyUnitOptions(state, (candidate) => unitCanAttack(candidate.type)),
      });
    }

    if (
      !Number.isInteger(position.x) ||
      !Number.isInteger(position.y) ||
      position.y < 0 ||
      position.y >= state.tiles.length ||
      position.x < 0 ||
      position.x >= (state.tiles[position.y]?.length ?? 0)
    ) {
      return this.actionResult({
        ok: false,
        error: "invalid_position",
        hint: "Choose a target tile inside the map bounds.",
      });
    }

    const priority = targetPriority && targetPriority.length > 0 ? targetPriority : getDefaultAttackMovePriority(unit.type);
    this.missionRuntime.interruptUnit(unitId);
    this.attackOrders.delete(unitId);
    const command = this.enqueue(this.createCommand("attack_move", { unitId, position, targetPriority: priority }));
    return {
      effect: "action",
      result: this.withActionMetadata({
        ok: true,
        commandId: command.id,
      }),
    };
  }

  attackTarget(unitId: string, targetId: string): ExecutedToolResult {
    this.observationProjection.invalidate();
    const attacker = this.getFriendlyUnit(unitId);
    if (!attacker) {
      const state = this.getReadState();
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "No living friendly attacker matches this unitId; use one of availableAttackers.",
        availableAttackers: this.getFriendlyUnitOptions(state, (candidate) => unitCanAttack(candidate.type)),
      });
    }

    if (!unitCanAttack(attacker.type)) {
      const state = this.getReadState();
      return this.actionResult({
        ok: false,
        error: "invalid_attacker",
        hint: "This unit cannot attack; use one of availableAttackers.",
        availableAttackers: this.getFriendlyUnitOptions(state, (candidate) => unitCanAttack(candidate.type)),
      });
    }

    const resolution = this.resolveAttackOrderCommand(unitId, targetId);
    if (!resolution.ok) {
      const recovery = resolution.error === "target_missing"
        ? this.getEnemyTargetRecovery(attacker, targetId)
        : {};
      return this.actionResult({
        ok: false,
        error: resolution.error,
        hint: resolution.hint,
        ...recovery,
      });
    }

    this.missionRuntime.interruptUnit(unitId);
    if (resolution.completedAfterCommand) {
      this.attackOrders.delete(unitId);
    } else {
      this.attackOrders.set(unitId, { unitId, targetId });
    }
    if (resolution.mode === "attack" && this.isAttackReloading(attacker)) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: true,
          mode: "wait_for_reload",
        }),
      };
    }
    const command = this.enqueue(resolution.command);
    return {
      effect: "action",
      result: this.withActionMetadata({
        ok: true,
        commandId: command.id,
        mode: resolution.mode,
      }),
    };
  }

  spawnUnit(buildingId: string, unitType: UnitType): ExecutedToolResult {
    const state = this.getReadState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    const building = me.buildings.find((candidate) => candidate.id === buildingId && candidate.exists);
    if (!building) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_building",
          hint: "No living friendly building matches this buildingId; use one of availableProductionBuildings.",
          availableProductionBuildings: me.buildings
            .filter((candidate) => candidate.exists && isBuildingComplete(candidate) && canBuildingProduce(candidate.type, unitType))
            .map((candidate) => ({ id: candidate.id, type: candidate.type, x: candidate.x, y: candidate.y })),
        }),
      };
    }

    if (building.constructionProgress) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "building_under_construction",
          hint: `${building.type} is still under construction and cannot produce units yet.`,
        }),
      };
    }

    if (!isUnitType(unitType)) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_spawn_request",
          hint: "Unknown unit type. Supported unit types are worker, soldier, rifleman, rocket_soldier, and light_tank.",
        }),
      };
    }

    const canProduce = canBuildingProduce(building.type, unitType);
    if (!canProduce) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_spawn_request",
          hint: `${building.type} can produce: ${getProductionOptions(building.type).join(", ")}.`,
          validUnitTypes: getProductionOptions(building.type),
          compatibleProductionBuildings: me.buildings
            .filter((candidate) => candidate.exists && isBuildingComplete(candidate) && canBuildingProduce(candidate.type, unitType))
            .map((candidate) => ({ id: candidate.id, type: candidate.type, x: candidate.x, y: candidate.y })),
        }),
      };
    }

    const cost = getUnitCost(unitType);
    if (me.resources.credits < cost) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "insufficient_credits",
          hint: `Need ${cost} credits before spawning ${unitType}.`,
        }),
      };
    }

    const command = this.enqueue(this.createCommand("spawn", { buildingId, unitType }));
    return {
      effect: "action",
      result: this.withActionMetadata({
        ok: true,
        commandId: command.id,
      }),
    };
  }

  buildStructure(unitId: string, buildingType: BuildingType, requestedPosition?: Position): ExecutedToolResult {
    const state = this.getReadState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    const worker = me.units.find((candidate) => candidate.id === unitId && candidate.exists);
    if (!worker || worker.type !== UNIT_TYPES.WORKER) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_unit",
          hint: "No living friendly worker matches this unitId; use one of availableWorkers.",
          availableWorkers: this.getFriendlyUnitOptions(state, (candidate) => candidate.type === UNIT_TYPES.WORKER),
        }),
      };
    }

    if (!isBuildableBuildingType(buildingType)) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_building",
          hint: "Buildable structures are barracks, war_factory, and refinery. HQ cannot be built.",
        }),
      };
    }

    if (worker.constructingBuildingId) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "worker_busy",
          hint: "This worker is already constructing a building and cannot start another order yet.",
        }),
      };
    }

    if (buildingType === BUILDING_TYPES.WAR_FACTORY && !me.buildings.some((building) => building.type === BUILDING_TYPES.BARRACKS && isBuildingComplete(building))) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "missing_prerequisite",
          hint: "Build and complete a barracks before starting a war_factory.",
        }),
      };
    }

    const cost = getBuildingCost(buildingType);
    if (me.resources.credits < cost) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "insufficient_credits",
          hint: `Need ${cost} credits before building ${buildingType}.`,
        }),
      };
    }

    const occupancy = this.createBuildOccupancyIndex(state);
    let selectedPlacement: SuggestedBuildSite | undefined;
    if (requestedPosition) {
      const validation = this.validateBuildPosition(requestedPosition, buildingType, state, occupancy);
      if (!validation.ok) {
        const suggestedPlacements = this.getSuggestedBuildSites(state, buildingType, 3, worker, undefined, occupancy);
        return {
          effect: "action",
          result: this.withActionMetadata({
            ok: false,
            error: "invalid_build_position",
            hint: this.buildPlacementHint(validation.hint, suggestedPlacements),
            suggestedPlacements,
          }),
        };
      }
      const workerPosition = this.getWorkerApproachPosition(state, buildingType, requestedPosition, worker, occupancy);
      if (workerPosition) selectedPlacement = { ...requestedPosition, workerPosition };
    } else {
      selectedPlacement = this.getSuggestedBuildSites(state, buildingType, 3, worker, undefined, occupancy)[0];
    }
    if (!selectedPlacement?.workerPosition) {
      const suggestedPlacements = requestedPosition
        ? this.getSuggestedBuildSites(state, buildingType, 3, worker, undefined, occupancy)
        : [];
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "no_build_site",
          hint: "No reachable legal site is currently available for this worker.",
          suggestedPlacements,
        }),
      };
    }
    const position = { x: selectedPlacement.x, y: selectedPlacement.y };

    if (worker.intent?.type === "harvest_loop") {
      this.pendingBuildResumeOrders.set(unitId, structuredClone(worker.intent));
    } else {
      this.pendingBuildResumeOrders.delete(unitId);
    }

    this.missionRuntime.interruptUnit(unitId);
    this.attackOrders.delete(unitId);
    if (!this.isWorkerAdjacentToBuildFootprint(worker, buildingType, position)) {
      const plan = this.orchestratePlan({
        unitIds: [unitId],
        loop: 1,
        replaceExisting: true,
        steps: [
          {
            call: "move_unit",
            args: { unitId, x: selectedPlacement.workerPosition.x, y: selectedPlacement.workerPosition.y },
            scope: "global",
            until: {
              condition: "worker_adjacent_to_build_footprint",
              buildingType,
              x: position.x,
              y: position.y,
            },
            retry: true,
          },
          {
            call: "build_structure",
            args: { unitId, buildingType, x: position.x, y: position.y },
            scope: "global",
            retry: true,
          },
        ],
      });
      return {
        effect: "plan",
        result: {
          ...(plan.result as Record<string, unknown>),
          buildingType,
          position,
          workerPosition: selectedPlacement.workerPosition,
          ...(selectedPlacement.estimatedRouteSaving !== undefined
            ? {
              estimatedRouteSaving: selectedPlacement.estimatedRouteSaving,
              nearbyResources: selectedPlacement.nearbyResources,
            }
            : {}),
        },
      };
    }
    const command = this.enqueue(this.createCommand("build", {
      unitId,
      buildingType,
      position,
      resumeWorkerOrder: this.pendingBuildResumeOrders.get(unitId),
    }));
    return {
      effect: "action",
      result: this.withActionMetadata({
        ok: true,
        commandId: command.id,
        buildingType,
        position,
        ...(selectedPlacement.estimatedRouteSaving !== undefined
          ? {
            estimatedRouteSaving: selectedPlacement.estimatedRouteSaving,
            nearbyResources: selectedPlacement.nearbyResources,
          }
          : {}),
      }),
    };
  }

  startHarvestLoop(unitId: string, position?: Position): ExecutedToolResult {
    const state = this.getReadState();
    const unit = this.getFriendlyUnit(unitId);
    if (!unit || unit.type !== UNIT_TYPES.WORKER) {
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "No living friendly worker matches this unitId; use one of availableWorkers.",
        availableWorkers: this.getFriendlyUnitOptions(state, (candidate) => candidate.type === UNIT_TYPES.WORKER),
      });
    }

    if (
      position &&
      (!Number.isInteger(position.x) ||
        !Number.isInteger(position.y) ||
        position.y < 0 ||
        position.y >= state.tiles.length ||
        position.x < 0 ||
        position.x >= (state.tiles[position.y]?.length ?? 0))
    ) {
      return this.actionResult({
        ok: false,
        error: "invalid_resource_target",
        hint: "The requested coordinates are not a valid resource tile; omit x/y for automatic selection or use nearbyResources.",
        nearbyResources: this.getNearbyResourceOptions(state, unit),
      });
    }

    if (position && state.tiles[position.y]?.[position.x]?.type !== TILE_TYPES.RESOURCE) {
      return this.actionResult({
        ok: false,
        error: "invalid_resource_target",
        hint: "The requested tile is not a resource tile; omit x/y for automatic selection or use nearbyResources.",
        nearbyResources: this.getNearbyResourceOptions(state, unit),
      });
    }

    this.missionRuntime.interruptUnit(unitId);
    this.attackOrders.delete(unitId);
    const command = this.enqueue(this.createCommand("harvest_loop", { unitId, position }));
    return {
      effect: "action",
      result: this.withActionMetadata({
        ok: true,
        commandId: command.id,
      }),
    };
  }

  holdUnit(unitId: string): ExecutedToolResult {
    const state = this.getReadState();
    const unit = this.getFriendlyUnit(unitId);
    if (!unit) {
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "No living friendly unit matches this unitId; use one of availableFriendlyUnits.",
        availableFriendlyUnits: this.getFriendlyUnitOptions(state),
      });
    }

    this.missionRuntime.interruptUnit(unitId);
    this.attackOrders.delete(unitId);
    const command = this.enqueue(this.createCommand("hold", { unitId }));
    return {
      effect: "action",
      result: this.withActionMetadata({
        ok: true,
        commandId: command.id,
      }),
    };
  }

  orchestratePlan(input: OrchestratePlanInput): ExecutedToolResult {
    const validated = this.validatePlanInput(input);
    if (!validated.ok) {
      return {
        effect: "plan",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_plan",
          hint: validated.hint,
          supportedCallTools: [...PLAN_CALL_TOOL_NAMES],
          supportedUntilConditions: [...PLAN_UNTIL_CONDITIONS],
        }),
      };
    }

    const normalizedInput = validated.value;
    if (normalizedInput.replaceExisting !== false) {
      for (const unitId of normalizedInput.unitIds) {
        this.missionRuntime.interruptUnit(unitId);
        this.attackOrders.delete(unitId);
      }
    }
    const record = this.missionRuntime.register(normalizedInput, this.commandProvenance ?? undefined);
    this.runPlanRecords.push(record);
    return {
      effect: "plan",
      result: this.withActionMetadata({
        ok: true,
        missionId: record.missionId ?? record.planId,
        planId: record.planId,
        unitIds: record.unitIds,
        loop: record.loop,
        status: record.status,
      }),
    };
  }

  private enqueue(command: Command): Command {
    this.issuedCommands.push(command);
    this.submitCommands([command]);
    return command;
  }

  private consumeMissionCommandFailures(): void {
    const deterministicFailures = new Set<string>([
      RESULT_TYPES.BUILD_INVALID_POSITION,
      RESULT_TYPES.BUILD_INVALID_BUILDING,
      RESULT_TYPES.SPAWN_INVALID_BUILDING,
      RESULT_TYPES.INVALID_UNIT,
      RESULT_TYPES.ATTACK_INVALID_TARGET,
      RESULT_TYPES.COMMAND_CRASHED,
    ]);

    for (const log of this.game.getAIFeedback(this.playerId)) {
      if (log.type !== LOG_TYPES.COMMAND_RESULT || log.data.result_code >= 0) {
        continue;
      }
      const { command } = log.data;
      const missionId = command.provenance?.missionId;
      if (!missionId) {
        continue;
      }

      const failedType = log.data.type === RESULT_TYPES.COMMAND_INVALID
        ? log.data.result_data.failedResultType
        : log.data.type;
      const isFailedCommand = log.data.type !== RESULT_TYPES.COMMAND_INVALID
        || (
          log.data.result_data.reason === "command_failed" &&
          log.data.result_data.failedCommandId === command.id
        );
      if (!failedType || !isFailedCommand || !deterministicFailures.has(failedType)) {
        continue;
      }

      const feedbackKey = `${log.tick}:${command.id}:${failedType}`;
      if (this.consumedMissionFailureKeys.has(feedbackKey)) {
        continue;
      }
      this.consumedMissionFailureKeys.add(feedbackKey);
      this.missionRuntime.failMission(
        missionId,
        log.tick,
        `engine rejected ${command.type}: ${failedType}`,
      );
    }
  }

  private createCommand(type: string, payload: Partial<Command>): Command {
    return {
      id: `agent_cmd_${this.playerId}_${++this.commandCounter}`,
      type,
      playerId: this.playerId,
      ...(this.commandProvenance ? { provenance: structuredClone(this.commandProvenance) } : {}),
      ...payload,
    };
  }

  private trackRead(tick: number, trackRead = true): void {
    if (trackRead) {
      this.lastReadTick = tick;
    }
  }

  private actionResult(result: Record<string, unknown>): ExecutedToolResult {
    return {
      effect: "action",
      result: this.withActionMetadata(result),
    };
  }

  private withActionMetadata<T extends Record<string, unknown>>(result: T): T & Record<string, unknown> {
    const currentTick = this.game.getTick();
    const staleWarning = this.policy.getStaleReadWarning(this.lastReadTick, currentTick);
    return {
      tick: currentTick,
      ...result,
      ...(staleWarning ? { warning: staleWarning } : {}),
    };
  }

  private getFriendlyUnitOptions(
    state: AgentReadState,
    predicate: (unit: Unit) => boolean = () => true,
    limit = 12,
  ) {
    const me = state.players.find((player) => player.id === this.playerId)!;
    return me.units
      .filter((unit) => unit.exists && predicate(unit))
      .slice(0, limit)
      .map((unit) => ({
        id: unit.id,
        type: unit.type,
        x: unit.x,
        y: unit.y,
        hp: unit.hp,
        state: unit.state,
      }));
  }

  private getEnemyTargetRecovery(attacker: Unit, targetId: string) {
    const state = this.getReadState();
    const enemies = state.players.filter((player) => player.id !== this.playerId);
    const historicalTarget = enemies.flatMap((player) => [...player.units, ...player.buildings])
      .find((candidate) => candidate.id === targetId);
    const friendlyId = state.players
      .find((player) => player.id === this.playerId)
      ?.units.some((candidate) => candidate.id === targetId) || state.players
        .find((player) => player.id === this.playerId)
        ?.buildings.some((candidate) => candidate.id === targetId);
    const targetStatus = (historicalTarget && !historicalTarget.exists) || this.knownEnemyTargetIds.has(targetId)
      ? "destroyed"
      : friendlyId
        ? "not_enemy"
        : "invalid_id";
    const buildings = enemies
      .flatMap((player) => player.buildings)
      .filter((building) => building.exists)
      .sort((a, b) => {
        const aDistance = getDistanceToBuildingFootprint(a.type, a.x, a.y, attacker.x, attacker.y);
        const bDistance = getDistanceToBuildingFootprint(b.type, b.x, b.y, attacker.x, attacker.y);
        return aDistance - bDistance;
      })
      .map((building) => ({
        id: building.id,
        type: building.type,
        x: building.x,
        y: building.y,
        hp: building.hp,
      }));
    const units = enemies
      .flatMap((player) => player.units)
      .filter((unit) => unit.exists)
      .sort((a, b) => {
        const aDistance = Math.max(Math.abs(a.x - attacker.x), Math.abs(a.y - attacker.y));
        const bDistance = Math.max(Math.abs(b.x - attacker.x), Math.abs(b.y - attacker.y));
        return aDistance - bDistance;
      })
      .map((unit) => ({
        id: unit.id,
        type: unit.type,
        x: unit.x,
        y: unit.y,
        hp: unit.hp,
      }));
    const targetLimit = 12;
    const includedBuildings = buildings.slice(0, targetLimit);
    const availableEnemyTargets = [
      ...includedBuildings,
      ...units.slice(0, targetLimit - includedBuildings.length),
    ];
    return {
      targetId,
      targetStatus,
      availableEnemyTargetCount: buildings.length + units.length,
      availableEnemyTargets,
    };
  }

  private getNearbyResourceOptions(state: AgentReadState, worker: Unit, limit = 8) {
    return state.tiles
      .flat()
      .filter((tile) => tile.type === TILE_TYPES.RESOURCE && (tile.resourceRemaining ?? 0) > 0)
      .sort((a, b) => {
        const aDistance = Math.max(Math.abs(a.x - worker.x), Math.abs(a.y - worker.y));
        const bDistance = Math.max(Math.abs(b.x - worker.x), Math.abs(b.y - worker.y));
        return aDistance - bDistance;
      })
      .slice(0, limit)
      .map((tile) => ({ x: tile.x, y: tile.y, remaining: tile.resourceRemaining ?? 0 }));
  }

  private getFriendlyUnit(unitId: string) {
    const state = this.getReadState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    return me.units.find((candidate) => candidate.id === unitId && candidate.exists) ?? null;
  }

  private getEnemyTarget(targetId: string) {
    const state = this.getReadState();
    for (const player of state.players.filter((candidate) => candidate.id !== this.playerId)) {
      const unit = player.units.find((candidate) => candidate.id === targetId && candidate.exists);
      if (unit) {
        return unit;
      }
      const building = player.buildings.find((candidate) => candidate.id === targetId && candidate.exists);
      if (building) {
        return building;
      }
    }
    return null;
  }

  private advanceAttackOrders(): Command[] {
    const commands: Command[] = [];
    for (const [unitId, order] of this.attackOrders) {
      const unit = this.getFriendlyUnit(unitId);
      if (!unit || !unitCanAttack(unit.type)) {
        this.attackOrders.delete(unitId);
        continue;
      }
      if (unit.state === "moving" && unit.intent?.type === "move") {
        continue;
      }

      const resolution = this.resolveAttackOrderCommand(order.unitId, order.targetId);
      if (!resolution.ok) {
        this.attackOrders.delete(unitId);
        continue;
      }
      if (resolution.mode === "attack" && this.isAttackReloading(unit)) {
        continue;
      }

      commands.push(resolution.command);
      if (resolution.completedAfterCommand) {
        this.attackOrders.delete(unitId);
      }
    }
    return commands;
  }

  private resolveAttackOrderCommand(unitId: string, targetId: string): AttackOrderResolution {
    const attacker = this.getFriendlyUnit(unitId);
    if (!attacker) {
      return { ok: false, error: "invalid_unit", hint: "The assigned attacker no longer exists." };
    }

    const target = this.getEnemyTarget(targetId);
    if (target) {
      const distance = isBuildingType(target.type)
        ? getDistanceToBuildingFootprint(target.type, target.x, target.y, attacker.x, attacker.y)
        : Math.max(Math.abs(attacker.x - target.x), Math.abs(attacker.y - target.y));
      const inRange = distance <= attacker.attackRange;
      if (inRange) {
        return {
          ok: true,
          command: this.createCommand("attack", { unitId, targetId }),
          mode: "attack",
          // The simulation owns the persistent attack intent and will fire again
          // after reload. The gameplay controller only needs to keep orders that are still
          // moving toward a target.
          completedAfterCommand: true,
        };
      }

      return {
        ok: true,
        command: this.createCommand("move", {
          unitId,
          position: this.toGridPosition(target, this.getReadState()),
        }),
        mode: "move_to_target",
        completedAfterCommand: false,
      };
    }

    return {
      ok: false,
      error: "target_missing",
      hint: "No living enemy unit or building matches this targetId; use one of availableEnemyTargets.",
    };
  }

  private isAttackReloading(unit: { nextAttackTick?: number } | undefined): boolean {
    return unit?.nextAttackTick !== undefined && this.game.getTick() < unit.nextAttackTick;
  }

  private toGridPosition(position: Position, state: AgentReadState): Position {
    const height = state.tiles.length;
    const width = state.tiles[0]?.length ?? 0;
    return {
      x: Math.max(0, Math.min(width - 1, Math.round(position.x))),
      y: Math.max(0, Math.min(height - 1, Math.round(position.y))),
    };
  }

  private getLargestUnitCluster<T extends { x: number; y: number }>(units: T[], radius = 12): T[] {
    let largest: T[] = [];
    for (const anchor of units) {
      const cluster = units.filter((unit) =>
        Math.max(Math.abs(unit.x - anchor.x), Math.abs(unit.y - anchor.y)) <= radius
      );
      if (cluster.length > largest.length) {
        largest = cluster;
      }
    }
    return largest;
  }

  private getPlanSnapshot() {
    const state = this.getReadState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    return {
      tick: state.tick,
      myCredits: me.resources.credits,
      myUnits: me.units.filter((unit) => unit.exists),
      myBuildings: me.buildings.filter(isBuildingComplete),
      visibleUnits: state.players.flatMap((player) =>
        player.units
          .filter((unit) => unit.exists)
          .map((unit) => {
            const relation: "self" | "enemy" = player.id === this.playerId ? "self" : "enemy";
            return { ...unit, relation };
          })
      ),
      visibleBuildings: state.players.flatMap((player) =>
        player.buildings
          .filter((building) => building.exists)
          .map((building) => {
            const relation: "self" | "enemy" = player.id === this.playerId ? "self" : "enemy";
            return { ...building, relation };
          })
      ),
    };
  }

  private getSuggestedBuildSites(
    state = this.getReadState(),
    buildingType: BuildingType = BUILDING_TYPES.WAR_FACTORY,
    limit = 3,
    worker?: { id: string; x: number; y: number },
    candidateSites?: Position[],
    occupancy?: BuildOccupancyIndex,
  ): SuggestedBuildSite[] {
    const buildOccupancy = occupancy ?? this.createBuildOccupancyIndex(state);
    return (candidateSites ?? this.getSuggestedBuildSiteCandidates(state, buildingType, limit, buildOccupancy, worker))
      .map((site) => {
        const refineryEconomics = buildingType === BUILDING_TYPES.REFINERY
          ? this.getRefinerySiteEconomics(state, site)
          : undefined;
        return {
          ...site,
          workerPosition: this.getWorkerApproachPosition(state, buildingType, site, worker, buildOccupancy),
          ...(refineryEconomics ? {
            estimatedRouteSaving: refineryEconomics.estimatedRouteSaving,
            nearbyResources: refineryEconomics.nearbyResources,
          } : {}),
        };
      })
      .filter((site): site is SuggestedBuildSite => site.workerPosition !== null)
      .slice(0, limit);
  }

  private getSuggestedBuildSiteCandidates(
    state: AgentReadState,
    buildingType: BuildingType,
    limit: number,
    occupancy: BuildOccupancyIndex,
    worker?: { id: string; x: number; y: number },
  ): Position[] {
    const me = state.players.find((player) => player.id === this.playerId)!;
    const hq = me.buildings.find((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    if (!hq) {
      return [];
    }

    if (buildingType === BUILDING_TYPES.REFINERY) {
      return this.getRefineryBuildSiteCandidates(state, limit, occupancy, worker);
    }

    const preferredX = hq.x + (hq.x < state.tiles[0]?.length / 2 ? 12 : -12);
    const candidates: Position[] = [];
    for (let radius = 5; radius <= 32 && candidates.length < limit * 4; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (const dx of [-radius, radius]) {
          const position = { x: hq.x + dx, y: hq.y + dy };
          if (this.validateBuildPosition(position, buildingType, state, occupancy).ok) candidates.push(position);
        }
      }
      for (let dx = -radius + 1; dx < radius && candidates.length < limit * 4; dx++) {
        for (const dy of [-radius, radius]) {
          const position = { x: hq.x + dx, y: hq.y + dy };
          if (this.validateBuildPosition(position, buildingType, state, occupancy).ok) candidates.push(position);
        }
      }
    }

    return candidates
      .sort((a, b) => {
        const aScore = Math.abs(a.x - preferredX) * 3 + Math.abs(a.y - hq.y);
        const bScore = Math.abs(b.x - preferredX) * 3 + Math.abs(b.y - hq.y);
        if (aScore !== bScore) {
          return aScore - bScore;
        }
        return Math.abs(a.x - hq.x) + Math.abs(a.y - hq.y) - (Math.abs(b.x - hq.x) + Math.abs(b.y - hq.y));
      });
  }

  private getRefineryBuildSiteCandidates(
    state: AgentReadState,
    limit: number,
    occupancy: BuildOccupancyIndex,
    worker?: { x: number; y: number },
  ): Position[] {
    const resources = this.getEconomicallyRelevantResources(state);
    const candidateMap = new Map<string, Position>();
    for (const resource of resources) {
      for (let radius = 4; radius <= 9; radius++) {
        for (let offset = -radius; offset <= radius; offset++) {
          for (const position of [
            { x: resource.x - radius, y: resource.y + offset },
            { x: resource.x + radius, y: resource.y + offset },
            { x: resource.x + offset, y: resource.y - radius },
            { x: resource.x + offset, y: resource.y + radius },
          ]) {
            const key = `${position.x},${position.y}`;
            if (
              !candidateMap.has(key) &&
              this.validateBuildPosition(position, BUILDING_TYPES.REFINERY, state, occupancy).ok
            ) {
              candidateMap.set(key, position);
            }
          }
        }
      }
    }

    return [...candidateMap.values()]
      .map((position) => {
        const economics = this.getRefinerySiteEconomics(state, position);
        const workerDistance = worker
          ? Math.max(Math.abs(worker.x - position.x), Math.abs(worker.y - position.y))
          : 0;
        return { position, economics, workerDistance };
      })
      .filter((candidate) => candidate.economics.estimatedRouteSaving > 0)
      .sort((a, b) =>
        b.economics.estimatedRouteSaving - a.economics.estimatedRouteSaving ||
        a.workerDistance - b.workerDistance ||
        a.position.y - b.position.y ||
        a.position.x - b.position.x
      )
      .slice(0, Math.max(limit * 4, limit))
      .map((candidate) => candidate.position);
  }

  private getEconomicallyRelevantResources(state: AgentReadState) {
    const me = state.players.find((player) => player.id === this.playerId)!;
    const hq = me.buildings.find((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    const enemyHqs = state.players
      .filter((player) => player.id !== this.playerId)
      .flatMap((player) => player.buildings)
      .filter((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    return state.tiles
      .flat()
      .filter((tile) => tile.type === TILE_TYPES.RESOURCE && (tile.resourceRemaining ?? 0) > 0)
      .filter((tile) => {
        if (!hq || enemyHqs.length === 0) return true;
        const ownDistance = Math.max(Math.abs(tile.x - hq.x), Math.abs(tile.y - hq.y));
        const enemyDistance = Math.min(...enemyHqs.map((enemyHq) =>
          Math.max(Math.abs(tile.x - enemyHq.x), Math.abs(tile.y - enemyHq.y))
        ));
        return ownDistance <= enemyDistance;
      });
  }

  private getRefinerySiteEconomics(state: AgentReadState, site: Position) {
    const me = state.players.find((player) => player.id === this.playerId)!;
    const deliveryBuildings = me.buildings.filter((building) =>
      building.exists &&
      !building.constructionProgress &&
      (building.type === BUILDING_TYPES.HQ || building.type === BUILDING_TYPES.REFINERY)
    );
    const activeHarvesters = me.units.filter((unit) => unit.exists && unit.intent?.type === "harvest_loop");
    const resourceDetails = this.getEconomicallyRelevantResources(state).map((resource) => {
      const assignedHarvesters = activeHarvesters.filter((unit) =>
        unit.intent?.type === "harvest_loop" &&
        unit.intent.targetX === resource.x &&
        unit.intent.targetY === resource.y
      ).length;
      const currentDeliveryDistance = deliveryBuildings.length > 0
        ? Math.min(...deliveryBuildings.map((building) =>
          this.getResourceDeliveryDistance(building.type, building, resource)
        ))
        : Number.POSITIVE_INFINITY;
      const newDeliveryDistance = this.getResourceDeliveryDistance(BUILDING_TYPES.REFINERY, site, resource);
      const routeSaving = Number.isFinite(currentDeliveryDistance)
        ? Math.max(0, currentDeliveryDistance - newDeliveryDistance)
        : 0;
      return {
        x: resource.x,
        y: resource.y,
        remaining: resource.resourceRemaining ?? 0,
        assignedHarvesters,
        currentDeliveryDistance,
        newDeliveryDistance,
        routeSaving,
      };
    });
    return {
      estimatedRouteSaving: resourceDetails.reduce(
        (sum, resource) => sum + resource.routeSaving * Math.max(1, resource.assignedHarvesters),
        0,
      ),
      nearbyResources: resourceDetails
        .sort((a, b) =>
          a.newDeliveryDistance - b.newDeliveryDistance ||
          b.routeSaving - a.routeSaving ||
          a.y - b.y ||
          a.x - b.x
        )
        .slice(0, 4)
        .map(({ routeSaving: _routeSaving, ...resource }) => resource),
    };
  }

  private getResourceDeliveryDistance(
    buildingType: BuildingType,
    buildingPosition: Position,
    resourcePosition: Position,
  ): number {
    const deliveryRange = buildingType === BUILDING_TYPES.REFINERY
      ? ECONOMY_RULES.REFINERY_DELIVERY_RANGE
      : ECONOMY_RULES.HQ_DELIVERY_RANGE;
    return Math.max(
      0,
      getDistanceToBuildingFootprint(
        buildingType,
        buildingPosition.x,
        buildingPosition.y,
        resourcePosition.x,
        resourcePosition.y,
      ) - deliveryRange,
    );
  }

  private getWorkerApproachPosition(
    state: AgentReadState,
    buildingType: BuildingType,
    site: Position,
    worker?: { id: string; x: number; y: number },
    occupancy = this.createBuildOccupancyIndex(state),
  ): Position | null {
    const footprint = getBuildingFootprintCells(buildingType, site.x, site.y);
    const footprintKeys = new Set(footprint.map((cell) => `${cell.x},${cell.y}`));
    const candidates = new Map<string, Position>();
    for (const cell of footprint) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const candidate = { x: cell.x + dx, y: cell.y + dy };
          const key = `${candidate.x},${candidate.y}`;
          if (!footprintKeys.has(key)) {
            candidates.set(key, candidate);
          }
        }
      }
    }

    const isOpen = (candidate: Position): boolean => {
      if (state.tiles[candidate.y]?.[candidate.x]?.type !== TILE_TYPES.EMPTY) {
        return false;
      }
      const occupyingUnitIds = occupancy.unitIdsByCell.get(`${candidate.x},${candidate.y}`) ?? [];
      if (occupyingUnitIds.some((unitId) => unitId !== worker?.id)) {
        return false;
      }
      return !occupancy.buildingCells.has(`${candidate.x},${candidate.y}`);
    };

    return [...candidates.values()]
      .filter(isOpen)
      .sort((a, b) => {
        const aDistance = worker ? Math.max(Math.abs(a.x - worker.x), Math.abs(a.y - worker.y)) : 0;
        const bDistance = worker ? Math.max(Math.abs(b.x - worker.x), Math.abs(b.y - worker.y)) : 0;
        return aDistance - bDistance || a.y - b.y || a.x - b.x;
      })[0] ?? null;
  }

  private buildPlacementHint(baseHint: string, suggestedPlacements: SuggestedBuildSite[]): string {
    const suggestions = suggestedPlacements
      .map((site) => `move worker to (${site.workerPosition.x}, ${site.workerPosition.y}), then build at (${site.x}, ${site.y})`)
      .join(", ");
    if (!suggestions) {
      return `${baseHint} Structures must be on an empty tile and leave one empty ring around HQ.`;
    }
    return `${baseHint} Do not move the worker onto the building center or footprint. Valid sequences: ${suggestions}.`;
  }

  private validateBuildPosition(
    position: Position,
    buildingType: BuildingType,
    state = this.getReadState(),
    occupancy = this.createBuildOccupancyIndex(state),
  ): { ok: true } | { ok: false; hint: string } {
    const me = state.players.find((player) => player.id === this.playerId)!;
    const hq = me.buildings.find((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    const { x, y } = position;

    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return { ok: false, hint: "Choose an empty tile inside the map bounds." };
    }

    const footprint = getBuildingFootprintCells(buildingType, x, y);
    for (const cell of footprint) {
      const tile = state.tiles[cell.y]?.[cell.x];
      if (!tile) {
        return { ok: false, hint: "The full building footprint must stay inside the map." };
      }
      if (tile.type !== "empty") {
        return { ok: false, hint: "The building footprint overlaps terrain or resources." };
      }
      const key = `${cell.x},${cell.y}`;
      if (occupancy.unitIdsByCell.has(key)) {
        return { ok: false, hint: "The building footprint is occupied by a unit right now." };
      }
      if (occupancy.buildingCells.has(key)) {
        return { ok: false, hint: "The building footprint overlaps another structure." };
      }
    }

    if (hq && footprint.some((cell) => getDistanceToBuildingFootprint(hq.type, hq.x, hq.y, cell.x, cell.y) <= 1)) {
      return { ok: false, hint: "Leave at least one clear tile between the full building footprint and HQ." };
    }

    return { ok: true };
  }

  private createBuildOccupancyIndex(state: AgentReadState): BuildOccupancyIndex {
    const unitIdsByCell = new Map<string, string[]>();
    const buildingCells = new Set<string>();
    for (const player of state.players) {
      for (const unit of player.units) {
        if (!unit.exists) continue;
        const key = `${Math.round(unit.x)},${Math.round(unit.y)}`;
        const ids = unitIdsByCell.get(key) ?? [];
        ids.push(unit.id);
        unitIdsByCell.set(key, ids);
      }
      for (const building of player.buildings) {
        if (!building.exists) continue;
        for (const cell of getBuildingFootprintCells(building.type, building.x, building.y)) {
          buildingCells.add(`${cell.x},${cell.y}`);
        }
      }
    }
    return { unitIdsByCell, buildingCells };
  }

  private isWorkerAdjacentToBuildFootprint(worker: { x: number; y: number }, buildingType: BuildingType, position: Position): boolean {
    const distance = getDistanceToBuildingFootprint(buildingType, position.x, position.y, worker.x, worker.y);
    return distance > 0 && distance <= 1;
  }

  private validatePlanInput(input: OrchestratePlanInput): { ok: true; value: OrchestratePlanInput } | { ok: false; hint: string } {
    if (!input || !Array.isArray(input.unitIds) || input.unitIds.length === 0) {
      return { ok: false, hint: "unitIds must contain at least one friendly unit id." };
    }

    const state = this.getReadState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    const myUnitIds = new Set(me.units.filter((unit) => unit.exists).map((unit) => unit.id));
    const normalizedUnitIds = [...new Set(input.unitIds.map((unitId) => String(unitId)))];
    const invalidUnitId = normalizedUnitIds.find((unitId) => !myUnitIds.has(unitId));
    if (invalidUnitId) {
      return { ok: false, hint: `Unknown controllable unit id: ${invalidUnitId}. Plans can only target friendly units.` };
    }

    if (!Array.isArray(input.steps) || input.steps.length === 0) {
      return { ok: false, hint: "steps must contain at least one supported plan step." };
    }

    const allowedPlanUnitIds = new Set(normalizedUnitIds);
    if (!input.steps.every((step) => this.isPlanStep(step, allowedPlanUnitIds))) {
      return {
        ok: false,
        hint: "Unsupported plan step. Each step must use { call: existing_tool, args, until?, retry?, maxTicks? }.",
      };
    }

    if (input.loop !== undefined && (!Number.isInteger(input.loop) || input.loop === 0)) {
      return { ok: false, hint: "loop must be an integer and cannot be 0." };
    }

    if (input.scope !== undefined && !this.isPlanScope(input.scope)) {
      return { ok: false, hint: "scope must be either global or per_unit." };
    }

    return {
      ok: true,
      value: {
        unitIds: normalizedUnitIds,
        replaceExisting: input.replaceExisting,
        scope: input.scope,
        loop: input.loop,
        steps: structuredClone(input.steps),
      },
    };
  }

  private isPlanStep(value: unknown, allowedUnitIds?: Set<string>): value is PlanStep {
    if (!this.isRecord(value)) {
      return false;
    }

    return typeof value.call === "string" && this.isPlanCallStep(value, allowedUnitIds);
  }

  private isPlanCallStep(value: Record<string, unknown>, allowedUnitIds?: Set<string>): boolean {
    const call = value.call as PlanCallToolName;
    const handler = this.planToolHandlers[call];
    if (!PLAN_CALL_TOOL_NAMES.includes(call) || !handler) {
      return false;
    }
    if (!this.isRecord(value.args)) {
      return false;
    }
    if (value.scope !== undefined && !this.isPlanScope(value.scope)) {
      return false;
    }
    if (value.retry !== undefined && typeof value.retry !== "boolean") {
      return false;
    }
    if (value.maxTicks !== undefined && (!Number.isInteger(value.maxTicks) || Number(value.maxTicks) < 0)) {
      return false;
    }
    if (value.when !== undefined && !this.isPlanStepCondition(value.when)) {
      return false;
    }
    if (value.until !== undefined && !this.isPlanStepCondition(value.until)) {
      return false;
    }

    const args = value.args;
    const hasValidUnitId =
      args.unitId === undefined ||
      args.unitId === "$unitId" ||
      (typeof args.unitId === "string" && (allowedUnitIds === undefined || allowedUnitIds.has(args.unitId)));
    if (!hasValidUnitId) {
      return false;
    }

    return handler.validateArgs(args);
  }

  private isPlanScope(value: unknown): value is PlanStepScope {
    return value === "global" || value === "per_unit";
  }

  private isPlanStepCondition(value: unknown): boolean {
    if (!this.isRecord(value) || typeof value.condition !== "string") {
      return false;
    }
    if (!PLAN_UNTIL_CONDITIONS.includes(value.condition as (typeof PLAN_UNTIL_CONDITIONS)[number])) {
      return false;
    }

    switch (value.condition) {
      case "near_position":
        return (
          Number.isInteger(value.x) &&
          Number.isInteger(value.y) &&
          (value.distance === undefined || (Number.isInteger(value.distance) && Number(value.distance) >= 0))
        );
      case "worker_adjacent_to_build_footprint":
        return (
          isBuildableBuildingType(value.buildingType) &&
          Number.isInteger(value.x) &&
          Number.isInteger(value.y)
        );
      case "target_in_range":
      case "target_destroyed":
        return typeof value.targetId === "string";
      case "credits_at_least":
        return typeof value.amount === "number" && Number.isInteger(value.amount) && value.amount >= 0;
      case "building_exists":
      case "enemy_building_exists":
        return (
          isBuildingType(value.buildingType) &&
          (value.count === undefined || (Number.isInteger(value.count) && Number(value.count) > 0))
        );
      case "unit_count_at_least":
      case "enemy_unit_count_at_least":
        return (
          isUnitType(value.unitType) &&
          Number.isInteger(value.count) &&
          Number(value.count) >= 0
        );
      case "production_queue_empty":
        return (
          (value.buildingId === undefined || typeof value.buildingId === "string") &&
          (value.buildingType === undefined || isBuildingType(value.buildingType)) &&
          (value.buildingId !== undefined || value.buildingType !== undefined)
        );
      default:
        return true;
    }
  }

  private isOptionalTargetPriority(value: unknown): boolean {
    return (
      value === undefined ||
      (Array.isArray(value) && value.every((entry) => isUnitType(entry) || isBuildingType(entry)))
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}
