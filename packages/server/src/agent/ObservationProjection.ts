import type { AgentReadState, Game } from "../Game";

/** Read-only, revision-aware projection exposed to agent observation tools. */
export class ObservationProjection {
  private cached: AgentReadState | null = null;

  constructor(private readonly game: Game) {}

  read(): AgentReadState {
    const revision = this.game.getStateRevision();
    if (!this.cached || this.cached.revision !== revision) {
      this.cached = this.game.getAgentReadState();
    }
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}
