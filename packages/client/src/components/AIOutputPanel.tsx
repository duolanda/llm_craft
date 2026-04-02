import { GameSnapshot } from "@llmcraft/shared";

interface AIOutputPanelProps {
  snapshots: GameSnapshot[];
}

export function AIOutputPanel({ snapshots }: AIOutputPanelProps) {
  const latest = snapshots[snapshots.length - 1];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", height: "100%" }}>
      <div style={{ flex: 1, overflow: "auto" }}>
        <h3 style={{ margin: "0 0 8px 0", color: "#ff6b6b" }}>AI 1 (红方)</h3>
        <pre
          style={{
            background: "#1a1a2e",
            padding: "8px",
            borderRadius: "4px",
            fontSize: "11px",
            whiteSpace: "pre-wrap",
            maxHeight: "200px",
            overflow: "auto",
            color: "#e0e0e0",
            fontFamily: "monospace",
          }}
        >
          {latest?.aiOutputs?.player_1 || "等待 AI..."}
        </pre>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <h3 style={{ margin: "0 0 8px 0", color: "#4ecdc4" }}>AI 2 (蓝方)</h3>
        <pre
          style={{
            background: "#1a1a2e",
            padding: "8px",
            borderRadius: "4px",
            fontSize: "11px",
            whiteSpace: "pre-wrap",
            maxHeight: "200px",
            overflow: "auto",
            color: "#e0e0e0",
            fontFamily: "monospace",
          }}
        >
          {latest?.aiOutputs?.player_2 || "等待 AI..."}
        </pre>
      </div>
    </div>
  );
}
