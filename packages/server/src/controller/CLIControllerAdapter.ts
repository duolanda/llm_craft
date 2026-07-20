import type { PlayerId } from "@llmcraft/shared";
import type { GameplayController } from "./GameplayController";

/**
 * Identifies externally triggered CLI calls as one decision source.
 *
 * The adapter does not schedule turns or own gameplay logic; HTTP requests call
 * the shared GameplayController directly after this adapter attaches provenance.
 */
export class CLIControllerAdapter {
  private readonly controllerId: string;

  constructor(
    playerId: PlayerId,
    readonly gameplayController: GameplayController,
    sessionId?: string,
  ) {
    this.controllerId = sessionId ? `cli:${sessionId}` : `cli:${playerId}`;
  }

  beginExternalCall(turnId?: string): void {
    this.gameplayController.beginToolCall({
      controllerId: this.controllerId,
      source: "external",
      ...(turnId ? { turnId } : {}),
    });
  }
}
