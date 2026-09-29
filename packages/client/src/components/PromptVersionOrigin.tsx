import type { StrategyPromptVersion, StrategyPromptVersionProvenance } from "@llmcraft/shared";

export function PromptVersionOrigin({ version, provenance, loading, unavailable = false }: {
  version: StrategyPromptVersion;
  provenance?: StrategyPromptVersionProvenance;
  loading: boolean;
  unavailable?: boolean;
}) {
  const inherited = provenance && provenance.sourceVersionId !== version.id;
  const model = provenance?.model ?? version.model;
  const matchId = provenance?.matchId ?? version.matchId;
  const playerId = provenance?.playerId ?? version.playerId;
  return (
    <div className="prompt-version-origin">
      {inherited && <span>基于 v{provenance.sourceVersion} 编辑 · </span>}
      <span>{inherited ? "原复盘模型" : "生成模型"}：{model ?? (loading ? "加载中…" : unavailable ? "暂时无法加载" : version.source === "user" && !matchId ? "无（编辑保存）" : "未记录")}</span>
      {playerId && <span> · {playerId === "player_1" ? "红方" : "蓝方"}</span>}
      {provenance?.recordFileName ? (
        <div>
          <a className="prompt-record-link" href={`/?replay=${encodeURIComponent(provenance.recordFileName)}`} target="_blank" rel="noopener noreferrer">
            查看来源录像 ↗
          </a>
          <span className="prompt-record-name">{provenance.recordFileName}</span>
        </div>
      ) : matchId && !loading && !unavailable ? <div>来源对局：{matchId} · 未找到录像（未录制或已移除）</div> : null}
    </div>
  );
}
