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
import type { GameAgentBridge } from "../agent/GameAgentBridge";
import type { Controller, ControllerDescriptor, ControllerKind } from "./Controller";

/**
 * Compatibility boundary for the current provider-backed AgentRuntime.
 * Provider/session separation happens behind this adapter in the next P3A
 * slice instead of leaking back into GameOrchestrator.
 */
export class LLMControllerAdapter implements Controller {
  private readonly runtime: AgentRuntime;
  private readonly descriptor: ControllerDescriptor;

  constructor(
    playerId: PlayerId,
    private readonly session: AgentSession,
    bridge: GameAgentBridge,
    kind: ControllerKind = "llm",
  ) {
    this.runtime = new AgentRuntime(session, bridge);
    this.descriptor = {
      controllerId: `${kind}:${playerId}`,
      kind,
      playerId,
      model: session.getModel(),
      baseURL: session.getBaseURL(),
    };
  }

  getDescriptor(): ControllerDescriptor {
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

  advancePlans() {
    return this.runtime.advancePlans();
  }

  getActivePlans() {
    return this.runtime.getActivePlans();
  }

  runSubAgentTask(input: RunSubAgentTaskInput): Promise<string> {
    return this.session.runSubAgentTask(input);
  }
}
