import {
  TestLLMPresetRequest,
  TestLLMPresetResponse,
} from "@llmcraft/shared";

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
    }
    throw new Error(errorMessage);
  }

  return await response.json() as T;
}

export async function testPreset(
  apiBaseUrl: string,
  input: TestLLMPresetRequest
): Promise<TestLLMPresetResponse> {
  return await requestJson<TestLLMPresetResponse>(`${apiBaseUrl}/api/settings/presets/test`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
