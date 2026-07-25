import type { PlayerId } from "@llmcraft/shared";
import { WorldState } from "../WorldState";

export interface VictoryOutcome {
  type: "player_eliminated";
  winnerId: PlayerId;
  loserId: PlayerId;
}

export class VictorySystem {
  step(world: WorldState): VictoryOutcome | null {
    for (const playerId of world.getPlayerIds()) {
      if (world.buildings.getBuildingsByPlayer(playerId).length > 0) continue;
      const winnerId = world.getPlayerIds().find((candidateId) => candidateId !== playerId);
      if (!winnerId) return null;
      world.winner = winnerId;
      world.markChanged();
      return { type: "player_eliminated", winnerId, loserId: playerId };
    }
    return null;
  }
}
