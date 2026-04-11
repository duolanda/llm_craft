import {
  CreateLLMPresetRequest,
  LLMPresetSummary,
  UpdateLLMPresetRequest,
} from "@llmcraft/shared";

interface PresetListResponse {
  presets: LLMPresetSummary[];
}

interface PresetMutationResponse {
  preset: LLMPresetSummary;
}

interface ErrorResponse {
  error?: string;
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    ...init,
  });

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorPayload = await response.json() as ErrorResponse;
      if (errorPayload.error) {
        errorMessage = errorPayload.error;
      }
    } catch {
      // Fall back to the HTTP status when the body is not JSON.
    }
    throw new Error(errorMessage);
  }

  return await response.json() as T;
}

export async function listPresets(apiBaseUrl: string): Promise<LLMPresetSummary[]> {
  const payload = await requestJson<PresetListResponse>(`${apiBaseUrl}/api/settings/presets`);
  return payload.presets;
}

export async function createPreset(
  apiBaseUrl: string,
  input: CreateLLMPresetRequest
): Promise<LLMPresetSummary> {
  const payload = await requestJson<PresetMutationResponse>(`${apiBaseUrl}/api/settings/presets`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return payload.preset;
}

export async function updatePreset(
  apiBaseUrl: string,
  presetId: string,
  input: UpdateLLMPresetRequest
): Promise<LLMPresetSummary> {
  const payload = await requestJson<PresetMutationResponse>(
    `${apiBaseUrl}/api/settings/presets/${encodeURIComponent(presetId)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    }
  );
  return payload.preset;
}

export async function deletePreset(apiBaseUrl: string, presetId: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`${apiBaseUrl}/api/settings/presets/${encodeURIComponent(presetId)}`, {
    method: "DELETE",
  });
}
