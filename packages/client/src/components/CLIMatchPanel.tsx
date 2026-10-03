import { useEffect, useState } from "react";
import type { MatchRegistrySummary, PlayerId } from "@llmcraft/shared";
import { createCLIMatch, getCLILobby, listRegisteredMatches, observeRegisteredMatch, stopRegisteredMatch, type CLILobbyState } from "../lib/matchApi";
import { SettingsOverlay } from "./SettingsOverlay";

const PLAYERS: PlayerId[] = ["player_1", "player_2"];

function createPrompt(playerId: PlayerId, matchId: string, baseUrl: string): string {
  return [
    "Read only docs/cli-agent-guide.md from the project. Do not list directories or read/search any other project content, including source code, dependencies, logs, and match records.",
    "The server and CLI are already prepared. If llmcraft is not on PATH, use ./node_modules/.bin/llmcraft (PowerShell: .\\node_modules\\.bin\\llmcraft). You may check only that exact executable path and run --help. If it is unavailable, report the blocker without scanning the repository, installing dependencies, or rebuilding the project.",
    "Use the guide and current CLI outputs to make gameplay decisions. Once the match starts, keep observing and acting instead of researching the implementation.",
    "",
    `You are ${playerId} in a LLMCraft CLI match.`,
    "First read docs/cli-agent-guide.md.",
    `Join with: llmcraft session use --player ${playerId} --game ${matchId} --base-url ${baseUrl}`,
    `After joining, copy your sessionId and pass --session <sessionId> --base-url ${baseUrl} on every command, including each command in a pipeline.`,
    "Use only llmcraft. Do not write WebSocket or raw HTTP clients.",
    "Wait for both players to join, then keep observing and acting until the match ends.",
  ].join("\n");
}

interface CLIMatchPanelProps {
  open: boolean;
  apiBaseUrl: string;
  observedMatch: Pick<MatchRegistrySummary, "matchId" | "status"> | null;
  onClose: () => void;
  onObserve: (matchId: string) => void;
}

