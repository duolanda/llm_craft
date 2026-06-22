import { useEffect, useRef } from "react";
import { AITerminalEvent, PlayerId } from "@llmcraft/shared";

interface AIOutputPanelProps {
  aiOutputs: Record<string, string>;
  events: AITerminalEvent[];
  autoScroll: boolean;
  canLoadEarlier?: boolean;
  onLoadEarlier?: () => void;
}

function formatJSON(value: unknown): string {
  if (value === undefined) {
    return "(none)";
  }
  return JSON.stringify(value, null, 2);
}

function ReplayOutput({ output }: { output: string | undefined }) {
  return (
    <pre className="ai-terminal-body">
      {output || (
        <span className="empty-state">等待 AI 接入...</span>
      )}
    </pre>
  );
}

function LiveEventStream({
  events,
  autoScroll,
  tone,
}: {
  events: AITerminalEvent[];
  autoScroll: boolean;
  tone: "red" | "cyan";
}) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoScroll) {
      return;
    }
    endRef.current?.scrollIntoView({ block: "end" });
  }, [autoScroll, events]);

  return (
    <div className="ai-terminal-stream">
      {events.length === 0 && (
        <div className="empty-state">等待 AI 事件...</div>
      )}

      {events.map((event) => {
        if (event.kind === "request") {
          return (
            <div key={event.id} className="ai-terminal-divider">
              <span className="ai-terminal-divider-label">
                {`Request #${event.requestNumber} · tick ${event.requestTick}`}
              </span>
            </div>
          );
        }

        if (event.kind === "assistant") {
          return (
            <div key={event.id} className="ai-terminal-entry ai-terminal-entry-assistant">
              <pre className="ai-terminal-entry-text">{event.text}</pre>
            </div>
          );
        }

        return (
          <details key={event.id} className="ai-terminal-tool">
            <summary className="ai-terminal-tool-summary">
              <span className={`ai-terminal-tool-badge ${tone}`}>{event.toolCall.toolName}</span>
            </summary>
            <div className="ai-terminal-tool-details">
              <div className="ai-terminal-detail-group">
                <div className="ai-terminal-detail-label">参数</div>
                <pre className="ai-terminal-detail-code">{formatJSON(event.toolCall.args)}</pre>
              </div>
              <div className="ai-terminal-detail-group">
                <div className="ai-terminal-detail-label">结果</div>
                <pre className="ai-terminal-detail-code">{formatJSON(event.toolCall.result)}</pre>
              </div>
            </div>
          </details>
        );
      })}

      <div ref={endRef} />
    </div>
  );
}

function PlayerTerminal({
  headerClassName,
  title,
  replayOutput,
  events,
  autoScroll,
}: {
  headerClassName: string;
  title: string;
  replayOutput: string | undefined;
  events: AITerminalEvent[];
  autoScroll: boolean;
}) {
  const hasEventStream = events.length > 0;
  const tone = headerClassName === "red" ? "red" : "cyan";

  return (
    <div className="ai-terminal-block">
      <div className={`ai-terminal-header ${headerClassName}`}>
        <span>●</span>
        <span>{title}</span>
      </div>
      {hasEventStream ? <LiveEventStream events={events} autoScroll={autoScroll} tone={tone} /> : <ReplayOutput output={replayOutput} />}
    </div>
  );
}

function getPlayerEvents(events: AITerminalEvent[], playerId: PlayerId) {
  return events.filter((event) => event.playerId === playerId);
}

export function AIOutputPanel({
  aiOutputs,
  events,
  autoScroll,
  canLoadEarlier = false,
  onLoadEarlier,
}: AIOutputPanelProps) {
  return (
    <div className="ai-terminal">
      {canLoadEarlier && onLoadEarlier ? (
        <button type="button" className="ai-terminal-load-earlier" onClick={onLoadEarlier}>
          加载更早记录
        </button>
      ) : null}
      <PlayerTerminal
        headerClassName="red"
        title="AI 1 — 红方指挥核心"
        replayOutput={aiOutputs.player_1}
        events={getPlayerEvents(events, "player_1")}
        autoScroll={autoScroll}
      />

      <PlayerTerminal
        headerClassName="cyan"
        title="AI 2 — 蓝方指挥核心"
        replayOutput={aiOutputs.player_2}
        events={getPlayerEvents(events, "player_2")}
        autoScroll={autoScroll}
      />
    </div>
  );
}
