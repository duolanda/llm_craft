import { describe, expect, it } from "vitest";
import { ContextWindowLimiter } from "../agent/ContextWindowLimiter";

describe("ContextWindowLimiter", () => {
  it("drops complete older user segments instead of leaving orphan tool results", () => {
    const limiter = new ContextWindowLimiter({
      maxMessages: 5,
      maxBytes: 4096,
      maxMessageBytes: 512,
    });
    const history = [
      { role: "user", content: "old turn" },
      { role: "assistant", content: null, tool_calls: [{ id: "old-call", function: { name: "get_map_state", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "old-call", name: "get_map_state", content: "{}" },
      { role: "assistant", content: "old done" },
      { role: "user", content: "latest turn" },
      { role: "assistant", content: null, tool_calls: [{ id: "new-call", function: { name: "get_my_state", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "new-call", name: "get_my_state", content: "{}" },
      { role: "assistant", content: "latest done" },
    ];

    const result = limiter.limit(history);
    const limited = result.history as Array<Record<string, unknown>>;

    expect(limited).toHaveLength(5);
    expect(JSON.stringify(limited[0])).toContain("older_history_omitted");
    expect(limited.slice(1).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(JSON.stringify(limited)).toContain("new-call");
    expect(JSON.stringify(limited)).not.toContain("old-call");
    expect(result.record.droppedMessages).toBe(4);
  });

  it("replaces oversized tool observations with a structured tombstone", () => {
    const limiter = new ContextWindowLimiter({
      maxMessages: 10,
      maxBytes: 4096,
      maxMessageBytes: 512,
    });
    const result = limiter.limit([
      { role: "user", content: "read" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", function: { name: "get_map_state", arguments: "{}" } }] },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "get_map_state",
        content: JSON.stringify({ tick: 42, cells: "x".repeat(4000) }),
      },
      { role: "assistant", content: "done" },
    ]);
    const toolMessage = (result.history as Array<Record<string, unknown>>)[2]!;
    const tombstone = JSON.parse(String(toolMessage.content));

    expect(tombstone).toMatchObject({
      expired: true,
      reason: "context_window_oversize",
      observedTick: 42,
    });
    expect(result.record.truncatedMessages).toBe(1);
    expect(result.record.bytesAfter).toBeLessThanOrEqual(result.record.maxBytes);
  });

  it("keeps assistant tool-call declarations paired with limited tool results", () => {
    const limiter = new ContextWindowLimiter({
      maxMessages: 6,
      maxBytes: 4096,
      maxMessageBytes: 512,
    });
    const result = limiter.limit([
      { role: "user", content: "read" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-large",
          function: { name: "get_map_state", arguments: JSON.stringify({ query: "x".repeat(700) }) },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call-large",
        name: "get_map_state",
        content: JSON.stringify({ tick: 42, cells: "x".repeat(4000) }),
      },
    ]) as { history: Array<Record<string, unknown>> };

    expect(result.history[1]?.tool_calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "call-large" }),
    ]));
    expect(result.history[2]).toMatchObject({ role: "tool", tool_call_id: "call-large" });
  });

  it("reports explicit bounded history metrics", () => {
    const limiter = new ContextWindowLimiter({
      maxMessages: 4,
      maxBytes: 2048,
      maxMessageBytes: 256,
    });
    const result = limiter.limit(Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}-${"z".repeat(300)}`,
    })));

    expect(result.record).toMatchObject({
      maxMessages: 4,
      maxBytes: 2048,
      messagesBefore: 20,
    });
    expect(result.record.messagesAfter).toBeLessThanOrEqual(4);
    expect(result.record.bytesAfter).toBeLessThanOrEqual(2048);
    expect(result.record.droppedMessages).toBeGreaterThan(0);
    expect(result.record.truncatedMessages).toBeGreaterThan(0);
  });
});
