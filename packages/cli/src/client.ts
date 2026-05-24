import type { ControlResponse } from "@llmcraft/shared";

export const DEFAULT_SERVER = process.env.LLMCRAFT_SERVER || "http://localhost:3001";

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
