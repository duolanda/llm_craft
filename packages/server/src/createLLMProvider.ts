import { LLMProvider, LLMProviderConfig } from "./LLMProvider";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import { RateLimitedLLMProvider } from "./RateLimitedLLMProvider";
import { BenchmarkCPUProvider } from "./benchmark/BenchmarkCPUProvider";

export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  if (config.providerType === "builtin-cpu") {
    return new BenchmarkCPUProvider(config);
  }

  let provider: LLMProvider;
  switch (config.providerType) {
    case "openai-compatible":
      provider = new OpenAICompatibleProvider(config);
      break;
    default:
      throw new Error(`不支持的 provider 类型: ${(config as { providerType: string }).providerType}`);
  }

  return new RateLimitedLLMProvider(provider, config.rpm ?? null);
}
