import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { GameRecord, PlayerId } from "@llmcraft/shared";
import { projectRecordToMatchRecord } from "@llmcraft/record";
import {
  buildMatchDiagnosticReport,
  DiagnosticTag,
  MatchDiagnosticReport,
  PlayerDiagnostic,
  RecordListEntry,
} from "./diagnostics";
import { API_BASE_URL } from "./lib/serverConnection";
import "./diagnosticsViewer.css";

const TAG_LABELS: Record<DiagnosticTag, string> = {
  missed_defense: "未防守",
  late_defense: "防守过慢",
  read_loop_under_pressure: "受压后反复读状态",
  invalid_unit_after_pressure: "受压后引用失效单位",
  spawn_trap: "出生点陷阱",
};

const EVENT_TYPE_LABELS: Record<MatchDiagnosticReport["timeline"][number]["type"], string> = {
  enemy_near_hq: "敌军接近总部",
  hq_damage: "总部受伤",
  hq_death: "总部被毁",
  llm_request: "模型请求",
  read_tool: "读取工具",
  action_tool: "行动工具",
  combat_command: "战斗命令",
  invalid_unit: "失效单位",
  spawn: "生产",
  unit_death: "单位阵亡",
};

interface FlowEvent {
  tick: number;
  label: string;
  detail: string;
  tone: "pressure" | "damage" | "decision" | "action" | "death";
}

interface FlowCluster {
  tick: number;
  endTick: number;
  events: FlowEvent[];
  tone: FlowEvent["tone"];
  percent: number;
  row: number;
}

interface FlowWindow {
  startTick: number;
  endTick: number;
}

