import type { MatchPlayerLLMConfig, PlayerId } from "@llmcraft/shared";
import { createAgentSession } from "../createLLMProvider";
import type { GameAgentBridge } from "../agent/GameAgentBridge";
import type { Controller } from "./Controller";
import { LLMControllerAdapter } from "./LLMControllerAdapter";
import { BuiltinTestController } from "./BuiltinTestController";

export function createController(
  playerId: PlayerId,
  config: MatchPlayerLLMConfig,
  bridge: GameAgentBridge,
  systemPrompt: string,
): Controller {
  if (config.providerType === "builtin-cpu") {
    return new BuiltinTestController(playerId, config, bridge);
  }
  return new LLMControllerAdapter(
    playerId,
    createAgentSession(config, { systemPrompt }),
    bridge,
    "llm",
  );
}
