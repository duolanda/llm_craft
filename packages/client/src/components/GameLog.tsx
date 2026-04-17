import { GameState, PLAYER_COLORS, LOG_LEVEL_COLORS, LOG_LEVEL_ICONS, ActorId } from "@llmcraft/shared";
import type { GameLog, LogLevel } from "@llmcraft/shared";

interface GameLogProps {
  state: GameState | null;
}

function getPlayerId(log: GameLog): ActorId {
  return log.meta.owner;
}

function getPlayerColor(playerId: ActorId): string {
  return PLAYER_COLORS[playerId];
}

function getLogLevelColor(level: LogLevel): string {
  return LOG_LEVEL_COLORS[level];
}

function getLogLevelIcon(level: LogLevel): string {
  return LOG_LEVEL_ICONS[level];
}

export function GameLog({ state }: GameLogProps) {
  return (
    <div className="log-terminal">
      {state?.logs.slice(-20).map((log, i) => {
        const playerId = getPlayerId(log);
        const playerColor = getPlayerColor(playerId);
        const level = log.meta.level;
        const levelColor = getLogLevelColor(level);
        const levelIcon = getLogLevelIcon(level);

        return (
          <div key={i} className="log-entry">
            <span className="log-tick">[{log.tick}]</span>
            <span className="log-level" style={{ color: levelColor }} title={level}>
              {levelIcon}
            </span>
            <span className="log-player" style={{ color: playerColor }}>({playerId})</span>
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
