import { useCallback, useEffect, useRef, useState } from "react";
import {
  AITerminalEvent,
  ClientMessage,
  GameState,
  MatchPrepareState,
  PlayerId,
  ServerBenchmarkCompleteMessage,
  ServerBenchmarkProgressMessage,
  isServerMessage,
} from "@llmcraft/shared";
import { SimulationFrameBuffer } from "@llmcraft/trace";

const MAX_LIVE_TERMINAL_EVENTS = 500;

export function useWebSocket(url: string, enabled = true) {
  const [state, setState] = useState<GameState | null>(null);
  const [aiOutputs, setAIOutputs] = useState<Record<string, string>>({});
  const [aiTerminalEvents, setAiTerminalEvents] = useState<AITerminalEvent[]>([]);
  const [terminalHistoryEvents, setTerminalHistoryEvents] = useState<AITerminalEvent[]>([]);
  const [terminalHistoryHasMore, setTerminalHistoryHasMore] = useState(false);
  const [connected, setConnected] = useState(false);
  const [lastSavedRecordPath, setLastSavedRecordPath] = useState<string | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [matchStatus, setMatchStatus] = useState<"preparing" | "running" | "stopped" | "finished" | null>(null);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [benchmarkProgress, setBenchmarkProgress] = useState<ServerBenchmarkProgressMessage | null>(null);
  const [benchmarkResult, setBenchmarkResult] = useState<ServerBenchmarkCompleteMessage | null>(null);
  const [prepareStatuses, setPrepareStatuses] = useState<Partial<Record<PlayerId, MatchPrepareState>>>({});
  const [prepareMessage, setPrepareMessage] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const terminalSessionIdRef = useRef<string | null>(null);
  const frameBufferRef = useRef(new SimulationFrameBuffer());

  const send = useCallback((message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
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

        switch (parsed.type) {
          case "state":
            setServerMessage(null);
            if (parsed.frame) {
              const projected = frameBufferRef.current.ingest(parsed.frame);
              if (projected) setState(projected);
              setAIOutputs(parsed.frame.aiOutputs);
            } else {
              frameBufferRef.current.clear();
              setState(parsed.state);
              setAIOutputs(parsed.aiOutputs);
            }
            setLiveEnabled(parsed.liveEnabled);
            setMatchStatus(parsed.matchStatus);
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
            setLastSavedRecordPath(parsed.filePath);
            break;

          case "benchmark_progress":
            setBenchmarkProgress(parsed);
            break;

          case "benchmark_complete":
            setBenchmarkProgress(null);
            setBenchmarkResult(parsed);
            break;

          case "prepare_status":
            setPrepareStatuses((current) => ({
              ...current,
              ...parsed.statuses,
            }));
            setPrepareMessage(parsed.message ?? null);
            break;
        }
      } catch (e) {
        console.error("消息解析错误:", e);
      }
    };

    ws.onclose = () => {
      console.log("WebSocket 已断开");
      setConnected(false);
    };

    ws.onerror = (error) => {
      console.error("WebSocket 错误:", error);
    };

    return () => {
      ws.close();
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

  return {
    state,
    frameBuffer: frameBufferRef.current,
    aiOutputs,
    aiTerminalEvents: terminalHistoryEvents.concat(aiTerminalEvents),
    terminalHistoryHasMore,
    loadEarlierTerminalEvents,
    connected,
    lastSavedRecordPath,
    liveEnabled,
    matchStatus,
    serverMessage,
    benchmarkProgress,
    benchmarkResult,
    prepareStatuses,
    prepareMessage,
    setPrepareStatuses,
    setPrepareMessage,
    send,
    clearServerMessage,
    clearBenchmarkResult,
  };
}
