import { GameSnapshot } from "@llmcraft/shared";

interface AIOutputPanelProps {
  snapshots: GameSnapshot[];
}

export function AIOutputPanel({ snapshots }: AIOutputPanelProps) {
  const latest = snapshots[snapshots.length - 1];

  return (
    <div className="ai-terminal">
      <div className="ai-terminal-block">
        <div className="ai-terminal-header red">
          <span>●</span>
          <span>AI 1 — 红方指挥核心</span>
        </div>
        <pre className="ai-terminal-body">
          {latest?.aiOutputs?.player_1 || (
            <span className="empty-state">等待 AI 接入...</span>
          )}
        </pre>
      </div>

      <div className="ai-terminal-block">
        <div className="ai-terminal-header cyan">
          <span>●</span>
          <span>AI 2 — 蓝方指挥核心</span>
        </div>
        <pre className="ai-terminal-body">
          {latest?.aiOutputs?.player_2 || (
            <span className="empty-state">等待 AI 接入...</span>
          )}
        </pre>
      </div>
    </div>
  );
}
