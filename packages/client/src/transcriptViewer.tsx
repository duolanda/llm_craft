import React, { ChangeEvent, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "./transcriptViewer.css";

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
  mode: "full" | "delta";
  requestTick: number;
  executeTick: number | null;
  model: string;
  requestMessages: TranscriptMessage[];
  response: string;
  parsedCode: string;
  providerError: string;
  commands: string;
  sandbox: string;
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

function parseEntry(chunk: string, index: number): TranscriptEntry | null {
  const trimmed = chunk.trim();
  if (!trimmed) {
    return null;
  }

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
  };
}

function parseTranscript(text: string): TranscriptEntry[] {
  return text
    .split("==========")
    .map((chunk, index) => parseEntry(chunk, index))
    .filter((entry): entry is TranscriptEntry => entry !== null);
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

  const filteredEntries = useMemo(() => {
    if (playerFilter === "all") {
      return entries;
    }
    return entries.filter((entry) => entry.playerId === playerFilter);
  }, [entries, playerFilter]);

  const selectedEntry =
    filteredEntries.find((entry) => entry.id === selectedId) ?? filteredEntries[0] ?? null;

  const selectedSummary = selectedEntry ? summarizeContext(selectedEntry) : null;

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = parseTranscript(text);
      if (parsed.length === 0) {
        setError("没能从这个文件里解析出 transcript entry。确认它是 `llm-debug` 日志。");
        setEntries([]);
        setSelectedId(null);
        return;
      }

      setEntries(parsed);
      setSelectedId(parsed[0].id);
      setError(null);
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
          <h1>Transcript Viewer</h1>
          <p className="tv-subtitle">
            上传 `packages/server/logs/llm-debug/*.log`，把每次真正发给 LLM 的上下文拆成人能看懂的结构。
          </p>
        </div>
        <div className="tv-toolbar">
          <label className="tv-upload">
            <input type="file" accept=".log,.txt" onChange={handleFileChange} />
            选择 Transcript 日志
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
              <p>先上传一份 transcript 日志。</p>
              <p>这个面板会列出每次模型调用的 `player / mode / requestTick`。</p>
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
                    executeTick {entry.executeTick ?? "n/a"} · {entry.model}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="tv-panel">
          <div className="tv-panel-header">
            <strong>Request Breakdown</strong>
            <span>{selectedEntry ? `${selectedEntry.playerId} @ ${selectedEntry.requestTick}` : "未选择"}</span>
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
                <summary>Parsed Code</summary>
                <section className="tv-raw-section">
                  <pre>{selectedEntry.parsedCode || "(empty)"}</pre>
                </section>
              </details>
              <details className="tv-disclosure">
                <summary>Provider Error</summary>
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
                <summary>Sandbox</summary>
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
