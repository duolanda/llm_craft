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

  if (!isStdinInput(parsed)) {
    return null;
  }

  return parsed;
}

function isStdinInput(value: unknown): value is NonNullable<StdinInput> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.kind === "string" && typeof obj.tick === "number" && obj.data !== undefined;
}
