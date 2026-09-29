import { useRef, useState } from "react";
import type { SimulationVisualTimeline } from "@llmcraft/record";
import { PLAYER_IDS, UNIT_TYPES } from "@llmcraft/shared";
import type { AITerminalEvent, GameRecord, GameState, LiveLogEvent } from "@llmcraft/shared";
import { formatTickTime } from "../replay";
import { AIOutputPanel } from "./AIOutputPanel";
import { Battlefield3D } from "./Battlefield3D";
import { GameLog } from "./GameLog";
import { StatsPanel } from "./StatsPanel";
import "./spectatorWorkspace.css";

const PANELS = [
  { id: "stats", label: "情报", title: "观战情报" },
  { id: "ai", label: "AI", title: "AI 指挥终端" },
  { id: "logs", label: "日志", title: "战术日志" },
] as const;

type PanelId = typeof PANELS[number]["id"];

interface SpectatorWorkspaceProps {
  state: GameState | null;
  timeline: SimulationVisualTimeline;
  tickIntervalMs: number;
  recordedPlayers?: GameRecord["metadata"]["players"];
  effectsResetKey?: string;
  aiOutputs: Record<string, string>;
  terminalEvents: AITerminalEvent[];
  terminalAutoScroll: boolean;
  canLoadEarlier: boolean;
  onLoadEarlier: () => void;
  logs?: LiveLogEvent[];
}

export function SpectatorWorkspace({
  state,
  timeline,
  tickIntervalMs,
  recordedPlayers,
  effectsResetKey,
  aiOutputs,
  terminalEvents,
  terminalAutoScroll,
  canLoadEarlier,
  onLoadEarlier,
  logs,
}: SpectatorWorkspaceProps) {
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);
  const panelButtons = useRef<Partial<Record<PanelId, HTMLButtonElement | null>>>({});
  const closePanel = () => {
    if (activePanel) panelButtons.current[activePanel]?.focus();
    setActivePanel(null);
  };

  return (
    <main className="spectator-workspace" aria-label="观战窗口">
      <div className="spectator-toolbar">
        <div className="spectator-clock">
          <span className="spectator-kicker">战场</span>
          <strong>{formatTickTime(state?.tick ?? 0, tickIntervalMs)}</strong>
          <span className="spectator-tick">TICK {state?.tick ?? 0}</span>
        </div>
        {state && (
          <div className="spectator-scoreboard" aria-label="双方战况摘要">
            {state.players.map((player) => (
              <div className={`spectator-score ${player.id === PLAYER_IDS.PLAYER_1 ? "red" : "blue"}`} key={player.id}>
                <span className="spectator-side">{player.id === PLAYER_IDS.PLAYER_1 ? "红方" : "蓝方"}</span>
                <span><b>{Math.floor(player.resources.credits).toLocaleString()}</b> 资金</span>
                <span><b>{player.units.filter((unit) => unit.exists && unit.type !== UNIT_TYPES.WORKER).length}</b> 作战</span>
              </div>
            ))}
          </div>
        )}
        <nav className="spectator-panel-switch" aria-label="观战信息">
          {PANELS.map((panel) => (
            <button
              key={panel.id}
              ref={(button) => { panelButtons.current[panel.id] = button; }}
              type="button"
              className={`spectator-panel-button ${activePanel === panel.id ? "active" : ""}`}
              aria-label={panel.title}
              aria-expanded={activePanel === panel.id}
              aria-controls={`spectator-panel-${panel.id}`}
              title={`${activePanel === panel.id ? "收起" : "展开"}${panel.title}`}
              onClick={() => setActivePanel((current) => current === panel.id ? null : panel.id)}
            >
              {panel.label}
            </button>
          ))}
          <button
            type="button"
            className={`spectator-panel-button spectator-focus ${activePanel === null ? "active" : ""}`}
            aria-pressed={activePanel === null}
            onClick={() => setActivePanel(null)}
            title="收起所有信息面板，专注观战"
          >
            专注观战
          </button>
        </nav>
      </div>
      <div className={`spectator-content ${activePanel ? "with-panel" : ""}`}>
        <div className="hud-panel battlefield-panel">
          <div className="hud-panel-top-corners" />
          <div className="hud-panel-bottom-corners" />
          <div className="viewport">
            <Battlefield3D state={state} timeline={timeline} effectsResetKey={effectsResetKey} />
          </div>
        </div>
        <aside
          className="hud-panel spectator-inspector"
          aria-label="观战信息面板"
          hidden={activePanel === null}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closePanel();
            }
          }}
        >
          <div className="panel-header">
            <span className="panel-header-accent accent-cyan">
              {PANELS.find((panel) => panel.id === activePanel)?.title}
            </span>
            <button type="button" className="inspector-close" onClick={closePanel} aria-label="收起信息面板" title="收起信息面板">×</button>
          </div>
          <div id="spectator-panel-stats" className="spectator-panel-body" hidden={activePanel !== "stats"}>
            <StatsPanel state={state} tickIntervalMs={tickIntervalMs} recordedPlayers={recordedPlayers} />
          </div>
          <div id="spectator-panel-ai" className="spectator-panel-body" hidden={activePanel !== "ai"}>
            <AIOutputPanel
              aiOutputs={aiOutputs}
              events={terminalEvents}
              autoScroll={terminalAutoScroll && activePanel === "ai"}
              canLoadEarlier={canLoadEarlier}
              onLoadEarlier={onLoadEarlier}
            />
          </div>
          <div id="spectator-panel-logs" className="spectator-panel-body" hidden={activePanel !== "logs"}>
            <GameLog state={state} logs={logs} />
          </div>
        </aside>
      </div>
    </main>
  );
}
