import { GameState, PLAYER_COLORS } from "@llmcraft/shared";

interface GameLogProps {
  state: GameState | null;
}

function getPlayerId(log: { data?: { playerId?: string } | null }): string {
  return log.data?.playerId ?? "system_0";
}

function getPlayerColor(playerId: string): string {
  return PLAYER_COLORS[playerId] ?? PLAYER_COLORS.system_0;
}

export function GameLog({ state }: GameLogProps) {
  return (
    <div className="log-terminal">
      {state?.logs.slice(-20).map((log, i) => {
        const playerId = getPlayerId(log);
        const color = getPlayerColor(playerId);
        return (
          <div key={i} className="log-entry">
            <span className="log-tick">[{log.tick}]</span>
            <span className="log-player" style={{ color }}>({playerId})</span>
            <span className="log-msg">{log.message}</span>
          </div>
        );
      })}
      {!state?.logs.length && (
        <div className="empty-state">暂无日志数据</div>
      )}
    </div>
  );
}
