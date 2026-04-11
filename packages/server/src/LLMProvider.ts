import { AIPromptPayload, MatchPlayerLLMConfig } from "@llmcraft/shared";

export type LLMProviderConfig = MatchPlayerLLMConfig;

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
