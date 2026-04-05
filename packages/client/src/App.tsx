import { useState } from "react";
import { GameCanvas } from "./components/GameCanvas";
import { AIOutputPanel } from "./components/AIOutputPanel";
import { GameLog } from "./components/GameLog";
import { StatsPanel } from "./components/StatsPanel";
import { LegendPanel } from "./components/LegendPanel";
import { useWebSocket } from "./hooks/useWebSocket";

function App() {
  const { state, snapshots, connected, lastSavedRecordPath, send } = useWebSocket("ws://localhost:3001");
  const [isPlaying, setIsPlaying] = useState(false);

  const handleStart = () => {
    send({ type: "start" });
    setIsPlaying(true);
  };

  const handleStop = () => {
    send({ type: "stop" });
    setIsPlaying(false);
  };

  const handleSaveRecord = () => {
    send({ type: "save_record" });
  };

  return (
    <>
      <div className="noise-overlay" />
      <div className="app-shell">
        <header className="app-header">
          <div className="brand">
            <h1>LLMCraft</h1>
            <span className="brand-badge">MVP BUILD</span>
          </div>
          <div className="controls">
            <span className={`connection-pill ${connected ? "connected" : ""}`}>
              {connected ? "ONLINE" : "OFFLINE"}
            </span>
            <button
              onClick={isPlaying ? handleStop : handleStart}
              disabled={!connected}
              className={`hud-btn ${isPlaying ? "hud-btn-stop" : "hud-btn-start"}`}
            >
              {isPlaying ? "终止模拟" : "启动模拟"}
            </button>
            <button
              onClick={handleSaveRecord}
              disabled={!connected || !state}
              className="hud-btn"
            >
              保存记录
            </button>
          </div>
        </header>

        {lastSavedRecordPath && (
          <div style={{ marginBottom: 12, color: "var(--text-secondary)", fontSize: 12 }}>
            记录已保存到: {lastSavedRecordPath}
          </div>
        )}

        <div className="dashboard">
          <div className="stats-col">
            <div className="hud-panel" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div className="hud-panel-bottom-corners" />
              <div className="panel-header">
                <span className="panel-header-accent accent-amber">战场数据</span>
              </div>
              <StatsPanel state={state} />
            </div>

            <div className="hud-panel" style={{ marginTop: 12, display: "flex", flexDirection: "column" }}>
              <div className="hud-panel-bottom-corners" />
              <div className="panel-header">
                <span className="panel-header-accent accent-red">战术图例</span>
              </div>
              <LegendPanel />
            </div>
          </div>

          <div className="tactical-col">
            <div className="hud-panel viewport">
              <div className="hud-panel-bottom-corners" />
              <div className="scanlines" />
              <div className="viewport-data-lines">
                <span className="data-line dl-tl" />
                <span className="data-line dl-tr" />
                <span className="data-line dl-bl" />
                <span className="data-line dl-br" />
              </div>
              <GameCanvas state={state} />
            </div>

            <div className="hud-panel">
              <div className="hud-panel-bottom-corners" />
              <div className="panel-header">
                <span className="panel-header-accent accent-amber">战术日志</span>
              </div>
              <GameLog state={state} />
            </div>
          </div>

          <div className="terminal-col">
            <div className="hud-panel" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
              <div className="hud-panel-bottom-corners" />
              <div className="panel-header">
                <span className="panel-header-accent accent-cyan">AI 指挥终端</span>
              </div>
              <AIOutputPanel snapshots={snapshots} />
            </div>
          </div>
        </div>

        {state?.winner && (
          <div className="winner-overlay">
            <div className="winner-card">
              <div className="winner-label">Simulation Complete</div>
              <div className={`winner-name ${state.winner === "player_1" ? "red" : "cyan"}`}>
                {state.winner === "player_1" ? "红方获胜" : "蓝方获胜"}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default App;
