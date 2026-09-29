import { AgentSession, LLMProvider, LLMProviderConfig } from "./LLMProvider";
import { OpenAIAgentSession, OpenAICompatibleProvider, type OpenAIAgentSessionOptions } from "./OpenAICompatibleProvider";
import { OpenAICompatibleModelTransport } from "./model/OpenAICompatibleModelTransport";
import { RateLimitedModelTransport } from "./model/RateLimitedModelTransport";
import type { ModelTransport } from "./model/ModelTransport";

function createModelTransport(
  config: Extract<LLMProviderConfig, { providerType: "openai-compatible" }>,
): ModelTransport {
  return new RateLimitedModelTransport(
    new OpenAICompatibleModelTransport(config),
    config.rpm ?? null,
  );
}

export function createAgentSession(
  config: LLMProviderConfig,
  options: OpenAIAgentSessionOptions = {},
): AgentSession {
  if (config.providerType === "builtin-cpu") {
    throw new Error("builtin-cpu is a DecisionController-backed opponent, not an AgentSession");
  }

  switch (config.providerType) {
    case "openai-compatible":
      return new OpenAIAgentSession(config, createModelTransport(config), options);
    default:
      throw new Error(`不支持的 provider 类型: ${(config as { providerType: string }).providerType}`);
  }
}

/** Factory for the preset connection-test endpoint; matches use createAgentSession. */
export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  if (config.providerType === "builtin-cpu") {
    throw new Error("builtin-cpu is not an LLM provider and cannot test model connectivity");
  }
  return new OpenAICompatibleProvider(config, createModelTransport(config));
}