export function CLIMatchPanel({ open, apiBaseUrl, observedMatch, onClose, onObserve }: CLIMatchPanelProps) {
  const [matchId, setMatchId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [lobbyRefreshKey, setLobbyRefreshKey] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<PlayerId | null>(null);
  const [lobby, setLobby] = useState<CLILobbyState | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);
  const baseUrl = new URL(apiBaseUrl || window.location.origin, window.location.origin).href.replace(/\/$/, "");
  const currentLobby = lobby?.matchId === matchId ? lobby : null;
  const status = currentLobby?.status ?? (observedMatch?.matchId === matchId ? observedMatch.status : null);
  const matchEnded = status === "finished" || status === "stopped";
  const canStop = status === "running" || status === "waiting_for_players";
  const canView = !lobbyError && currentLobby?.ready.player_1 === true && currentLobby.ready.player_2 === true;
  const statusLabel = status === "running" ? "对局进行中"
    : status === "finished" ? "对局已结束"
    : status === "stopped" ? "对局已停止"
    : status === "waiting_for_players" ? "等待双方 agent 加入" : "";

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setRestoring(true);
    setError(null);
    setMessage(null);
    const restore = async () => {
      try {
        const { matches, observedMatchId } = await listRegisteredMatches(apiBaseUrl, controller.signal);
        if (controller.signal.aborted) return;
        const selected = matches.find((match) => match.kind === "control" && match.matchId === observedMatchId)
          ?? matches.find((match) => match.kind === "control" && (match.status === "running" || match.status === "waiting_for_players"));
        setMatchId(selected?.matchId ?? null);
        setCopied(null);
        setMessage(selected ? "已恢复现有 CLI 对局。" : null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(`无法读取现有 CLI 对局：${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        if (!controller.signal.aborted) setRestoring(false);
      }
    };
    void restore();
    return () => controller.abort();
  }, [open, apiBaseUrl]);

  useEffect(() => {
    if (!open || !matchId) return;
    const controller = new AbortController();
    let timer: number | undefined;
    setLobby(null);
    setLobbyError(null);
    const refresh = async () => {
      try {
        const nextLobby = await getCLILobby(apiBaseUrl, matchId, controller.signal);
        if (controller.signal.aborted) return;
        setLobby(nextLobby);
        setLobbyError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setLobbyError(cause instanceof Error ? cause.message : String(cause));
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void refresh(), 1_000);
    };
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, matchId, apiBaseUrl, lobbyRefreshKey]);

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await createCLIMatch(apiBaseUrl);
      if (result.matchId !== matchId) {
        setCopied(null);
      }
      setMatchId(result.matchId);
      setLobby(null);
      onObserve(result.matchId);
      setMessage(result.reused ? "已接入现有 CLI 对局。分别复制下方提示词给两个 agent。" : "对局已创建。分别复制下方提示词给两个 agent，双方加入后自动开打。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleObserve = async () => {
    if (!matchId || !canView || restoring || busy) return;
    setBusy(true);
    setError(null);
    try {
      await observeRegisteredMatch(apiBaseUrl, matchId);
      onObserve(matchId);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (playerId: PlayerId) => {
    if (!matchId) return;
    setError(null);
    setCopied(null);
    try {
      await navigator.clipboard.writeText(createPrompt(playerId, matchId, baseUrl));
      setCopied(playerId);
    } catch {
      setError("复制失败，请允许浏览器访问剪贴板后重试。");
    }
  };

  const handleStop = async () => {
    if (!matchId || !canStop) return;
    setBusy(true);
    setError(null);
    try {
      await stopRegisteredMatch(apiBaseUrl, matchId);
      setLobby((current) => current?.matchId === matchId ? { ...current, status: "stopped" } : current);
      setLobbyRefreshKey((current) => current + 1);
      setMessage("对局已停止，录像已保存。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsOverlay open={open} title="CLI 对战" onClose={onClose}>
      <div className="cli-match-panel">
        <div className="cli-match-intro">
          <p>创建对局，将双方提示词分别发给你自己的 agent。两边都加入后，战场自动开始。</p>
          <button type="button" className="hud-btn hud-btn-start" disabled={busy || restoring} onClick={() => void handleCreate()}>
            {restoring ? "读取大厅…" : busy ? "处理中…" : matchEnded ? "创建新对局" : matchId ? "接入当前对局" : "创建 CLI 对局"}
          </button>
        </div>
        <div className="cli-match-meta">
          <span>服务地址 <code>{baseUrl}</code></span>
          {matchId && <span>对局 <code>{matchId}</code></span>}
          {statusLabel && <span>{statusLabel}</span>}
        </div>
        {message && <p className="cli-match-message" role="status">{matchEnded ? "本局已结束。可以创建新对局生成新的接入指令。" : message}</p>}
        {error && <p className="match-browser-error" role="alert">{error}</p>}
        {lobbyError && <p className="match-browser-error" role="status">大厅状态更新失败，正在重试：{lobbyError}</p>}
        <div className="cli-match-players">
          {PLAYERS.map((playerId, index) => (
            <section className={`cli-player-card cli-player-${index + 1}`} key={playerId}>
              <div className="cli-player-heading">
                <div className="cli-player-identity">玩家 {index + 1} <span>{playerId}</span></div>
                <button type="button" className="hud-btn hud-btn-ghost" disabled={busy || restoring || !matchId || matchEnded}
                  onClick={() => void handleCopy(playerId)}>
                  {copied === playerId ? "已复制" : "复制提示词"}
                </button>
              </div>
              <div className={`cli-player-status ${!lobbyError && currentLobby?.ready[playerId] ? "joined" : ""}`} role="status">
                {restoring ? "正在读取大厅…"
                  : !matchId ? error ? "大厅状态暂不可用" : "尚未创建对局"
                  : lobbyError ? "状态暂不可用"
                  : !currentLobby ? "正在获取加入状态…"
                  : currentLobby.ready[playerId] ? "已加入大厅" : "等待加入大厅"}
              </div>
            </section>
          ))}
        </div>
        <div className="cli-match-footer">
          <span>Agent 需能在项目目录运行 llmcraft，并读取 docs/cli-agent-guide.md。</span>
          <div className="cli-match-actions">
            {canStop && <button type="button" className="hud-btn hud-btn-stop" disabled={busy || restoring} onClick={() => void handleStop()}>停止对局</button>}
            <button type="button" className="hud-btn" disabled={!canView || busy || restoring}
              title={matchId && !canView ? "双方加入大厅后可查看战场" : undefined}
              onClick={() => void handleObserve()}>查看战场</button>
          </div>
        </div>
      </div>
    </SettingsOverlay>
  );
}
