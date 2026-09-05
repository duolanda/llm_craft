import { useState } from "react";
import {
  BUILDING_TYPES,
  getProductionOptions,
  type Building,
  type GameRecord,
  type GameState,
  type Player,
  type PlayerId,
  type UnitType,
  UNIT_TYPES,
} from "@llmcraft/shared";
import {
  BUILDING_LABELS,
  formatTickDuration,
  getBuildingDisplayName,
  PLAYER_LABELS,
  PRODUCTION_STATUS_LABELS,
  UNIT_COLORS,
  UNIT_LABELS,
  UNIT_SHORT_LABELS,
} from "../lib/entityPresentation";

interface StatsPanelProps {
  state: GameState | null;
  tickIntervalMs?: number;
  recordedPlayers?: GameRecord["metadata"]["players"];
}

const COMBAT_UNIT_TYPES: UnitType[] = [
  UNIT_TYPES.SOLDIER,
  UNIT_TYPES.RIFLEMAN,
  UNIT_TYPES.ROCKET_SOLDIER,
  UNIT_TYPES.COMMANDO,
  UNIT_TYPES.LIGHT_TANK,
  UNIT_TYPES.FLAME_TANK,
  UNIT_TYPES.HEAVY_TANK,
];

const VEHICLE_UNIT_TYPES = new Set<UnitType>([
  UNIT_TYPES.LIGHT_TANK,
  UNIT_TYPES.FLAME_TANK,
  UNIT_TYPES.HEAVY_TANK,
]);

const BUILDING_ORDER = [
  BUILDING_TYPES.HQ,
  BUILDING_TYPES.BARRACKS,
  BUILDING_TYPES.WAR_FACTORY,
  BUILDING_TYPES.REFINERY,
  BUILDING_TYPES.MACHINE_GUN_TURRET,
  BUILDING_TYPES.ANTI_TANK_TURRET,
  BUILDING_TYPES.TECH_CENTER,
] as const;

