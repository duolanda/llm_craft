import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { GameRecord, GameSnapshot, GameState } from "@llmcraft/shared";
import { GameCanvas } from "./components/GameCanvas";
import { AIOutputPanel } from "./components/AIOutputPanel";
import { GameLog } from "./components/GameLog";
import { StatsPanel } from "./components/StatsPanel";
import { LegendPanel } from "./components/LegendPanel";
import { useWebSocket } from "./hooks/useWebSocket";
import { buildReplayFrames, buildReplaySnapshots, formatTickTime, ReplayFrame } from "./replay";

type AppMode = "live" | "replay";

interface ReplayRecordListEntry {
  fileName: string;
  fullPath: string;
  size: number;
  modifiedAt: string;
}

const SERVER_HOST = window.location.hostname || "localhost";
const WS_URL = `ws://${SERVER_HOST}:3001`;
const API_BASE_URL = `http://${SERVER_HOST}:3001`;

function App() {
  const { state, snapshots, connected, lastSavedRecordPath, liveEnabled, serverMessage, send } = useWebSocket(WS_URL);
  const [isPlaying, setIsPlaying] = useState(false);
  const [winnerOverlayDismissed, setWinnerOverlayDismissed] = useState(false);
  const [mode, setMode] = useState<AppMode>("live");
  const [recordEntries, setRecordEntries] = useState<ReplayRecordListEntry[]>([]);
  const [selectedRecordFile, setSelectedRecordFile] = useState("");
  const [activeReplayRecord, setActiveReplayRecord] = useState<GameRecord | null>(null);
  const [replayFrames, setReplayFrames] = useState<ReplayFrame[]>([]);
  const [replaySnapshots, setReplaySnapshots] = useState<GameSnapshot[]>([]);
  const [replayFrameIndex, setReplayFrameIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [replaySourceName, setReplaySourceName] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const lastAutoSavedWinnerRef = useRef<string | null>(null);

  useEffect(() => {
    if (mode !== "live") {
      return;
    }

    if (state?.winner) {
      setWinnerOverlayDismissed(false);
      setIsPlaying(false);
      if (lastAutoSavedWinnerRef.current !== state.winner) {
        send({ type: "save_record" });
        lastAutoSavedWinnerRef.current = state.winner;
      }
    } else {
      lastAutoSavedWinnerRef.current = null;
    }
  }, [mode, send, state?.winner]);

  useEffect(() => {
    if (mode !== "live" || !state?.winner || winnerOverlayDismissed) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWinnerOverlayDismissed(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [mode, state?.winner, winnerOverlayDismissed]);

  useEffect(() => {
    if (mode !== "replay" || !replayPlaying || replayFrames.length <= 1) {
      return;
    }

    const interval = window.setInterval(() => {
      setReplayFrameIndex((current) => {
        if (current >= replayFrames.length - 1) {
          setReplayPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, Math.max(50, 500 / replaySpeed));

    return () => {
      window.clearInterval(interval);
    };
  }, [mode, replayFrames.length, replayPlaying, replaySpeed]);

  const fetchRecordEntries = async () => {
    setRecordsLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/replay/records`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json() as { records: ReplayRecordListEntry[] };
      setRecordEntries(payload.records);
      if (!selectedRecordFile && payload.records.length > 0) {
        setSelectedRecordFile(payload.records[0].fileName);
      }
    } catch (error) {
      setReplayError(`获取服务端记录列表失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRecordsLoading(false);
    }
  };

  useEffect(() => {
    void fetchRecordEntries();
  }, []);

  const loadReplayRecord = (record: GameRecord, sourceName: string) => {
    const frames = buildReplayFrames(record);
    const builtSnapshots = buildReplaySnapshots(frames);
    setActiveReplayRecord(record);
    setReplayFrames(frames);
    setReplaySnapshots(builtSnapshots);
    setReplayFrameIndex(0);
    setReplayPlaying(false);
    setReplaySourceName(sourceName);
    setReplayError(null);
    setMode("replay");
  };

  const handleLoadSelectedRecord = async () => {
    if (!selectedRecordFile) {
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/replay/records/${encodeURIComponent(selectedRecordFile)}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const record = await response.json() as GameRecord;
      loadReplayRecord(record, selectedRecordFile);
    } catch (error) {
      setReplayError(`加载回放记录失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleLocalFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const record = JSON.parse(text) as GameRecord;
      loadReplayRecord(record, file.name);
      event.target.value = "";
    } catch (error) {
      setReplayError(`解析本地 JSON 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

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

  const replayFrame = replayFrames[replayFrameIndex] ?? null;
  const displayState: GameState | null = mode === "replay" ? replayFrame?.state ?? null : state;
  const displaySnapshots = useMemo(() => {
    if (mode === "replay") {
      const snapshot = replaySnapshots[replayFrameIndex];
      return snapshot ? [snapshot] : [];
    }
    return snapshots;
  }, [mode, replayFrameIndex, replaySnapshots, snapshots]);

  const replayProgress = replayFrames.length > 1
    ? replayFrameIndex / (replayFrames.length - 1)
    : 0;

  return (
    <>
      <div className="noise-overlay" />
      <div className="app-shell">
        <header className="app-header">
          <div className="brand">
            <h1>LLMCraft</h1>
            <span className="brand-badge">{mode === "live" ? "LIVE OPS" : "REPLAY OPS"}</span>
          </div>
          <div className="controls">
            <div className="mode-switch">
              <button
                onClick={() => setMode("live")}
                disabled={!liveEnabled}
                className={`mode-pill ${mode === "live" ? "active" : ""}`}
              >
                实时对局
              </button>
              <button
                onClick={() => setMode("replay")}
                className={`mode-pill ${mode === "replay" ? "active" : ""}`}
              >
                对局回放
              </button>
            </div>
            <span className={`connection-pill ${connected ? "connected" : ""}`}>
              {connected ? (liveEnabled ? "ONLINE" : "REPLAY ONLY") : "OFFLINE"}
            </span>
            {mode === "live" && (
              <>
                <button
                  onClick={isPlaying ? handleStop : handleStart}
                  disabled={!connected || !liveEnabled}
                  className={`hud-btn ${isPlaying ? "hud-btn-stop" : "hud-btn-start"}`}
                >
                  {isPlaying ? "终止模拟" : "启动模拟"}
                </button>
                <button
                  onClick={handleSaveRecord}
                  disabled={!connected || !state || !liveEnabled}
                  className="hud-btn"
                >
                  保存记录
                </button>
              </>
            )}
          </div>
        </header>

        {(serverMessage || replayError || lastSavedRecordPath) && (
          <div className="status-strip">
            {serverMessage && <span>{serverMessage}</span>}
            {replayError && <span className="status-error">{replayError}</span>}
            {lastSavedRecordPath && <span>记录已保存到: {lastSavedRecordPath}</span>}
          </div>
        )}

        {mode === "replay" && (
          <section className="replay-toolbar">
            <div className="replay-toolbar-top">
              <div className="replay-loader">
                <label className="replay-label">
                  服务端记录
                  <select
                    className="replay-select"
                    value={selectedRecordFile}
                    onChange={(event) => setSelectedRecordFile(event.target.value)}
                  >
                    <option value="">选择一份记录</option>
                    {recordEntries.map((entry) => (
                      <option key={entry.fileName} value={entry.fileName}>
                        {entry.fileName}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="hud-btn" onClick={() => void handleLoadSelectedRecord()} disabled={!selectedRecordFile}>
                  加载记录
                </button>
                <button className="hud-btn hud-btn-ghost" onClick={() => void fetchRecordEntries()} disabled={recordsLoading}>
                  {recordsLoading ? "刷新中" : "刷新列表"}
                </button>
              </div>

              <label className="file-pick">
                <input type="file" accept=".json,application/json" onChange={handleLocalFileChange} />
                导入本地 JSON
              </label>
            </div>

            <div className="replay-toolbar-bottom">
              <div className="replay-meta">
                <span className="replay-meta-chip">
                  源文件: {replaySourceName ?? "未加载"}
                </span>
                <span className="replay-meta-chip">
                  Tick: {replayFrame?.tick ?? 0} / {activeReplayRecord?.finalState.tick ?? 0}
                </span>
                <span className="replay-meta-chip">
                  时间: {formatTickTime(replayFrame?.tick ?? 0)}
                </span>
                {activeReplayRecord?.metadata.winner && (
                  <span className="replay-meta-chip">
                    胜者: {activeReplayRecord.metadata.winner === "player_1" ? "红方" : "蓝方"}
                  </span>
                )}
              </div>

              <div className="replay-controls">
                <button
                  className={`hud-btn ${replayPlaying ? "hud-btn-stop" : "hud-btn-start"}`}
                  onClick={() => setReplayPlaying((value) => !value)}
                  disabled={replayFrames.length <= 1}
                >
                  {replayPlaying ? "暂停" : "播放"}
                </button>
                <button
                  className="hud-btn hud-btn-ghost"
                  onClick={() => {
                    setReplayPlaying(false);
                    setReplayFrameIndex(0);
                  }}
                  disabled={replayFrames.length === 0}
                >
                  回到开头
                </button>
                <label className="speed-control">
                  速度
                  <select
                    className="replay-select speed-select"
                    value={replaySpeed}
                    onChange={(event) => setReplaySpeed(Number(event.target.value))}
                  >
                    <option value={0.5}>0.5x</option>
                    <option value={1}>1x</option>
                    <option value={2}>2x</option>
                    <option value={4}>4x</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="replay-progress">
              <input
                type="range"
                min={0}
                max={Math.max(replayFrames.length - 1, 0)}
                step={1}
                value={Math.min(replayFrameIndex, Math.max(replayFrames.length - 1, 0))}
                onChange={(event) => {
                  setReplayPlaying(false);
                  setReplayFrameIndex(Number(event.target.value));
                }}
                disabled={replayFrames.length <= 1}
              />
              <div className="replay-progress-labels">
                <span>0%</span>
                <span>{Math.round(replayProgress * 100)}%</span>
                <span>100%</span>
              </div>
            </div>
          </section>
        )}

        <div className="dashboard">
          <div className="stats-col">
            <div className="hud-panel" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div className="hud-panel-bottom-corners" />
              <div className="panel-header">
                <span className="panel-header-accent accent-amber">战场数据</span>
              </div>
              <StatsPanel state={displayState} />
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
              <GameCanvas state={displayState} />
            </div>

            <div className="hud-panel">
              <div className="hud-panel-bottom-corners" />
              <div className="panel-header">
                <span className="panel-header-accent accent-amber">战术日志</span>
              </div>
              <GameLog state={displayState} />
            </div>
          </div>

          <div className="terminal-col">
            <div className="hud-panel" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
              <div className="hud-panel-bottom-corners" />
              <div className="panel-header">
                <span className="panel-header-accent accent-cyan">AI 指挥终端</span>
              </div>
              <AIOutputPanel snapshots={displaySnapshots} />
            </div>
          </div>
        </div>

        {mode === "live" && state?.winner && !winnerOverlayDismissed && (
          <div className="winner-overlay" onClick={() => setWinnerOverlayDismissed(true)}>
            <div className="winner-card" onClick={(event) => event.stopPropagation()}>
              <div className="winner-label">Simulation Complete</div>
              <div className={`winner-name ${state.winner === "player_1" ? "red" : "cyan"}`}>
                {state.winner === "player_1" ? "红方获胜" : "蓝方获胜"}
              </div>
              {lastSavedRecordPath && (
                <div className="winner-save-path">
                  对局记录已自动保存到: {lastSavedRecordPath}
                </div>
              )}
              <div className="winner-actions">
                <button className="hud-btn hud-btn-ghost" onClick={() => setWinnerOverlayDismissed(true)}>
                  关闭覆盖层
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default App;
