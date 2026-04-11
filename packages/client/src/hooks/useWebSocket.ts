import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClientMessage,
  GameState,
  GameSnapshot,
  isServerMessage,
} from "@llmcraft/shared";

export function useWebSocket(url: string) {
  const [state, setState] = useState<GameState | null>(null);
  const [snapshots, setSnapshots] = useState<GameSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastSavedRecordPath, setLastSavedRecordPath] = useState<string | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const send = useCallback((message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const clearServerMessage = useCallback(() => {
    setServerMessage(null);
  }, []);

  useEffect(() => {
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

          case "error":
            setServerMessage(parsed.message);
            break;

          case "record_saved":
            setLastSavedRecordPath(parsed.filePath);
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
  }, [url]);

  return { state, snapshots, connected, lastSavedRecordPath, liveEnabled, serverMessage, send, clearServerMessage };
}
