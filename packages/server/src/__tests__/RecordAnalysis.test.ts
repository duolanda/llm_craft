import { describe, expect, it } from "vitest";
import type { AgentModelRequestRecord, AgentToolCallRecord, MatchRecord } from "@llmcraft/shared";
import { analyzeMatchRecord } from "@llmcraft/record";
import { Game } from "../Game";
import { createDefaultMatchDefinition } from "../MatchDefinition";

describe("Match Record request analysis", () => {
  it("surfaces the historical 509-Connection-error storm instead of hiding it in aggregate latency", () => {
    const game = new Game();
    const state = game.getState();
    state.tick = 731;
    const successfulRequests: AgentModelRequestRecord[] = Array.from({ length: 17 }, (_, index) => ({
      requestIndex: index + 1,
      phase: "turn",
      finishReason: "tool_calls",
      latencyMs: 3_000 + index,
      messageCount: 4,
      toolCount: 12,
      inputTokens: 1_000,
      outputTokens: 120,
      reasoningTokens: 40,
      cachedInputTokens: 800,
      status: "success",
    }));
    const failedRequests: AgentModelRequestRecord[] = Array.from({ length: 509 }, (_, index) => ({
      requestIndex: successfulRequests.length + index + 1,
      phase: "turn",
      finishReason: "request_error",
      latencyMs: 70 + index % 20,
      messageCount: 12,
      toolCount: 12,
      status: "error",
      error: "Connection error",
    }));
    const tools: AgentToolCallRecord[] = Array.from({ length: 29 }, (_, index) => ({
      toolCallId: `tool-${index}`,
      toolName: "get_my_state",
      args: {},
      result: { ok: true },
      isError: false,
    }));
    const record: MatchRecord = {
      recordFormat: "match-record",
      matchId: "historical-509-error-shape",
      definition: createDefaultMatchDefinition(),
      metadata: {
        startedAt: "2026-08-03T00:00:00.000Z",
        savedAt: "2026-08-03T00:06:05.500Z",
        status: "stopped",
        winner: null,
        recordingProfile: "evaluation",
        includeTranscript: false,
        players: [
          { playerId: "player_1", model: "fixture" },
          { playerId: "player_2", model: "fixture" },
        ],
      },
      initialState: game.getState(),
      finalState: state,
      tickDeltas: [],
      commandResults: [],
      aiTurns: [{
        playerId: "player_2",
        requestTick: 0,
        executeTick: 731,
        runInput: { playerId: "player_2", tick: 0, tickIntervalMs: 500, summary: "fixture" },
        assistantMessages: [],
        toolCalls: tools,
        plans: [],
        commands: [],
        stopReason: "request_error",
        metrics: {
          modelRequests: 526,
          toolCalls: 29,
          stallDetected: false,
          modelRequestRecords: [...successfulRequests, ...failedRequests],
          contextWindow: {
            maxMessages: 80,
            maxBytes: 1_000_000,
            messagesBefore: 90,
            messagesAfter: 80,
            bytesBefore: 900_000,
            bytesAfter: 800_000,
            droppedMessages: 10,
            truncatedMessages: 2,
          },
        },
        model: "fixture",
        createdAt: "2026-08-03T00:00:00.000Z",
      }],
    };

    const report = analyzeMatchRecord(record) as ReturnType<typeof analyzeMatchRecord> & {
      agents?: Array<Record<string, any>>;
    };
    const player = report.agents?.find((entry) => entry.playerId === "player_2");

    expect(player).toMatchObject({
      playerId: "player_2",
      requestCount: 526,
      errorCount: 509,
      longestSameErrorStreak: { count: 509, error: "Connection error" },
      statusCounts: { success: 17, error: 509 },
      finishReasonCounts: { tool_calls: 17, request_error: 509 },
      toolCalls: 29,
      contextDroppedMessages: 10,
      contextTruncatedMessages: 2,
    });
    expect(report.findings).toContainEqual(expect.objectContaining({
      detectorId: "request_error_storm",
      scopeId: "player_2",
      value: 509,
    }));
  });
});
