import type {
  AgentPlanRecord,
  AgentRunInput,
  Command,
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

export type ControllerKind = "llm" | "cli" | "human" | "test";

export interface ControllerDescriptor {
  controllerId: string;
  kind: ControllerKind;
  playerId: PlayerId;
  model?: string;
  baseURL?: string;
}

/**
 * Match-facing decision source. GameOrchestrator schedules Controllers without
 * knowing whether their implementation is backed by a model provider.
 *
 * The current adapter preserves the existing AgentRuntime behavior. Later P3A
 * slices can move session state out of LLMProvider without changing the match
 * scheduler again.
 */
export interface Controller {
  getDescriptor(): ControllerDescriptor;
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
  advancePlans(): Command[];
  getActivePlans(): AgentPlanRecord[];
  runSubAgentTask?(input: RunSubAgentTaskInput): Promise<string>;
}
