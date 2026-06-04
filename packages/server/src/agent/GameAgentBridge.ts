import {
  AgentMapState,
  AgentMapStateBuilding,
  AgentMapStateCell,
  AgentMapStateUnit,
  AgentPlanRecord,
  BUILDING_STATS,
  BUILDING_TYPES,
  Command,
  OrchestratePlanInput,
  PlanCallToolName,
  PlanStep,
  PlanStepScope,
  PlayerId,
  Position,
  TILE_TYPES,
  UNIT_STATS,
  UNIT_TYPES,
} from "@llmcraft/shared";
import { Game } from "../Game";
import { AgentPlanRuntime, PlanToolContext, PlanToolHandlers } from "./AgentPlanRuntime";

type ToolEffect = "read" | "action" | "plan";

export interface ExecutedToolResult {
  effect: ToolEffect;
  result: unknown;
}

const STALE_READ_WARNING_TICKS = 10;
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
  "target_in_range",
  "target_destroyed",
  "credits_at_least",
  "building_exists",
  "unit_count_at_least",
  "production_queue_empty",
] as const;

type CachedEnemyTarget = {
  id: string;
  type: string;
  x: number;
  y: number;
  tick: number;
};

type AttackOrderResolution =
  | { ok: true; command: Command; mode: "attack" | "move_to_target" | "move_to_last_seen"; completedAfterCommand: boolean }
  | { ok: false; error: string; hint: string };

export class GameAgentBridge {
  private issuedCommands: Command[] = [];
  private runPlanRecords: AgentPlanRecord[] = [];
  private commandCounter = 0;
  private lastReadTick: number | null = null;
  private planRuntime: AgentPlanRuntime;
  private readonly planToolHandlers: PlanToolHandlers;
  private targetMemory = new Map<string, CachedEnemyTarget>();
  private attackOrders = new Map<string, { unitId: string; targetId: string }>();
  private pendingCallToArms = false;

  constructor(private readonly game: Game, private readonly playerId: PlayerId) {
    this.planToolHandlers = this.createPlanToolHandlers();
    this.planRuntime = new AgentPlanRuntime(this.planToolHandlers);
  }

  beginRun(): void {
    this.issuedCommands = [];
    this.runPlanRecords = [];
    this.lastReadTick = null;
    this.pendingCallToArms = false;
  }

