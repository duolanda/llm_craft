import React, { ChangeEvent, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import type { AgentModelRequestRecord, DomainEvent, GameRecord, MatchTraceRecordV3, SavedAITurnRecord } from "@llmcraft/shared";
import { detectRecordFormat, projectRecordToGameRecord, validateMatchTraceRecordV3 } from "@llmcraft/trace";
import { readLocalRecordText } from "./lib/readRecordFile";
import { buildMatchDiagnosticReport, type MatchDiagnosticReport } from "./diagnostics";
import "./transcriptViewer.css";

const SERVER_HOST = window.location.hostname || "localhost";
const API_BASE_URL = `http://${SERVER_HOST}:3101`;

type ChatRole = "system" | "user" | "assistant";

type ParsedPayload = {
  mode?: "full" | "delta";
  tick?: number;
  summary?: string;
  raw: string;
};

type TranscriptMessage = {
  role: ChatRole;
  content: string;
  payload: ParsedPayload | null;
};

type TranscriptEntry = {
  id: string;
  playerId: string;
  mode: "full" | "delta" | "trace";
  requestTick: number;
  executeTick: number | null;
  model: string;
  requestMessages: TranscriptMessage[];
  response: string;
  parsedCode: string;
  providerError: string;
  commands: string;
  sandbox: string;
  source: "trace-v3" | "compact-v2" | "legacy-log";
  modelRequests: AgentModelRequestRecord[];
};

type RecordListEntry = {
  fileName: string;
  size: number;
  modifiedAt: string;
  encoding?: "identity" | "gzip";
};

type ContextTurn = {
  user: TranscriptMessage;
  assistant: TranscriptMessage | null;
  mode: "full" | "delta" | "unknown";
  tick: number | null;
};

function parsePayload(raw: string): ParsedPayload | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as { mode?: "full" | "delta"; tick?: number; summary?: string };
    return {
      mode: parsed.mode,
      tick: parsed.tick,
      summary: parsed.summary,
      raw: trimmed,
    };
  } catch {
    return {
      raw: trimmed,
    };
  }
}

function parseRequestMessages(raw: string): TranscriptMessage[] {
  const matches = Array.from(raw.matchAll(/\((system|user|assistant)\)\n([\s\S]*?)(?=\n\n\((?:system|user|assistant)\)\n|$)/g));
  return matches.map((match, index) => {
    const role = match[1] as ChatRole;
    const content = match[2].trim();
    return {
      role,
      content,
      payload: role === "user" ? parsePayload(content) : null,
      key: `${role}-${index}`,
    } as TranscriptMessage & { key: string };
  });
}

function parseStreamedEntry(chunk: string, index: number): TranscriptEntry | null {
  const header = chunk.match(
    /^\[(?<timestamp>[^\]]+)\] transcript=(?<transcriptId>\S+) player=(?<playerId>\S+) requestTick=(?<requestTick>\d+) model=(?<model>.+)$/m,
  );
  if (!header?.groups) return null;
  const request = chunk.match(/--- request ---\n(?<value>[\s\S]*?)\n--- summary ---/)?.groups?.value ?? "";
  const assistantMessages = Array.from(chunk.matchAll(
    /\[assistant transcript=[^\]]+\]\n([\s\S]*?)(?=\n\[(?:assistant|tool_call|result) transcript=|$)/g,
  )).map((match) => match[1]!.trim()).filter(Boolean);
  const toolCalls = Array.from(chunk.matchAll(
    /\[tool_call transcript=[^\]]+\]\n([\s\S]*?)(?=\n\[(?:assistant|tool_call|result) transcript=|$)/g,
  )).map((match) => match[1]!.trim()).filter(Boolean);
  const result = chunk.match(
    /--- result ---\nexecuteTick=(?<executeTick>\d+)\nstopReason=(?<stopReason>[^\n]+)\n--- commands ---\n(?<commands>[\s\S]*?)\n--- plans ---\n(?<plans>[\s\S]*?)\n--- metrics ---\n(?<metrics>[\s\S]*)$/,
  );
  return {
    id: `${header.groups.transcriptId}-${index}`,
    playerId: header.groups.playerId,
    mode: "trace",
    requestTick: Number(header.groups.requestTick),
    executeTick: result?.groups ? Number(result.groups.executeTick) : null,
    model: header.groups.model.trim(),
    requestMessages: parseRequestMessages(request.trim()),
    response: assistantMessages.join("\n\n"),
    parsedCode: stringify(assistantMessages),
    providerError: result?.groups?.stopReason ? `stopReason=${result.groups.stopReason}` : "",
    commands: result?.groups?.commands.trim() ?? "(none)",
    sandbox: stringify({
      toolCalls: toolCalls.map((raw) => {
        try { return JSON.parse(raw) as unknown; } catch { return raw; }
      }),
      plans: result?.groups?.plans.trim() ?? "(none)",
      metrics: result?.groups?.metrics.trim() ?? "(none)",
    }),
    source: "legacy-log",
    modelRequests: [],
  };
}

