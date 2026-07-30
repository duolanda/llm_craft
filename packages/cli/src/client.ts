import type { ControlBatchAction, ControlResponse } from "@llmcraft/shared";
import { randomUUID } from "node:crypto";

export const DEFAULT_SERVER = process.env.LLMCRAFT_SERVER || "http://localhost:3101";

type RawControlBody = Partial<ControlResponse> & {
  error?: string | { code?: string; message?: string; hint?: string };
  message?: string;
};

export class ControlClient {
  constructor(private baseUrl: string = DEFAULT_SERVER) {}

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async startGame(cpu?: string): Promise<ControlResponse> {
    const res = await fetch(`${this.baseUrl}/api/control/start-game`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cpu ? { cpu } : {}),
    });
    return parseControlResponse(res, "state");
  }

  async createSession(
    playerId: string,
    gameId?: string,
  ): Promise<ControlResponse> {
    const res = await fetch(`${this.baseUrl}/api/control/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId, gameId }),
    });
    return parseControlResponse(res, "state");
  }

  async getState(sessionId: string): Promise<ControlResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/control/sessions/${sessionId}/state`,
    );
    return parseControlResponse(res, "state");
  }

  async callTool(
    sessionId: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<ControlResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/control/sessions/${sessionId}/tools/${toolName}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: args ?? {} }),
      },
    );
    return parseControlResponse(res, "action_result");
  }

  async callActionBatch(
    sessionId: string,
    actions: ControlBatchAction[],
    clientRequestId = `cli_${randomUUID()}`,
  ): Promise<ControlResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/control/sessions/${sessionId}/actions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientRequestId, actions }),
      },
    );
    return parseControlResponse(res, "batch_result");
  }

  async listMatches(): Promise<unknown> {
    return requestJson(fetch(`${this.baseUrl}/api/control/matches`));
  }

  async observeMatch(matchId: string): Promise<unknown> {
    return requestJson(fetch(
      `${this.baseUrl}/api/control/matches/${encodeURIComponent(matchId)}/observe`,
      { method: "POST" },
    ));
  }

  async stopMatch(matchId: string): Promise<unknown> {
    return requestJson(fetch(
      `${this.baseUrl}/api/control/matches/${encodeURIComponent(matchId)}/stop`,
      { method: "POST" },
    ));
  }

  async saveMatchRecord(matchId: string): Promise<unknown> {
    return requestJson(fetch(
      `${this.baseUrl}/api/control/matches/${encodeURIComponent(matchId)}/save-record`,
      { method: "POST" },
    ));
  }

}

async function requestJson(request: Promise<Response>): Promise<unknown> {
  const response = await request;
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) as unknown : {};
  } catch {
    body = { error: text || response.statusText };
  }
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body
      ? (body as { error?: unknown }).error
      : undefined;
    throw new Error(typeof error === "string" ? error : `HTTP ${response.status}`);
  }
  return body;
}

async function parseControlResponse(
  res: Response,
  fallbackKind: ControlResponse["kind"],
): Promise<ControlResponse> {
  let body: RawControlBody | null = null;
  let text = "";

  try {
    text = await res.text();
    body = text ? JSON.parse(text) as RawControlBody : null;
  } catch {
    body = null;
  }

  if (body?.ok === true || body?.ok === false) {
    return body as ControlResponse;
  }

  const rawError = body?.error;
  const code = typeof rawError === "object" && rawError?.code
    ? rawError.code
    : `http_${res.status}`;
  const parsedMessage = typeof rawError === "string"
    ? rawError
    : rawError?.message ?? body?.message ?? text;
  const message = parsedMessage || res.statusText || "Control API request failed";
  const hint = typeof rawError === "object" ? rawError.hint : undefined;

  return {
    ok: false,
    tick: typeof body?.tick === "number" ? body.tick : 0,
    kind: fallbackKind,
    data: {},
    error: {
      code,
      message,
      ...(hint ? { hint } : {}),
    },
  };
}
