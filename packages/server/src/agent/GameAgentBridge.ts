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
  PlanCondition,
  PlanStep,
  PlayerId,
  Position,
  UNIT_STATS,
} from "@llmcraft/shared";
import { Game } from "../Game";
import { AgentPlanRuntime } from "./AgentPlanRuntime";

type ToolEffect = "read" | "action" | "plan";

export interface ExecutedToolResult {
  effect: ToolEffect;
  result: unknown;
}

const STALE_READ_WARNING_TICKS = 10;
const PLAN_STEP_KINDS = ["move_to", "attack_in_range", "hold_position", "wait_until", "branch", "stop"] as const;
const PLAN_CONDITION_KINDS = ["cargo_full", "cargo_empty", "hq_in_range", "enemy_in_range"] as const;
const TARGET_PRIORITIES = ["hq", "soldier", "worker", "barracks"] as const;

export class GameAgentBridge {
  private issuedCommands: Command[] = [];
  private runPlanRecords: AgentPlanRecord[] = [];
  private commandCounter = 0;
  private lastReadTick: number | null = null;
  private planRuntime: AgentPlanRuntime;

  constructor(private readonly game: Game, private readonly playerId: PlayerId) {
    this.planRuntime = new AgentPlanRuntime({
      move: (unitId, position) => this.createCommand("move", { unitId, position }),
      attackInRange: (unitId, targetPriority) => this.createCommand("attack_in_range", { unitId, targetPriority }),
      hold: (unitId) => this.createCommand("hold", { unitId }),
    });
  }

  beginRun(): void {
    this.issuedCommands = [];
    this.runPlanRecords = [];
    this.lastReadTick = null;
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
    return this.planRuntime.advance(this.getPlanSnapshot());
  }

  getActivePlans(): AgentPlanRecord[] {
    return this.planRuntime.getActivePlans();
  }

  getMapState(args?: { includeEmptyTiles?: boolean; trackRead?: boolean }): ExecutedToolResult {
    const state = this.game.getState();
    this.trackRead(state.tick, args?.trackRead);
    const includeEmptyTiles = args?.includeEmptyTiles === true;
    const cells = new Map<string, AgentMapStateCell>();
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

    for (const row of state.tiles) {
      for (const tile of row) {
        if (includeEmptyTiles || tile.type !== "empty") {
          getOrCreateCell(tile.x, tile.y);
        }
      }
    }

    for (const player of state.players) {
      const relation = player.id === this.playerId ? "self" : "enemy";
      for (const unit of player.units.filter((candidate) => candidate.exists)) {
        const cell = getOrCreateCell(unit.x, unit.y);
        cell.unit = {
          id: unit.id,
          type: unit.type,
          hp: unit.hp,
          state: unit.state,
          relation,
        } satisfies AgentMapStateUnit;
      }
      for (const building of player.buildings.filter((candidate) => candidate.exists)) {
        const cell = getOrCreateCell(building.x, building.y);
        cell.building = {
          id: building.id,
          type: building.type,
          hp: building.hp,
          maxHp: building.maxHp,
          relation,
        } satisfies AgentMapStateBuilding;
      }
    }

    const result: AgentMapState = {
      tick: state.tick,
      width: state.tiles[0]?.length ?? 0,
      height: state.tiles.length,
      cells: Array.from(cells.values()),
    };
    return {
      effect: "read",
      result,
    };
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
    const command = this.enqueue(this.createCommand("move", { unitId, position }));
    return {
      effect: "action",
      result: this.withActionMetadata({
        ok: true,
        commandId: command.id,
      }),
    };
  }

