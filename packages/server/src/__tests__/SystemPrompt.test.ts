import { describe, expect, it } from "vitest";
import type { PlayerId } from "@llmcraft/shared";
import { createDefaultMatchDefinition } from "../MatchDefinition";
import { createSystemPrompt } from "../SystemPrompt";

describe("createSystemPrompt", () => {
  it("generates mirrored factual guidance without a fixed opening strategy", () => {
    const definition = createDefaultMatchDefinition();
    const player1 = createSystemPrompt(definition, "player_1");
    const player2 = createSystemPrompt(definition, "player_2");

    expect(player1).toContain("当前控制 player_1");
    expect(player1).toContain("我方 HQ 在 (14,48)，敌方 HQ 在 (129,48)");
    expect(player1).toContain("地图较大");
    expect(player1).toContain("自主决定");
    expect(player1).not.toContain("观赏性");
    expect(player1).not.toContain("6 个 rifleman");
    expect(player1).not.toContain("battle_line");

    expect(player2).toContain("当前控制 player_2");
    expect(player2).toContain("我方 HQ 在 (129,48)，敌方 HQ 在 (14,48)");
    expect(player2).toContain("集中进攻、多方向进攻");
    expect(player2).not.toContain("北线");
  });

  it("rejects a player identity outside the MatchDefinition", () => {
    expect(() => createSystemPrompt(createDefaultMatchDefinition(), "spectator" as unknown as PlayerId))
      .toThrow(/unknown player spectator/);
  });
});
