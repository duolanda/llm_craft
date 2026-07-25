import { ChangeEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CPUStrategyType,
  CreateLLMPresetRequest,
  GameRecord,
  GameState,
  LLMPresetSummary,
  MatchDebugOptions,
  MatchWarmupState,
  MatchRecordingProfile,
  MatchRegistrySummary,
  PlayerId,
  TestLLMPresetRequest,
  UpdateLLMPresetRequest,
} from "@llmcraft/shared";
import { projectRecordToMatchRecord, SimulationFrameBuffer } from "@llmcraft/record";
import { Battlefield3D } from "./components/Battlefield3D";
import { AIOutputPanel } from "./components/AIOutputPanel";
import { GameLog } from "./components/GameLog";
import { StatsPanel } from "./components/StatsPanel";
import { LegendPanel } from "./components/LegendPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SettingsOverlay } from "./components/SettingsOverlay";
import { BenchmarkPanel } from "./components/BenchmarkPanel";
import { BenchmarkResult } from "./components/BenchmarkResult";
import { MatchPanel } from "./components/MatchPanel";
import { useWebSocket } from "./hooks/useWebSocket";
import { createPreset, deletePreset, listPresets, testPreset, updatePreset } from "./lib/settingsApi";
import { listRegisteredMatches, observeRegisteredMatch } from "./lib/matchApi";
import { readLocalRecordText } from "./lib/readRecordFile";
import { buildReplayFrames, formatTickTime, ReplayFrame } from "./replay";
import { createAnimationLabState, createMassBattleState } from "./dev/createMassBattleState";

type AppMode = "live" | "replay";
type AnimationLabMode = "implemented" | "preview";

interface ReplayRecordListEntry {
  fileName: string;
  fullPath: string;
  size: number;
  modifiedAt: string;
  encoding?: "identity" | "gzip";
}

const SERVER_HOST = window.location.hostname || "localhost";
const WS_URL = `ws://${SERVER_HOST}:3101`;
const API_BASE_URL = `http://${SERVER_HOST}:3101`;
const LIVE_PRESET_SELECTION_STORAGE_KEY = "llmcraft.livePresetSelection";
const SHOWCASE_MODE = new URLSearchParams(window.location.search).get("showcase");
const REQUESTED_REPLAY_FILE = new URLSearchParams(window.location.search).get("replay");
const requestedReplayTick = new URLSearchParams(window.location.search).get("tick");
const REQUESTED_REPLAY_TICK = requestedReplayTick === null ? null : Number(requestedReplayTick);
const MASS_BATTLE_SHOWCASE = import.meta.env.DEV && SHOWCASE_MODE === "mass-battle";
const ANIMATION_LAB_SHOWCASE = import.meta.env.DEV && SHOWCASE_MODE === "animation-lab";
const ANIMATION_LAB_MODE: AnimationLabMode = new URLSearchParams(window.location.search).get("lab") === "preview"
  ? "preview"
  : "implemented";
const LOCAL_SHOWCASE = MASS_BATTLE_SHOWCASE || ANIMATION_LAB_SHOWCASE;
const requestedShowcaseUnits = Number(new URLSearchParams(window.location.search).get("units"));
const MASS_BATTLE_UNIT_COUNT = Number.isFinite(requestedShowcaseUnits) && requestedShowcaseUnits > 0
  ? Math.min(240, Math.floor(requestedShowcaseUnits))
  : 200;

interface LivePresetSelection {
  player1PresetId: string;
  player2PresetId: string;
}

function DevQuickNav() {
  if (!import.meta.env.DEV) {
    return null;
  }

  const links = [
    { label: "Live", href: "/" },
    { label: "Mass Battle", href: "/?showcase=mass-battle&units=200" },
    { label: "Animation Lab", href: "/?showcase=animation-lab" },
    { label: "FX Preview", href: "/?showcase=animation-lab&lab=preview" },
    { label: "Diagnostics", href: "/diagnostics.html" },
    { label: "Match Explorer", href: "/transcript.html" },
  ];

  return (
    <details className="dev-quick-nav">
      <summary>DEV</summary>
      <nav aria-label="Developer quick navigation">
        {links.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label}
          </a>
        ))}
      </nav>
    </details>
  );
}

