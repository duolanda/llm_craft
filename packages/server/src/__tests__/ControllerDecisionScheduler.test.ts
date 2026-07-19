import { describe, expect, it } from "vitest";
import { ControllerDecisionScheduler } from "../controller/ControllerDecisionScheduler";

describe("ControllerDecisionScheduler", () => {
  it("does not starve an idle controller while its opponent is still running", () => {
    const scheduler = new ControllerDecisionScheduler({
      intervalTicksByPlayer: { player_1: 5, player_2: 5 },
    });
    scheduler.reset(0);

    expect(scheduler.select(0, { player_1: false, player_2: false })).toEqual([
      "player_1",
      "player_2",
    ]);
    expect(scheduler.select(5, { player_1: false, player_2: true })).toEqual(["player_1"]);
    expect(scheduler.select(10, { player_1: false, player_2: true })).toEqual(["player_1"]);
    expect(scheduler.select(10, { player_1: true, player_2: false })).toEqual(["player_2"]);
  });

  it("retains independent intervals for asymmetric benchmark controllers", () => {
    const scheduler = new ControllerDecisionScheduler({
      intervalTicksByPlayer: { player_1: 2, player_2: 6 },
    });
    scheduler.reset(0);

    expect(scheduler.select(0, { player_1: false, player_2: false })).toEqual([
      "player_1",
      "player_2",
    ]);
    expect(scheduler.select(2, { player_1: false, player_2: false })).toEqual(["player_1"]);
    expect(scheduler.select(4, { player_1: false, player_2: false })).toEqual(["player_1"]);
    expect(scheduler.select(6, { player_1: false, player_2: false })).toEqual([
      "player_1",
      "player_2",
    ]);
  });

  it("rejects invalid decision intervals", () => {
    expect(() => new ControllerDecisionScheduler({
      intervalTicksByPlayer: { player_1: 0, player_2: 5 },
    })).toThrow(/positive integers/);
  });
});
