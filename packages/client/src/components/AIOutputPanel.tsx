import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AITerminalEvent,
  AITerminalToolCallEvent,
  PlayerId,
} from "@llmcraft/shared";

interface AIOutputPanelProps {
  aiOutputs: Record<string, string>;
  events: AITerminalEvent[];
  autoScroll: boolean;
  canLoadEarlier?: boolean;
  onLoadEarlier?: () => void;
}

interface VirtualEventLayout {
  event: AITerminalEvent;
  top: number;
  height: number;
}

const TERMINAL_ROW_GAP = 10;
const TERMINAL_OVERSCAN_PX = 240;
const TERMINAL_BOTTOM_THRESHOLD_PX = 48;

function formatJSON(value: unknown): string {
  if (value === undefined) {
    return "(none)";
  }
  return JSON.stringify(value, null, 2);
}

function estimateEventHeight(event: AITerminalEvent): number {
  if (event.kind === "request") return 26;
  if (event.kind === "tool_call") return 36;
  const estimatedLines = Math.max(1, Math.ceil(event.text.length / 52));
  return 12 + estimatedLines * 18;
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

const ToolCallEvent = memo(function ToolCallEvent({
  event,
  expanded,
  tone,
  onExpandedChange,
}: {
  event: AITerminalToolCallEvent;
  expanded: boolean;
  tone: "red" | "cyan";
  onExpandedChange: (eventId: string, expanded: boolean) => void;
}) {
  const argsText = useMemo(
    () => expanded ? formatJSON(event.toolCall.args) : "",
    [event.toolCall.args, expanded],
  );
  const resultText = useMemo(
    () => expanded ? formatJSON(event.toolCall.result) : "",
    [event.toolCall.result, expanded],
  );

  return (
    <details
      className="ai-terminal-tool"
      open={expanded}
      onToggle={(toggleEvent) => onExpandedChange(event.id, toggleEvent.currentTarget.open)}
    >
      <summary className="ai-terminal-tool-summary">
        <span className={`ai-terminal-tool-badge ${tone}`}>{event.toolCall.toolName}</span>
      </summary>
      {expanded ? (
        <div className="ai-terminal-tool-details">
          <div className="ai-terminal-detail-group">
            <div className="ai-terminal-detail-label">参数</div>
            <pre className="ai-terminal-detail-code">{argsText}</pre>
          </div>
          <div className="ai-terminal-detail-group">
            <div className="ai-terminal-detail-label">结果</div>
            <pre className="ai-terminal-detail-code">{resultText}</pre>
          </div>
        </div>
      ) : null}
    </details>
  );
});

const TerminalEventRow = memo(function TerminalEventRow({
  event,
  expanded,
  tone,
  top,
  onExpandedChange,
  onMeasure,
}: {
  event: AITerminalEvent;
  expanded: boolean;
  tone: "red" | "cyan";
  top: number;
  onExpandedChange: (eventId: string, expanded: boolean) => void;
  onMeasure: (eventId: string, height: number) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => onMeasure(event.id, row.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [event.id, onMeasure]);

  return (
    <div
      ref={rowRef}
      className="ai-terminal-virtual-row"
      style={{ transform: `translateY(${top}px)` }}
    >
      {event.kind === "request" ? (
        <div className="ai-terminal-divider">
          <span className="ai-terminal-divider-label">
            {`Request #${event.requestNumber} · tick ${event.requestTick}`}
          </span>
        </div>
      ) : event.kind === "assistant" ? (
        <div className="ai-terminal-entry ai-terminal-entry-assistant">
          <pre className="ai-terminal-entry-text">{event.text}</pre>
        </div>
      ) : (
        <ToolCallEvent
          event={event}
          expanded={expanded}
          tone={tone}
          onExpandedChange={onExpandedChange}
        />
      )}
    </div>
  );
});

function LiveEventStream({
  events,
  autoScroll,
  tone,
}: {
  events: AITerminalEvent[];
  autoScroll: boolean;
  tone: "red" | "cyan";
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const measuredHeightsRef = useRef(new Map<string, number>());
  const pinnedToBottomRef = useRef(true);
  const firstEventIdRef = useRef<string | undefined>(undefined);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(() => new Set());
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });

  const onExpandedChange = useCallback((eventId: string, expanded: boolean) => {
    setExpandedEventIds((current) => {
      const next = new Set(current);
      if (expanded) next.add(eventId);
      else next.delete(eventId);
      return next;
    });
  }, []);

  const onMeasure = useCallback((eventId: string, height: number) => {
    const previous = measuredHeightsRef.current.get(eventId);
    if (previous !== undefined && Math.abs(previous - height) < 0.5) return;
    measuredHeightsRef.current.set(eventId, height);
    setMeasurementRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    const liveIds = new Set(events.map((event) => event.id));
    for (const eventId of measuredHeightsRef.current.keys()) {
      if (!liveIds.has(eventId)) measuredHeightsRef.current.delete(eventId);
    }
    setExpandedEventIds((current) => {
      const next = new Set([...current].filter((eventId) => liveIds.has(eventId)));
      return next.size === current.size ? current : next;
    });
  }, [events]);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    const updateViewport = () => {
      setViewport({
        scrollTop: scrollElement.scrollTop,
        height: scrollElement.clientHeight,
      });
    };
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, []);

  const { layouts, totalHeight } = useMemo(() => {
    let top = 0;
    const nextLayouts: VirtualEventLayout[] = events.map((event) => {
      const height = measuredHeightsRef.current.get(event.id) ?? estimateEventHeight(event);
      const layout = { event, top, height };
      top += height + TERMINAL_ROW_GAP;
      return layout;
    });
    return {
      layouts: nextLayouts,
      totalHeight: Math.max(0, top - TERMINAL_ROW_GAP),
    };
  }, [events, measurementRevision]);

  const visibleLayouts = useMemo(() => {
    const visibleTop = Math.max(0, viewport.scrollTop - TERMINAL_OVERSCAN_PX);
    const visibleBottom = viewport.scrollTop + viewport.height + TERMINAL_OVERSCAN_PX;
    return layouts.filter((layout) => (
      layout.top + layout.height >= visibleTop && layout.top <= visibleBottom
    ));
  }, [layouts, viewport]);

  const firstEventId = events[0]?.id;
  const latestEventId = events.at(-1)?.id;
  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const previousFirstEventId = firstEventIdRef.current;
    firstEventIdRef.current = firstEventId;
    if (!scrollElement || !previousFirstEventId || previousFirstEventId === firstEventId) return;
    const previousFirstLayout = layouts.find((layout) => layout.event.id === previousFirstEventId);
    if (!previousFirstLayout || previousFirstLayout.top <= 0) return;
    scrollElement.scrollTop += previousFirstLayout.top;
    setViewport({
      scrollTop: scrollElement.scrollTop,
      height: scrollElement.clientHeight,
    });
  }, [firstEventId, layouts]);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (!autoScroll || !scrollElement || !pinnedToBottomRef.current) return;
    const animationFrame = requestAnimationFrame(() => {
      scrollElement.scrollTop = scrollElement.scrollHeight;
      setViewport({
        scrollTop: scrollElement.scrollTop,
        height: scrollElement.clientHeight,
      });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [autoScroll, latestEventId, totalHeight]);

  const onScroll = useCallback(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    const distanceFromBottom = scrollElement.scrollHeight
      - scrollElement.scrollTop
      - scrollElement.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom <= TERMINAL_BOTTOM_THRESHOLD_PX;
    setViewport({
      scrollTop: scrollElement.scrollTop,
      height: scrollElement.clientHeight,
    });
  }, []);

  return (
    <div ref={scrollRef} className="ai-terminal-stream" onScroll={onScroll}>
      {events.length === 0 ? (
        <div className="empty-state">等待 AI 事件...</div>
      ) : (
        <div className="ai-terminal-virtual-spacer" style={{ height: totalHeight }}>
          {visibleLayouts.map((layout) => (
            <TerminalEventRow
              key={layout.event.id}
              event={layout.event}
              expanded={expandedEventIds.has(layout.event.id)}
              tone={tone}
              top={layout.top}
              onExpandedChange={onExpandedChange}
              onMeasure={onMeasure}
            />
          ))}
        </div>
      )}
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

export function AIOutputPanel({
  aiOutputs,
  events,
  autoScroll,
  canLoadEarlier = false,
  onLoadEarlier,
}: AIOutputPanelProps) {
  const eventsByPlayer = useMemo(() => {
    const grouped: Record<PlayerId, AITerminalEvent[]> = {
      player_1: [],
      player_2: [],
    };
    for (const event of events) grouped[event.playerId].push(event);
    return grouped;
  }, [events]);

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
        events={eventsByPlayer.player_1}
        autoScroll={autoScroll}
      />

      <PlayerTerminal
        headerClassName="cyan"
        title="AI 2 — 蓝方指挥核心"
        replayOutput={aiOutputs.player_2}
        events={eventsByPlayer.player_2}
        autoScroll={autoScroll}
      />
    </div>
  );
}
