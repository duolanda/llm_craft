import { describe, expect, it } from "vitest";
import type { CommandEnvelope } from "@llmcraft/shared";
import { CommandGateway } from "../CommandGateway";

function createEnvelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    matchId: "match_test",
    actorId: "player_1",
    baseTick: 5,
    applyAtTick: 6,
    sequence: 1,
    clientRequestId: "request_1",
    commands: [{
      id: "command_1",
      type: "hold",
      playerId: "player_1",
      unitId: "unit_1",
    }],
    ...overrides,
  };
}

describe("CommandGateway", () => {
  it("accepts an envelope once and makes exact retries idempotent", () => {
    const gateway = new CommandGateway({ matchId: "match_test", getCurrentTick: () => 5 });
    const envelope = createEnvelope();

    expect(gateway.submit(envelope)).toMatchObject({ accepted: true, duplicate: false });
    expect(gateway.submit(structuredClone(envelope))).toMatchObject({ accepted: true, duplicate: true });
    expect(gateway.takeForTick(6)).toHaveLength(1);
    expect(gateway.takeForTick(6)).toEqual([]);
  });

  it("rejects reuse of a client request id with different content", () => {
    const gateway = new CommandGateway({ matchId: "match_test", getCurrentTick: () => 5 });
    gateway.submit(createEnvelope());

    expect(gateway.submit(createEnvelope({ sequence: 2 }))).toMatchObject({
      accepted: false,
      code: "idempotency_conflict",
    });
  });

  it("rejects the complete batch when any command is unauthorized", () => {
    const gateway = new CommandGateway({ matchId: "match_test", getCurrentTick: () => 5 });
    const envelope = createEnvelope({
      commands: [
        createEnvelope().commands[0],
        { id: "command_2", type: "hold", playerId: "player_2", unitId: "unit_2" },
      ],
    });

    expect(gateway.submit(envelope)).toMatchObject({ accepted: false, code: "unauthorized_actor" });
    expect(gateway.takeForTick(6)).toEqual([]);
  });

  it("releases batches in actor, sequence and request-id order, independent of arrival", () => {
    const gateway = new CommandGateway({ matchId: "match_test", getCurrentTick: () => 5 });
    gateway.submit(createEnvelope({ sequence: 2, clientRequestId: "request_2" }));
    gateway.submit(createEnvelope({
      sequence: 1,
      clientRequestId: "request_1",
      commands: [{ ...createEnvelope().commands[0], id: "command_2" }],
    }));

    expect(gateway.takeForTick(6).map((envelope) => envelope.sequence)).toEqual([1, 2]);
  });

  it("rejects command ids already accepted by another envelope", () => {
    const gateway = new CommandGateway({ matchId: "match_test", getCurrentTick: () => 5 });
    gateway.submit(createEnvelope());

    expect(gateway.submit(createEnvelope({ clientRequestId: "request_2", sequence: 2 }))).toMatchObject({
      accepted: false,
      code: "duplicate_command_id",
    });
  });

  it("accepts multiple same-tick envelopes without an artificial command quota", () => {
    const gateway = new CommandGateway({ matchId: "match_test", getCurrentTick: () => 5 });
    const commands = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}_${index}`,
      type: "hold",
      playerId: "player_1" as const,
      unitId: "unit_1",
    }));
    expect(gateway.submit(createEnvelope({ commands: commands("first", 2) }))).toMatchObject({ accepted: true });
    expect(gateway.submit(createEnvelope({
      sequence: 2,
      clientRequestId: "request_2",
      commands: commands("second", 2),
    }))).toMatchObject({ accepted: true });
    expect(gateway.submit(createEnvelope({
      actorId: "player_2",
      sequence: 1,
      clientRequestId: "request_player_2",
      commands: commands("other", 2).map((command) => ({ ...command, playerId: "player_2" as const })),
    }))).toMatchObject({ accepted: true });
  });

  it("stores an immutable copy and rejects missed or excessively future ticks", () => {
    let tick = 5;
    const gateway = new CommandGateway({ matchId: "match_test", getCurrentTick: () => tick, maxFutureTicks: 2 });
    const envelope = createEnvelope();
    expect(gateway.submit(envelope)).toMatchObject({ accepted: true });
    envelope.commands[0].type = "move";
    expect(gateway.takeForTick(6)[0].commands[0].type).toBe("hold");

    tick = 6;
    expect(gateway.submit(createEnvelope({ clientRequestId: "late", applyAtTick: 6 }))).toMatchObject({
      accepted: false,
      code: "invalid_tick",
    });
    expect(gateway.submit(createEnvelope({ clientRequestId: "future", baseTick: 6, applyAtTick: 9 }))).toMatchObject({
      accepted: false,
      code: "invalid_tick",
    });
  });
});
