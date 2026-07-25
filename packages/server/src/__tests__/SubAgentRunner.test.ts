import { describe, expect, it, vi } from "vitest";
import { runSubAgentTask } from "../agent/SubAgentRunner";

describe("SubAgentRunner leases", () => {
  it("blocks unleased units and attributes leased commands to the child controller", async () => {
    const executeTool = vi.fn(async () => ({ effect: "action" as const, result: { ok: true } }));
    const responses = [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "bad", function: { name: "move_unit", arguments: JSON.stringify({ unitId: "unit_2", x: 1, y: 1 }) } },
            { id: "good", function: { name: "move_unit", arguments: JSON.stringify({ unitId: "unit_1", x: 2, y: 2 }) } },
          ],
        },
        finishReason: "tool_calls",
        usage: {},
      },
      {
        message: { role: "assistant", content: "done", tool_calls: [] },
        finishReason: "stop",
        usage: {},
      },
    ];
    const requests: Array<{ messages: unknown[] }> = [];

    await runSubAgentTask({
      createCompletion: async (request) => {
        requests.push(request);
        return responses.shift()!;
      },
      taskId: "task-1",
      description: "move leased unit",
      objective: "move",
      assignedUnits: ["unit_1"],
      parentContext: {
        playerId: "player_1",
        controllerId: "llm:player_1",
        turnId: "turn-1",
        input: { playerId: "player_1", tick: 1, tickIntervalMs: 500, summary: "test" },
        messages: [],
        runtimeState: { mapState: null, myState: null, myUnits: null, activePlans: null, recentEvents: null },
        tools: [{ name: "move_unit", description: "move", parameters: {} }],
        executeTool,
      },
      signal: new AbortController().signal,
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith("move_unit", { unitId: "unit_1", x: 2, y: 2 }, {
      toolCallId: "good",
      controllerId: "subagent:task-1",
      parentControllerId: "llm:player_1",
      turnId: "turn-1",
      source: "subagent",
    });
    expect(JSON.stringify(requests[1].messages)).toContain("resource_not_leased");
  });
});
