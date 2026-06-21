import { useCallback, useEffect, useRef, useState } from "react";
import {
  AITerminalEvent,
  ClientMessage,
  GameState,
  GameSnapshot,
  MatchPrepareState,
  PlayerId,
  ServerBenchmarkCompleteMessage,
  ServerBenchmarkProgressMessage,
  isServerMessage,
} from "@llmcraft/shared";

export function useWebSocket(url: string, enabled = true) {
  const [state, setState] = useState<GameState | null>(null);
  const [snapshots, setSnapshots] = useState<GameSnapshot[]>([]);
  const [aiTerminalEvents, setAiTerminalEvents] = useState<AITerminalEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastSavedRecordPath, setLastSavedRecordPath] = useState<string | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [benchmarkProgress, setBenchmarkProgress] = useState<ServerBenchmarkProgressMessage | null>(null);
  const [benchmarkResult, setBenchmarkResult] = useState<ServerBenchmarkCompleteMessage | null>(null);
  const [prepareStatuses, setPrepareStatuses] = useState<Partial<Record<PlayerId, MatchPrepareState>>>({});
  const [prepareMessage, setPrepareMessage] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

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
            setState(parsed.state);
            setSnapshots(parsed.snapshots);
            setLiveEnabled(parsed.liveEnabled);
            break;

          case "ai_terminal_events":
            setAiTerminalEvents((current) => (parsed.reset ? parsed.events : current.concat(parsed.events)));
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

  return {
    state,
    snapshots,
    aiTerminalEvents,
    connected,
    lastSavedRecordPath,
    liveEnabled,
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