function parseEntry(chunk: string, index: number): TranscriptEntry | null {
  const trimmed = chunk.trim();
  if (!trimmed) {
    return null;
  }

  const streamed = parseStreamedEntry(trimmed, index);
  if (streamed) return streamed;

  const headerMatch = trimmed.match(
    /^\[(?<timestamp>[^\]]+)\] player=(?<playerId>\S+) mode=(?<mode>full|delta) requestTick=(?<requestTick>\d+) executeTick=(?<executeTick>\d+|n\/a) model=(?<model>.+)$/m
  );
  if (!headerMatch?.groups) {
    return null;
  }

  const sectionPattern =
    /--- request ---\n(?<request>[\s\S]*?)\n--- response ---\n(?<response>[\s\S]*?)\n--- parsed_code ---\n(?<parsed>[\s\S]*?)\n--- provider_error ---\n(?<provider>[\s\S]*?)\n--- commands ---\n(?<commands>[\s\S]*?)\n--- sandbox ---\n(?<sandbox>[\s\S]*)$/;
  const sectionMatch = trimmed.match(sectionPattern);
  if (!sectionMatch?.groups) {
    return null;
  }

  return {
    id: `${headerMatch.groups.playerId}-${headerMatch.groups.requestTick}-${index}`,
    playerId: headerMatch.groups.playerId,
    mode: headerMatch.groups.mode as "full" | "delta",
    requestTick: Number(headerMatch.groups.requestTick),
    executeTick: headerMatch.groups.executeTick === "n/a" ? null : Number(headerMatch.groups.executeTick),
    model: headerMatch.groups.model.trim(),
    requestMessages: parseRequestMessages(sectionMatch.groups.request.trim()),
    response: sectionMatch.groups.response.trim(),
    parsedCode: sectionMatch.groups.parsed.trim(),
    providerError: sectionMatch.groups.provider.trim(),
    commands: sectionMatch.groups.commands.trim(),
    sandbox: sectionMatch.groups.sandbox.trim(),
    source: "legacy-log",
    modelRequests: [],
  };
}

function parseTranscript(text: string): TranscriptEntry[] {
  return text
    .split("==========")
    .map((chunk, index) => parseEntry(chunk, index))
    .filter((entry): entry is TranscriptEntry => entry !== null);
}

function stringify(value: unknown, empty = "(none)"): string {
  if (value === undefined || value === null) return empty;
  if (Array.isArray(value) && value.length === 0) return empty;
  return JSON.stringify(value, null, 2);
}

function mapTraceTurns(trace: MatchTraceRecordV3): TranscriptEntry[] {
  const systemPrompt = trace.replayProjection?.metadata.systemPrompt?.trim() ?? "";
  return trace.aiTurns.map((turn, index) => mapTraceTurn(
    turn,
    index,
    systemPrompt,
    trace.domainEvents,
    trace.manifest.capabilities.modelRequestSpans,
    trace.manifest.capabilities.toolCallSpans,
    "trace-v3",
  ));
}

function mapCompactRecordTurns(record: GameRecord): TranscriptEntry[] {
  const systemPrompt = record.metadata.systemPrompt?.trim() ?? "";
  const hasModelRequestSpans = record.aiTurns.some((turn) => (turn.metrics.modelRequestRecords?.length ?? 0) > 0);
  const hasToolCalls = record.aiTurns.some((turn) => turn.toolCalls.length > 0);
  return record.aiTurns.map((turn, index) => mapTraceTurn(
    turn,
    index,
    systemPrompt,
    [],
    hasModelRequestSpans ? "partial" : "absent",
    hasToolCalls ? "partial" : "absent",
    "compact-v2",
  ));
}

