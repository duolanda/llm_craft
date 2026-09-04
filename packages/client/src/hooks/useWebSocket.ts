import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AITerminalEvent,
  ClientMessage,
  GameState,
  LiveLogEvent,
  LiveStateProjectionFrame,
  LiveStateSnapshot,
  MatchWarmupState,
  PlayerId,
  ServerBenchmarkCompleteMessage,
  ServerBenchmarkProgressMessage,
  ServerMessage,
  ServerStateMessage,
  StateProjectionFrame,
  Tile,
  Unit,
  Building,
  isServerMessage,
} from "@llmcraft/shared";
import { SimulationFrameBuffer } from "@llmcraft/record";

const MAX_LIVE_TERMINAL_EVENTS = 100;
const MAX_LIVE_STATE_LOG_EVENTS = 100;

function materializeLiveUnit(unit: LiveStateSnapshot["players"][number]["units"][number]): Unit {
  return {
    ...unit,
    exists: true,
    attackRange: 0,
    carryingCredits: 0,
    carryCapacity: 0,
  };
}

function materializeLiveBuilding(
  building: LiveStateSnapshot["players"][number]["buildings"][number],
): Building {
  const { constructionProgress, ...baseBuilding } = building;
  const materialized: Building = {
    ...baseBuilding,
    exists: true,
    productionQueue: baseBuilding.productionQueue.map((order) => ({ ...order })),
    productionProgress: baseBuilding.productionProgress
      ? {
          ...baseBuilding.productionProgress,
          missingPrerequisites: baseBuilding.productionProgress.missingPrerequisites
            ? [...baseBuilding.productionProgress.missingPrerequisites]
            : undefined,
        }
      : undefined,
  };
  if (constructionProgress) {
    materialized.constructionProgress = {
      workerId: "",
      remainingTicks: constructionProgress.remainingTicks,
      totalTicks: constructionProgress.totalTicks,
    };
  }
  return materialized;
}

// Buffered states intentionally carry no tile grid: SimulationFrameBuffer
// structured-clones every buffered state, so embedding the shared 144x96 map
// here would clone ~13k objects per ingested frame. The shared grid from
// map_init is attached only when a projection is published to React.
function materializeLiveSnapshot(snapshot: LiveStateSnapshot): GameState {
  return {
    tick: snapshot.tick,
    players: snapshot.players.map((player) => ({
      id: player.id,
      resources: { ...player.resources },
      units: player.units.map(materializeLiveUnit),
      buildings: player.buildings.map(materializeLiveBuilding),
    })),
    tiles: [],
    logs: [],
    winner: snapshot.winner,
    ...(snapshot.projectiles === undefined ? {} : { projectiles: snapshot.projectiles }),
  };
}

function materializeLiveFrame(
  frame: LiveStateProjectionFrame,
  aiOutputs: Record<string, string>,
): StateProjectionFrame {
  const metadata = {
    frameSequence: frame.metadata.frameSequence,
    simulationTick: frame.metadata.simulationTick,
    simulationTimeMs: frame.metadata.simulationTimeMs,
    tickIntervalMs: frame.metadata.tickIntervalMs,
    serverTimeMs: 0,
  };
  if (frame.kind === "keyframe") {
    return {
      kind: "keyframe",
      metadata,
      state: materializeLiveSnapshot(frame.state),
      aiOutputs,
    };
  }
  return {
    kind: "delta",
    metadata,
    baseFrameSequence: frame.baseFrameSequence,
    delta: {
      tick: frame.delta.tick,
      players: frame.delta.players.map((player) => ({
        playerId: player.playerId,
        ...(player.resources === undefined ? {} : { resources: { ...player.resources } }),
        unitUpserts: player.unitUpserts.map(materializeLiveUnit),
        removedUnitIds: player.removedUnitIds,
        buildingUpserts: player.buildingUpserts.map(materializeLiveBuilding),
        removedBuildingIds: player.removedBuildingIds,
      })),
      tileUpserts: [],
      ...(frame.delta.projectiles === undefined ? {} : { projectiles: frame.delta.projectiles }),
      logs: { mode: "replace", entries: [] },
      ...(frame.delta.winner === undefined ? {} : { winner: frame.delta.winner }),
    },
    aiOutputs,
  };
}

