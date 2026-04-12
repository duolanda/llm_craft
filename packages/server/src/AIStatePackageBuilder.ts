import {
  AIStatePackage,
  AIPromptPayload,
  AIFeedback,
  Building,
  BUILDING_STATS,
  ECONOMY_RULES,
  GameState,
  GameLog,
  TILE_TYPES,
  UNIT_STATS,
  Unit,
  LogType,
  LogMeta,
} from "@llmcraft/shared";
import { Game } from "./Game";

type VisibleEnemy = AIStatePackage["enemies"][number];
type VisibleEnemyBuilding = AIStatePackage["enemyBuildings"][number];

export class AIStatePackageBuilder {
  static build(playerId: string, state: GameState, game?: Game, sinceTick?: number): AIStatePackage {
    const player = state.players.find((p) => p.id === playerId)!;
    const enemy = state.players.find((p) => p.id !== playerId)!;

    // 过滤出 AI 相关日志（替代原有的 aiFeedback 独立存储）
    const allRelevantLogs = state.logs.filter(log =>
      sinceTick === undefined || log.tick > sinceTick
    );
    const aiRelevantLogs = this.filterAIRelevantLogs(allRelevantLogs);
    // 再过滤出当前玩家的日志（logs 里可能混有 he playerId 的日志，如 player_2 的 ai_feedback）
    const playerRelevantLogs = aiRelevantLogs.filter(log =>
      !log.data?.playerId || log.data.playerId === playerId
    );
    const eventsSinceLastCall = playerRelevantLogs.slice(-10);

    const tiles = [];
    for (let y = 0; y < state.tiles.length; y++) {
      for (let x = 0; x < state.tiles[y].length; x++) {
        const tile = state.tiles[y][x];
        if (tile.type !== TILE_TYPES.EMPTY) {
          tiles.push({ x, y, type: tile.type });
        }
      }
    }

    return {
      tick: state.tick,
      my: {
        resources: { ...player.resources },
        units: player.units.filter((u) => u.exists).map((u) => ({ ...u, my: true })),
        buildings: player.buildings.filter((b) => b.exists).map((b) => ({ ...b, my: true })),
      },
      enemies: enemy.units
        .filter((u) => u.exists)
        .map((u) => ({ id: u.id, type: u.type, x: u.x, y: u.y, hp: u.hp, maxHp: u.maxHp })),
      enemyBuildings: enemy.buildings
        .filter((b) => b.exists)
        .map((b) => ({ id: b.id, type: b.type, x: b.x, y: b.y, hp: b.hp, maxHp: b.maxHp })),
      map: {
        width: state.tiles[0]?.length || 0,
        height: state.tiles.length,
        tiles,
      },
      unitStats: UNIT_STATS,
      buildingStats: BUILDING_STATS,
      economy: {
        workerCarryCapacity: ECONOMY_RULES.WORKER_CARRY_CAPACITY,
        workerGatherRate: ECONOMY_RULES.WORKER_GATHER_RATE,
        hqDeliveryRange: ECONOMY_RULES.HQ_DELIVERY_RANGE,
      },
      eventsSinceLastCall,
      // ❌ 删除 aiFeedbackSinceLastCall 字段
      gameTimeRemaining: Math.max(0, 600 - state.tick / 2),
    };
  }

  static buildPromptPayload(
    current: AIStatePackage,
    previous: AIStatePackage | null,
    forceFull: boolean
  ): AIPromptPayload {
    const summary = this.buildSummary(current, previous, forceFull);

    if (forceFull || !previous) {
      return {
        mode: "full",
        tick: current.tick,
        tickIntervalMs: 500,
        summary,
        state: current,
        delta: null,
      };
    }

    const creditsChanged = current.my.resources.credits - previous.my.resources.credits;
    const myUnitChanges = this.diffMyUnits(previous.my.units, current.my.units);
    const myBuildingChanges = this.diffMyBuildings(previous.my.buildings, current.my.buildings);
    const enemyUnitChanges = this.diffEnemyUnits(previous.enemies, current.enemies);
    const enemyBuildingChanges = this.diffEnemyBuildings(previous.enemyBuildings, current.enemyBuildings);

    return {
      mode: "delta",
      tick: current.tick,
      tickIntervalMs: 500,
      summary,
      state: null,
      delta: {
        creditsChanged: creditsChanged === 0 ? undefined : creditsChanged,
        myUnitChanges,
        myBuildingChanges,
        enemyUnitChanges,
        enemyBuildingChanges,
        events: current.eventsSinceLastCall,
        // ❌ 删除 aiFeedback 字段——events 已包含所有 AI 相关日志
      },
    };
  }

