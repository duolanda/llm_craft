import { LLMProvider, LLMProviderConfig } from "./LLMProvider";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";

export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  return new OpenAICompatibleProvider(config);
}
