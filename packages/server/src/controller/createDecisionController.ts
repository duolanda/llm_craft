import type { MatchPlayerLLMConfig, PlayerId } from "@llmcraft/shared";
import { createAgentSession } from "../createLLMProvider";
import { BuiltinCPUController } from "./BuiltinCPUController";
import type { DecisionController } from "./DecisionController";
import type { GameplayController } from "./GameplayController";
import { LLMControllerAdapter } from "./LLMControllerAdapter";

export function createDecisionController(
  playerId: PlayerId,
  config: MatchPlayerLLMConfig,
  gameplayController: GameplayController,
  systemPrompt: string,
): DecisionController {
  if (config.providerType === "builtin-cpu") {
    return new BuiltinCPUController(playerId, config, gameplayController);
  }
  return new LLMControllerAdapter(
    playerId,
    createAgentSession(config, { systemPrompt }),
    gameplayController,
  );
}