function ShowcasePanel({
  kicker,
  title,
  children,
}: {
  kicker: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <aside className="showcase-panel">
      <span className="showcase-panel-kicker">{kicker}</span>
      <div className="showcase-panel-title">{title}</div>
      <div className="showcase-panel-tabs">
        {children}
      </div>
    </aside>
  );
}

function AnimationLabPanel({ mode }: { mode: AnimationLabMode }) {
  if (!import.meta.env.DEV) {
    return null;
  }

  return (
    <ShowcasePanel kicker="Animation Lab" title={mode === "preview" ? "FX Preview" : "Implemented States"}>
      <a className={mode === "implemented" ? "active" : ""} href="/?showcase=animation-lab">
        Implemented
      </a>
      <a className={mode === "preview" ? "active" : ""} href="/?showcase=animation-lab&lab=preview">
        Preview
      </a>
    </ShowcasePanel>
  );
}

function MassBattlePanel({ unitCount }: { unitCount: number }) {
  if (!import.meta.env.DEV) {
    return null;
  }

  const lodEnabled = new URLSearchParams(window.location.search).get("lod") === "mass";
  const highDetailHref = `/?showcase=mass-battle&units=${unitCount}`;
  const lodHref = `/?showcase=mass-battle&units=${unitCount}&lod=mass`;

  return (
    <ShowcasePanel kicker="Mass Battle" title={`${unitCount} vs ${unitCount}`}>
      <a className={!lodEnabled ? "active" : ""} href={highDetailHref}>
        High Detail
      </a>
      <a className={lodEnabled ? "active" : ""} href={lodHref}>
        Mass LOD
      </a>
    </ShowcasePanel>
  );
}

function readStoredLivePresetSelection(): LivePresetSelection {
  try {
    const rawSelection = window.localStorage.getItem(LIVE_PRESET_SELECTION_STORAGE_KEY);
    if (!rawSelection) {
      return { player1PresetId: "", player2PresetId: "" };
    }

    const parsedSelection = JSON.parse(rawSelection) as Partial<LivePresetSelection>;
    return {
      player1PresetId: typeof parsedSelection.player1PresetId === "string" ? parsedSelection.player1PresetId : "",
      player2PresetId: typeof parsedSelection.player2PresetId === "string" ? parsedSelection.player2PresetId : "",
    };
  } catch {
    return { player1PresetId: "", player2PresetId: "" };
  }
}

