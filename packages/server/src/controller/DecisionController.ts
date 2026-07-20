import type {
  AgentRunInput,
  PlayerId,
} from "@llmcraft/shared";
import type {
  RunSubAgentTaskInput,
  WarmupAgentResult,
} from "../LLMProvider";
import type {
  AgentRuntimeCallbacks,
  AgentRuntimeResult,
} from "../agent/AgentRuntime";

export type DecisionControllerKind = "llm" | "cpu";

export interface DecisionControllerDescriptor {
  controllerId: string;
  kind: DecisionControllerKind;
  playerId: PlayerId;
  model?: string;
  baseURL?: string;
}

/**
 * A tick-scheduled decision source. GameOrchestrator only needs to know whether
 * the source is idle; gameplay observations and actions remain in
 * GameplayController.
 */
export interface DecisionController {
  getDescriptor(): DecisionControllerDescriptor;
  warmup(
    input: AgentRunInput,
    callbacks?: AgentRuntimeCallbacks,
    signal?: AbortSignal,
  ): Promise<WarmupAgentResult>;
  run(
    input: AgentRunInput,
    callbacks?: AgentRuntimeCallbacks,
    signal?: AbortSignal,
  ): Promise<AgentRuntimeResult>;
  runSubAgentTask?(input: RunSubAgentTaskInput): Promise<string>;
}