function formatTime(tick: number, tickIntervalMs: number): string {
  const seconds = Math.floor((tick * tickIntervalMs) / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function getTechTier(player: Player): 1 | 2 | 3 {
  const completedBuildings = player.buildings.filter((building) => building.exists && !building.constructionProgress);
  if (completedBuildings.some((building) => building.type === BUILDING_TYPES.TECH_CENTER)) return 3;
  if (completedBuildings.some((building) => building.type === BUILDING_TYPES.WAR_FACTORY)) return 2;
  return 1;
}

function getRecordedModel(players: GameRecord["metadata"]["players"], playerId: PlayerId): string {
  const participant = Array.isArray(players) ? players.find((player) => player?.playerId === playerId) : undefined;
  const model = typeof participant?.model === "string" ? participant.model.trim() : undefined;
  return !model || model === "unknown" || model === "legacy-record" ? "模型未记录" : model;
}

function ForceCard({ player, model }: { player: Player; model?: string }) {
  const [hoveredUnitType, setHoveredUnitType] = useState<UnitType | null>(null);
  const livingUnits = player.units.filter((unit) => unit.exists);
  const combatUnits = livingUnits.filter((unit) => unit.type !== UNIT_TYPES.WORKER);
  const workers = livingUnits.length - combatUnits.length;
  const vehicles = combatUnits.filter((unit) => VEHICLE_UNIT_TYPES.has(unit.type)).length;
  const infantry = combatUnits.length - vehicles;
  const buildings = player.buildings.filter((building) => building.exists);
  const hq = buildings.find((building) => building.type === BUILDING_TYPES.HQ);
  const hqRatio = hq ? Math.max(0, Math.min(1, hq.hp / Math.max(1, hq.maxHp))) : 0;
  const unitCounts = new Map<UnitType, number>();
  for (const unit of livingUnits) {
    unitCounts.set(unit.type, (unitCounts.get(unit.type) ?? 0) + 1);
  }
  const composition = COMBAT_UNIT_TYPES
    .map((unitType) => ({ unitType, count: unitCounts.get(unitType) ?? 0 }))
    .filter((entry) => entry.count > 0);
  const activeComposition = composition.find((entry) =>
    entry.unitType === hoveredUnitType
  );
  const sideClass = player.id === "player_1" ? "red" : "blue";

  return (
    <article className={`force-card ${sideClass}`}>
      <header className="force-card-header">
        <span className="force-side-mark" />
        <span>{PLAYER_LABELS[player.id]}</span>
        <span className="force-tier">T{getTechTier(player)}</span>
      </header>
      {model && (
        <div className="force-model" title={model} aria-label={`${PLAYER_LABELS[player.id]}对战模型`}>
          {model}
        </div>
      )}

      <div className="force-card-main">
        <div className="force-total">
          <strong>{combatUnits.length}</strong>
          <span>作战单位</span>
        </div>
        <div className="force-quick-stats">
          <span><b>{workers}</b> 工人</span>
          <span><b>{Math.floor(player.resources.credits)}</b> 资金</span>
        </div>
      </div>

      <div className="force-breakdown" aria-label={`步兵 ${infantry}，载具 ${vehicles}，建筑 ${buildings.length}`}>
        <span>步兵 <b>{infantry}</b></span>
        <span>载具 <b>{vehicles}</b></span>
        <span>建筑 <b>{buildings.length}</b></span>
      </div>

      <div className="hq-status">
        <div className="hq-status-label">
          <span>总部完整度</span>
          <b>{hq ? `${Math.ceil(hq.hp)} / ${hq.maxHp}` : "已摧毁"}</b>
        </div>
        <div className="hq-health-track">
          <span style={{ width: `${hqRatio * 100}%` }} />
        </div>
      </div>

      <div className="composition-row">
        <span className="composition-label">兵种构成</span>
        <div className="composition-track">
          {composition.length > 0 ? composition.map(({ unitType, count }) => (
            <span
              key={unitType}
              className="composition-segment"
              style={{
                background: UNIT_COLORS[unitType],
                flexGrow: count,
              }}
              aria-label={`${UNIT_LABELS[unitType]} ${count}`}
              onPointerEnter={() => setHoveredUnitType(unitType)}
              onPointerLeave={() => setHoveredUnitType(null)}
            />
          )) : <span className="composition-empty">暂无作战单位</span>}
        </div>
        <div className="composition-detail" aria-live="polite">
          {activeComposition ? (
            <>
              <span>
                <i style={{ background: UNIT_COLORS[activeComposition.unitType] }} />
                {UNIT_LABELS[activeComposition.unitType]}
              </span>
              <b>× {activeComposition.count}</b>
            </>
          ) : (
            <span className="composition-detail-hint">
              {composition.length > 0 ? "悬停色块查看兵种" : "暂无作战单位"}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function progressRatio(remainingTicks: number, totalTicks: number): number {
  if (totalTicks <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - remainingTicks / totalTicks));
}

function ProductionBuildingCard({
  building,
  tickIntervalMs,
}: {
  building: Building;
  tickIntervalMs: number;
}) {
  const progress = building.productionProgress;
  const construction = building.constructionProgress;
  const isWaiting = progress?.status !== undefined && progress.status !== "producing";
  const activeUnitType = progress?.unitType ?? building.productionQueue[0]?.unitType;
  const percent = progress
    ? Math.round(progressRatio(progress.remainingTicks, progress.totalTicks) * 100)
    : 0;
  const queuedOrders = building.productionQueue
    .map((order) => ({
      ...order,
      remainingCount: Math.max(
        0,
        order.remainingCount - (progress?.orderId === order.orderId ? 1 : 0),
      ),
    }))
    .filter((order) => order.remainingCount > 0);
  const visibleOrders = queuedOrders.slice(0, 3);
  const hiddenOrderCount = queuedOrders.length - visibleOrders.length;
  const hpRatio = Math.max(0, Math.min(1, building.hp / Math.max(1, building.maxHp)));

  return (
    <article className={`production-card${isWaiting ? " waiting" : ""}`} title={building.id}>
      <header className="production-card-header">
        <div>
          <strong>{getBuildingDisplayName(building)}</strong>
          <span>{Math.ceil(building.hp)} / {building.maxHp} HP</span>
        </div>
        <div className="building-health-mini" aria-label={`建筑生命值 ${Math.round(hpRatio * 100)}%`}>
          <span style={{ width: `${hpRatio * 100}%` }} />
        </div>
      </header>

      {construction ? (
        <div className="production-active construction-active">
          <div className="production-active-line">
            <span className="production-state-dot" />
            <strong>建筑施工中</strong>
            <b>{Math.round(progressRatio(construction.remainingTicks, construction.totalTicks) * 100)}%</b>
          </div>
          <div className="production-progress-track">
            <span style={{ width: `${progressRatio(construction.remainingTicks, construction.totalTicks) * 100}%` }} />
          </div>
          <span className="production-detail">
            预计 {formatTickDuration(construction.remainingTicks, tickIntervalMs)} 完成
          </span>
        </div>
      ) : activeUnitType ? (
        <div className="production-active">
          <div className="production-active-line">
            <span className="production-state-dot" />
            <strong>{UNIT_LABELS[activeUnitType]}</strong>
            <b>{progress ? `${percent}%` : "待启动"}</b>
          </div>
          <div className="production-progress-track">
            <span style={{ width: `${percent}%` }} />
          </div>
          <span className="production-detail">
            {progress
              ? `${PRODUCTION_STATUS_LABELS[progress.status]} · ${formatTickDuration(progress.remainingTicks, tickIntervalMs)}`
              : "订单已进入生产线"}
            {progress?.missingPrerequisites?.length
              ? ` · 缺少 ${progress.missingPrerequisites.map((type) => BUILDING_LABELS[type]).join("、")}`
              : ""}
          </span>
        </div>
      ) : (
        <div className="production-idle">
          <span className="production-state-dot" />
          <span>生产线空闲</span>
        </div>
      )}

      {!construction && (
        <div className="production-queue-row">
          <span className="queue-label">后续</span>
          <div className="queue-chips">
            {visibleOrders.length > 0 ? visibleOrders.map((order) => (
              <span key={order.orderId} className="queue-chip" title={order.orderId}>
                {UNIT_SHORT_LABELS[order.unitType]} ×{order.remainingCount}
              </span>
            )) : <span className="queue-empty">无排队订单</span>}
            {hiddenOrderCount > 0 && <span className="queue-more">+{hiddenOrderCount} 项</span>}
          </div>
        </div>
      )}
    </article>
  );
}

function ConstructionProject({
  building,
  tickIntervalMs,
}: {
  building: Building;
  tickIntervalMs: number;
}) {
  const progress = building.constructionProgress;
  if (!progress) return null;
  const percent = Math.round(progressRatio(progress.remainingTicks, progress.totalTicks) * 100);
  return (
    <div className="construction-project" title={building.id}>
      <span>{getBuildingDisplayName(building)}</span>
      <div className="construction-project-progress">
        <span style={{ width: `${percent}%` }} />
      </div>
      <b>{percent}% · {formatTickDuration(progress.remainingTicks, tickIntervalMs)}</b>
    </div>
  );
}

function ProductionLane({ player, tickIntervalMs }: { player: Player; tickIntervalMs: number }) {
  const sideClass = player.id === "player_1" ? "red" : "blue";
  const livingBuildings = player.buildings.filter((building) => building.exists);
  const productionBuildings = livingBuildings
    .filter((building) => getProductionOptions(building.type).length > 0)
    .sort((left, right) => {
      const typeDifference = BUILDING_ORDER.indexOf(left.type) - BUILDING_ORDER.indexOf(right.type);
      return typeDifference || left.id.localeCompare(right.id);
    });
  const otherConstruction = livingBuildings.filter((building) =>
    building.constructionProgress && getProductionOptions(building.type).length === 0
  );
  const activeLines = productionBuildings.filter((building) =>
    building.constructionProgress || building.productionProgress || building.productionQueue.length > 0
  ).length;

  return (
    <section className={`production-lane ${sideClass}`}>
      <header className="production-lane-header">
        <div>
          <span className="force-side-mark" />
          <strong>{PLAYER_LABELS[player.id]}生产</strong>
        </div>
        <span>{activeLines} / {productionBuildings.length} 条生产线活动</span>
      </header>
      <div className="production-card-list">
        {productionBuildings.length > 0 ? productionBuildings.map((building) => (
          <ProductionBuildingCard
            key={building.id}
            building={building}
            tickIntervalMs={tickIntervalMs}
          />
        )) : <div className="production-lane-empty">暂无生产建筑</div>}
      </div>
      {otherConstruction.length > 0 && (
        <div className="construction-projects">
          <span className="construction-projects-title">在建项目</span>
          {otherConstruction.map((building) => (
            <ConstructionProject key={building.id} building={building} tickIntervalMs={tickIntervalMs} />
          ))}
        </div>
      )}
    </section>
  );
}

export function StatsPanel({ state, tickIntervalMs = 500, recordedPlayers }: StatsPanelProps) {
  if (!state) {
    return <div className="spectator-overview empty-state">等待游戏数据...</div>;
  }

  return (
    <div className="spectator-overview">
      <div className="match-pulse">
        <div>
          <span className="match-pulse-live" />
          <span>战局时间</span>
          <strong>{formatTime(state.tick, tickIntervalMs)}</strong>
        </div>
        <span className="match-pulse-tick">TICK {state.tick}</span>
      </div>

      <div className="force-comparison">
        {state.players.map((player) => (
          <ForceCard
            key={player.id}
            player={player}
            model={recordedPlayers === undefined ? undefined : getRecordedModel(recordedPlayers, player.id)}
          />
        ))}
      </div>

      <section className="production-board">
        <header className="production-board-header">
          <div>
            <span className="production-board-kicker">Production intelligence</span>
            <strong>生产与建设态势</strong>
          </div>
          <span>悬停战场实体查看详情</span>
        </header>
        {state.players.map((player) => (
          <ProductionLane key={player.id} player={player} tickIntervalMs={tickIntervalMs} />
        ))}
      </section>
    </div>
  );
}
