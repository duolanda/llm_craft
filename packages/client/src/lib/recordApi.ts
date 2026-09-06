import type { MatchRecord } from "@llmcraft/shared";
import { API_BASE_URL } from "./serverConnection";

/** Uploads opaque file bytes; decoding and validation belong to the server. */
export async function importMatchRecord(file: File): Promise<MatchRecord> {
  const response = await fetch(`${API_BASE_URL}/api/replay/import`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!response.ok) {
    const payload = await response.json() as { error?: string };
    throw new Error(payload.error ?? `导入录像失败：HTTP ${response.status}`);
  }
  return await response.json() as MatchRecord;
}
