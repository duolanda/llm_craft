import { describe, expect, it, vi } from "vitest";
import { BenchmarkOrchestrator } from "../benchmark/BenchmarkOrchestrator";

function createFakeRound(params: {
  winner: string | null;
  tick: number;
  recordPath?: string;
  transcriptPath?: string;
}) {
  const game = {
    getWinner: () => params.winner,
    getState: () => ({ tick: params.tick }),
    isGameRunning: () => false,
    getSnapshots: () => [],
  };

  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    saveRecord: vi.fn(async () => params.recordPath ?? `logs/records/round-${params.tick}.json`),
    getGame: vi.fn(() => game),
    getTranscriptFilePath: vi.fn(() => params.transcriptPath ?? null),
  };
}

describe("BenchmarkOrchestrator", () => {
  it("alternates LLM side and aggregates benchmark results by strategy", async () => {
    const ws = { send: vi.fn() };
    const rounds = [
      createFakeRound({ winner: "player_1", tick: 120, recordPath: "logs/records/round-1.json" }),
      createFakeRound({ winner: "player_2", tick: 140, recordPath: "logs/records/round-2.json", transcriptPath: "logs/llm-debug/round-2.log" }),
      createFakeRound({ winner: null, tick: 180, recordPath: "logs/records/round-3.json" }),
    ];
    const configs: Array<{ player1: { providerType: string }; player2: { providerType: string } }> = [];
    const orchestrator = new BenchmarkOrchestrator(
      {
        presetId: "preset-1",
        llmConfig: {
          providerType: "openai-compatible",
          apiKey: "token",
          baseURL: "https://api.example.test/v1",
          model: "gpt-4.1-mini",
        },
        cpuStrategy: "rush",
        rounds: 3,
        recordReplay: true,
        decisionIntervalTicks: 9,
      },
      ws as any,
      (config) => {
        configs.push(config as any);
        return rounds.shift() as any;
      }
    );

    await orchestrator.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sentMessages = ws.send.mock.calls.map((call) => JSON.parse(call[0]));
    const complete = sentMessages.find((message) => message.type === "benchmark_complete");

    expect(configs).toHaveLength(3);
    expect(configs[0]?.player1.providerType).toBe("openai-compatible");
    expect(configs[0]?.player2.providerType).toBe("builtin-cpu");
    expect(configs[1]?.player1.providerType).toBe("builtin-cpu");
    expect(configs[1]?.player2.providerType).toBe("openai-compatible");
    expect((configs[0] as any)?.runtime?.aiIntervalTicksByPlayer).toMatchObject({
      player_1: 5,
      player_2: 9,
    });
    expect((configs[1] as any)?.runtime?.aiIntervalTicksByPlayer).toMatchObject({
      player_1: 9,
      player_2: 5,
    });
    expect((configs[0] as any)?.runtime?.recordDir).toContain("benchmark-records");
    expect((configs[0] as any)?.runtime?.transcriptDir).toContain("benchmark-llm-debug");

    expect(complete).toMatchObject({
      cpuStrategy: "rush",
      totalRounds: 3,
      completedRounds: 3,
      llmWins: 2,
      cpuWins: 0,
      draws: 1,
      llmWinRate: 66.7,
      averageDurationTicks: 147,
      stopped: false,
    });
    expect(complete.rounds[1]).toMatchObject({
      round: 2,
      llmSide: "player_2",
      winner: "llm",
      transcriptPath: "logs/llm-debug/round-2.log",
    });
  });
});
