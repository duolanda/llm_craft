import { AIPromptPayload } from "@llmcraft/shared";

export interface LLMProviderConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export interface GenerateCodeResult {
  code: string;
  requestMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export interface LLMProvider {
  shouldForceFullState(): boolean;
  generateCode(payload: AIPromptPayload): Promise<GenerateCodeResult>;
  getModel(): string;
  getBaseURL(): string | undefined;
}
