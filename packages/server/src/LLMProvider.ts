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
  shouldResetConversation(): boolean;
  generateCode(payload: AIPromptPayload, resetConversation?: boolean): Promise<GenerateCodeResult>;
  getModel(): string;
  getBaseURL(): string | undefined;
}
