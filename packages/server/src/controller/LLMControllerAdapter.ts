import type { AgentRunInput, PlayerId } from "@llmcraft/shared";
import type {
  AgentSession,
  RunSubAgentTaskInput,
  WarmupAgentResult,
} from "../LLMProvider";
import {
  AgentRuntime,
  type AgentRuntimeCallbacks,
  type AgentRuntimeResult,
} from "../agent/AgentRuntime";
import type { GameplayController } from "./GameplayController";
import type { DecisionController, DecisionControllerDescriptor } from "./DecisionController";
import type { PromptReflectionInput, PromptReflectionOptions, PromptReflectionResult } from "../PromptReflection";

/** Connects the AgentRuntime harness to the tick-scheduled decision interface. */
export class LLMControllerAdapter implements DecisionController {
  private readonly runtime: AgentRuntime;
  private readonly descriptor: DecisionControllerDescriptor;

  constructor(
    playerId: PlayerId,
    private readonly session: AgentSession,
    gameplayController: GameplayController,
  ) {
    this.runtime = new AgentRuntime(session, gameplayController);
    this.descriptor = {
      controllerId: `llm:${playerId}`,
      kind: "llm",
      playerId,
      model: session.getModel(),
      baseURL: session.getBaseURL(),
    };
  }

  getDescriptor(): DecisionControllerDescriptor {
    return { ...this.descriptor };
  }

  async warmup(
    input: AgentRunInput,
    callbacks?: AgentRuntimeCallbacks,
    signal?: AbortSignal,
  ): Promise<WarmupAgentResult> {
    return this.runtime.warmup(input, callbacks, signal);
  }

  async run(
    input: AgentRunInput,
    callbacks?: AgentRuntimeCallbacks,
    signal?: AbortSignal,
  ): Promise<AgentRuntimeResult> {
    return this.runtime.run(input, callbacks, signal);
  }

  runSubAgentTask(input: RunSubAgentTaskInput): Promise<string> {
    return this.session.runSubAgentTask(input);
  }

  reflectPrompt(input: PromptReflectionInput, options?: PromptReflectionOptions): Promise<PromptReflectionResult> {
    return this.session.reflectPrompt(input, options);
  }
}