  attackUnit(unitId: string, targetId: string): ExecutedToolResult {
    const attacker = this.getFriendlyUnit(unitId);
    if (!attacker) {
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "Choose an existing friendly attacker from get_my_units.",
      });
    }

    if (UNIT_STATS[attacker.type].attack <= 0) {
      return this.actionResult({
        ok: false,
        error: "invalid_attacker",
        hint: "Choose a friendly unit with attack capability, such as a soldier.",
      });
    }

    if (!this.getEnemyTarget(targetId)) {
      return this.actionResult({
        ok: false,
        error: "invalid_target",
        hint: "Choose an existing enemy unit or building id from get_map_state.",
      });
    }

    this.planRuntime.interruptUnit(unitId);
    const command = this.enqueue(this.createCommand("attack", { unitId, targetId }));
    return {
      effect: "action",
      result: this.withActionMetadata({
        ok: true,
        commandId: command.id,
      }),
    };
  }

  attackInRange(unitId: string, targetPriority?: Array<"hq" | "soldier" | "worker" | "barracks">): ExecutedToolResult {
    const unit = this.getFriendlyUnit(unitId);
    if (!unit) {
      return this.actionResult({
        ok: false,
        error: "invalid_unit",
        hint: "Choose an existing friendly unit from get_my_units.",
      });
    }

    if (UNIT_STATS[unit.type].attack <= 0) {
      return this.actionResult({
        ok: false,
        error: "invalid_attacker",
        hint: "Choose a friendly unit with attack capability, such as a soldier.",
      });
    }

    this.planRuntime.interruptUnit(unitId);
    const command = this.enqueue(this.createCommand("attack_in_range", { unitId, targetPriority }));
    return {
      effect: "action",
      result: this.withActionMetadata({
        ok: true,
        commandId: command.id,
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
    const command = this.enqueue(this.createCommand("build", { unitId, buildingType, position }));
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
          supportedSteps: [...PLAN_STEP_KINDS],
          supportedConditions: [...PLAN_CONDITION_KINDS],
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
        return unit;
      }
      const building = player.buildings.find((candidate) => candidate.id === targetId && candidate.exists);
      if (building) {
        return building;
      }
    }
    return null;
  }

  private getPlanSnapshot() {
    const state = this.game.getState();
    const me = state.players.find((player) => player.id === this.playerId)!;
    return {
      tick: state.tick,
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

    if (!input.steps.every((step) => this.isPlanStep(step))) {
      return {
        ok: false,
        hint: "Unsupported plan DSL. Each step must use the new { do: ... } format, not legacy { type: ... } steps.",
      };
    }

    if (input.loop !== undefined && (!Number.isInteger(input.loop) || input.loop === 0)) {
      return { ok: false, hint: "loop must be an integer and cannot be 0." };
    }

    return {
      ok: true,
      value: {
        unitIds: normalizedUnitIds,
        replaceExisting: input.replaceExisting,
        loop: input.loop,
        steps: structuredClone(input.steps),
      },
    };
  }

  private isPlanStep(value: unknown): value is PlanStep {
    if (!this.isRecord(value) || typeof value.do !== "string") {
      return false;
    }

    switch (value.do) {
      case "move_to":
        return Number.isInteger(value.x) && Number.isInteger(value.y) && (value.formation === undefined || value.formation === "direct" || value.formation === "spread");
      case "attack_in_range":
        return value.priority === undefined || this.isPriorityList(value.priority);
      case "hold_position":
      case "stop":
        return true;
      case "wait_until":
        return (
          this.isPlanCondition(value.condition) &&
          (value.maxTicks === undefined || (typeof value.maxTicks === "number" && Number.isInteger(value.maxTicks) && value.maxTicks >= 0))
        );
      case "branch":
        return (
          this.isPlanCondition(value.if) &&
          Array.isArray(value.then) &&
          value.then.every((entry) => this.isPlanStep(entry)) &&
          (value.else === undefined || (Array.isArray(value.else) && value.else.every((entry) => this.isPlanStep(entry))))
        );
      default:
        return false;
    }
  }

  private isPlanCondition(value: unknown): value is PlanCondition {
    if (typeof value === "string") {
      return PLAN_CONDITION_KINDS.includes(value as (typeof PLAN_CONDITION_KINDS)[number]);
    }

    if (!this.isRecord(value)) {
      return false;
    }

    if (Array.isArray(value.all)) {
      return value.all.every((entry) => this.isPlanCondition(entry));
    }
    if (Array.isArray(value.any)) {
      return value.any.every((entry) => this.isPlanCondition(entry));
    }
    return value.not !== undefined && this.isPlanCondition(value.not);
  }

  private isPriorityList(value: unknown): value is Array<(typeof TARGET_PRIORITIES)[number]> {
    return Array.isArray(value) && value.every((entry) => TARGET_PRIORITIES.includes(entry as (typeof TARGET_PRIORITIES)[number]));
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}
