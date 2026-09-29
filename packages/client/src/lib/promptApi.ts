import type {
  CreateStrategyPromptRequest,
  StrategyPrompt,
  StrategyPromptVersionProvenance,
  UpdateStrategyPromptRequest,
} from "@llmcraft/shared";

interface PromptListResponse {
  prompts: StrategyPrompt[];
}

interface PromptMutationResponse {
  prompt: StrategyPrompt;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export async function listPrompts(apiBaseUrl: string): Promise<StrategyPrompt[]> {
  return (await requestJson<PromptListResponse>(`${apiBaseUrl}/api/prompts`)).prompts;
}

export async function getPromptProvenance(apiBaseUrl: string, promptId: string): Promise<Record<string, StrategyPromptVersionProvenance>> {
  return (await requestJson<{ provenance: Record<string, StrategyPromptVersionProvenance> }>(
    `${apiBaseUrl}/api/prompts/${encodeURIComponent(promptId)}/provenance`,
  )).provenance;
}

export async function createPrompt(
  apiBaseUrl: string,
  input: CreateStrategyPromptRequest,
): Promise<StrategyPrompt> {
  return (await requestJson<PromptMutationResponse>(`${apiBaseUrl}/api/prompts`, {
    method: "POST",
    body: JSON.stringify(input),
  })).prompt;
}

export async function updatePrompt(
  apiBaseUrl: string,
  promptId: string,
  input: UpdateStrategyPromptRequest,
): Promise<StrategyPrompt> {
  return (await requestJson<PromptMutationResponse>(`${apiBaseUrl}/api/prompts/${encodeURIComponent(promptId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  })).prompt;
}

export async function activatePromptVersion(
  apiBaseUrl: string,
  promptId: string,
  versionId: string,
): Promise<StrategyPrompt> {
  return (await requestJson<PromptMutationResponse>(
    `${apiBaseUrl}/api/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(versionId)}/activate`,
    { method: "POST" },
  )).prompt;
}

export async function deletePrompt(apiBaseUrl: string, promptId: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`${apiBaseUrl}/api/prompts/${encodeURIComponent(promptId)}`, {
    method: "DELETE",
  });
}
