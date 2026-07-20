import type { MatchRegistrySummary } from "@llmcraft/shared";

interface MatchPanelProps {
  matches: MatchRegistrySummary[];
  observedMatchId: string | null;
  loading: boolean;
  error: string | null;
  switchingMatchId: string | null;
  onRefresh: () => void;
  onObserve: (match: MatchRegistrySummary) => void;
}

const KIND_LABELS: Record<MatchRegistrySummary["kind"], string> = {
  live: "LLM LIVE",
  control: "CONTROL",
  benchmark: "BENCHMARK",
};

const STATUS_LABELS: Record<MatchRegistrySummary["status"], string> = {
  warming_up: "模型预热",
  waiting_for_players: "等待玩家",
  running: "运行中",
  stopped: "已停止",
  finished: "已结束",
  failed: "失败",
};

export function MatchPanel({
  matches,
  observedMatchId,
  loading,
  error,
  switchingMatchId,
  onRefresh,
  onObserve,
}: MatchPanelProps) {
  return (
    <div className="match-browser">
      <div className="match-browser-toolbar">
        <div>
          <div className="match-browser-kicker">MatchRegistry</div>
          <p>选择主战场正在观察的对局。切换只改变 WebSocket 投影，不会暂停或重定向其他对局。</p>
        </div>
        <button className="hud-btn hud-btn-ghost" type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "刷新中" : "刷新"}
        </button>
      </div>

      {error && <div className="match-browser-error">{error}</div>}
      {!loading && matches.length === 0 && (
        <div className="match-browser-empty">当前没有已注册对局。</div>
      )}
      <div className="match-browser-list">
        {matches.map((match) => {
          const observed = match.matchId === observedMatchId || match.observed;
          const switching = switchingMatchId === match.matchId;
          return (
            <article className={`match-browser-row ${observed ? "observed" : ""}`} key={match.matchId}>
              <div className="match-browser-row-main">
                <div className="match-browser-title-line">
                  <span className={`match-kind kind-${match.kind}`}>{KIND_LABELS[match.kind]}</span>
                  <strong>{match.label ?? compactMatchId(match.matchId)}</strong>
                  {observed && <span className="match-observed-badge">正在观察</span>}
                </div>
                <code title={match.matchId}>{match.matchId}</code>
                <div className="match-browser-meta">
                  <span className={`match-status status-${match.status}`}>{STATUS_LABELS[match.status]}</span>
                  <span>Tick {match.tick}</span>
                  <span>{match.winner ? `胜者 ${match.winner}` : "尚无胜者"}</span>
                  {match.parentId && <span>实验 {compactMatchId(match.parentId)}</span>}
                </div>
              </div>
              <button
                className={`hud-btn ${observed ? "hud-btn-ghost" : ""}`}
                type="button"
                onClick={() => onObserve(match)}
                disabled={observed || switchingMatchId !== null}
              >
                {observed ? "当前画面" : switching ? "切换中" : "观察"}
              </button>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function compactMatchId(matchId: string): string {
  if (matchId.length <= 24) return matchId;
  return `${matchId.slice(0, 12)}…${matchId.slice(-8)}`;
}
