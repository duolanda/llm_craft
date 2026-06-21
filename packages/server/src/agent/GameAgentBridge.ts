import {
  AgentMapState,
  AgentMapStateBuilding,
  AgentMapStateCell,
  AgentMapStateUnit,
  AgentPlanRecord,
  AttackTargetType,
  BUILDING_TYPES,
  BuildingType,
  Command,
  OrchestratePlanInput,
  PlanCallToolName,
  PlanStep,
  PlanStepScope,
  PlayerId,
  Position,
  TILE_TYPES,
  UNIT_TYPES,
  UnitType,
  canBuildingProduce,
  getDefaultAttackMovePriority,
  getBuildingCost,
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
import { AgentPlanRuntime, PlanToolContext, PlanToolHandlers } from "./AgentPlanRuntime";

type ToolEffect = "read" | "action" | "plan";
type GroupFormation = "line" | "column" | "wedge" | "dispersed";

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
  "enemy_building_exists",
  "unit_count_at_least",
  "enemy_unit_count_at_least",
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
  private readStateCache: AgentReadState | null = null;

  constructor(private readonly game: Game, private readonly playerId: PlayerId) {
    this.planToolHandlers = this.createPlanToolHandlers();
    this.planRuntime = new AgentPlanRuntime(this.planToolHandlers);
  }

  beginRun(): void {
    this.issuedCommands = [];
    this.runPlanRecords = [];
    this.lastReadTick = null;
    this.readStateCache = null;
  }

  beginToolCall(): void {
    this.issuedCommands = [];
    this.runPlanRecords = [];
    this.readStateCache = null;
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

  private getReadState(): AgentReadState {
    const tick = this.game.getTick();
    if (!this.readStateCache || this.readStateCache.tick !== tick) {
      this.readStateCache = this.game.getAgentReadState();
    }
    return this.readStateCache;
  }

  getMapState(args?: { includeCells?: boolean; includeEmptyTiles?: boolean; trackRead?: boolean }): ExecutedToolResult {
    const state = this.getReadState();
    this.trackRead(state.tick, args?.trackRead);
    this.rememberEnemyTargets(state);
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
      fogOfWar: false,
      visibleTileCount: (state.tiles[0]?.length ?? 0) * state.tiles.length,
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
          return buildingId ? this.createCommand("spawn", { buildingId, unitType }) : null;
        },
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
          return unitId && isBuildableBuildingType(context.args.buildingType) && Number.isInteger(context.args.x) && Number.isInteger(context.args.y)
            ? this.createCommand("build", {
                unitId,
                buildingType: context.args.buildingType,
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

  private resolvePlanBuildingId(context: PlanToolContext, fallbackType: BuildingType): string | null {
    const requested = context.args.buildingId;
    if (typeof requested === "string" && !requested.startsWith("$")) {
      return requested;
    }
    const placeholderType = this.resolveBuildingPlaceholder(requested);
    const type = placeholderType ?? (isBuildingType(context.args.buildingType) ? context.args.buildingType : fallbackType);
    return context.snapshot.myBuildings.find((building) => building.type === type && building.exists)?.id ?? null;
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

  private renderAsciiMap(state: AgentReadState): string {
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
            : type === BUILDING_TYPES.WAR_FACTORY
              ? "F"
              : type === BUILDING_TYPES.REFINERY
                ? "D"
              : type === UNIT_TYPES.LIGHT_TANK
                ? "T"
                : type === UNIT_TYPES.ROCKET_SOLDIER
                  ? "R"
                  : type === UNIT_TYPES.RIFLEMAN
                    ? "I"
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
        if (
          building.y >= 0 &&
          building.y < height &&
          building.x >= 0 &&
          building.x < width &&
          building.exists
        ) {
          grid[building.y][building.x] = symbolFor(relation, building.type);
        }
      }
    }

    for (const player of state.players) {
      const relation = player.id === this.playerId ? "self" : "enemy";
      for (const unit of player.units.filter((candidate) => candidate.exists)) {
        if (
          unit.y >= 0 &&
          unit.y < height &&
          unit.x >= 0 &&
          unit.x < width &&
          unit.exists
        ) {
          grid[unit.y][unit.x] = symbolFor(relation, unit.type);
        }
      }
    }

    return grid.map((row) => row.join("")).join("\n");
  }

  getMyState(args?: { trackRead?: boolean }): ExecutedToolResult {
    const state = this.getReadState();
    this.trackRead(state.tick, args?.trackRead);
    const me = state.players.find((player) => player.id === this.playerId)!;
    const enemies = state.players.filter((player) => player.id !== this.playerId);
    const myBuildings = me.buildings.filter((building) => building.exists);
    const myUnits = me.units.filter((unit) => unit.exists);
    const enemyBuildings = enemies.flatMap((player) => player.buildings.filter((building) => building.exists));
    const enemyUnits = enemies.flatMap((player) => player.units.filter((unit) => unit.exists));
    const hq = me.buildings.find((building) => building.type === BUILDING_TYPES.HQ) ?? null;
    const countUnits = (unitType: UnitType) => myUnits.filter((unit) => unit.type === unitType).length;
    const countBuildings = (buildingType: BuildingType) => myBuildings.filter((building) => building.type === buildingType).length;
    const hasBarracks = countBuildings(BUILDING_TYPES.BARRACKS) > 0;
    const hasWarFactory = countBuildings(BUILDING_TYPES.WAR_FACTORY) > 0;
    const hasRefinery = countBuildings(BUILDING_TYPES.REFINERY) > 0;
    const enemyHasWarFactory = enemyBuildings.some((building) => building.type === BUILDING_TYPES.WAR_FACTORY);
    const enemyVehicleCount = enemyUnits.filter((unit) => unit.type === UNIT_TYPES.LIGHT_TANK).length;
    const suggestedBuildSites = this.getSuggestedBuildSites(state);
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
    const economyRecommendations: Array<Record<string, unknown>> = [];
    if (idleWorkers.length > 0) {
      economyRecommendations.push({
        action: "start_harvest_loop",
        reason: "Idle workers should usually be assigned to automatic harvesting before adding more production.",
        unitIds: idleWorkers.map((unit) => unit.id),
      });
    }
    if (activeHarvesters.length < Math.min(2, workers.length)) {
      economyRecommendations.push({
        action: "keep_two_harvesters",
        reason: "The opening economy expects both starting workers to be on harvest_loop.",
      });
    }
    const recommendedStructures: Array<Record<string, unknown>> = [];
    if (!hasBarracks) {
      recommendedStructures.push({
        buildingType: BUILDING_TYPES.BARRACKS,
        cost: getBuildingCost(BUILDING_TYPES.BARRACKS),
        reason: "Unlock infantry production before floating credits.",
        suggestedSites: suggestedBuildSites,
      });
    } else if (!hasRefinery && me.resources.credits >= getBuildingCost(BUILDING_TYPES.REFINERY)) {
      recommendedStructures.push({
        buildingType: BUILDING_TYPES.REFINERY,
        cost: getBuildingCost(BUILDING_TYPES.REFINERY),
        reason: "Expand toward a flank deposit so additional workers can sustain multiple production buildings.",
        suggestedSites: suggestedBuildSites,
      });
    } else if (!hasWarFactory && me.resources.credits >= getBuildingCost(BUILDING_TYPES.WAR_FACTORY)) {
      recommendedStructures.push({
        buildingType: BUILDING_TYPES.WAR_FACTORY,
        cost: getBuildingCost(BUILDING_TYPES.WAR_FACTORY),
        reason: "Tech to light_tank once barracks exists and credits can pay for the factory.",
        suggestedSites: suggestedBuildSites,
      });
    }
    const recommendedProduction: Array<Record<string, unknown>> = [];
    if (hasBarracks) {
      recommendedProduction.push({
        buildingType: BUILDING_TYPES.BARRACKS,
        unitType: enemyVehicleCount > 0 || enemyHasWarFactory ? UNIT_TYPES.ROCKET_SOLDIER : UNIT_TYPES.RIFLEMAN,
        reason: enemyVehicleCount > 0 || enemyHasWarFactory
          ? "Enemy vehicle tech detected; rocket_soldier is the infantry counter."
          : "Rifleman is the default low-cost infantry baseline.",
      });
    }
    if (hasWarFactory) {
      recommendedProduction.push({
        buildingType: BUILDING_TYPES.WAR_FACTORY,
        unitType: UNIT_TYPES.LIGHT_TANK,
        reason: "Light tanks convert factory tech into high-HP structure pressure.",
      });
    }
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
        canBuildWarFactory: me.resources.credits >= getBuildingCost(BUILDING_TYPES.WAR_FACTORY),
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
          recommendations: economyRecommendations,
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
          },
          recommendedStructures,
          recommendedProduction,
        },
      },
    };
  }

  getMyUnits(args?: { trackRead?: boolean }): ExecutedToolResult {
    const state = this.getReadState();
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

  attackMoveUnit(unitId: string, position: Position, targetPriority?: AttackTargetType[]): ExecutedToolResult {
    const state = this.getReadState();
    const unit = this.getFriendlyUnit(unitId);
    if (!unit) {
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "Choose an existing friendly unit from get_my_units.",
      });
    }

    if (!unitCanAttack(unit.type)) {
      return this.actionResult({
        ok: false,
        error: "invalid_attacker",
        hint: "Choose a friendly unit with attack capability, such as a soldier, rifleman, rocket_soldier, or light_tank.",
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

    if (!unitCanAttack(attacker.type)) {
      return this.actionResult({
        ok: false,
        error: "invalid_attacker",
        hint: "Choose a friendly unit with attack capability, such as a soldier, rifleman, rocket_soldier, or light_tank.",
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
          hint: "Choose a building from get_my_state.buildings.",
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

  buildStructure(unitId: string, buildingType: BuildingType, position: Position): ExecutedToolResult {
    const state = this.getReadState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    const worker = me.units.find((candidate) => candidate.id === unitId && candidate.exists);
    if (!worker || worker.type !== UNIT_TYPES.WORKER) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_unit",
          hint: "Choose a friendly worker from get_my_units.",
        }),
      };
    }

    if (!isBuildableBuildingType(buildingType)) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_building",
          hint: "Buildable structures are barracks and war_factory. HQ cannot be built.",
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
          hint: this.buildPlacementHint(`Need ${cost} credits before building ${buildingType}.`, state),
        }),
      };
    }

    const validation = this.validateBuildPosition(position, buildingType, state);
    if (!validation.ok) {
      return {
        effect: "action",
        result: this.withActionMetadata({
          ok: false,
          error: "invalid_build_position",
          hint: this.buildPlacementHint(validation.hint, state),
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
    const state = this.getReadState();
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
    const currentTick = this.game.getTick();
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
    const state = this.getReadState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    return me.units.find((candidate) => candidate.id === unitId && candidate.exists) ?? null;
  }

  private getEnemyTarget(targetId: string) {
    const state = this.getReadState();
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

  attackMoveGroup(unitIds: string[], position: Position, formation: GroupFormation = "line"): ExecutedToolResult {
    const state = this.getReadState();
    const uniqueUnitIds = [...new Set(unitIds.map(String))];
    if (uniqueUnitIds.length === 0 || uniqueUnitIds.length > 100) {
      return this.actionResult({ ok: false, error: "invalid_group", hint: "Choose between 1 and 100 friendly combat units." });
    }
    if (
      !Number.isInteger(position.x) || !Number.isInteger(position.y) ||
      position.y < 0 || position.y >= state.tiles.length ||
      position.x < 0 || position.x >= (state.tiles[position.y]?.length ?? 0)
    ) {
      return this.actionResult({ ok: false, error: "invalid_position", hint: "Choose a formation center inside the map bounds." });
    }

    const units = uniqueUnitIds.map((unitId) => this.getFriendlyUnit(unitId));
    if (units.some((unit) => !unit || !unitCanAttack(unit.type))) {
      return this.actionResult({ ok: false, error: "invalid_group_unit", hint: "Every group member must be an existing friendly combat unit." });
    }

    const assignments = this.createFormationAssignments(uniqueUnitIds, position, formation, state.tiles[0]?.length ?? 1, state.tiles.length);
    const commandIds: string[] = [];
    for (const assignment of assignments) {
      const unit = this.getFriendlyUnit(assignment.unitId)!;
      this.planRuntime.interruptUnit(unit.id);
      this.attackOrders.delete(unit.id);
      const command = this.enqueue(this.createCommand("attack_move", {
        unitId: unit.id,
        position: assignment.position,
        targetPriority: getDefaultAttackMovePriority(unit.type),
      }));
      commandIds.push(command.id);
    }
    return {
      effect: "action",
      result: this.withActionMetadata({ ok: true, commandIds, formation, assignments }),
    };
  }

  private createFormationAssignments(
    unitIds: string[],
    center: Position,
    formation: GroupFormation,
    mapWidth: number,
    mapHeight: number,
  ): Array<{ unitId: string; position: Position }> {
    const backward = this.playerId === "player_1" ? -1 : 1;
    const clamp = (value: number, max: number) => Math.max(0, Math.min(max - 1, value));
    return unitIds.map((unitId, index) => {
      let offsetX = 0;
      let offsetY = 0;
      if (formation === "column") {
        offsetX = backward * Math.floor(index / 3) * 2;
        offsetY = (index % 3 - 1) * 2;
      } else if (formation === "wedge") {
        const rank = Math.floor(Math.sqrt(index));
        const rankStart = rank * rank;
        offsetX = backward * rank * 2;
        offsetY = (index - rankStart - rank) * 2;
      } else if (formation === "dispersed") {
        const columns = Math.ceil(Math.sqrt(unitIds.length));
        offsetX = backward * Math.floor(index / columns) * 3;
        offsetY = (index % columns - (columns - 1) / 2) * 3;
      } else {
        const frontWidth = Math.min(12, unitIds.length);
        offsetX = backward * Math.floor(index / frontWidth) * 2;
        offsetY = (index % frontWidth - (frontWidth - 1) / 2) * 2;
      }
      return {
        unitId,
        position: { x: clamp(Math.round(center.x + offsetX), mapWidth), y: clamp(Math.round(center.y + offsetY), mapHeight) },
      };
    });
  }

  private rememberEnemyTargets(state: AgentReadState): void {
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
      if (!unit || !unitCanAttack(unit.type)) {
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
      const inRange = Math.max(Math.abs(attacker.x - target.x), Math.abs(attacker.y - target.y)) <= attacker.attackRange;
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
    const state = this.getReadState();
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

  private getSuggestedBuildSites(state = this.getReadState(), buildingType: BuildingType = BUILDING_TYPES.WAR_FACTORY, limit = 3): Position[] {
    const me = state.players.find((player) => player.id === this.playerId)!;
    const hq = me.buildings.find((building) => building.type === BUILDING_TYPES.HQ && building.exists);
    if (!hq) {
      return [];
    }

    const preferredX = hq.x + (hq.x < state.tiles[0]?.length / 2 ? 12 : -12);
    const candidates: Position[] = [];
    for (let radius = 5; radius <= 32 && candidates.length < limit * 4; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (const dx of [-radius, radius]) {
          const position = { x: hq.x + dx, y: hq.y + dy };
          if (this.validateBuildPosition(position, buildingType, state).ok) candidates.push(position);
        }
      }
      for (let dx = -radius + 1; dx < radius && candidates.length < limit * 4; dx++) {
        for (const dy of [-radius, radius]) {
          const position = { x: hq.x + dx, y: hq.y + dy };
          if (this.validateBuildPosition(position, buildingType, state).ok) candidates.push(position);
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

  private buildPlacementHint(baseHint: string, state = this.getReadState()): string {
    const suggestions = this.getSuggestedBuildSites(state)
      .map((site) => `(${site.x}, ${site.y})`)
      .join(", ");
    if (!suggestions) {
      return `${baseHint} Structures must be on an empty tile and leave one empty ring around HQ.`;
    }
    return `${baseHint} Try an empty tile that leaves one empty ring around HQ, for example: ${suggestions}.`;
  }

  private validateBuildPosition(position: Position, buildingType: BuildingType, state = this.getReadState()): { ok: true } | { ok: false; hint: string } {
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
      if (state.players.some((player) => player.units.some((unit) => unit.exists && unit.x === cell.x && unit.y === cell.y))) {
        return { ok: false, hint: "The building footprint is occupied by a unit right now." };
      }
      if (state.players.some((player) => player.buildings.some((building) =>
        building.exists && getBuildingFootprintCells(building.type, building.x, building.y).some((occupied) => occupied.x === cell.x && occupied.y === cell.y)
      ))) {
        return { ok: false, hint: "The building footprint overlaps another structure." };
      }
    }

    if (hq && footprint.some((cell) => getDistanceToBuildingFootprint(hq.type, hq.x, hq.y, cell.x, cell.y) <= 1)) {
      return { ok: false, hint: "Leave at least one clear tile between the full building footprint and HQ." };
    }

    return { ok: true };
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