function mapTraceTurn(
  turn: SavedAITurnRecord,
  index: number,
  systemPrompt: string,
  domainEvents: readonly DomainEvent[],
  modelRequestCapability: string,
  toolCallCapability: string,
  source: "trace-v3" | "compact-v2",
): TranscriptEntry {
  const commandIds = new Set(turn.commands.map((command) => command.id));
  const relatedEvents = domainEvents.filter((event) => (
    (event.commandId && commandIds.has(event.commandId))
    || (
      event.actorId === turn.playerId
      && event.tick >= turn.requestTick
      && event.tick <= Math.max(turn.executeTick, turn.requestTick + 1)
      && event.type.startsWith("command_envelope_")
    )
  ));
  const runInput = turn.runInput ?? {
    playerId: turn.playerId,
    tick: turn.requestTick,
    summary: "Trace did not persist this run input.",
  };
  const modelRequests = turn.metrics.modelRequestRecords ?? [];
  const exactMessages = modelRequests.at(-1)?.messages;
  const requestMessages: TranscriptMessage[] = exactMessages
    ? exactMessages.flatMap((message) => {
        if (!message || typeof message !== "object") return [];
        const record = message as { role?: unknown; content?: unknown };
        if (record.role !== "system" && record.role !== "user" && record.role !== "assistant") return [];
        const content = typeof record.content === "string" ? record.content : stringify(record.content);
        return [{ role: record.role, content, payload: record.role === "user" ? parsePayload(content) : null }];
      })
    : [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt, payload: null }] : []),
    {
      role: "user" as const,
      content: stringify(runInput),
      payload: parsePayload(stringify(runInput)),
    },
    ];
  return {
    id: `trace-${turn.playerId}-${turn.requestTick}-${index}`,
    playerId: turn.playerId,
    mode: "trace",
    requestTick: turn.requestTick,
    executeTick: turn.executeTick,
    model: turn.model,
    requestMessages,
    response: turn.assistantMessages.join("\n\n"),
    parsedCode: stringify(turn.assistantMessages),
    providerError: [
      `stopReason=${turn.stopReason}`,
      `modelRequestSpans=${modelRequestCapability}`,
      `toolCallSpans=${toolCallCapability}`,
      `modelRequests=${modelRequests.length}`,
      ...modelRequests.map((request) => `#${request.requestIndex} ${request.status ?? "success"} ${request.latencyMs ?? "?"}ms finish=${request.finishReason} tokens=${request.inputTokens ?? "?"}/${request.outputTokens ?? "?"} retryOf=${request.retryOfRequestIndex ?? "-"}`),
    ].join("\n"),
    commands: stringify({ commands: turn.commands, relatedDomainEvents: relatedEvents }),
    sandbox: stringify({
      toolCalls: turn.toolCalls,
      plans: turn.plans,
      metrics: turn.metrics,
      createdAt: turn.createdAt,
    }),
    source,
    modelRequests,
  };
}

function parseTranscriptSource(text: string): TranscriptEntry[] {
  try {
    const value: unknown = JSON.parse(text);
    if (detectRecordFormat(value) === "trace-v3") {
      validateMatchTraceRecordV3(value);
      return mapTraceTurns(value);
    }
    if (detectRecordFormat(value) === "compact-v2") {
      return mapCompactRecordTurns(projectRecordToGameRecord(value));
    }
  } catch (error) {
    if (text.trimStart().startsWith("{")) throw error;
  }
  return parseTranscript(text);
}

function buildContextTurns(messages: TranscriptMessage[]): ContextTurn[] {
  const history = messages.filter((message) => message.role !== "system");
  const turns: ContextTurn[] = [];

  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message.role !== "user") {
      continue;
    }

    const next = history[i + 1];
    const assistant = next?.role === "assistant" ? next : null;
    turns.push({
      user: message,
      assistant,
      mode: message.payload?.mode ?? "unknown",
      tick: message.payload?.tick ?? null,
    });

    if (assistant) {
      i += 1;
    }
  }

  return turns;
}

function summarizeContext(entry: TranscriptEntry) {
  const contextTurns = buildContextTurns(entry.requestMessages);
  const currentTurn = contextTurns.at(-1) ?? null;
  const historyTurns = contextTurns.slice(0, -1);
  const earliestFull = historyTurns.find((turn) => turn.mode === "full") ?? currentTurn;
  const latestFull = [...contextTurns].reverse().find((turn) => turn.mode === "full") ?? null;
  const refreshBaseline = entry.mode === "full" && entry.requestTick > 0;

  return {
    contextTurns,
    currentTurn,
    historyTurns,
    earliestFull,
    latestFull,
    refreshBaseline,
    systemCount: entry.requestMessages.filter((message) => message.role === "system").length,
    historyMessageCount: entry.requestMessages.filter((message) => message.role !== "system").length - 1,
  };
}

