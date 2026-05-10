import type { ControlResponse } from "@llmcraft/shared";

export const DEFAULT_SERVER = process.env.LLMCRAFT_SERVER || "http://localhost:3001";

export class ControlClient {
  constructor(private baseUrl: string = DEFAULT_SERVER) {}

  getBaseUrl(): string {
    return this.baseUrl;
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
    return res.json() as Promise<ControlResponse>;
  }

  async getState(sessionId: string): Promise<ControlResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/control/sessions/${sessionId}/state`,
    );
    return res.json() as Promise<ControlResponse>;
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
    return res.json() as Promise<ControlResponse>;
  }

  async waitTicks(
    sessionId: string,
    ticks: number,
  ): Promise<ControlResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/control/sessions/${sessionId}/wait`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticks }),
      },
    );
    return res.json() as Promise<ControlResponse>;
  }
}
