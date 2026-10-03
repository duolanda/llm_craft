import type { MatchRegistryListResponse, PlayerId } from "@llmcraft/shared";

export interface CLILobbyState {
  matchId: string;
  status: "waiting_for_players" | "running" | "finished" | "stopped";
  ready: Record<PlayerId, boolean>;
}

interface ErrorPayload {
  error?: string | { message?: string };
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => ({})) as ErrorPayload & T;
  if (!response.ok) {
    const message = typeof payload.error === "string"
      ? payload.error
      : payload.error?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

export function listRegisteredMatches(apiBaseUrl: string, signal?: AbortSignal): Promise<MatchRegistryListResponse> {
  return requestJson(`${apiBaseUrl}/api/control/matches`, { signal, cache: "no-store" });
}

export function stopRegisteredMatch(apiBaseUrl: string, matchId: string): Promise<{ ok: true; matchId: string; filePath: string }> {
  return requestJson(`${apiBaseUrl}/api/control/matches/${encodeURIComponent(matchId)}/stop`, {
    method: "POST",
  });
}

export function observeRegisteredMatch(apiBaseUrl: string, matchId: string): Promise<{ ok: true; matchId: string }> {
  return requestJson(`${apiBaseUrl}/api/control/matches/${encodeURIComponent(matchId)}/observe`, {
    method: "POST",
  });
}

export function getCLILobby(apiBaseUrl: string, matchId: string, signal: AbortSignal): Promise<CLILobbyState> {
  return requestJson(`${apiBaseUrl}/api/control/matches/${encodeURIComponent(matchId)}/lobby`, {
    signal,
    cache: "no-store",
  });
}

export async function createCLIMatch(apiBaseUrl: string): Promise<{ matchId: string; reused: boolean }> {
  const response = await requestJson<{
    ok: boolean;
    data: { matchId: string; reused: boolean; decisionIntervalTicks?: number };
  }>(`${apiBaseUrl}/api/control/start-game`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!response.ok || !response.data?.matchId) {
    throw new Error("无法创建 CLI 对局，请重试。");
  }
  if (response.data.decisionIntervalTicks !== undefined) {
    throw new Error("已有 CLI 对 CPU 的对局正在进行，请先结束该局，再创建双玩家 CLI 对局。");
  }
  return { matchId: response.data.matchId, reused: response.data.reused };
}