function shortLabel(turn: ContextTurn, fallback: string) {
  const mode = turn.mode === "unknown" ? "?" : turn.mode;
  const tick = turn.tick === null ? fallback : `${turn.tick}`;
  return `${mode}@${tick}`;
}

function App() {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playerFilter, setPlayerFilter] = useState<"all" | "player_1" | "player_2">("all");
  const [records, setRecords] = useState<RecordListEntry[]>([]);
  const [selectedRecordFile, setSelectedRecordFile] = useState("");
  const [loading, setLoading] = useState(false);
  const [diagnostic, setDiagnostic] = useState<MatchDiagnosticReport | null>(null);
  const [sourceName, setSourceName] = useState("");

  const filteredEntries = useMemo(() => {
    if (playerFilter === "all") {
      return entries;
    }
    return entries.filter((entry) => entry.playerId === playerFilter);
  }, [entries, playerFilter]);

  const selectedEntry =
    filteredEntries.find((entry) => entry.id === selectedId) ?? filteredEntries[0] ?? null;

  const selectedSummary = selectedEntry ? summarizeContext(selectedEntry) : null;

  function commitSource(text: string, sourceName: string) {
    let parsed: TranscriptEntry[];
    try {
      const value: unknown = JSON.parse(text);
      if (detectRecordFormat(value) === "trace-v3") {
        validateMatchTraceRecordV3(value);
        parsed = mapTraceTurns(value);
        setDiagnostic(buildMatchDiagnosticReport(projectRecordToGameRecord(value), sourceName));
      } else if (detectRecordFormat(value) === "compact-v2") {
        const record = projectRecordToGameRecord(value);
        parsed = mapCompactRecordTurns(record);
        setDiagnostic(buildMatchDiagnosticReport(record, sourceName));
      } else {
        parsed = parseTranscriptSource(text);
        setDiagnostic(null);
      }
    } catch (parseError) {
      if (text.trimStart().startsWith("{")) throw parseError;
      parsed = parseTranscriptSource(text);
      setDiagnostic(null);
    }
    if (parsed.length === 0) {
      throw new Error(`${sourceName} 没有可展示的 AI turn；Trace 可能在首轮模型调用前结束，或 agentTurns capability 不完整。`);
    }
    setEntries(parsed);
    setSelectedId(parsed[0]!.id);
    setError(null);
    setSourceName(sourceName);
  }

  async function fetchRecords() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/replay/records`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { records: RecordListEntry[] };
      setRecords(payload.records);
      setSelectedRecordFile((current) => current || payload.records[0]?.fileName || "");
    } catch (fetchError) {
      setError(`获取 Trace 列表失败：${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
    }
  }

  async function loadSelectedRecord() {
    if (!selectedRecordFile) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/replay/records/${encodeURIComponent(selectedRecordFile)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      commitSource(await response.text(), selectedRecordFile);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setEntries([]);
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchRecords();
  }, []);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      commitSource(await readLocalRecordText(file), file.name);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : String(readError));
      setEntries([]);
      setSelectedId(null);
    } finally {
      event.target.value = "";
    }
  }

  return (
    <div className="tv-shell">
      <header className="tv-header">
        <div>
          <p className="tv-eyebrow">LLMCraft Debug Tool</p>
          <h1>Match Explorer</h1>
          <p className="tv-subtitle">
            用同一 Trace 对齐战场 tick、Agent request waterfall、工具调用、命令和 DomainEvent。
          </p>
        </div>
        <div className="tv-toolbar">
          <select
            value={selectedRecordFile}
            onChange={(event) => setSelectedRecordFile(event.target.value)}
            aria-label="选择服务端 Trace"
          >
            {records.length === 0 ? <option value="">没有可用 Trace</option> : null}
            {records.map((record) => (
              <option value={record.fileName} key={record.fileName}>
                {record.fileName} · {(record.size / 1024).toFixed(1)} KiB
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void loadSelectedRecord()} disabled={!selectedRecordFile || loading}>
            {loading ? "读取中" : "打开 Trace"}
          </button>
          <label className="tv-upload">
            <input type="file" accept=".json,.gz,.log,.txt,application/json,application/gzip" onChange={handleFileChange} />
            导入本地文件
          </label>
          <div className="tv-filter">
            <button
              className={playerFilter === "all" ? "active" : ""}
              onClick={() => setPlayerFilter("all")}
              type="button"
            >
              全部
            </button>
            <button
              className={playerFilter === "player_1" ? "active" : ""}
              onClick={() => setPlayerFilter("player_1")}
              type="button"
            >
              player_1
            </button>
            <button
              className={playerFilter === "player_2" ? "active" : ""}
              onClick={() => setPlayerFilter("player_2")}
              type="button"
            >
              player_2
            </button>
          </div>
        </div>
      </header>

      {error ? <div className="tv-error">{error}</div> : null}

      <main className="tv-grid">
        <aside className="tv-panel tv-list-panel">
          <div className="tv-panel-header">
            <strong>Turns</strong>
            <span>{filteredEntries.length}</span>
          </div>
          {filteredEntries.length === 0 ? (
            <div className="tv-empty">
              <p>先打开一份 Trace，或导入旧 transcript 日志。</p>
              <p>这个面板会列出每次 AI turn 的 `player / source / requestTick`。</p>
            </div>
          ) : (
            <div className="tv-turn-list">
              {filteredEntries.map((entry) => (
                <button
                  key={entry.id}
                  className={`tv-turn-item ${selectedEntry?.id === entry.id ? "selected" : ""}`}
                  onClick={() => setSelectedId(entry.id)}
                  type="button"
                >
                  <div className="tv-turn-top">
                    <span className={`tv-badge ${entry.mode}`}>{entry.mode}</span>
                    <span className="tv-player">{entry.playerId}</span>
                  </div>
                  <div className="tv-turn-main">requestTick {entry.requestTick}</div>
                  <div className="tv-turn-meta">
                    executeTick {entry.executeTick ?? "n/a"} · {entry.model} · {entry.source}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="tv-panel">
          <div className="tv-panel-header">
            <strong>Request Breakdown</strong>
            <span>
              {selectedEntry ? `${selectedEntry.playerId} @ ${selectedEntry.requestTick}` : "未选择"}
              {selectedEntry && sourceName ? (
                <> · <a href={`/?replay=${encodeURIComponent(sourceName)}&tick=${selectedEntry.requestTick}`}>battlefield tick</a></>
              ) : null}
            </span>
          </div>
          {!selectedEntry || !selectedSummary ? (
            <div className="tv-empty">
              <p>选中一条 turn 后，这里会把请求拆成三块：</p>
              <p>`system`、历史窗口、当前这一轮 user payload。</p>
            </div>
          ) : (
            <div className="tv-main">
              <section className="tv-card">
                <div className="tv-card-header">
                  <h2>LLM 看到的上下文窗口</h2>
                </div>
                <div className="tv-timeline">
                  {selectedSummary.contextTurns.map((turn, index) => {
                    const isCurrent = index === selectedSummary.contextTurns.length - 1;
                    return (
                      <div
                        key={`${turn.mode}-${turn.tick ?? index}`}
                        className={`tv-tile ${turn.mode} ${isCurrent ? "current" : ""}`}
                        title={`${turn.mode} @ tick ${turn.tick ?? "unknown"}`}
                      >
                        <span>{turn.mode}</span>
                        <strong>{turn.tick ?? "?"}</strong>
                      </div>
                    );
                  })}
                </div>
                <div className="tv-note-grid">
                  <div className="tv-note">
                    <span>最早保留的 full</span>
                    <strong>
                      {selectedSummary.earliestFull
                        ? shortLabel(selectedSummary.earliestFull, "?")
                        : "无"}
                    </strong>
                  </div>
                  <div className="tv-note">
                    <span>离当前最近的 full</span>
                    <strong>
                      {selectedSummary.latestFull ? shortLabel(selectedSummary.latestFull, "?") : "无"}
                    </strong>
                  </div>
                  <div className="tv-note">
                    <span>当前轮</span>
                    <strong>
                      {selectedSummary.currentTurn
                        ? shortLabel(selectedSummary.currentTurn, `${selectedEntry.requestTick}`)
                        : "无"}
                    </strong>
                  </div>
                </div>
              </section>

              {diagnostic ? (
                <section className="tv-card">
                  <div className="tv-card-header"><h2>Diagnostics</h2><span>{diagnostic.durationSeconds.toFixed(1)}s</span></div>
                  <div className="tv-note-grid">
                    {diagnostic.players.map((player) => (
                      <div className="tv-note" key={player.playerId}>
                        <span>{player.playerId}</span>
                        <strong>{player.tags.length > 0 ? player.tags.join(", ") : "no detector findings"}</strong>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="tv-card">
                <div className="tv-card-header">
                  <h2>Internal Request Waterfall</h2>
                  <span>{selectedEntry.modelRequests.length} requests</span>
                </div>
                <div className="tv-waterfall">
                  {selectedEntry.modelRequests.length === 0 ? <p>(span unavailable)</p> : selectedEntry.modelRequests.map((request) => (
                    <div className={`tv-waterfall-row ${request.status ?? "success"}`} key={request.requestIndex}>
                      <strong>#{request.requestIndex}</strong>
                      <span>{request.phase}</span>
                      <span>{request.latencyMs ?? "?"} ms</span>
                      <span>{request.finishReason}</span>
                      <span>in {request.inputTokens ?? "?"} / out {request.outputTokens ?? "?"}</span>
                      <span>{request.retryOfRequestIndex ? `retry of #${request.retryOfRequestIndex}` : ""}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="tv-card">
                <div className="tv-card-header">
                  <h2>这次请求怎么组成</h2>
                </div>
                <div className="tv-blocks">
                  <div className="tv-block">
                    <div className="tv-block-title">1. System</div>
                    <p>总是重新放在最前面，不参与历史窗口滚动。</p>
                  </div>
                  <div className="tv-block">
                    <div className="tv-block-title">2. 历史窗口</div>
                    <p>
                      这里有 {selectedSummary.historyTurns.length} 轮历史，按从旧到新的顺序保留。
                      如果旧 `full` 快被挤掉，当前轮会升级成新的 `full`。
                    </p>
                  </div>
                  <div className="tv-block current">
                    <div className="tv-block-title">3. 当前 user payload</div>
                    <p>
                      当前轮是 <strong>{selectedEntry.mode}</strong> @ tick{" "}
                      <strong>{selectedEntry.requestTick}</strong>。
                    </p>
                    <pre>{selectedSummary.currentTurn?.user.content ?? "(missing)"}</pre>
                  </div>
                </div>
              </section>
            </div>
          )}
        </section>

        <aside className="tv-panel">
          <div className="tv-panel-header">
            <strong>Raw Content</strong>
            <span>{selectedEntry ? "当前 turn" : "未选择"}</span>
          </div>
          {!selectedEntry ? (
            <div className="tv-empty">
              <p>这里会显示原始 request / parsed_code / sandbox 信息。</p>
            </div>
          ) : (
            <div className="tv-raw">
              <details className="tv-disclosure">
                <summary>Request Messages ({selectedEntry.requestMessages.length})</summary>
                <section className="tv-raw-section">
                  {selectedEntry.requestMessages.map((message, index) => (
                    <details className="tv-message" key={`${message.role}-${index}`}>
                      <summary className="tv-message-summary">
                        <span className={`tv-message-role ${message.role}`}>{message.role}</span>
                        <span className="tv-message-summary-text">
                          {message.role === "user"
                            ? `${message.payload?.mode ?? "unknown"} @ tick ${message.payload?.tick ?? "?"}`
                            : "展开内容"}
                        </span>
                      </summary>
                      <pre>{message.content}</pre>
                    </details>
                  ))}
                </section>
              </details>
              <details className="tv-disclosure">
                <summary>Assistant Messages</summary>
                <section className="tv-raw-section">
                  <pre>{selectedEntry.parsedCode || "(empty)"}</pre>
                </section>
              </details>
              <details className="tv-disclosure">
                <summary>Stop / Trace Capability</summary>
                <section className="tv-raw-section">
                  <pre>{selectedEntry.providerError || "(none)"}</pre>
                </section>
              </details>
              <details className="tv-disclosure">
                <summary>Commands</summary>
                <section className="tv-raw-section">
                  <pre>{selectedEntry.commands || "(none)"}</pre>
                </section>
              </details>
              <details className="tv-disclosure">
                <summary>Tool Calls / Plans / Metrics</summary>
                <section className="tv-raw-section">
                  <pre>{selectedEntry.sandbox || "(none)"}</pre>
                </section>
              </details>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