function DiagnosticsApp() {
  const [records, setRecords] = useState<RecordListEntry[]>([]);
  const [selectedRecordFile, setSelectedRecordFile] = useState("");
  const [selectedRecord, setSelectedRecord] = useState<GameRecord | null>(null);
  const [selectedRecordName, setSelectedRecordName] = useState("");
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordLoading, setRecordLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timelineFilter, setTimelineFilter] = useState<PlayerId | "all">("all");

  const report = useMemo<MatchDiagnosticReport | null>(() => {
    if (!selectedRecord) {
      return null;
    }
    return buildMatchDiagnosticReport(selectedRecord, selectedRecordName || selectedRecordFile || "record.json");
  }, [selectedRecord, selectedRecordFile, selectedRecordName]);

  const filteredTimeline = useMemo(() => {
    if (!report) {
      return [];
    }
    if (timelineFilter === "all") {
      return report.timeline;
    }
    return report.timeline.filter((event) => event.playerId === timelineFilter || event.playerId === "system");
  }, [report, timelineFilter]);

  async function fetchRecords() {
    setRecordsLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/api/replay/records`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json() as { records: RecordListEntry[] };
      setRecords(payload.records);
      if (!selectedRecordFile && payload.records.length > 0) {
        setSelectedRecordFile(payload.records[0]!.fileName);
      }
    } catch (fetchError) {
      setError(`获取记录列表失败: ${formatError(fetchError)}`);
    } finally {
      setRecordsLoading(false);
    }
  }

  async function loadSelectedRecord() {
    if (!selectedRecordFile) {
      return;
    }

    setRecordLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/api/replay/records/${encodeURIComponent(selectedRecordFile)}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const record = projectRecordToMatchRecord(await response.json() as unknown);
      setSelectedRecord(record);
      setSelectedRecordName(selectedRecordFile);
      setTimelineFilter("all");
    } catch (fetchError) {
      setSelectedRecord(null);
      setSelectedRecordName("");
      setError(`加载记录失败: ${formatError(fetchError)}`);
    } finally {
      setRecordLoading(false);
    }
  }

  useEffect(() => {
    void fetchRecords();
  }, []);

  useEffect(() => {
    if (!selectedRecord && selectedRecordFile) {
      void loadSelectedRecord();
    }
  }, [selectedRecord, selectedRecordFile]);

  return (
    <div className="dx-shell">
      <header className="dx-header">
        <div>
          <p className="dx-eyebrow">LLMCraft 调试工具</p>
          <h1>对局诊断</h1>
          <p className="dx-subtitle">
            从服务端保存的记录里诊断 LLM 为什么没守住、何时开始反应、是否陷入读状态循环或出生陷阱。
          </p>
        </div>
        <div className="dx-actions">
          <a className="dx-link" href="/">
            返回对局
          </a>
          <a className="dx-link" href="/transcript.html">
            模型日志
          </a>
        </div>
      </header>

      <section className="dx-loader">
        <label className="dx-field">
          <span>服务端记录</span>
          <select
            value={selectedRecordFile}
            onChange={(event) => {
              setSelectedRecordFile(event.target.value);
              setSelectedRecord(null);
              setSelectedRecordName("");
            }}
            disabled={recordsLoading || records.length === 0}
          >
            <option value="">选择一份记录</option>
            {records.map((record) => (
              <option key={record.fileName} value={record.fileName}>
                {record.fileName}
              </option>
            ))}
          </select>
        </label>
        <button className="dx-btn primary" type="button" onClick={() => void loadSelectedRecord()} disabled={!selectedRecordFile || recordLoading}>
          {recordLoading ? "加载中" : "加载诊断"}
        </button>
        <button className="dx-btn" type="button" onClick={() => void fetchRecords()} disabled={recordsLoading}>
          {recordsLoading ? "刷新中" : "刷新列表"}
        </button>
        {records.length > 0 && (
          <span className="dx-muted">{records.length} 份记录</span>
        )}
      </section>

      {error && <div className="dx-error">{error}</div>}

      {!report ? (
        <main className="dx-empty">
          <h2>选择一份保存的记录开始诊断</h2>
          <p>这里复用回放页的服务端记录列表，不需要手动上传 JSON。</p>
        </main>
      ) : (
        <main className="dx-main">
          <section className="dx-overview">
            <div className="dx-overview-title">
              <div>
                <p className="dx-kicker">对局记录</p>
                <h2>{report.recordName}</h2>
              </div>
              <span className={`dx-winner ${report.winner ?? "draw"}`}>
                {formatWinner(report.winner)}
              </span>
            </div>
            <div className="dx-stat-grid">
              <Metric label="对局状态" value={formatStatus(report.status)} />
              <Metric label="持续时间" value={`${report.durationTicks} tick`} detail={`${report.durationSeconds.toFixed(1)} 秒`} />
              <Metric label="地图尺寸" value={`${report.mapWidth} x ${report.mapHeight}`} />
              <Metric label="关键事件数" value={String(report.timeline.length)} />
            </div>
          </section>

          <FlowTimeline report={report} />

          <section className="dx-player-grid">
            {report.players.map((player) => (
              <PlayerCard key={player.playerId} player={player} />
            ))}
          </section>

          <section className="dx-timeline-panel">
            <div className="dx-panel-header">
              <div>
                <p className="dx-kicker">关键时间线</p>
                <h2>关键事件</h2>
              </div>
              <div className="dx-segmented">
                <button type="button" className={timelineFilter === "all" ? "active" : ""} onClick={() => setTimelineFilter("all")}>
                  全部
                </button>
                <button type="button" className={timelineFilter === "player_1" ? "active" : ""} onClick={() => setTimelineFilter("player_1")}>
                  红方
                </button>
                <button type="button" className={timelineFilter === "player_2" ? "active" : ""} onClick={() => setTimelineFilter("player_2")}>
                  蓝方
                </button>
              </div>
            </div>
            <div className="dx-timeline">
              {filteredTimeline.length === 0 ? (
                <div className="dx-timeline-empty">没有匹配的关键事件。</div>
              ) : (
                filteredTimeline.slice(0, 180).map((event, index) => (
                  <article className={`dx-event ${event.severity}`} key={`${event.tick}-${event.type}-${event.playerId}-${index}`}>
                    <div className="dx-event-tick">T{event.tick}</div>
                    <div className="dx-event-body">
                      <div className="dx-event-top">
                        <span className={`dx-player-pill ${event.playerId}`}>{formatPlayer(event.playerId)}</span>
                        <span className="dx-event-type">{EVENT_TYPE_LABELS[event.type]}</span>
                      </div>
                      <h3>{event.label}</h3>
                      {event.detail && <p>{event.detail}</p>}
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

function FlowTimeline({ report }: { report: MatchDiagnosticReport }) {
  const window = getFlowWindow(report);

  return (
    <section className="dx-flow-panel">
      <div className="dx-panel-header">
        <div>
          <p className="dx-kicker">战况时间轴</p>
          <h2>压力到响应</h2>
        </div>
        <div className="dx-flow-legend">
          <span className="pressure">总部压力</span>
          <span className="decision">模型/命令</span>
          <span className="damage">总部受伤</span>
          <span className="death">总部结局</span>
        </div>
      </div>
      <div className="dx-flow-scroll">
        <div className="dx-flow-axis">
          <span>T{window.startTick}</span>
          <span>T{Math.round((window.startTick + window.endTick) / 2)}</span>
          <span>T{window.endTick}</span>
        </div>
        {report.players.map((player) => (
          <FlowLane key={player.playerId} player={player} report={report} window={window} />
        ))}
      </div>
    </section>
  );
}

function FlowLane({ player, report, window }: { player: PlayerDiagnostic; report: MatchDiagnosticReport; window: FlowWindow }) {
  const clusters = assignClusterRows(clusterFlowEvents(buildFlowEvents(report, player)), window);
  const pressureTick = player.enemyNearHqTickByRadius[5];
  const responseTick = player.firstDefensiveCommandTick ?? player.firstCombatCommandTick ?? player.hqDeathTick ?? report.durationTicks;
  const hasResponseWindow = pressureTick !== null && responseTick >= pressureTick;
  const responseWindowLeft = hasResponseWindow ? tickPercent(pressureTick, window) : 0;
  const responseWindowWidth = hasResponseWindow ? Math.max(0, tickPercent(responseTick, window) - responseWindowLeft) : 0;

  return (
    <article className={`dx-flow-lane ${player.playerId}`}>
      <div className="dx-flow-lane-label">
        <strong>{formatPlayer(player.playerId)}</strong>
        <span>{summarizeLane(player)}</span>
      </div>
      <div className="dx-flow-track">
        {hasResponseWindow && (
          <div
            className="dx-flow-window"
            style={{
              left: `${responseWindowLeft}%`,
              width: `${responseWindowWidth}%`,
            }}
            title={`从总部 5 格压力到首次响应/结局：${responseTick - pressureTick} tick`}
          />
        )}
        {clusters.map((cluster) => (
          <div
            className={`dx-flow-marker ${cluster.tone}`}
            key={`${player.playerId}-${cluster.tick}-${cluster.events.map((event) => event.label).join("-")}`}
            style={{
              left: `${cluster.percent}%`,
              "--card-offset-y": `${getFlowCardOffset(cluster.row)}px`,
            } as React.CSSProperties}
            title={cluster.events.map((event) => `T${event.tick} ${event.label}: ${event.detail}`).join("\n")}
          >
            <span className="dx-flow-dot" />
            <div className="dx-flow-card">
              <strong>{formatClusterTick(cluster)}</strong>
              {cluster.events.map((event) => (
                <span key={`${event.tick}-${event.label}`}>
                  {event.tick === cluster.tick ? event.label : `T${event.tick} ${event.label}`}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function getFlowCardOffset(row: number) {
  return [-98, 24, 84][row] ?? 24;
}

function getFlowWindow(report: MatchDiagnosticReport): FlowWindow {
  const ticks = report.players.flatMap((player) => buildFlowEvents(report, player).map((event) => event.tick));
  if (ticks.length === 0) {
    return { startTick: 0, endTick: Math.max(report.durationTicks, 1) };
  }

  const minTick = Math.min(...ticks);
  const maxTick = Math.max(...ticks);
  const minSpan = 36;
  let startTick = Math.max(0, minTick - 8);
  let endTick = Math.min(report.durationTicks, maxTick + 8);

  if (endTick - startTick < minSpan) {
    const missing = minSpan - (endTick - startTick);
    startTick = Math.max(0, startTick - Math.ceil(missing / 2));
    endTick = Math.min(report.durationTicks, endTick + Math.floor(missing / 2));
  }

  if (endTick - startTick < minSpan && endTick === report.durationTicks) {
    startTick = Math.max(0, endTick - minSpan);
  }

  return { startTick, endTick: Math.max(endTick, startTick + 1) };
}

function buildFlowEvents(report: MatchDiagnosticReport, player: PlayerDiagnostic): FlowEvent[] {
  const events: FlowEvent[] = [];
  const pressureTicks = player.enemyNearHqTickByRadius;

  addFlowEvent(events, pressureTicks[5], "进入 5 格", "敌方战斗单位开始形成守家压力", "pressure");
  addFlowEvent(events, pressureTicks[3], "进入 3 格", "敌方战斗单位逼近总部", "pressure");
  addFlowEvent(events, pressureTicks[2], "进入 2 格", "敌方战斗单位贴近总部", "damage");
  addFlowEvent(events, player.hqFirstDamageTick, "总部受伤", "基地开始实际掉血", "damage");

  const pressureStart = pressureTicks[5];
  const timelineAfterPressure = report.timeline.filter((event) =>
    event.playerId === player.playerId &&
    (pressureStart === null || event.tick >= pressureStart)
  );

  addFlowEvent(events, timelineAfterPressure.find((event) => event.type === "llm_request")?.tick ?? null, "模型请求", "压力出现后的首次 LLM 请求", "decision");
  addFlowEvent(events, timelineAfterPressure.find((event) => event.type === "read_tool")?.tick ?? null, "读取状态", "压力出现后的首次状态读取", "decision");
  addFlowEvent(events, timelineAfterPressure.find((event) => event.type === "action_tool")?.tick ?? null, "执行工具", "压力出现后的首次行动工具", "action");
  addFlowEvent(events, player.firstCombatCommandTick, "战斗命令", "第一次出现 attack / attack_move 等战斗命令", "action");
  addFlowEvent(events, player.firstDefensiveCommandTick, "防守命令", "第一次出现靠近总部压力区的防守动作", "action");
  addFlowEvent(events, player.hqDeathTick, "总部被毁", "总部归零，本方失败", "death");

  return dedupeFlowEvents(events).sort((a, b) => a.tick - b.tick);
}

function addFlowEvent(events: FlowEvent[], tick: number | null | undefined, label: string, detail: string, tone: FlowEvent["tone"]) {
  if (tick === null || tick === undefined) {
    return;
  }
  events.push({ tick, label, detail, tone });
}

function dedupeFlowEvents(events: FlowEvent[]) {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.tick}:${event.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function clusterFlowEvents(events: FlowEvent[]): Array<Omit<FlowCluster, "percent" | "row">> {
  const sortedEvents = [...events].sort((a, b) => a.tick - b.tick);
  const clusters: Array<Omit<FlowCluster, "percent" | "row">> = [];

  for (const event of sortedEvents) {
    const current = clusters.at(-1);
    if (current && event.tick - current.endTick <= 5) {
      current.events.push(event);
      current.endTick = event.tick;
      current.tone = strongerTone(current.tone, event.tone);
      continue;
    }

    clusters.push({
      tick: event.tick,
      endTick: event.tick,
      events: [event],
      tone: event.tone,
    });
  }

  return clusters;
}

function assignClusterRows(clusters: Array<Omit<FlowCluster, "percent" | "row">>, window: FlowWindow): FlowCluster[] {
  const rowPercents = [-100, -100, -100];
  return clusters.map((cluster) => {
    const percent = tickPercent(cluster.tick, window);
    const row = rowPercents.findIndex((lastPercent) => percent - lastPercent >= 17);
    const assignedRow = row >= 0 ? row : rowPercents.indexOf(Math.min(...rowPercents));
    rowPercents[assignedRow] = percent;
    return { ...cluster, percent, row: assignedRow };
  });
}

function strongerTone(left: FlowEvent["tone"], right: FlowEvent["tone"]) {
  const weights: Record<FlowEvent["tone"], number> = {
    pressure: 1,
    decision: 2,
    action: 3,
    damage: 4,
    death: 5,
  };
  return weights[right] > weights[left] ? right : left;
}

function formatClusterTick(cluster: Pick<FlowCluster, "tick" | "endTick">) {
  return cluster.tick === cluster.endTick ? `T${cluster.tick}` : `T${cluster.tick}-T${cluster.endTick}`;
}

function tickPercent(tick: number, window: FlowWindow) {
  const span = window.endTick - window.startTick;
  if (span <= 0) {
    return 0;
  }
  return Math.max(8, Math.min(92, ((tick - window.startTick) / span) * 100));
}

function summarizeLane(player: PlayerDiagnostic) {
  const pressureTick = player.enemyNearHqTickByRadius[5];
  const responseTick = player.firstDefensiveCommandTick ?? player.firstCombatCommandTick;
  if (pressureTick === null) {
    return "本局未检测到总部 5 格压力";
  }
  if (responseTick === null) {
    return "检测到总部压力，但没有防守响应";
  }
  return `压力后 ${responseTick - pressureTick} tick 出现响应`;
}

function PlayerCard({ player }: { player: PlayerDiagnostic }) {
  const pressureTick = player.enemyNearHqTickByRadius[5];
  const defenseLag = pressureTick !== null && player.firstDefensiveCommandTick !== null
    ? player.firstDefensiveCommandTick - pressureTick
    : null;

  return (
    <article className={`dx-player-card ${player.playerId}`}>
      <div className="dx-card-title">
        <div>
          <p className="dx-kicker">{player.playerId === "player_1" ? "红方玩家" : "蓝方玩家"}</p>
          <h2>{formatPlayer(player.playerId)}</h2>
        </div>
        <div className="dx-tags">
          {player.tags.length === 0 ? (
            <span className="dx-tag clean">未发现明显问题</span>
          ) : (
            player.tags.map((tag) => <span className="dx-tag" key={tag}>{TAG_LABELS[tag]}</span>)
          )}
        </div>
      </div>

      <div className="dx-pressure-row">
        <Metric label="敌军进入总部 5 格内" value={formatTick(player.enemyNearHqTickByRadius[5])} />
        <Metric label="敌军进入总部 3 格内" value={formatTick(player.enemyNearHqTickByRadius[3])} />
        <Metric label="敌军进入总部 2 格内" value={formatTick(player.enemyNearHqTickByRadius[2])} />
      </div>
      <p className="dx-help">
        这里的“总部 N 格内”表示敌方可攻击单位第一次进入我方 HQ 周围 N 格范围的 tick，用来判断模型什么时候已经处于守家压力下。
      </p>

      <div className="dx-metric-list">
        <Metric label="总部首次受伤" value={formatTick(player.hqFirstDamageTick)} />
        <Metric label="总部被摧毁" value={formatTick(player.hqDeathTick)} />
        <Metric label="首次战斗命令" value={formatTick(player.firstCombatCommandTick)} />
        <Metric label="首次防守命令" value={formatTick(player.firstDefensiveCommandTick)} detail={defenseLag === null ? undefined : `延迟 ${defenseLag} tick`} />
        <Metric label="受压后模型请求" value={String(player.modelRequestsAfterPressure)} />
        <Metric label="受压后工具调用" value={String(player.toolCallsAfterPressure)} detail={`${player.readToolCallsAfterPressure} 次读取 / ${player.actionToolCallsAfterPressure} 次行动`} />
        <Metric label="受压后失效单位" value={String(player.invalidUnitAfterPressureCount)} />
        <Metric label="受压后生产士兵" value={String(player.spawnedCombatUnderPressure)} detail={`${player.spawnedCombatDeathsUnderPressure} 个快速阵亡`} />
      </div>

      <div className="dx-final-row">
        <Metric label="最终工人数" value={String(player.finalWorkers)} />
        <Metric label="最终士兵数" value={String(player.finalSoldiers)} />
        <Metric label="最终资金" value={String(player.finalCredits)} />
      </div>
    </article>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="dx-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function formatTick(tick: number | null) {
  return tick === null ? "从未发生" : `T${tick}`;
}

function formatStatus(status: string) {
  const labels: Record<string, string> = {
    finished: "已结束",
    running: "进行中",
    stopped: "已停止",
  };
  return labels[status] ?? status;
}

function formatWinner(winner: PlayerId | null) {
  if (winner === "player_1") {
    return "红方获胜";
  }
  if (winner === "player_2") {
    return "蓝方获胜";
  }
  return "无胜者";
}

function formatPlayer(playerId: PlayerId | "system") {
  if (playerId === "player_1") {
    return "红方";
  }
  if (playerId === "player_2") {
    return "蓝方";
  }
  return "系统";
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DiagnosticsApp />
  </React.StrictMode>
);
