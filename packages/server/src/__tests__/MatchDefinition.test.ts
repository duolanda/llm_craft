import { describe, expect, it } from "vitest";
import { DEFAULT_MAP_LAYOUT, MAP_HEIGHT, MAP_WIDTH } from "@llmcraft/shared";
import { Game } from "../Game";
import type { MatchDefinitionV1 } from "@llmcraft/shared";
import { resolveCommandBudgetPolicy } from "../CommandBudget";
import { createDefaultMatchDefinition } from "../MatchDefinition";

describe("MatchDefinition", () => {
  it("materializes the current rules and scenario inputs used by Game", () => {
    const definition = createDefaultMatchDefinition();
    definition.players[0].startingCredits = 321;
    const game = new Game(definition);
    const state = game.getState();

    expect(game.getDefinition()).toEqual(definition);
    expect(definition).toMatchObject({
      definitionVersion: 2,
      rules: {
        schemaVersion: 1,
        commandBudget: {
          maxCommandsPerActorPerTick: 100,
          maxPathCommandsPerTick: 4,
        },
      },
    });
    expect(definition.map).toMatchObject({ width: MAP_WIDTH, height: MAP_HEIGHT });
    expect(state.players[0].resources.credits).toBe(321);
    expect(state.players[0].buildings[0]).toMatchObject(DEFAULT_MAP_LAYOUT.player1Hq);
    expect(state.players[0].units).toEqual(
      expect.arrayContaining(DEFAULT_MAP_LAYOUT.player1Workers.map((position) => expect.objectContaining(position))),
    );
  });

  it("rejects dimensions the current SimulationCore cannot yet support", () => {
    const definition = createDefaultMatchDefinition();
    definition.map.width -= 1;

    expect(() => new Game(definition)).toThrow(/requires a 144x96 map/);
  });

  it("rejects geometry that disagrees with the versioned default scenario", () => {
    const definition = createDefaultMatchDefinition();
    definition.players[0].hq.x += 1;

    expect(() => new Game(definition)).toThrow(/requires its versioned HQ, worker, and resource layout/);
  });

  it("validates explicit v2 budgets and preserves frozen v1 budget semantics", () => {
    const invalid = createDefaultMatchDefinition();
    invalid.rules.commandBudget.maxCommandsPerActorPerTick = 0;
    expect(() => new Game(invalid)).toThrow(/positive integer number of commands/);

    const current = createDefaultMatchDefinition();
    const { rules: _rules, ...legacyBase } = current;
    const legacy: MatchDefinitionV1 = { ...legacyBase, definitionVersion: 1 };
    expect(resolveCommandBudgetPolicy(legacy)).toEqual({
      maxCommandsPerActorPerTick: 100,
      maxPathCommandsPerTick: 4,
    });
  });
});
