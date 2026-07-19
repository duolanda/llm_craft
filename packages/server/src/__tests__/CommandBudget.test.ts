import { describe, expect, it } from "vitest";
import { allocateFairPathBudgets } from "../CommandBudget";

describe("CommandBudget", () => {
  it("reserves equal capacity when both actors have path demand", () => {
    expect(Object.fromEntries(allocateFairPathBudgets(new Map([
      ["player_1", 4],
      ["player_2", 4],
    ]), 4, 0))).toEqual({ player_1: 2, player_2: 2 });
  });

  it("lends unused capacity to the actor that can use it", () => {
    expect(Object.fromEntries(allocateFairPathBudgets(new Map([
      ["player_1", 4],
      ["player_2", 1],
    ]), 4, 0))).toEqual({ player_1: 3, player_2: 1 });
    expect(Object.fromEntries(allocateFairPathBudgets(new Map([
      ["player_1", 4],
    ]), 4, 0))).toEqual({ player_1: 4 });
  });

  it("rotates indivisible spare capacity instead of favoring one actor forever", () => {
    const demand = new Map([["player_1", 3], ["player_2", 3]]);
    expect(Object.fromEntries(allocateFairPathBudgets(demand, 3, 0))).toEqual({ player_1: 2, player_2: 1 });
    expect(Object.fromEntries(allocateFairPathBudgets(demand, 3, 1))).toEqual({ player_1: 1, player_2: 2 });
  });
});
