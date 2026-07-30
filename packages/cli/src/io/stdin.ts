import { createInterface } from "node:readline";

export type StdinInput =
  | { kind: string; tick: number; data: unknown }
  | null;

export async function readStdin(): Promise<StdinInput> {
  if (process.stdin.isTTY) {
    return null;
  }

  const rl = createInterface({ input: process.stdin });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }

  const raw = lines.join("\n").trim();
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (isStdinInput(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.actions)) {
      return { kind: "actions", tick: typeof obj.tick === "number" ? obj.tick : 0, data: obj };
    }
    if (Array.isArray(obj.unitIds) && Array.isArray(obj.steps)) {
      return { kind: "plan", tick: typeof obj.tick === "number" ? obj.tick : 0, data: obj };
    }
  }
  return null;
}

function isStdinInput(value: unknown): value is NonNullable<StdinInput> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.kind === "string" && typeof obj.tick === "number" && obj.data !== undefined;
}
