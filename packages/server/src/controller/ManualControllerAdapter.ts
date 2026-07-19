import type { AgentRunInput, PlayerId } from "@llmcraft/shared";
import type { WarmupAgentResult } from "../LLMProvider";
import type { AgentRuntimeCallbacks, AgentRuntimeResult } from "../agent/AgentRuntime";
import type { GameAgentBridge } from "../agent/GameAgentBridge";
import type { Controller, ControllerDescriptor, ControllerKind } from "./Controller";

/** Shared lifecycle adapter for externally driven CLI and human controllers. */
export class ManualControllerAdapter implements Controller {
  private readonly descriptor: ControllerDescriptor;

  constructor(
    kind: Extract<ControllerKind, "cli" | "human">,
    playerId: PlayerId,
    readonly bridge: GameAgentBridge,
    controllerId = `${kind}:${playerId}`,
  ) {
    this.descriptor = { controllerId, kind, playerId };
  }

  getDescriptor(): ControllerDescriptor {
    return { ...this.descriptor };
  }

  beginExternalCall(turnId?: string): void {
    this.bridge.beginToolCall({
      controllerId: this.descriptor.controllerId,
      source: "external",
      ...(turnId ? { turnId } : {}),
    });
  }

  async warmup(): Promise<WarmupAgentResult> {
    return {
      assistantMessages: [],
      stopReason: "manual_controller_ready",
      hasPendingToolCalls: false,
      metrics: { modelRequests: 0 },
    };
  }

  async run(_input: AgentRunInput, _callbacks?: AgentRuntimeCallbacks, signal?: AbortSignal): Promise<AgentRuntimeResult> {
    return {
      assistantMessages: [],
      toolCalls: [],
      plans: [],
      commands: [],
      stopReason: signal?.aborted ? "aborted" : "externally_driven",
      metrics: { modelRequests: 0, toolCalls: 0, stallDetected: false },
    };
  }

  advancePlans() {
    return this.bridge.advancePlans();
  }

  getActivePlans() {
    return this.bridge.getActivePlans();
  }
}

export class CLIControllerAdapter extends ManualControllerAdapter {
  constructor(playerId: PlayerId, bridge: GameAgentBridge, sessionId?: string) {
    super("cli", playerId, bridge, sessionId ? `cli:${sessionId}` : undefined);
  }
}

export class HumanControllerAdapter extends ManualControllerAdapter {
  constructor(playerId: PlayerId, bridge: GameAgentBridge, clientId?: string) {
    super("human", playerId, bridge, clientId ? `human:${clientId}` : undefined);
  }
}
