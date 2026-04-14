import { AIPromptPayload, MatchPlayerLLMConfig, OpenAICompatibleRuntimeConfig } from "@llmcraft/shared";

export type LLMProviderConfig = MatchPlayerLLMConfig;
export type OpenAIProviderConfig = OpenAICompatibleRuntimeConfig;

export interface GenerateCodeResult {
  code: string;
  rawResponse: string;
  requestMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  errorMessage?: string;
}

export interface LLMProvider {
  shouldForceFullState(): boolean;
  generateCode(payload: AIPromptPayload): Promise<GenerateCodeResult>;
  getModel(): string;
  getBaseURL(): string | undefined;
}
