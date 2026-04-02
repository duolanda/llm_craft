import { useState } from "react";
import { GameCanvas } from "./components/GameCanvas";
import { AIOutputPanel } from "./components/AIOutputPanel";
import { GameLog } from "./components/GameLog";
import { useWebSocket } from "./hooks/useWebSocket";

function App() {
  const { state, snapshots, connected, send } = useWebSocket("ws://localhost:3001");
  const [isPlaying, setIsPlaying] = useState(false);

  const handleStart = () => {
    send({ type: "start" });
    setIsPlaying(true);
  };

  const handleStop = () => {
    send({ type: "stop" });
    setIsPlaying(false);
  };

  return (
    <div style={{
      background: "#0f0f1a",
      minHeight: "100vh",
      color: "#e0e0e0",
      padding: "16px",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "16px",
      }}>
        <h1 style={{ margin: 0 }}>LLMCraft MVP</h1>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <span style={{
            padding: "4px 8px",
            borderRadius: "4px",
            background: connected ? "#27ae60" : "#c0392b",
            fontSize: "12px",
          }}>
            {connected ? "已连接" : "未连接"}
          </span>
          <button
            onClick={isPlaying ? handleStop : handleStart}
            disabled={!connected}
            style={{
              padding: "8px 16px",
              background: isPlaying ? "#c0392b" : "#27ae60",
              border: "none",
              borderRadius: "4px",
              color: "white",
              cursor: connected ? "pointer" : "not-allowed",
              opacity: connected ? 1 : 0.5,
            }}
          >
            {isPlaying ? "停止" : "开始"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: "16px" }}>
        <div>
          <GameCanvas state={state} />
          <div style={{ marginTop: "8px" }}>
            <GameLog state={state} />
          </div>
        </div>
        <div style={{ minHeight: "500px" }}>
          <AIOutputPanel snapshots={snapshots} />
        </div>
      </div>

      {state?.winner && (
        <div style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background: "#1a1a2e",
          padding: "32px",
          borderRadius: "8px",
          border: "2px solid #ffd700",
          fontSize: "24px",
          textAlign: "center",
          zIndex: 1000,
        }}>
          胜利者: {state.winner === "player_1" ? "红方" : "蓝方"}
        </div>
      )}
    </div>
  );
}

export default App;
