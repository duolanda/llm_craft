import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  CPUStrategyType,
  CreateLLMPresetRequest,
  GameRecord,
  GameSnapshot,
  GameState,
  LLMPresetSummary,
  MatchDebugOptions,
  UpdateLLMPresetRequest,
} from "@llmcraft/shared";
import { GameCanvas } from "./components/GameCanvas";
import { AIOutputPanel } from "./components/AIOutputPanel";
import { GameLog } from "./components/GameLog";
import { StatsPanel } from "./components/StatsPanel";
import { LegendPanel } from "./components/LegendPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SettingsOverlay } from "./components/SettingsOverlay";
import { BenchmarkPanel } from "./components/BenchmarkPanel";
import { BenchmarkResult } from "./components/BenchmarkResult";
import { useWebSocket } from "./hooks/useWebSocket";
import { createPreset, deletePreset, listPresets, updatePreset } from "./lib/settingsApi";
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
  const {
    state,
    snapshots,
    connected,
    lastSavedRecordPath,
    liveEnabled,
    serverMessage,
    benchmarkProgress,
    benchmarkResult,
    send,
    clearServerMessage,
    clearBenchmarkResult,
  } = useWebSocket(WS_URL);
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
  const [presets, setPresets] = useState<LLMPresetSummary[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [player1PresetId, setPlayer1PresetId] = useState("");
  const [player2PresetId, setPlayer2PresetId] = useState("");
  const [recordLLMTranscript, setRecordLLMTranscript] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [startBaselineTick, setStartBaselineTick] = useState(-1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [benchmarkOpen, setBenchmarkOpen] = useState(false);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkRunSummary, setBenchmarkRunSummary] = useState<{
    cpuStrategy: CPUStrategyType;
    totalRounds: number;
  } | null>(null);
  const [hasLiveMatchStarted, setHasLiveMatchStarted] = useState(false);
  const lastAutoSavedWinnerRef = useRef<string | null>(null);

  useEffect(() => {
    if (mode !== "live" || benchmarkRunning) {
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
  }, [benchmarkRunning, mode, send, state?.winner]);

  useEffect(() => {
    if (mode !== "live" || benchmarkRunning || !state?.winner || winnerOverlayDismissed) {
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
  }, [benchmarkRunning, mode, state?.winner, winnerOverlayDismissed]);

  useEffect(() => {
    if (!startPending) {
      return;
    }

    if (serverMessage) {
      setStartPending(false);
      setIsPlaying(false);
    }
  }, [serverMessage, startPending]);

  useEffect(() => {
    if (!startPending || !state) {
      return;
    }

    if (state.tick !== startBaselineTick) {
      setStartPending(false);
      setIsPlaying(true);
      setHasLiveMatchStarted(true);
    }
  }, [startBaselineTick, startPending, state]);

  useEffect(() => {
    if (!benchmarkResult) {
      return;
    }

    setBenchmarkRunning(false);
    setBenchmarkOpen(true);
    setBenchmarkRunSummary(null);
    void fetchRecordEntries();
  }, [benchmarkResult]);

  useEffect(() => {
    if (benchmarkRunning && serverMessage) {
      setBenchmarkRunning(false);
      setBenchmarkRunSummary(null);
    }
  }, [benchmarkRunning, serverMessage]);

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

  const refreshPresets = async () => {
    setPresetsLoading(true);
    setPresetError(null);
    try {
      const nextPresets = await listPresets(API_BASE_URL);
      setPresets(nextPresets);
    } catch (error) {
      setPresetError(`获取预设列表失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPresetsLoading(false);
    }
  };

  useEffect(() => {
    void fetchRecordEntries();
    void refreshPresets();
  }, []);

  useEffect(() => {
    if (presets.length === 0) {
      setPlayer1PresetId("");
      setPlayer2PresetId("");
      return;
    }

    const presetIds = new Set(presets.map((preset) => preset.id));
    setPlayer1PresetId((current) => (current && presetIds.has(current) ? current : presets[0]?.id ?? ""));
    setPlayer2PresetId((current) => (current && presetIds.has(current) ? current : presets[1]?.id ?? presets[0]?.id ?? ""));
  }, [presets]);

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
    startLiveMatch();
  };

  const handleRestart = () => {
    if (!player1PresetId || !player2PresetId) {
      return;
    }

    clearServerMessage();
    setStartPending(false);
    setIsPlaying(false);
    setWinnerOverlayDismissed(false);
    send({
      type: "reset",
      player1PresetId,
      player2PresetId,
      debug: buildMatchDebugOptions(recordLLMTranscript),
    });
  };

  const startLiveMatch = () => {
    if (!player1PresetId || !player2PresetId) {
      return;
    }

    clearServerMessage();
    setStartPending(true);
    setStartBaselineTick(state?.tick ?? -1);
    setIsPlaying(false);
    send({
      type: "start",
      player1PresetId,
      player2PresetId,
      debug: buildMatchDebugOptions(recordLLMTranscript),
    });
  };

  const handleStop = () => {
    send({ type: "stop" });
    setStartPending(false);
    setIsPlaying(false);
  };

  const handleSaveRecord = () => {
    send({ type: "save_record" });
  };

  const handleStartBenchmark = (input: {
    presetId: string;
    cpuStrategy: CPUStrategyType;
    rounds: number;
    recordReplay: boolean;
    decisionIntervalTicks: number;
    debug?: MatchDebugOptions;
  }) => {
    clearServerMessage();
    clearBenchmarkResult();
    setBenchmarkRunning(true);
    setBenchmarkOpen(false);
    setBenchmarkRunSummary({
      cpuStrategy: input.cpuStrategy,
      totalRounds: input.rounds,
    });
    setWinnerOverlayDismissed(true);
    setIsPlaying(false);
    send({
      type: "start_benchmark",
      presetId: input.presetId,
      cpuStrategy: input.cpuStrategy,
      rounds: input.rounds,
      recordReplay: input.recordReplay,
      decisionIntervalTicks: input.decisionIntervalTicks,
      debug: input.debug,
    });
  };

  const handleCreatePreset = async (input: CreateLLMPresetRequest) => {
    await createPreset(API_BASE_URL, input);
    await refreshPresets();
  };

  const handleUpdatePreset = async (presetId: string, input: UpdateLLMPresetRequest) => {
    await updatePreset(API_BASE_URL, presetId, input);
    await refreshPresets();
  };

  const handleDeletePreset = async (presetId: string) => {
    await deletePreset(API_BASE_URL, presetId);
    await refreshPresets();
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
  const canStartLiveMatch = connected && liveEnabled && Boolean(player1PresetId) && Boolean(player2PresetId);
  const canStopLiveMatch = connected && (isPlaying || startPending || benchmarkRunning);
  const canRestartLiveMatch = connected
    && !isPlaying
    && !startPending
    && !benchmarkRunning
    && hasLiveMatchStarted
    && Boolean(player1PresetId)
    && Boolean(player2PresetId);
  const canSaveLiveMatch = connected && !benchmarkRunning && Boolean(state || isPlaying);

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
                <div className="match-preset-bar">
                  <label className="settings-field compact">
                    <span>红方预设</span>
                    <select
                      className="settings-select live-preset-select red"
                      value={player1PresetId}
                      onChange={(event) => setPlayer1PresetId(event.target.value)}
                      disabled={presetsLoading || presets.length === 0}
                    >
                      <option value="">选择红方预设</option>
                      {presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-field compact">
                    <span>蓝方预设</span>
                    <select
                      className="settings-select live-preset-select blue"
                      value={player2PresetId}
                      onChange={(event) => setPlayer2PresetId(event.target.value)}
                      disabled={presetsLoading || presets.length === 0}
                    >
                      <option value="">选择蓝方预设</option>
                      {presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-field compact live-debug-toggle">
                    <span>LLM Debug</span>
                    <input
                      type="checkbox"
                      checked={recordLLMTranscript}
                      onChange={(event) => setRecordLLMTranscript(event.target.checked)}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="hud-btn hud-btn-ghost"
                  onClick={() => setSettingsOpen(true)}
                  disabled={benchmarkRunning}
                >
                  设置
                </button>
                <button
                  type="button"
                  className="hud-btn hud-btn-ghost"
                  onClick={() => {
                    clearBenchmarkResult();
                    setBenchmarkOpen(true);
                  }}
                  disabled={!connected || presets.length === 0 || benchmarkRunning}
                >
                  Benchmark
                </button>
                <button
                  onClick={isPlaying ? handleStop : handleStart}
                  disabled={benchmarkRunning ? true : isPlaying ? !canStopLiveMatch : startPending || !canStartLiveMatch}
                  className={`hud-btn ${isPlaying ? "hud-btn-stop" : "hud-btn-start"}`}
                >
                  {isPlaying ? "暂停模拟" : startPending ? "启动中" : "启动模拟"}
                </button>
                {benchmarkRunning && (
                  <button
                    type="button"
                    className="hud-btn hud-btn-stop"
                    onClick={handleStop}
                    disabled={!canStopLiveMatch}
                  >
                    停止 Benchmark
                  </button>
                )}
                {canRestartLiveMatch && (
                  <button
                    onClick={handleRestart}
                    disabled={!canRestartLiveMatch}
                    className="hud-btn hud-btn-ghost"
                  >
                    重置
                  </button>
                )}
                <button
                  onClick={handleSaveRecord}
                  disabled={!canSaveLiveMatch}
                  className="hud-btn"
                >
                  保存记录
                </button>
              </>
            )}
          </div>
        </header>

        {(serverMessage || replayError || presetError || lastSavedRecordPath) && (
          <div className="status-strip">
            {serverMessage && <span>{serverMessage}</span>}
            {(benchmarkProgress || (benchmarkRunning && benchmarkRunSummary)) && (
              <span>
                Benchmark {(benchmarkProgress?.cpuStrategy ?? benchmarkRunSummary?.cpuStrategy)}: {benchmarkProgress?.completedRounds ?? 0} / {benchmarkProgress?.totalRounds ?? benchmarkRunSummary?.totalRounds ?? 0}
                {" · "}
                LLM / CPU / 平 {benchmarkProgress?.llmWins ?? 0} / {benchmarkProgress?.cpuWins ?? 0} / {benchmarkProgress?.draws ?? 0}
              </span>
            )}
            {replayError && <span className="status-error">{replayError}</span>}
            {presetError && <span className="status-error">{presetError}</span>}
            {lastSavedRecordPath && <span>记录已保存到: {lastSavedRecordPath}</span>}
          </div>
        )}

        {mode === "replay" && (
          <section className="replay-toolbar">
            <div className="hud-panel-top-corners" />
            <div className="hud-panel-bottom-corners" />
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
            <div className="hud-panel" style={{ flex: 1, minHeight: 0 }}>
              <div className="hud-panel-top-corners" />
              <div className="hud-panel-bottom-corners" />
              <div className="panel-header">
                <span className="panel-header-accent accent-amber">战场数据</span>
              </div>
              <StatsPanel state={displayState} />
            </div>

            <div className="hud-panel" style={{ marginTop: 12 }}>
              <div className="hud-panel-top-corners" />
              <div className="hud-panel-bottom-corners" />
              <div className="panel-header">
                <span className="panel-header-accent accent-red">战术图例</span>
              </div>
              <LegendPanel />
            </div>
          </div>

          <div className="tactical-col">
            <div className="hud-panel">
              <div className="hud-panel-top-corners" />
              <div className="hud-panel-bottom-corners" />
              <div className="scanlines" />
              <div className="viewport-data-lines">
                <span className="data-line dl-tl" />
                <span className="data-line dl-tr" />
                <span className="data-line dl-bl" />
                <span className="data-line dl-br" />
              </div>
              <div className="viewport">
                <GameCanvas state={displayState} />
              </div>
            </div>

            <div className="hud-panel">
              <div className="hud-panel-top-corners" />
              <div className="hud-panel-bottom-corners" />
              <div className="panel-header">
                <span className="panel-header-accent accent-amber">战术日志</span>
              </div>
              <GameLog state={displayState} />
            </div>
          </div>

          <div className="terminal-col">
            <div className="hud-panel" style={{ flex: 1, minHeight: 0 }}>
              <div className="hud-panel-top-corners" />
              <div className="hud-panel-bottom-corners" />
              <div className="panel-header">
                <span className="panel-header-accent accent-cyan">AI 指挥终端</span>
              </div>
              <AIOutputPanel snapshots={displaySnapshots} />
            </div>
          </div>
        </div>

        <SettingsOverlay
          open={mode === "live" && settingsOpen}
          title="设置"
          onClose={() => setSettingsOpen(false)}
        >
          <SettingsPanel
            presets={presets}
            loading={presetsLoading}
            error={presetError}
            onRefresh={refreshPresets}
            onCreate={handleCreatePreset}
            onUpdate={handleUpdatePreset}
            onDelete={handleDeletePreset}
          />
        </SettingsOverlay>

        <SettingsOverlay
          open={mode === "live" && benchmarkOpen}
          title={benchmarkResult ? "Benchmark 结果" : "Benchmark"}
          onClose={() => {
            setBenchmarkOpen(false);
            if (benchmarkResult) {
              clearBenchmarkResult();
            }
          }}
        >
          {benchmarkOpen && !benchmarkRunning && !benchmarkResult && (
            <BenchmarkPanel
              presets={presets}
              initialPresetId={player1PresetId}
              running={benchmarkRunning}
              onStart={handleStartBenchmark}
              onClose={() => setBenchmarkOpen(false)}
            />
          )}
          {benchmarkOpen && benchmarkResult && (
            <BenchmarkResult
              progress={benchmarkProgress}
              result={benchmarkResult}
            />
          )}
        </SettingsOverlay>

        {mode === "live" && !benchmarkRunning && state?.winner && !winnerOverlayDismissed && (
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

function buildMatchDebugOptions(recordLLMTranscript: boolean): MatchDebugOptions | undefined {
  return recordLLMTranscript ? { recordLLMTranscript: true } : undefined;
}