  beginToolCall(): void {
    this.issuedCommands = [];
    this.runPlanRecords = [];
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

  advancePlans(): Command[] {
    return [...this.planRuntime.advance(this.getPlanSnapshot()), ...this.advanceAttackOrders()];
  }

  getActivePlans(): AgentPlanRecord[] {
    return this.planRuntime.getActivePlans();
  }

  getMapState(args?: { includeCells?: boolean; includeEmptyTiles?: boolean; trackRead?: boolean }): ExecutedToolResult {
    const state = this.game.getState();
    this.trackRead(state.tick, args?.trackRead);
    this.rememberVisibleEnemyTargets(state);
    const includeCells = args?.includeCells === true || args?.includeEmptyTiles === true;
    const includeEmptyTiles = args?.includeEmptyTiles === true;
    const cells = new Map<string, AgentMapStateCell>();
    const units: AgentMapStateUnit[] = [];
    const buildings: AgentMapStateBuilding[] = [];
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
      asciiMap: this.renderAsciiMap(state),
      units,
      buildings,
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
          return unitId && Number.isInteger(context.args.x) && Number.isInteger(context.args.y)
            ? this.createCommand("move", { unitId, position: { x: Number(context.args.x), y: Number(context.args.y) } })
            : null;
        },
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
          return this.createCommand("attack_move", {
            unitId,
            position: { x: Number(context.args.x), y: Number(context.args.y) },
            targetPriority: this.resolveTargetPriority(context.args.priority),
          });
        },
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
          const resolution = this.resolveAttackOrderCommand(unitId, context.args.targetId);
          return resolution.ok ? resolution.command : null;
        },
      },
      spawn_unit: {
        defaultScope: "global",
        defaultRetry: true,
        validateArgs: (args) =>
          (args.buildingId === undefined || typeof args.buildingId === "string") &&
          (args.buildingType === undefined || args.buildingType === BUILDING_TYPES.HQ || args.buildingType === BUILDING_TYPES.BARRACKS) &&
          (args.unitType === UNIT_TYPES.WORKER || args.unitType === UNIT_TYPES.SOLDIER),
        createCommand: (context) => {
          const unitType = context.args.unitType;
          if (unitType !== UNIT_TYPES.WORKER && unitType !== UNIT_TYPES.SOLDIER) {
            return null;
          }
          const buildingId = this.resolvePlanBuildingId(context, unitType === UNIT_TYPES.WORKER ? BUILDING_TYPES.HQ : BUILDING_TYPES.BARRACKS);
          return buildingId ? this.createCommand("spawn", { buildingId, unitType }) : null;
        },
      },
      build_structure: {
        defaultScope: "global",
        defaultRetry: true,
        validateArgs: (args) =>
          this.hasOptionalPlanUnitId(args) &&
          args.buildingType === BUILDING_TYPES.BARRACKS &&
          Number.isInteger(args.x) &&
          Number.isInteger(args.y),
        createCommand: (context) => {
          const unitId = this.resolvePlanUnitId(context);
          return unitId && context.args.buildingType === BUILDING_TYPES.BARRACKS && Number.isInteger(context.args.x) && Number.isInteger(context.args.y)
            ? this.createCommand("build", {
                unitId,
                buildingType: BUILDING_TYPES.BARRACKS,
                position: { x: Number(context.args.x), y: Number(context.args.y) },
              })
            : null;
        },
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
      },
      hold_unit: {
        defaultScope: "per_unit",
        validateArgs: (args) => this.hasOptionalPlanUnitId(args),
        createCommand: (context) => {
          const unitId = this.resolvePlanUnitId(context);
          return unitId ? this.createCommand("hold", { unitId }) : null;
        },
      },
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

  private resolvePlanBuildingId(context: PlanToolContext, fallbackType: "hq" | "barracks"): string | null {
    const requested = context.args.buildingId;
    if (typeof requested === "string" && requested !== "$hq" && requested !== "$barracks") {
      return requested;
    }
    const type =
      requested === "$hq"
        ? BUILDING_TYPES.HQ
        : requested === "$barracks"
          ? BUILDING_TYPES.BARRACKS
          : context.args.buildingType === BUILDING_TYPES.HQ || context.args.buildingType === BUILDING_TYPES.BARRACKS
            ? context.args.buildingType
            : fallbackType;
    return context.snapshot.myBuildings.find((building) => building.type === type && building.exists)?.id ?? null;
  }

  private resolveTargetPriority(value: unknown): Array<"soldier" | "worker"> | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const priority = value.filter((entry): entry is "soldier" | "worker" => entry === UNIT_TYPES.SOLDIER || entry === UNIT_TYPES.WORKER);
    return priority.length > 0 ? priority : undefined;
  }

  private renderAsciiMap(state: ReturnType<Game["getState"]>): string {
    const height = state.tiles.length;
    const width = state.tiles[0]?.length ?? 0;
    const grid: string[][] = state.tiles.map((row) =>
      row.map((tile) => {
        switch (tile.type) {
          case TILE_TYPES.OBSTACLE:
            return "#";
          case TILE_TYPES.RESOURCE:
            return "*";
          default:
            return ".";
        }
      })
    );

    const symbolFor = (relation: "self" | "enemy", type: string): string => {
      const upper =
        type === BUILDING_TYPES.HQ
          ? "H"
          : type === BUILDING_TYPES.BARRACKS
            ? "B"
            : type === UNIT_TYPES.SOLDIER
              ? "S"
              : type === UNIT_TYPES.WORKER
                ? "W"
                : "?";
      return relation === "self" ? upper : upper.toLowerCase();
    };

    for (const player of state.players) {
      const relation = player.id === this.playerId ? "self" : "enemy";
      for (const building of player.buildings.filter((candidate) => candidate.exists)) {
        if (building.y >= 0 && building.y < height && building.x >= 0 && building.x < width) {
          grid[building.y][building.x] = symbolFor(relation, building.type);
        }
      }
    }

    for (const player of state.players) {
      const relation = player.id === this.playerId ? "self" : "enemy";
      for (const unit of player.units.filter((candidate) => candidate.exists)) {
        if (unit.y >= 0 && unit.y < height && unit.x >= 0 && unit.x < width) {
          grid[unit.y][unit.x] = symbolFor(relation, unit.type);
        }
      }
    }

    return grid.map((row) => row.join("")).join("\n");
  }

  getMyState(args?: { trackRead?: boolean }): ExecutedToolResult {
    const state = this.game.getState();
    this.trackRead(state.tick, args?.trackRead);
    const me = state.players.find((player) => player.id === this.playerId)!;
    const hq = me.buildings.find((building) => building.type === BUILDING_TYPES.HQ) ?? null;
    return {
      effect: "read",
      result: {
        tick: state.tick,
        credits: me.resources.credits,
        hq,
        buildings: me.buildings.filter((building) => building.exists),
        productionQueues: me.buildings
          .filter((building) => building.exists)
          .map((building) => ({ buildingId: building.id, queue: building.productionQueue })),
        canBuildBarracks: me.resources.credits >= BUILDING_STATS.barracks.cost,
        canSpawnWorker: me.resources.credits >= UNIT_STATS.worker.cost,
        canSpawnSoldier: me.resources.credits >= UNIT_STATS.soldier.cost,
        callToArms: this.game.getCallToArmsStatus(this.playerId),
      },
    };
  }

  getMyUnits(args?: { trackRead?: boolean }): ExecutedToolResult {
    const state = this.game.getState();
    this.trackRead(state.tick, args?.trackRead);
    const me = state.players.find((player) => player.id === this.playerId)!;
    const plannedUnitIds = new Set(this.planRuntime.getActivePlans().flatMap((plan) => plan.unitIds));
    return {
      effect: "read",
      result: {
        tick: state.tick,
        units: me.units
          .filter((unit) => unit.exists)
          .map((unit) => ({
            ...unit,
            hasActivePlan: plannedUnitIds.has(unit.id),
          })),
      },
    };
  }

  getRecentEvents(args?: { trackRead?: boolean }): ExecutedToolResult {
    const state = this.game.getState();
    this.trackRead(state.tick, args?.trackRead);
    return {
      effect: "read",
      result: {
        tick: state.tick,
        events: this.game.getAIFeedback(this.playerId).slice(-20),
      },
    };
  }

  getActivePlansTool(args?: { trackRead?: boolean }): ExecutedToolResult {
    const state = this.game.getState();
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
    const unit = this.getFriendlyUnit(unitId);
    if (!unit) {
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "Choose an existing friendly unit from get_my_units.",
      });
    }

    this.planRuntime.interruptUnit(unitId);
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

  attackMoveUnit(unitId: string, position: Position, targetPriority?: Array<"soldier" | "worker">): ExecutedToolResult {
    const state = this.game.getState();
    const unit = this.getFriendlyUnit(unitId);
    if (!unit) {
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "Choose an existing friendly unit from get_my_units.",
      });
    }

    if (!this.canUnitAttack(unit)) {
      return this.actionResult({
        ok: false,
        error: "invalid_attacker",
        hint: "Choose a friendly unit with attack capability, such as a soldier.",
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

    const priority = targetPriority && targetPriority.length > 0 ? targetPriority : [UNIT_TYPES.SOLDIER, UNIT_TYPES.WORKER];
    this.planRuntime.interruptUnit(unitId);
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
    const attacker = this.getFriendlyUnit(unitId);
    if (!attacker) {
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "Choose an existing friendly attacker from get_my_units.",
      });
    }

    if (!this.canUnitAttack(attacker)) {
      return this.actionResult({
        ok: false,
        error: "invalid_attacker",
        hint: "Choose a friendly unit with attack capability, such as a soldier, or activate Call to Arms before ordering workers to attack.",
      });
    }

    const resolution = this.resolveAttackOrderCommand(unitId, targetId);
    if (!resolution.ok) {
      return this.actionResult({
        ok: false,
        error: resolution.error,
        hint: resolution.hint,
      });
    }

    this.planRuntime.interruptUnit(unitId);
    if (resolution.completedAfterCommand) {
      this.attackOrders.delete(unitId);
    } else {
      this.attackOrders.set(unitId, { unitId, targetId });
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

  spawnUnit(buildingId: string, unitType: "worker" | "soldier"): ExecutedToolResult {
    const state = this.game.getState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    const building = me.buildings.find((candidate) => candidate.id === buildingId && candidate.exists);
    if (!building) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_building",
          hint: "Choose a building from get_my_state.buildings.",
        }),
      };
    }

    const canProduce =
      (building.type === BUILDING_TYPES.HQ && unitType === "worker") ||
      (building.type === BUILDING_TYPES.BARRACKS && unitType === "soldier");
    if (!canProduce) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_spawn_request",
          hint:
            building.type === BUILDING_TYPES.HQ
              ? "HQ can only spawn workers."
              : "Barracks can only spawn soldiers.",
        }),
      };
    }

    const cost = UNIT_STATS[unitType].cost;
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

  buildStructure(unitId: string, buildingType: "barracks", position: Position): ExecutedToolResult {
    const state = this.game.getState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    const worker = me.units.find((candidate) => candidate.id === unitId && candidate.exists);
    if (!worker || worker.type !== "worker") {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_unit",
          hint: "Choose a friendly worker from get_my_units.",
        }),
      };
    }

    const cost = BUILDING_STATS[buildingType].cost;
    if (me.resources.credits < cost) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "insufficient_credits",
          hint: this.buildBarracksHint(`Need ${cost} credits before building a barracks.`),
        }),
      };
    }

    const validation = this.validateBarracksBuildPosition(position);
    if (!validation.ok) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_build_position",
          hint: this.buildBarracksHint(validation.hint),
        }),
      };
    }

    this.planRuntime.interruptUnit(unitId);
    this.attackOrders.delete(unitId);
    const command = this.enqueue(this.createCommand("build", { unitId, buildingType, position }));
    return {
      effect: "action",
      result: this.withActionMetadata({
        ok: true,
        commandId: command.id,
      }),
    };
  }

  startHarvestLoop(unitId: string, position?: Position): ExecutedToolResult {
    const state = this.game.getState();
    const unit = this.getFriendlyUnit(unitId);
    if (!unit || unit.type !== UNIT_TYPES.WORKER) {
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "Choose an existing friendly worker from get_my_units.",
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
        hint: "Choose a resource tile inside the map bounds, or omit x/y to auto-pick the nearest resource.",
      });
    }

    if (position && state.tiles[position.y]?.[position.x]?.type !== TILE_TYPES.RESOURCE) {
      return this.actionResult({
        ok: false,
        error: "invalid_resource_target",
        hint: "Choose a resource tile, or omit x/y to auto-pick the nearest resource.",
      });
    }

    this.planRuntime.interruptUnit(unitId);
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
    const unit = this.getFriendlyUnit(unitId);
    if (!unit) {
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "Choose an existing friendly unit from get_my_units.",
      });
    }

    this.planRuntime.interruptUnit(unitId);
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

  callToArms(): ExecutedToolResult {
    const status = this.game.getCallToArmsStatus(this.playerId);
    if (status.used || this.pendingCallToArms) {
      return this.actionResult({
        ok: false,
        error: "call_to_arms_already_used",
        hint: "Call to Arms can only be successfully activated once per player per match.",
      });
    }

    const state = this.game.getState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    const affectedWorkers = me.units.filter((unit) => unit.exists && unit.type === UNIT_TYPES.WORKER);
    if (affectedWorkers.length === 0) {
      return this.actionResult({
        ok: false,
        error: "call_to_arms_no_workers",
        hint: "Call to Arms only affects workers that are alive now.",
      });
    }

    this.pendingCallToArms = true;
    const command = this.enqueue(this.createCommand("call_to_arms", {}));
    return {
      effect: "action",
      result: this.withActionMetadata({
        ok: true,
        commandId: command.id,
        affectedWorkerIds: affectedWorkers.map((worker) => worker.id),
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
        this.planRuntime.interruptUnit(unitId);
      }
    }
    const record = this.planRuntime.register(normalizedInput);
    this.runPlanRecords.push(record);
    return {
      effect: "plan",
      result: this.withActionMetadata({
        ok: true,
        planId: record.planId,
        unitIds: record.unitIds,
        loop: record.loop,
        status: record.status,
      }),
    };
  }

  private enqueue(command: Command): Command {
    this.issuedCommands.push(command);
    this.game.queueCommand(command);
    return command;
  }

  private createCommand(type: string, payload: Partial<Command>): Command {
    return {
      id: `agent_cmd_${this.playerId}_${++this.commandCounter}`,
      type,
      playerId: this.playerId,
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
    const currentTick = this.game.getState().tick;
    const staleWarning = this.getStaleReadWarning(currentTick);
    return {
      tick: currentTick,
      ...result,
      ...(staleWarning ? { warning: staleWarning } : {}),
    };
  }

  private getStaleReadWarning(currentTick: number): Record<string, unknown> | null {
    if (this.lastReadTick === null) {
      return {
        type: "no_recent_read",
        message: "No read tool has been called in this run. Read the current situation before issuing more actions.",
        currentTick,
        staleAfterTicks: STALE_READ_WARNING_TICKS,
      };
    }

    const ageTicks = currentTick - this.lastReadTick;
    if (ageTicks <= STALE_READ_WARNING_TICKS) {
      return null;
    }

    return {
      type: "state_stale",
      message: `Last read was ${ageTicks} ticks ago. Read the current situation before issuing more actions.`,
      lastReadTick: this.lastReadTick,
      currentTick,
      ageTicks,
      staleAfterTicks: STALE_READ_WARNING_TICKS,
    };
  }

  private getFriendlyUnit(unitId: string) {
    const state = this.game.getState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    return me.units.find((candidate) => candidate.id === unitId && candidate.exists) ?? null;
  }

  private getEnemyTarget(targetId: string) {
    const state = this.game.getState();
    for (const player of state.players.filter((candidate) => candidate.id !== this.playerId)) {
      const unit = player.units.find((candidate) => candidate.id === targetId && candidate.exists);
      if (unit) {
        this.targetMemory.set(unit.id, { id: unit.id, type: unit.type, x: unit.x, y: unit.y, tick: state.tick });
        return unit;
      }
      const building = player.buildings.find((candidate) => candidate.id === targetId && candidate.exists);
      if (building) {
        this.targetMemory.set(building.id, {
          id: building.id,
          type: building.type,
          x: building.x,
          y: building.y,
          tick: state.tick,
        });
        return building;
      }
    }
    return null;
  }

  private rememberVisibleEnemyTargets(state: ReturnType<Game["getState"]>): void {
    for (const player of state.players.filter((candidate) => candidate.id !== this.playerId)) {
      for (const unit of player.units.filter((candidate) => candidate.exists)) {
        this.targetMemory.set(unit.id, { id: unit.id, type: unit.type, x: unit.x, y: unit.y, tick: state.tick });
      }
      for (const building of player.buildings.filter((candidate) => candidate.exists)) {
        this.targetMemory.set(building.id, {
          id: building.id,
          type: building.type,
          x: building.x,
          y: building.y,
          tick: state.tick,
        });
      }
    }
  }

  private advanceAttackOrders(): Command[] {
    const commands: Command[] = [];
    for (const [unitId, order] of this.attackOrders) {
      const unit = this.getFriendlyUnit(unitId);
      if (!unit || !this.canUnitAttack(unit)) {
        this.attackOrders.delete(unitId);
        continue;
      }

      const resolution = this.resolveAttackOrderCommand(order.unitId, order.targetId);
      if (!resolution.ok) {
        this.attackOrders.delete(unitId);
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
      return { ok: false, error: "invalid_unit", hint: "Choose an existing friendly attacker from get_my_units." };
    }

    const target = this.getEnemyTarget(targetId);
    if (target) {
      const inRange =
        Math.max(Math.abs(attacker.x - target.x), Math.abs(attacker.y - target.y)) <=
        this.getUnitAttackRange(attacker);
      if (inRange) {
        return {
          ok: true,
          command: this.createCommand("attack", { unitId, targetId }),
          mode: "attack",
          completedAfterCommand: false,
        };
      }

      return {
        ok: true,
        command: this.createCommand("move", { unitId, position: { x: target.x, y: target.y } }),
        mode: "move_to_target",
        completedAfterCommand: false,
      };
    }

    const lastSeen = this.targetMemory.get(targetId);
    if (!lastSeen) {
      return {
        ok: false,
        error: "unknown_target",
        hint: "Target is not currently visible and has no remembered position. Read get_map_state before attacking it.",
      };
    }

    return {
      ok: true,
      command: this.createCommand("move", { unitId, position: { x: lastSeen.x, y: lastSeen.y } }),
      mode: "move_to_last_seen",
      completedAfterCommand: true,
    };
  }

  private getPlanSnapshot() {
    const state = this.game.getState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    return {
      tick: state.tick,
      myCredits: me.resources.credits,
      myUnits: me.units.filter((unit) => unit.exists),
      myBuildings: me.buildings.filter((building) => building.exists),
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

  private getSuggestedBarracksSites(limit = 3): Position[] {
    const state = this.game.getState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    const hq = me.buildings.find((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    if (!hq) {
      return [];
    }

    const preferredX = hq.x + (hq.x < state.tiles[0]?.length / 2 ? 2 : -2);
    const candidates: Position[] = [];
    for (let y = 0; y < state.tiles.length; y++) {
      for (let x = 0; x < (state.tiles[y]?.length ?? 0); x++) {
        const validation = this.validateBarracksBuildPosition({ x, y });
        if (validation.ok) {
          candidates.push({ x, y });
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
      })
      .slice(0, limit);
  }

  private buildBarracksHint(baseHint: string): string {
    const suggestions = this.getSuggestedBarracksSites()
      .map((site) => `(${site.x}, ${site.y})`)
      .join(", ");
    if (!suggestions) {
      return `${baseHint} Barracks must be on an empty tile and leave one empty ring around HQ.`;
    }
    return `${baseHint} Try an empty tile that leaves one empty ring around HQ, for example: ${suggestions}.`;
  }

  private validateBarracksBuildPosition(position: Position): { ok: true } | { ok: false; hint: string } {
    const state = this.game.getState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    const hq = me.buildings.find((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    const { x, y } = position;

    if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= state.tiles.length || x < 0 || x >= (state.tiles[y]?.length ?? 0)) {
      return { ok: false, hint: "Choose an empty tile inside the map bounds." };
    }

    const tile = state.tiles[y]?.[x];
    if (!tile || tile.type !== "empty") {
      return { ok: false, hint: tile?.type === "obstacle" ? "That tile is blocked by terrain." : "That tile is not buildable." };
    }

    const occupiedByBuilding = state.players.some((player) =>
      player.buildings.some((building) => building.exists && building.x === x && building.y === y)
    );
    if (occupiedByBuilding) {
      return { ok: false, hint: "That tile is already occupied by a building." };
    }

    const occupiedByUnit = state.players.some((player) =>
      player.units.some((unit) => unit.exists && unit.x === x && unit.y === y)
    );
    if (occupiedByUnit) {
      return { ok: false, hint: "That tile is occupied by a unit right now." };
    }

    if (hq && Math.max(Math.abs(hq.x - x), Math.abs(hq.y - y)) <= 1) {
      return { ok: false, hint: "Leave at least one empty tile around HQ before placing barracks." };
    }

    return { ok: true };
  }

  private validatePlanInput(input: OrchestratePlanInput): { ok: true; value: OrchestratePlanInput } | { ok: false; hint: string } {
    if (!input || !Array.isArray(input.unitIds) || input.unitIds.length === 0) {
      return { ok: false, hint: "unitIds must contain at least one friendly unit id." };
    }

    const state = this.game.getState();
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
      case "target_in_range":
      case "target_destroyed":
        return typeof value.targetId === "string";
      case "credits_at_least":
        return typeof value.amount === "number" && Number.isInteger(value.amount) && value.amount >= 0;
      case "building_exists":
        return (
          (value.buildingType === BUILDING_TYPES.HQ || value.buildingType === BUILDING_TYPES.BARRACKS) &&
          (value.count === undefined || (Number.isInteger(value.count) && Number(value.count) > 0))
        );
      case "unit_count_at_least":
        return (
          (value.unitType === UNIT_TYPES.WORKER || value.unitType === UNIT_TYPES.SOLDIER) &&
          Number.isInteger(value.count) &&
          Number(value.count) >= 0
        );
      case "production_queue_empty":
        return (
          (value.buildingId === undefined || typeof value.buildingId === "string") &&
          (value.buildingType === undefined || value.buildingType === BUILDING_TYPES.HQ || value.buildingType === BUILDING_TYPES.BARRACKS) &&
          (value.buildingId !== undefined || value.buildingType !== undefined)
        );
      default:
        return true;
    }
  }

  private isOptionalTargetPriority(value: unknown): boolean {
    return (
      value === undefined ||
      (Array.isArray(value) && value.every((entry) => entry === UNIT_TYPES.SOLDIER || entry === UNIT_TYPES.WORKER))
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private canUnitAttack(unit: { type: string; statusEffects?: Array<{ type: string; expiresTick: number }> }): boolean {
    return (
      unit.type === UNIT_TYPES.SOLDIER ||
      this.hasActiveCallToArms(unit) ||
      (this.pendingCallToArms && unit.type === UNIT_TYPES.WORKER)
    );
  }

  private getUnitAttackRange(unit: { attackRange: number; type: string; statusEffects?: Array<Record<string, unknown>> }): number {
    const callToArms = unit.statusEffects?.find(
      (effect) => effect.type === "call_to_arms" && typeof effect.expiresTick === "number" && effect.expiresTick > this.game.getTick()
    );
    if (callToArms && typeof callToArms.attackRange === "number") {
      return callToArms.attackRange;
    }
    return this.pendingCallToArms && unit.type === UNIT_TYPES.WORKER ? 1 : unit.attackRange;
  }

  private hasActiveCallToArms(unit: { statusEffects?: Array<{ type: string; expiresTick: number }> }): boolean {
    return Boolean(
      unit.statusEffects?.some((effect) => effect.type === "call_to_arms" && effect.expiresTick > this.game.getTick())
    );
  }
}
