import { GameState } from "@llmcraft/shared";

interface GameLogProps {
  state: GameState | null;
}

export function GameLog({ state }: GameLogProps) {
  return (
    <div
      style={{
        background: "#1a1a2e",
        padding: "8px",
        borderRadius: "4px",
        height: "100px",
        overflow: "auto",
        fontSize: "12px",
        fontFamily: "monospace",
      }}
    >
      {state?.logs.slice(-20).map((log, i) => (
        <div key={i} style={{ color: "#aaa", lineHeight: "1.5" }}>
          [{log.tick}] {log.message}
        </div>
      ))}
    </div>
  );
}
