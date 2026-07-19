import { createHash } from "node:crypto";
import type { GameState, TraceStateHashRecord } from "@llmcraft/shared";
import type { DeterministicRngState } from "./DeterministicRng";

/**
 * Version 2 includes the RNG cursor because it affects the next authoritative
 * transition. Presentation logs and other observer-only fields are excluded.
 */
export function hashAuthoritativeStateV2(
  state: GameState,
  rng: DeterministicRngState,
): TraceStateHashRecord {
  const authoritativeState = {
    tick: state.tick,
    winner: state.winner,
    rng,
    players: state.players.map((player) => ({
      id: player.id,
      resources: player.resources,
      units: [...player.units].sort((a, b) => a.id.localeCompare(b.id)),
      buildings: [...player.buildings].sort((a, b) => a.id.localeCompare(b.id)),
    })),
    tiles: state.tiles.map((row) => row.map((tile) => ({
      x: tile.x,
      y: tile.y,
      type: tile.type,
      resourceRemaining: tile.resourceRemaining ?? null,
    }))),
    projectiles: [...(state.projectiles ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return {
    hashVersion: 2,
    tick: state.tick,
    algorithm: "sha256",
    hash: createHash("sha256").update(JSON.stringify(authoritativeState)).digest("hex"),
  };
}