  private static buildSummary(
    current: AIStatePackage,
    previous: AIStatePackage | null,
    forceFull: boolean
  ): string {
    const alerts: string[] = [];

    if (this.isHQUnderAttack(current, previous, forceFull)) {
      alerts.push("Alert: our HQ is under attack.");
    }

    const baseSummary =
      forceFull || !previous
        ? "这是完整基线状态。你正在每个 tick 实时下达指令，只需要处理当前局面，不要试图一次性写完全部战术。"
        : "这是自上一轮 AI 调用后的增量状态。你在持续对话中实时发指令，只需根据变化做下一步，不要重写一整套长期脚本。";

    return alerts.length > 0 ? `${alerts.join(" ")}\n${baseSummary}` : baseSummary;
  }

  private static isHQUnderAttack(
    current: AIStatePackage,
    previous: AIStatePackage | null,
    forceFull: boolean
  ): boolean {
    const currentHQ = current.my.buildings.find((building) => building.type === "hq");
    if (!currentHQ) {
      return false;
    }

    if (forceFull || !previous) {
      return currentHQ.hp < currentHQ.maxHp;
    }

    const previousHQ = previous.my.buildings.find((building) => building.type === "hq");
    return Boolean(previousHQ && currentHQ.hp < previousHQ.hp);
  }

  private static diffMyUnits(previous: Unit[], current: Unit[]) {
    return this.diffObjects(previous, current, true);
  }

  private static diffMyBuildings(previous: Building[], current: Building[]) {
    return this.diffObjects(previous, current, false);
  }

  private static diffEnemyUnits(previous: VisibleEnemy[], current: VisibleEnemy[]) {
    return this.diffObjects(previous, current, true);
  }

  private static diffEnemyBuildings(previous: VisibleEnemyBuilding[], current: VisibleEnemyBuilding[]) {
    return this.diffObjects(previous, current, false);
  }

  private static diffObjects(previous: any[], current: any[], movable: boolean) {
    const previousMap = new Map(previous.map((item) => [item.id, item]));
    const currentMap = new Map(current.map((item) => [item.id, item]));
    const changes: any[] = [];

    for (const item of current) {
      const oldItem = previousMap.get(item.id);
      if (!oldItem) {
        changes.push({
          id: item.id,
          type: item.type,
          change: "created",
          x: item.x,
          y: item.y,
          hp: item.hp,
          maxHp: item.maxHp,
          state: item.state,
          carryingCredits: item.carryingCredits,
          carryCapacity: item.carryCapacity,
        });
        continue;
      }

      const moved = movable && (oldItem.x !== item.x || oldItem.y !== item.y);
      const damaged = oldItem.hp !== item.hp;
      const stateChanged = movable && oldItem.state !== item.state;
      const carryingChanged = movable && oldItem.carryingCredits !== item.carryingCredits;

      if (moved || damaged || stateChanged || carryingChanged) {
        changes.push({
          id: item.id,
          type: item.type,
          change: moved ? "moved" : damaged ? "damaged" : "updated",
          x: item.x,
          y: item.y,
          hp: item.hp,
          maxHp: item.maxHp,
          state: item.state,
          carryingCredits: item.carryingCredits,
          carryCapacity: item.carryCapacity,
        });
      }
    }

    for (const item of previous) {
      if (!currentMap.has(item.id)) {
        changes.push({
          id: item.id,
          type: item.type,
          change: "removed",
        });
      }
    }

    return changes;
  }

  // 静态工具：过滤出 AI 相关的日志
  static filterAIRelevantLogs(logs: GameLog[]): GameLog[] {
    return logs.filter(log => {
      const type = log.type;
      const data = log.data || {};

      // AI 相关日志白名单：
      // 1. type 以 'ai_' 开头
      if (type.startsWith('ai_')) return true;

      // 2. type 为 ai_command_feedback
      if (type === 'ai_command_feedback') return true;

      // 3. type 为 command_result 且成功为 false
      if (type === 'command_result' && data.success === false) return true;

      // 4. 兜底：有 phase 字段的（向后兼容旧日志）
      if (data.phase) return true;

      return false;
    });
  }
}
