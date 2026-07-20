import { describe, expect, it } from "vitest";
import { DEFAULT_MAP_LAYOUT, MAP_HEIGHT, MAP_WIDTH } from "@llmcraft/shared";
import { Game } from "../Game";
import { createDefaultMatchDefinition } from "../MatchDefinition";

describe("MatchDefinition", () => {
  it("puts terrain, resources, obstacles, HQs, and starting units in the map definition", () => {
    const definition = createDefaultMatchDefinition();
    definition.players[0].startingCredits = 321;
    const game = new Game(definition);
    const state = game.getState();

    expect(game.getDefinition()).toEqual(definition);
    expect(definition.map).toMatchObject({
      id: "standard",
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      obstacles: [],
    });
    expect(definition.map.playerStarts[0]).toMatchObject({
      playerId: "player_1",
      buildings: [{ type: "hq", position: DEFAULT_MAP_LAYOUT.player1Hq }],
    });
    expect(definition.map.playerStarts[0].units.map((unit) => unit.position))
      .toEqual(DEFAULT_MAP_LAYOUT.player1Workers);
    expect(state.players[0].resources.credits).toBe(321);
  });

  it("rejects dimensions the current SimulationCore cannot yet support", () => {
    const definition = createDefaultMatchDefinition();
    definition.map.width -= 1;

    expect(() => new Game(definition)).toThrow(/requires a 144x96 map/);
  });

  it("rejects a map whose starting layout differs from the supported standard map", () => {
    const definition = createDefaultMatchDefinition();
    definition.map.playerStarts[0].buildings[0]!.position.x += 1;

    expect(() => new Game(definition)).toThrow(/requires its HQ, unit, resource, and obstacle layout/);
  });
});
