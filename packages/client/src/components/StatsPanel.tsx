import { GameState } from "@llmcraft/shared";

interface StatsPanelProps {
  state: GameState | null;
}

const UNIT_COLORS: Record<string, string> = {
  worker: "#ffb300",
  soldier: "#ff2a4a",
};

const UNIT_LABELS: Record<string, string> = {
  worker: "工人",
  soldier: "士兵",
};

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
    return {
      worker: units.filter((u) => u.type === "worker").length,
      soldier: units.filter((u) => u.type === "soldier").length,
      total: units.length,
    };
  };

  const getBuildingCounts = (player: (typeof state.players)[0]) => {
    const buildings = player.buildings.filter((b) => b.exists);
    return {
      hq: buildings.filter((b) => b.type === "hq").length,
      barracks: buildings.filter((b) => b.type === "barracks").length,
      total: buildings.length,
    };
  };

  const p1Units = getUnitCounts(player1);
  const p2Units = getUnitCounts(player2);
  const p1Buildings = getBuildingCounts(player1);
  const p2Buildings = getBuildingCounts(player2);

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
          <UnitLegend type="worker" />
          <UnitLegend type="soldier" />
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
        <BuildingRow label="兵营" p1={p1Buildings.barracks} p2={p2Buildings.barracks} />
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

function UnitChips({ counts, align }: { counts: { worker: number; soldier: number }; align: "start" | "end" }) {
  return (
    <div className="unit-chips" style={{ justifyContent: align === "end" ? "flex-end" : "flex-start" }}>
      <Chip type="worker" count={counts.worker} />
      <Chip type="soldier" count={counts.soldier} />
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

function BuildingRow({ label, p1, p2 }: { label: string; p1: number; p2: number }) {
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
