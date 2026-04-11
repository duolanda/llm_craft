import { LLMProvider, LLMProviderConfig } from "./LLMProvider";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";

export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  switch (config.providerType) {
    case "openai-compatible":
      return new OpenAICompatibleProvider(config);
    default:
      throw new Error(`不支持的 provider 类型: ${(config as { providerType: string }).providerType}`);
  }
}
