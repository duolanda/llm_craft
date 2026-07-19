import type { MatchRegistryListResponse } from "@llmcraft/shared";

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

export function listRegisteredMatches(apiBaseUrl: string): Promise<MatchRegistryListResponse> {
  return requestJson(`${apiBaseUrl}/api/control/matches`);
}

export function observeRegisteredMatch(apiBaseUrl: string, matchId: string): Promise<{ ok: true; matchId: string }> {
  return requestJson(`${apiBaseUrl}/api/control/matches/${encodeURIComponent(matchId)}/observe`, {
    method: "POST",
  });
}
