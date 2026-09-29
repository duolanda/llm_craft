import { describe, expect, it, vi } from "vitest";
import { runSubAgentTask } from "../agent/SubAgentRunner";
import type { ModelCompletionResult } from "../model/ModelTransport";

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
            { id: "bad-selection", function: { name: "move_unit", arguments: JSON.stringify({ selection: "all_combat", x: 1, y: 1 }) } },
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
    const requests: Array<{ messages: unknown[]; tools?: Array<{ name: string; parameters: Record<string, unknown> }> }> = [];

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
        tools: [{
          name: "move_unit",
          description: "move",
          parameters: {
            type: "object",
            required: ["x", "y"],
            properties: {
              unitIds: { type: "array", items: { type: "string" } },
              selection: { type: "string", enum: ["all_combat"] },
              x: { type: "integer" },
              y: { type: "integer" },
            },
          },
        }],
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
    expect(requests[0].tools?.[0].parameters).toMatchObject({
      required: expect.arrayContaining(["unitIds", "x", "y"]),
    });
    expect(requests[0].tools?.[0].parameters.properties).not.toHaveProperty("selection");
  });

  it.each(["length", "max_tokens"])("rejects a %s-truncated batch with paired results and lets the child recover", async (finishReason) => {
    const executeTool = vi.fn(() => ({ effect: "action" as const, result: { ok: true } }));
    const responses: ModelCompletionResult[] = [{
      message: { role: "assistant", content: null, reasoning_content: "test reasoning", tool_calls: [
        { id: "call-1", function: { name: "move_unit", arguments: '{"unitId":"unit_1","x":1,"y":1}' } },
        { id: "call-2", function: { name: "move_unit", arguments: '{"unitId":' } },
      ] },
      finishReason, usage: {},
    }, { message: { role: "assistant", content: "done" }, finishReason: "stop", usage: {} }];
    const requests: unknown[][] = [];
    await runSubAgentTask({
      createCompletion: async (request) => { requests.push(structuredClone(request.messages)); return responses.shift()!; },
      taskId: "task-1", description: "test", objective: "test", assignedUnits: ["unit_1"],
      parentContext: {
        playerId: "player_1", input: { playerId: "player_1", tick: 0, tickIntervalMs: 500, summary: "test" },
        messages: [], tools: [], executeTool,
        runtimeState: { mapState: null, myState: null, myUnits: null, activePlans: null, recentEvents: null },
      },
      signal: new AbortController().signal,
    });
    expect(executeTool).not.toHaveBeenCalled();
    const toolResults = requests[1]!.filter((message): message is { role: "tool"; tool_call_id: string; content: string } => (
      typeof message === "object" && message !== null && "role" in message && message.role === "tool"
    ));
    expect(toolResults.map((message) => message.tool_call_id)).toEqual(["call-1", "call-2"]);
    expect(toolResults.map((message) => JSON.parse(message.content)))
      .toEqual([expect.objectContaining({ ok: false, error: "model_output_truncated" }), expect.objectContaining({ ok: false, error: "model_output_truncated" })]);
  });
});
