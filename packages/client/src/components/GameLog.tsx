import { GameState } from "@llmcraft/shared";

interface GameLogProps {
  state: GameState | null;
}

export function GameLog({ state }: GameLogProps) {
  return (
    <div className="log-terminal">
      {state?.logs.slice(-20).map((log, i) => (
        <div key={i} className="log-entry">
          <span className="log-tick">[{log.tick}]</span>
          <span className="log-msg">{log.message}</span>
        </div>
      ))}
      {!state?.logs.length && (
        <div className="empty-state">暂无日志数据</div>
      )}
    </div>
  );
}
