import { useEffect, useRef, useState, useCallback } from "react";
import { GameState, GameSnapshot } from "@llmcraft/shared";

interface WSMessage {
  type: string;
  state: GameState;
  snapshots: GameSnapshot[];
}

export function useWebSocket(url: string) {
  const [state, setState] = useState<GameState | null>(null);
  const [snapshots, setSnapshots] = useState<GameSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
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
        const data: WSMessage = JSON.parse(event.data);
        if (data.type === "state") {
          setState(data.state);
          setSnapshots(data.snapshots);
        }
      } catch (e) {
        console.error("解析错误:", e);
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

  return { state, snapshots, connected, send };
}
