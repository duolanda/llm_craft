import { describe, expect, it } from "vitest";
import type { PlayerId } from "@llmcraft/shared";
import { createDefaultMatchDefinition } from "../MatchDefinition";
import { createSystemPrompt } from "../SystemPrompt";

describe("createSystemPrompt", () => {
  it("generates mirrored HQ guidance while requiring live paired build sites", () => {
    const definition = createDefaultMatchDefinition();
    const player1 = createSystemPrompt(definition, "player_1");
    const player2 = createSystemPrompt(definition, "player_2");

    expect(player1).toContain("当前控制 player_1");
    expect(player1).toContain("我方 HQ 在 (14,48)，敌方 HQ 在 (129,48)");
    expect(player1).toContain('"x":129,"y":48');
    expect(player1).toContain("suggestedSites 中同一项");
    expect(player1).toContain("观赏性");
    expect(player1).not.toContain('"buildingType":"barracks","x":26,"y":48');

    expect(player2).toContain("当前控制 player_2");
    expect(player2).toContain("我方 HQ 在 (129,48)，敌方 HQ 在 (14,48)");
    expect(player2).toContain('"x":14,"y":48');
    expect(player2).toContain("suggestedSites 中同一项");
    expect(player2).not.toContain('"buildingType":"barracks","x":117,"y":48');
  });

  it("rejects a player identity outside the MatchDefinition", () => {
    expect(() => createSystemPrompt(createDefaultMatchDefinition(), "spectator" as unknown as PlayerId))
      .toThrow(/unknown player spectator/);
  });
});
