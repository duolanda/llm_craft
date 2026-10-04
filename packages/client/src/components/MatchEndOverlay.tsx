import type { MatchRecordSaveState, MatchRegistryKind, MatchRegistryStatus, PlayerId } from "@llmcraft/shared";

export function getMatchEndPresentation(
  kind: MatchRegistryKind,
  status: MatchRegistryStatus | null,
  winner: PlayerId | null,
): { title: string; tone: "red" | "cyan" | "neutral" } | null {
  if (kind === "benchmark") return null;
  if (winner) return { title: winner === "player_1" ? "红方获胜" : "蓝方获胜", tone: winner === "player_1" ? "red" : "cyan" };
  if (status === "failed") return { title: "对局异常结束", tone: "neutral" };
  if (status === "finished") return { title: "对局已结束", tone: "neutral" };
  // A stopped Web match is paused and may resume; a CLI stop is terminal.
  if (kind === "control" && status === "stopped") return { title: "对局已停止", tone: "neutral" };
  return null;
}

export function MatchEndOverlay({ presentation, recordSave, onClose }: {
  presentation: NonNullable<ReturnType<typeof getMatchEndPresentation>>;
  recordSave: MatchRecordSaveState;
  onClose: () => void;
}) {
  return (
    <div className="winner-overlay" onClick={onClose}>
      <div className="winner-card" role="dialog" aria-modal="true" aria-labelledby="match-end-title"
        onClick={(event) => event.stopPropagation()}>
        <div className="winner-label">对局结束</div>
        <div id="match-end-title" className={`winner-name ${presentation.tone}`}>{presentation.title}</div>
        <div className="winner-save-path" role="status" aria-live="polite">
          {recordSave.status === "saved" ? <>
            录像已保存：<code className="winner-record-path">{recordSave.filePath}</code>
          </> : recordSave.status === "failed" ? <>
            录像保存失败：{recordSave.error}
          </> : recordSave.status === "disabled" ? "本局未启用录像录制。" : "录像保存中…"}
        </div>
        <div className="winner-actions">
          <button className="hud-btn hud-btn-ghost" onClick={onClose} autoFocus>关闭</button>
        </div>
      </div>
    </div>
  );
}
