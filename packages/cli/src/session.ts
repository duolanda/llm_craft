import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface CLISession {
  sessionId: string;
  gameId: string;
  playerId: string;
  serverUrl: string;
}

const SESSION_DIR = path.join(os.homedir(), ".llmcraft");
const SESSION_FILE = path.join(SESSION_DIR, "session.json");

export function loadSession(): CLISession | null {
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    return JSON.parse(raw) as CLISession;
  } catch {
    return null;
  }
}

export function saveSession(session: CLISession): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), "utf8");
}

export function resolveSessionId(
  explicitSessionId?: string,
): string | null {
  if (explicitSessionId) {
    return explicitSessionId;
  }
  if (process.env.LLMCRAFT_SESSION) {
    return process.env.LLMCRAFT_SESSION;
  }
  const saved = loadSession();
  return saved?.sessionId ?? null;
}

export function resolveServerUrl(explicitUrl?: string): string {
  if (explicitUrl) {
    return explicitUrl;
  }
  if (process.env.LLMCRAFT_SERVER) {
    return process.env.LLMCRAFT_SERVER;
  }
  const saved = loadSession();
  return saved?.serverUrl ?? "http://localhost:3101";
}