export function useWebSocket(url: string, enabled = true) {
  const [state, setState] = useState<GameState | null>(null);
  const [aiOutputs, setAIOutputs] = useState<Record<string, string>>({});
  const [liveLogs, setLiveLogs] = useState<LiveLogEvent[]>([]);
  const [aiTerminalEvents, setAiTerminalEvents] = useState<AITerminalEvent[]>([]);
  const [terminalHistoryEvents, setTerminalHistoryEvents] = useState<AITerminalEvent[]>([]);
  const [terminalHistoryHasMore, setTerminalHistoryHasMore] = useState(false);
  const [connected, setConnected] = useState(false);
  const [lastSavedRecord, setLastSavedRecord] = useState<{ matchId: string; fileName: string } | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [observedMatch, setObservedMatch] = useState<ServerStateMessage["observedMatch"]>(null);
  const [matchStatus, setMatchStatus] = useState<
    "warming_up" | "waiting_for_players" | "running" | "stopped" | "finished" | "failed" | null
  >(null);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [benchmarkProgress, setBenchmarkProgress] = useState<ServerBenchmarkProgressMessage | null>(null);
  const [benchmarkResult, setBenchmarkResult] = useState<ServerBenchmarkCompleteMessage | null>(null);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [warmupStatuses, setWarmupStatuses] = useState<Partial<Record<PlayerId, MatchWarmupState>>>({});
  const [warmupMessage, setWarmupMessage] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const terminalSessionIdRef = useRef<string | null>(null);
  const observedMatchIdRef = useRef<string | null>(null);
  const frameBufferRef = useRef(new SimulationFrameBuffer());
  const mapTilesRef = useRef<Tile[][]>([]);
  const liveLogsRef = useRef<LiveLogEvent[]>([]);
  const aiOutputsRef = useRef<Record<string, string>>({});

  const send = useCallback((message: ClientMessage): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
      return true;
    }
    setServerMessage("连接已断开，操作未发送。");
    return false;
  }, []);

  const clearServerMessage = useCallback(() => {
    setServerMessage(null);
  }, []);

  const clearBenchmarkResult = useCallback(() => {
    setBenchmarkResult(null);
    setBenchmarkProgress(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    observedMatchIdRef.current = null;
    frameBufferRef.current.clear();
    mapTilesRef.current = [];
    liveLogsRef.current = [];
    aiOutputsRef.current = {};
    setLiveLogs([]);
    setAIOutputs({});
    const delayedStateTimers = new Set<number>();
    let disposed = false;
    let reconnectTimer: number | null = null;
    const requestedStateJitterMs = import.meta.env.DEV
      ? Number(new URLSearchParams(window.location.search).get("stateJitterMs") ?? 0)
      : 0;
    const stateJitterMs = Number.isFinite(requestedStateJitterMs)
      ? Math.max(0, Math.min(1_000, requestedStateJitterMs))
      : 0;
    const processServerMessage = (parsed: ServerMessage) => {
      switch (parsed.type) {
          case "map_init":
            mapTilesRef.current = parsed.tiles.map((row) => row.map((tile) => ({ ...tile })));
            break;

          case "state_events":
            if (observedMatchIdRef.current && parsed.matchId !== observedMatchIdRef.current) {
              break;
            }
            if (!observedMatchIdRef.current) observedMatchIdRef.current = parsed.matchId;
            liveLogsRef.current = parsed.reset
              ? parsed.events.slice(-MAX_LIVE_STATE_LOG_EVENTS)
              : liveLogsRef.current.concat(parsed.events).slice(-MAX_LIVE_STATE_LOG_EVENTS);
            setLiveLogs(liveLogsRef.current);
            break;

          case "ai_output":
            if (observedMatchIdRef.current && parsed.matchId !== observedMatchIdRef.current) {
              break;
            }
            if (!observedMatchIdRef.current) observedMatchIdRef.current = parsed.matchId;
            aiOutputsRef.current = parsed.outputs;
            setAIOutputs(parsed.outputs);
            break;

          case "state":
            const nextObservedMatchId = parsed.observedMatch?.matchId ?? null;
            const matchChanged = observedMatchIdRef.current !== null
              && nextObservedMatchId !== observedMatchIdRef.current;
            if (matchChanged) {
              frameBufferRef.current.clear();
              liveLogsRef.current = [];
              setLiveLogs([]);
              aiOutputsRef.current = {};
              setAIOutputs({});
            }
            observedMatchIdRef.current = nextObservedMatchId;
            if (parsed.frame) {
              const projected = frameBufferRef.current.ingest(
                materializeLiveFrame(parsed.frame, aiOutputsRef.current),
              );
              if (projected) setState({ ...projected, tiles: mapTilesRef.current });
            } else {
              frameBufferRef.current.clear();
              setState(null);
            }
            setLiveEnabled(parsed.liveEnabled);
            setObservedMatch(parsed.observedMatch);
            setMatchStatus(parsed.matchStatus);
            setBenchmarkRunning(parsed.benchmarkRunning);
            setLastSavedRecord((current) => (
              current && current.matchId === nextObservedMatchId ? current : null
            ));
            break;

          case "ai_terminal_events":
            terminalSessionIdRef.current = parsed.sessionId;
            if (parsed.reset) {
              setTerminalHistoryEvents([]);
              setAiTerminalEvents(parsed.events.slice(-MAX_LIVE_TERMINAL_EVENTS));
            } else {
              setAiTerminalEvents((current) => current.concat(parsed.events).slice(-MAX_LIVE_TERMINAL_EVENTS));
            }
            setTerminalHistoryHasMore(Boolean(parsed.hasMore));
            break;

          case "terminal_history_page":
            if (parsed.sessionId !== terminalSessionIdRef.current) {
              break;
            }
            setTerminalHistoryEvents((current) => {
              const knownIds = new Set(current.map((event) => event.id));
              return parsed.events.filter((event) => !knownIds.has(event.id)).concat(current);
            });
            setTerminalHistoryHasMore(parsed.hasMore);
            break;

          case "error":
            setServerMessage(parsed.message);
            break;

          case "record_saved":
            setLastSavedRecord({ matchId: parsed.matchId, fileName: parsed.fileName });
            break;

          case "benchmark_progress":
            setBenchmarkRunning(true);
            setBenchmarkProgress(parsed);
            break;

          case "benchmark_complete":
            setBenchmarkRunning(false);
            setBenchmarkProgress(null);
            setBenchmarkResult(parsed);
            break;

          case "warmup_status":
            setWarmupStatuses((current) => ({
              ...current,
              ...parsed.statuses,
            }));
            setWarmupMessage(parsed.message ?? null);
            break;
      }
    };

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("WebSocket 已连接");
        setConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);

          if (!isServerMessage(parsed)) {
            console.warn("收到未知的服务端消息:", parsed);
            return;
          }

          if (parsed.type === "state" && parsed.frame && stateJitterMs > 0) {
            // DEV-only deterministic +/- jitter around a positive delay. The
            // alternating delay intentionally makes some frames arrive late.
            const delayMs = parsed.frame.metadata.frameSequence % 2 === 0 ? stateJitterMs * 2 : 0;
            const timer = window.setTimeout(() => {
              delayedStateTimers.delete(timer);
              processServerMessage(parsed);
            }, delayMs);
            delayedStateTimers.add(timer);
            return;
          }

          processServerMessage(parsed);
        } catch (e) {
          console.error("消息解析错误:", e);
        }
      };

      ws.onclose = () => {
        console.log("WebSocket 已断开");
        if (wsRef.current === ws) wsRef.current = null;
        setConnected(false);
        setMatchStatus(null);
        setBenchmarkRunning(false);
        setWarmupStatuses({});
        setWarmupMessage(null);
        observedMatchIdRef.current = null;
        frameBufferRef.current.clear();
        mapTilesRef.current = [];
        liveLogsRef.current = [];
        aiOutputsRef.current = {};
        if (!disposed && reconnectTimer === null) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 1_000);
        }
      };

      ws.onerror = (error) => {
        console.error("WebSocket 错误:", error);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      for (const timer of delayedStateTimers) window.clearTimeout(timer);
      delayedStateTimers.clear();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [enabled, url]);

  const loadEarlierTerminalEvents = useCallback(() => {
    const sequenceOf = (event: AITerminalEvent | undefined) => (
      event ? Number(event.id.replace(/^evt_/, "")) : undefined
    );
    const historyNewestSequence = sequenceOf(terminalHistoryEvents.at(-1));
    const liveOldestSequence = sequenceOf(aiTerminalEvents[0]);
    const hasGap = historyNewestSequence !== undefined
      && liveOldestSequence !== undefined
      && historyNewestSequence + 1 < liveOldestSequence;
    const beforeSequence = hasGap
      ? liveOldestSequence
      : sequenceOf(terminalHistoryEvents[0] ?? aiTerminalEvents[0]);
    send({
      type: "load_terminal_history",
      beforeSequence: Number.isFinite(beforeSequence) ? beforeSequence : undefined,
      limit: 100,
    });
  }, [aiTerminalEvents, send, terminalHistoryEvents]);

  const combinedTerminalEvents = useMemo(() => {
    const knownIds = new Set<string>();
    const combined: AITerminalEvent[] = [];
    for (const event of terminalHistoryEvents.concat(aiTerminalEvents)) {
      if (knownIds.has(event.id)) continue;
      knownIds.add(event.id);
      combined.push(event);
    }
    return combined;
  }, [aiTerminalEvents, terminalHistoryEvents]);

  return {
    state,
    frameBuffer: frameBufferRef.current,
    aiOutputs,
    liveLogs,
    aiTerminalEvents: combinedTerminalEvents,
    terminalHistoryHasMore,
    loadEarlierTerminalEvents,
    connected,
    lastSavedRecord,
    liveEnabled,
    observedMatch,
    matchStatus,
    serverMessage,
    benchmarkProgress,
    benchmarkResult,
    benchmarkRunning,
    warmupStatuses,
    warmupMessage,
    setWarmupStatuses,
    setWarmupMessage,
    send,
    clearServerMessage,
    clearBenchmarkResult,
  };
}
