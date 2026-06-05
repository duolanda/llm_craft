import { BUILDING_TYPES, GameState, UNIT_TYPES, UnitType } from "@llmcraft/shared";

interface StatsPanelProps {
  state: GameState | null;
}

const UNIT_COLORS: Record<string, string> = {
  worker: "#ffb300",
  soldier: "#ff2a4a",
  rifleman: "#8df2a6",
  rocket_soldier: "#ff8840",
  light_tank: "#7dd3fc",
};

const UNIT_LABELS: Record<string, string> = {
  worker: "工人",
  soldier: "士兵",
  rifleman: "步兵",
  rocket_soldier: "火箭",
  light_tank: "轻坦",
};

const DISPLAY_UNIT_TYPES: UnitType[] = [
  UNIT_TYPES.WORKER,
  UNIT_TYPES.SOLDIER,
  UNIT_TYPES.RIFLEMAN,
  UNIT_TYPES.ROCKET_SOLDIER,
  UNIT_TYPES.LIGHT_TANK,
];

export function StatsPanel({ state }: StatsPanelProps) {
  if (!state) {
    return (
      <div className="stats-grid">
        <div className="stat-block" style={{ gridColumn: "1 / -1" }}>
          <div className="empty-state">等待游戏数据...</div>
        </div>
      </div>
    );
  }

  const [player1, player2] = state.players;

  const getUnitCounts = (player: (typeof state.players)[0]) => {
    const units = player.units.filter((u) => u.exists);
    return Object.fromEntries([
      ...DISPLAY_UNIT_TYPES.map((unitType) => [unitType, units.filter((unit) => unit.type === unitType).length]),
      ["total", units.length],
    ]) as Record<UnitType, number> & { total: number };
  };

  const getBuildingCounts = (player: (typeof state.players)[0]) => {
    const buildings = player.buildings.filter((b) => b.exists);
    return {
      hq: buildings.filter((b) => b.type === BUILDING_TYPES.HQ).length,
      barracks: buildings.filter((b) => b.type === BUILDING_TYPES.BARRACKS).length,
      warFactory: buildings.filter((b) => b.type === BUILDING_TYPES.WAR_FACTORY).length,
      total: buildings.length,
    };
  };

  const getHQHealth = (player: (typeof state.players)[0]) => {
    const hq = player.buildings.find((b) => b.type === BUILDING_TYPES.HQ);
    if (!hq) {
      return "0/0";
    }

    return `${Math.max(0, Math.floor(hq.hp))}/${Math.floor(hq.maxHp)}`;
  };

  const p1Units = getUnitCounts(player1);
  const p2Units = getUnitCounts(player2);
  const p1Buildings = getBuildingCounts(player1);
  const p2Buildings = getBuildingCounts(player2);
  const p1HQHealth = getHQHealth(player1);
  const p2HQHealth = getHQHealth(player2);

  const formatTime = (tick: number) => {
    const seconds = Math.floor((tick * 500) / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="stats-grid">
      <div className="stat-block">
        <div className="stat-block-title">
          <span style={{ color: "var(--accent-amber)" }}>◈</span> 模拟进程
        </div>
        <div className="stat-row">
          <span style={{ color: "var(--text-secondary)" }}>Tick</span>
          <span className="stat-value-pair">
            <span className="stat-p1">{state.tick}</span>
            <span className="stat-vs">｜</span>
            <span className="stat-p2">{formatTime(state.tick)}</span>
          </span>
        </div>
      </div>

      <div className="stat-block">
        <div className="stat-block-title">
          <span style={{ color: "var(--accent-purple)" }}>◈</span> 单位编制
        </div>
        <div className="unit-legend-bar">
          {DISPLAY_UNIT_TYPES.map((unitType) => (
            <UnitLegend key={unitType} type={unitType} />
          ))}
        </div>
        <div className="stat-row" style={{ justifyContent: "center", gap: "12px", marginTop: 4 }}>
          <UnitChips counts={p1Units} align="end" />
          <span className="stat-vs">VS</span>
          <UnitChips counts={p2Units} align="start" />
        </div>
        <div className="stat-row" style={{ justifyContent: "center", marginTop: 4 }}>
          <span className="stat-value-pair">
            <span className="stat-p1">{p1Units.total}</span>
            <span className="stat-vs">总计</span>
            <span className="stat-p2">{p2Units.total}</span>
          </span>
        </div>
      </div>

      <div className="stat-block">
        <div className="stat-block-title">
          <span style={{ color: "var(--accent-cyan)" }}>◈</span> 建筑设施
        </div>
        <BuildingRow label="HQ" p1={p1Buildings.hq} p2={p2Buildings.hq} />
        <BuildingRow label="HP" p1={p1HQHealth} p2={p2HQHealth} />
        <BuildingRow label="兵营" p1={p1Buildings.barracks} p2={p2Buildings.barracks} />
        <BuildingRow label="战车工厂" p1={p1Buildings.warFactory} p2={p2Buildings.warFactory} />
      </div>

      <div className="stat-block">
        <div className="stat-block-title">
          <span style={{ color: "var(--accent-green)" }}>◈</span> Credits
        </div>
        <div className="stat-row">
          <span style={{ color: "var(--text-secondary)" }}>当前</span>
          <span className="stat-value-pair">
            <span className="stat-p1">{Math.floor(player1.resources.credits)}</span>
            <span className="stat-vs">｜</span>
            <span className="stat-p2">{Math.floor(player2.resources.credits)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function UnitLegend({ type }: { type: string }) {
  const color = UNIT_COLORS[type];
  return (
    <div className="unit-legend-item">
      <span className="unit-legend-dot" style={{ background: color, boxShadow: `0 0 6px ${color}66` }} />
      <span className="unit-legend-text">{UNIT_LABELS[type]}</span>
    </div>
  );
}

function UnitChips({ counts, align }: { counts: Record<UnitType, number> & { total: number }; align: "start" | "end" }) {
  return (
    <div className="unit-chips" style={{ justifyContent: align === "end" ? "flex-end" : "flex-start" }}>
      {DISPLAY_UNIT_TYPES.map((unitType) => (
        <Chip key={unitType} type={unitType} count={counts[unitType]} />
      ))}
    </div>
  );
}

function Chip({ type, count }: { type: string; count: number }) {
  const color = UNIT_COLORS[type];
  return (
    <span className="unit-chip" style={{ color }}>
      <span className="unit-chip-dot" style={{ background: color }} />
      {count}
    </span>
  );
}

function BuildingRow({ label, p1, p2 }: { label: string; p1: number | string; p2: number | string }) {
  return (
    <div className="stat-row">
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span className="stat-value-pair">
        <span className="stat-p1">{p1}</span>
        <span className="stat-vs">｜</span>
        <span className="stat-p2">{p2}</span>
      </span>
    </div>
  );
}