function writeStoredLivePresetSelection(selection: LivePresetSelection): void {
  try {
    window.localStorage.setItem(LIVE_PRESET_SELECTION_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Ignore storage failures so private browsing or quota issues do not break match setup.
  }
}

function App() {
  const {
    state,
    frameBuffer,
    aiOutputs,
    aiTerminalEvents,
    terminalHistoryHasMore,
    loadEarlierTerminalEvents,
    connected,
    lastSavedRecordPath,
    liveEnabled,
    matchStatus,
    serverMessage,
    benchmarkProgress,
    benchmarkResult,
    warmupStatuses,
    warmupMessage,
    setWarmupStatuses,
    setWarmupMessage,
    send,
    clearServerMessage,
    clearBenchmarkResult,
  } = useWebSocket(WS_URL, !LOCAL_SHOWCASE);
  const [isPlaying, setIsPlaying] = useState(false);
  const [winnerOverlayDismissed, setWinnerOverlayDismissed] = useState(false);
  const [mode, setMode] = useState<AppMode>("live");
  const [recordEntries, setRecordEntries] = useState<ReplayRecordListEntry[]>([]);
  const [selectedRecordFile, setSelectedRecordFile] = useState("");
  const [activeReplayRecord, setActiveReplayRecord] = useState<GameRecord | null>(null);
  const [replayFrames, setReplayFrames] = useState<ReplayFrame[]>([]);
  const [replayFrameIndex, setReplayFrameIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [replaySourceName, setReplaySourceName] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const replayFrameBuffer = useMemo(() => new SimulationFrameBuffer(4), []);
  const replayQueryLoaded = useRef(false);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [presets, setPresets] = useState<LLMPresetSummary[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [player1PresetId, setPlayer1PresetId] = useState(() => readStoredLivePresetSelection().player1PresetId);
  const [player2PresetId, setPlayer2PresetId] = useState(() => readStoredLivePresetSelection().player2PresetId);
  const [recordingProfile, setRecordingProfile] = useState<MatchRecordingProfile>("evaluation");
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [startBaselineTick, setStartBaselineTick] = useState(-1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [matchesOpen, setMatchesOpen] = useState(false);
  const [registeredMatches, setRegisteredMatches] = useState<MatchRegistrySummary[]>([]);
  const [observedMatchId, setObservedMatchId] = useState<string | null>(null);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchesError, setMatchesError] = useState<string | null>(null);
  const [switchingMatchId, setSwitchingMatchId] = useState<string | null>(null);
  const [benchmarkOpen, setBenchmarkOpen] = useState(false);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkRunSummary, setBenchmarkRunSummary] = useState<{
    cpuStrategy: CPUStrategyType;
    totalRounds: number;
    concurrency: number;
  } | null>(null);
  const [hasLiveMatchStarted, setHasLiveMatchStarted] = useState(false);
  const [showcaseTick, setShowcaseTick] = useState(0);
  const lastAutoSavedWinnerRef = useRef<string | null>(null);

  const refreshRegisteredMatches = useCallback(async (showLoading = true) => {
    if (showLoading) {
      setMatchesLoading(true);
      setMatchesError(null);
    }
    try {
      const payload = await listRegisteredMatches(API_BASE_URL);
      setRegisteredMatches(payload.matches);
      setObservedMatchId(payload.observedMatchId);
      setMatchesError(null);
    } catch (error) {
      setMatchesError(error instanceof Error ? error.message : String(error));
    } finally {
      if (showLoading) {
        setMatchesLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!LOCAL_SHOWCASE) {
      return;
    }

    const interval = window.setInterval(() => {
      setShowcaseTick((current) => current + 1);
    }, 500);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (LOCAL_SHOWCASE || mode !== "live" || !matchesOpen) return;
    void refreshRegisteredMatches();
    const interval = window.setInterval(() => {
      void refreshRegisteredMatches(false);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [matchesOpen, mode, refreshRegisteredMatches]);

  useEffect(() => {
    if (mode !== "live" || benchmarkRunning || benchmarkResult) {
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
  }, [benchmarkResult, benchmarkRunning, mode, send, state?.winner]);

  useEffect(() => {
    if (mode !== "live" || benchmarkRunning || benchmarkResult || matchStatus === null) {
      return;
    }
    setIsPlaying(matchStatus === "running");
    if (matchStatus === "running") {
      setStartPending(false);
      setHasLiveMatchStarted(true);
    }
  }, [benchmarkResult, benchmarkRunning, matchStatus, mode]);

  useEffect(() => {
    if (mode !== "live" || benchmarkRunning || benchmarkResult || !state?.winner || winnerOverlayDismissed) {
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
  }, [benchmarkResult, benchmarkRunning, mode, state?.winner, winnerOverlayDismissed]);

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
    }, Math.max(50, (activeReplayRecord?.definition.tickIntervalMs ?? 500) / replaySpeed));

    return () => {
      window.clearInterval(interval);
    };
  }, [activeReplayRecord?.definition.tickIntervalMs, mode, replayFrames.length, replayPlaying, replaySpeed]);

  const fetchRecordEntries = async () => {
    setRecordsLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/replay/records`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json() as { records: ReplayRecordListEntry[] };
      setRecordEntries(payload.records);
      setSelectedRecordFile((current) => current || payload.records[0]?.fileName || "");
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
      setPresetsLoaded(true);
    } catch (error) {
      setPresetError(`获取预设列表失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPresetsLoading(false);
    }
  };

  useEffect(() => {
    if (LOCAL_SHOWCASE) {
      return;
    }
    void fetchRecordEntries();
    void refreshPresets();
  }, []);

  useEffect(() => {
    if (!presetsLoaded) {
      return;
    }

    if (presets.length === 0) {
      setPlayer1PresetId("");
      setPlayer2PresetId("");
      return;
    }

    const presetIds = new Set(presets.map((preset) => preset.id));
    setPlayer1PresetId((current) => (current && presetIds.has(current) ? current : presets[0]?.id ?? ""));
    setPlayer2PresetId((current) => (current && presetIds.has(current) ? current : presets[1]?.id ?? presets[0]?.id ?? ""));
  }, [presets, presetsLoaded]);

  useEffect(() => {
    writeStoredLivePresetSelection({ player1PresetId, player2PresetId });
  }, [player1PresetId, player2PresetId]);

  useEffect(() => {
    setWarmupStatuses({});
    setWarmupMessage(null);
  }, [player1PresetId, player2PresetId, recordingProfile, includeTranscript, setWarmupMessage, setWarmupStatuses]);

  const loadReplayRecord = (record: GameRecord, sourceName: string) => {
    const frames = buildReplayFrames(record);
    setActiveReplayRecord(record);
    setReplayFrames(frames);
    setReplayFrameIndex(0);
    setReplayPlaying(false);
    setReplaySourceName(sourceName);
    setReplayError(null);
    setMode("replay");
  };

  useEffect(() => {
    if (!REQUESTED_REPLAY_FILE || replayQueryLoaded.current || LOCAL_SHOWCASE) return;
    replayQueryLoaded.current = true;
    setSelectedRecordFile(REQUESTED_REPLAY_FILE);
    void fetch(`${API_BASE_URL}/api/replay/records/${encodeURIComponent(REQUESTED_REPLAY_FILE)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const record = projectRecordToMatchRecord(await response.json() as unknown);
        const frames = buildReplayFrames(record);
        loadReplayRecord(record, REQUESTED_REPLAY_FILE);
        if (REQUESTED_REPLAY_TICK !== null && Number.isFinite(REQUESTED_REPLAY_TICK)) {
          const index = frames.findIndex((frame) => frame.tick >= REQUESTED_REPLAY_TICK);
          setReplayFrameIndex(index >= 0 ? index : Math.max(0, frames.length - 1));
        }
      })
      .catch((error) => setReplayError(`加载回放记录失败: ${error instanceof Error ? error.message : String(error)}`));
  }, []);

  const handleLoadSelectedRecord = async () => {
    if (!selectedRecordFile) {
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/replay/records/${encodeURIComponent(selectedRecordFile)}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const record = projectRecordToMatchRecord(await response.json() as unknown);
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
      const text = await readLocalRecordText(file);
      const record = projectRecordToMatchRecord(JSON.parse(text) as unknown);
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
      debug: buildMatchDebugOptions(recordingProfile, includeTranscript),
    });
  };

  const startLiveMatch = () => {
    if (!player1PresetId || !player2PresetId) {
      return;
    }

    clearServerMessage();
    setWarmupMessage(null);
    setStartPending(true);
    setStartBaselineTick(state?.tick ?? -1);
    setIsPlaying(false);
    send({
      type: "start",
      player1PresetId,
      player2PresetId,
      debug: buildMatchDebugOptions(recordingProfile, includeTranscript),
    });
  };

  const handleWarmup = (playerId: PlayerId) => {
    if (!player1PresetId || !player2PresetId) {
      return;
    }

    clearServerMessage();
    setWarmupStatuses((current) => ({
      ...current,
      [playerId]: "warming_up",
    }));
    setWarmupMessage(null);
    send({
      type: "warmup",
      player1PresetId,
      player2PresetId,
      debug: buildMatchDebugOptions(recordingProfile, includeTranscript),
      warmup: {
        player_1: playerId === "player_1",
        player_2: playerId === "player_2",
      },
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

  const handleObserveMatch = async (match: MatchRegistrySummary) => {
    setSwitchingMatchId(match.matchId);
    setMatchesError(null);
    try {
      await observeRegisteredMatch(API_BASE_URL, match.matchId);
      setObservedMatchId(match.matchId);
      setStartPending(false);
      setIsPlaying(match.status === "running");
      setWinnerOverlayDismissed(match.status !== "finished");
      await refreshRegisteredMatches();
    } catch (error) {
      setMatchesError(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitchingMatchId(null);
    }
  };

  const handleStartBenchmark = (input: {
    presetId: string;
    cpuStrategy: CPUStrategyType;
    rounds: number;
    recordReplay: boolean;
    concurrency: number;
    debug?: MatchDebugOptions;
  }) => {
    clearServerMessage();
    clearBenchmarkResult();
    setBenchmarkRunning(true);
    setBenchmarkOpen(false);
    setBenchmarkRunSummary({
      cpuStrategy: input.cpuStrategy,
      totalRounds: input.rounds,
      concurrency: input.concurrency,
    });
    setWinnerOverlayDismissed(true);
    setIsPlaying(false);
    send({
      type: "start_benchmark",
      presetId: input.presetId,
      cpuStrategy: input.cpuStrategy,
      rounds: input.rounds,
      recordReplay: input.recordReplay,
      concurrency: input.concurrency,
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

  const handleTestPreset = async (input: TestLLMPresetRequest) => {
    return await testPreset(API_BASE_URL, input);
  };

  const replayFrame = replayFrames[replayFrameIndex] ?? null;
  const replayTickIntervalMs = activeReplayRecord?.definition.tickIntervalMs ?? 500;
  const displayTickIntervalMs = mode === "replay"
    ? replayTickIntervalMs
    : frameBuffer.getLatestFrame()?.metadata.tickIntervalMs ?? 500;
  useEffect(() => {
    replayFrameBuffer.clear();
    const start = Math.max(0, replayFrameIndex - 1);
    for (let index = start; index <= replayFrameIndex; index++) {
      const frame = replayFrames[index];
      if (!frame) continue;
      replayFrameBuffer.ingest({
        kind: "keyframe",
        metadata: {
          frameSequence: index + 1,
          simulationTick: frame.tick,
          simulationTimeMs: frame.tick * replayTickIntervalMs,
          tickIntervalMs: replayTickIntervalMs,
          serverTimeMs: 0,
        },
        state: frame.state,
        aiOutputs: frame.aiOutputs,
      });
    }
  }, [replayFrameBuffer, replayFrameIndex, replayFrames, replayTickIntervalMs]);
  const sourceDisplayState: GameState | null = mode === "replay" ? replayFrame?.state ?? null : state;
  const displayState = useMemo(
    () => {
      if (ANIMATION_LAB_SHOWCASE) {
        return createAnimationLabState(showcaseTick, ANIMATION_LAB_MODE);
      }
      if (MASS_BATTLE_SHOWCASE) {
        return createMassBattleState(sourceDisplayState, MASS_BATTLE_UNIT_COUNT);
      }
      return sourceDisplayState;
    },
    [sourceDisplayState, showcaseTick],
  );
  const displayAIOutputs = mode === "replay" ? replayFrame?.aiOutputs ?? {} : aiOutputs;
  const displayAITerminalEvents = mode === "replay" ? replayFrame?.terminalEvents ?? [] : aiTerminalEvents;
  const terminalAutoScroll = mode === "replay" ? replayPlaying : (isPlaying || benchmarkRunning);

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
  const canSaveLiveMatch = connected
    && !isPlaying
    && !startPending
    && !benchmarkRunning
    && recordingProfile !== "off"
    && hasLiveMatchStarted;
  const isWarmingUp = warmupStatuses.player_1 === "warming_up" || warmupStatuses.player_2 === "warming_up";
  const benchmarkStatusVisible = Boolean(benchmarkProgress || (benchmarkRunning && benchmarkRunSummary));
  const benchmarkTotalRounds = benchmarkProgress?.totalRounds ?? benchmarkRunSummary?.totalRounds ?? 0;
  const benchmarkCurrentRound = benchmarkTotalRounds > 0
    ? Math.min((benchmarkProgress?.completedRounds ?? 0) + 1, benchmarkTotalRounds)
    : 0;
  const benchmarkViewedRound = benchmarkProgress?.viewedRound ?? null;
  const benchmarkActiveRoundLabel = benchmarkProgress?.activeRounds.length
    ? formatRoundList(benchmarkProgress.activeRounds.map((round) => round.round))
    : null;

  if (LOCAL_SHOWCASE) {
    return (
      <main className="battlefield-showcase">
        <DevQuickNav />
        {ANIMATION_LAB_SHOWCASE ? <AnimationLabPanel mode={ANIMATION_LAB_MODE} /> : null}
        {MASS_BATTLE_SHOWCASE ? <MassBattlePanel unitCount={MASS_BATTLE_UNIT_COUNT} /> : null}
        <Battlefield3D
          state={displayState}
          projectileFxMode={ANIMATION_LAB_SHOWCASE && ANIMATION_LAB_MODE === "preview" ? "preview" : "game"}
        />
      </main>
    );
  }

  return (
    <>
      <div className="noise-overlay" />
      <DevQuickNav />
      <div className="app-shell">
        <header className="app-header">
          <div className="brand">
            <h1>LLMCraft</h1>
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
                  <div className="settings-field compact">
                    <span>红方预设</span>
                    <div className="preset-select-row">
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
                      <button
                        type="button"
                        className={`match-warmup-btn ${getWarmupStatusClass(warmupStatuses.player_1)}`}
                        onClick={() => handleWarmup("player_1")}
                        disabled={!connected || !canStartLiveMatch || isPlaying || startPending || benchmarkRunning || warmupStatuses.player_1 === "warming_up"}
                      >
                        {getWarmupButtonLabel(warmupStatuses.player_1)}
                      </button>
                    </div>
                  </div>
                  <div className="settings-field compact">
                    <span>蓝方预设</span>
                    <div className="preset-select-row">
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
                      <button
                        type="button"
                        className={`match-warmup-btn ${getWarmupStatusClass(warmupStatuses.player_2)}`}
                        onClick={() => handleWarmup("player_2")}
                        disabled={!connected || !canStartLiveMatch || isPlaying || startPending || benchmarkRunning || warmupStatuses.player_2 === "warming_up"}
                      >
                        {getWarmupButtonLabel(warmupStatuses.player_2)}
                      </button>
                    </div>
                  </div>
                </div>
                <div className="match-action-bar">
                  <details className="match-options">
                    <summary className="hud-btn hud-btn-ghost">录制</summary>
                    <div className="match-options-menu">
                      <label className="settings-field compact">
                        <span>记录档位</span>
                        <select
                          className="settings-select"
                          value={recordingProfile}
                          onChange={(event) => setRecordingProfile(event.target.value as MatchRecordingProfile)}
                        >
                          <option value="off">关闭</option>
                          <option value="replay">回放</option>
                          <option value="evaluation">评估</option>
                        </select>
                      </label>
                      <label className="benchmark-inline-toggle-row">
                        <input
                          type="checkbox"
                          checked={includeTranscript}
                          onChange={(event) => setIncludeTranscript(event.target.checked)}
                          disabled={recordingProfile !== "evaluation"}
                        />
                        完整 transcript
                      </label>
                      <button
                        type="button"
                        onClick={handleSaveRecord}
                        disabled={!canSaveLiveMatch}
                        className="hud-btn"
                      >
                        保存记录
                      </button>
                    </div>
                  </details>
                  <button
                    type="button"
                    className="hud-btn hud-btn-ghost"
                    onClick={() => setMatchesOpen(true)}
                    disabled={!connected}
                  >
                    对局{registeredMatches.length > 0 ? ` ${registeredMatches.length}` : ""}
                  </button>
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
                    disabled={benchmarkRunning ? true : isPlaying ? !canStopLiveMatch : startPending || isWarmingUp || !canStartLiveMatch}
                    className={`hud-btn ${isPlaying ? "hud-btn-stop" : "hud-btn-start"}`}
                  >
                    {isPlaying ? "暂停对局" : startPending ? "启动中" : hasLiveMatchStarted ? "继续对局" : "启动对局"}
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
                </div>
              </>
            )}
          </div>
        </header>

        {(serverMessage || warmupMessage || benchmarkStatusVisible || replayError || presetError || lastSavedRecordPath) && (
          <div className="status-strip">
            {serverMessage && <span>{serverMessage}</span>}
            {warmupMessage && <span>{warmupMessage}</span>}
            {benchmarkStatusVisible && (
              <span>
                Benchmark {(benchmarkProgress?.cpuStrategy ?? benchmarkRunSummary?.cpuStrategy)}: 已完成 {benchmarkProgress?.completedRounds ?? 0} / {benchmarkTotalRounds} 局
                {" · "}
                LLM / CPU / 平 {benchmarkProgress?.llmWins ?? 0} / {benchmarkProgress?.cpuWins ?? 0} / {benchmarkProgress?.draws ?? 0}
                {" · "}
                当前画面: {benchmarkViewedRound ? `第 ${benchmarkViewedRound} 局（自动观战）` : benchmarkCurrentRound ? `等待第 ${benchmarkCurrentRound} 局` : "等待活跃对局"}
                {benchmarkActiveRoundLabel && (
                  <>
                    {" · "}
                    活跃: {benchmarkActiveRoundLabel}
                  </>
                )}
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
                <input type="file" accept=".json,.gz,application/json,application/gzip" onChange={handleLocalFileChange} />
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
                  时间: {formatTickTime(replayFrame?.tick ?? 0, replayTickIntervalMs)}
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
              <StatsPanel state={displayState} tickIntervalMs={displayTickIntervalMs} />
            </div>

            <details className="hud-panel legend-collapsible" style={{ marginTop: 12 }}>
              <div className="hud-panel-top-corners" />
              <div className="hud-panel-bottom-corners" />
              <summary className="panel-header legend-summary">
                <span className="panel-header-accent accent-red">战术图例</span>
              </summary>
              <LegendPanel />
            </details>
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
                <Battlefield3D
                  state={displayState}
                  frameBuffer={mode === "replay" ? replayFrameBuffer : undefined}
                  simulationTimeMs={mode === "replay" ? (replayFrame?.tick ?? 0) * replayTickIntervalMs : undefined}
                />
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
              <AIOutputPanel
                aiOutputs={displayAIOutputs}
                events={displayAITerminalEvents}
                autoScroll={terminalAutoScroll}
                canLoadEarlier={mode === "live" && terminalHistoryHasMore}
                onLoadEarlier={loadEarlierTerminalEvents}
              />
            </div>
          </div>
        </div>

        <SettingsOverlay
          open={mode === "live" && matchesOpen}
          title="对局观察"
          onClose={() => setMatchesOpen(false)}
        >
          <MatchPanel
            matches={registeredMatches}
            observedMatchId={observedMatchId}
            loading={matchesLoading}
            error={matchesError}
            switchingMatchId={switchingMatchId}
            onRefresh={() => void refreshRegisteredMatches()}
            onObserve={(match) => void handleObserveMatch(match)}
          />
        </SettingsOverlay>

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
            onTest={handleTestPreset}
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

        {mode === "live" && !benchmarkRunning && !benchmarkResult && state?.winner && !winnerOverlayDismissed && (
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

function buildMatchDebugOptions(
  recordingProfile: MatchRecordingProfile,
  includeTranscript: boolean,
): MatchDebugOptions {
  return {
    recordingProfile,
    includeTranscript: recordingProfile === "evaluation" && includeTranscript,
  };
}

function getWarmupButtonLabel(status: MatchWarmupState | undefined): string {
  if (status === "warming_up") {
    return "预热中";
  }
  if (status === "ready") {
    return "已预热";
  }
  if (status === "error") {
    return "重试";
  }
  return "预热";
}

function formatRoundList(rounds: number[]): string {
  if (rounds.length === 0) {
    return "";
  }
  return `第 ${rounds.join("、")} 局`;
}

function getWarmupStatusClass(status: MatchWarmupState | undefined): string {
  return status ? `warmup-${status}` : "warmup-idle";
}
