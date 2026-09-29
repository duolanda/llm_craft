import type { PlayerId, ServerPromptReflectionStatusMessage } from "@llmcraft/shared";

interface PromptReflectionRowProps {
  playerId: PlayerId;
  reflection?: ServerPromptReflectionStatusMessage;
  autoRequested: boolean;
  connected: boolean;
  onGenerate: (playerId: PlayerId) => void;
  onCancel: (playerId: PlayerId) => void;
}

export function PromptReflectionRow({ playerId, reflection, autoRequested, connected, onGenerate, onCancel }: PromptReflectionRowProps) {
  const isRed = playerId === "player_1";
  const side = isRed ? "红方" : "蓝方";
  const canGenerate = reflection?.status !== "running" && reflection?.status !== "completed";
  return (
    <div className="winner-reflection-row">
      <span className={`winner-reflection-side ${isRed ? "red" : "blue"}`}>{side}</span>
      <span className={`winner-reflection-status ${reflection?.status ?? "idle"}`} role="status">
        {reflection?.message ?? (autoRequested ? "已设置自动沉淀，等待启动…" : "本局尚未沉淀")}
      </span>
      {reflection?.status === "running" && reflection.canCancel && (
        <button
          type="button"
          className="hud-btn hud-btn-ghost winner-reflection-action"
          aria-label={`取消${side}策略沉淀`}
          onClick={() => onCancel(playerId)}
          disabled={!connected}
        >
          取消
        </button>
      )}
      {canGenerate && (
        <button
          type="button"
          className="hud-btn hud-btn-ghost winner-reflection-action"
          aria-label={`${reflection ? "重试" : "生成"}${side}策略沉淀`}
          onClick={() => onGenerate(playerId)}
          disabled={!connected}
        >
          {reflection ? "重试" : "生成策略"}
        </button>
      )}
    </div>
  );
}
