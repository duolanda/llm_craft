import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput } from "@llmcraft/shared";
import { TICK_INTERVAL_MS } from "@llmcraft/shared";
import { GameOrchestrator } from "../GameOrchestrator";
import { readMatchRecordFile } from "../RecordFile";

function createMatchConfig() {
  return {
    player1: {
      providerType: "openai-compatible" as const,
      apiKey: "test-key-1",
      baseURL: "https://api.one.test/v1",
      model: "model-one",
    },
    player2: {
      providerType: "openai-compatible" as const,
      apiKey: "test-key-2",
      baseURL: "https://api.two.test/v1",
      model: "model-two",
    },
  };
}

function createRunResult(stopReason = "model_stopped") {
  return {
    assistantMessages: ["thinking"],
    toolCalls: [],
    plans: [],
    commands: [],
    stopReason,
    metrics: {
      modelRequests: 1,
      toolCalls: 0,
      stallDetected: stopReason === "stall_detected",
    },
  };
}

describe("GameOrchestrator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps provider details behind one controller per player", () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());

    expect((orchestrator as any).controllerByPlayer.player_1.getDescriptor()).toMatchObject({
      kind: "llm",
      playerId: "player_1",
      model: "model-one",
      baseURL: "https://api.one.test/v1",
    });
    expect((orchestrator as any).controllerByPlayer.player_2.getDescriptor()).toMatchObject({
      kind: "llm",
      playerId: "player_2",
      model: "model-two",
      baseURL: "https://api.two.test/v1",
    });
  });

  it("starts once and schedules decisions from committed ticks, not a 100ms poll", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const gameStartSpy = vi.spyOn(orchestrator.getGame(), "start");
    const run1 = vi.fn(async (_input: AgentRunInput) => createRunResult());
    const run2 = vi.fn(async (_input: AgentRunInput) => createRunResult());
    (orchestrator as any).controllerByPlayer.player_1.run = run1;
    (orchestrator as any).controllerByPlayer.player_2.run = run2;

    await orchestrator.start();
    await orchestrator.start();
    expect(run1).toHaveBeenCalledTimes(1);
    expect(run2).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(400);
    expect(run1).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(run1).toHaveBeenCalledTimes(2);
    expect(run2).toHaveBeenCalledTimes(2);
    expect(gameStartSpy).toHaveBeenCalledTimes(1);
    orchestrator.stop();
  });

  it("keeps LLM decisions committed-tick driven while throttling the CPU to 10 ticks", async () => {
    const orchestrator = new GameOrchestrator({
      player1: createMatchConfig().player1,
      player2: { providerType: "builtin-cpu", strategy: "rush" },
    });
    const llmRun = vi.fn(async (_input: AgentRunInput) => createRunResult());
    const cpuRun = vi.fn(async (_input: AgentRunInput) => createRunResult("cpu_turn_complete"));
    (orchestrator as any).controllerByPlayer.player_1.run = llmRun;
    (orchestrator as any).controllerByPlayer.player_2.run = cpuRun;

    await orchestrator.start();
    expect(llmRun.mock.calls.map(([input]) => input.tick)).toEqual([0]);
    expect(cpuRun.mock.calls.map(([input]) => input.tick)).toEqual([0]);

    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 9);
    expect(llmRun).toHaveBeenCalledTimes(10);
    expect(cpuRun.mock.calls.map(([input]) => input.tick)).toEqual([0]);

    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
    expect(llmRun).toHaveBeenCalledTimes(11);
    expect(cpuRun.mock.calls.map(([input]) => input.tick)).toEqual([0, 10]);
    orchestrator.stop();
  });

  it("starts the clock while initial decisions are still running", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    let releaseBlue: (() => void) | undefined;
    const blueReady = new Promise<void>((resolve) => { releaseBlue = resolve; });
    (orchestrator as any).controllerByPlayer.player_1.run = vi.fn(async () => createRunResult());
    (orchestrator as any).controllerByPlayer.player_2.run = vi.fn(async () => {
      await blueReady;
      return createRunResult();
    });

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 4);
    expect(orchestrator.getGame().getTick()).toBe(4);
    expect(orchestrator.getGame().isGameRunning()).toBe(true);

    releaseBlue?.();
    await Promise.resolve();
    orchestrator.stop();
  });

  it("lets the fast side take later tick opportunities while the slow side is still running", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    let resolveSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => { resolveSlow = resolve; });
    const fastRun = vi.fn(async () => createRunResult());
    let slowRunCount = 0;
    const slowRun = vi.fn(async () => {
      slowRunCount += 1;
      if (slowRunCount === 1) return createRunResult();
      await slow;
      return createRunResult();
    });
    (orchestrator as any).controllerByPlayer.player_1.run = fastRun;
    (orchestrator as any).controllerByPlayer.player_2.run = slowRun;

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 3);

    expect(fastRun.mock.calls.length).toBeGreaterThan(1);
    expect(slowRun).toHaveBeenCalledTimes(2);
    resolveSlow?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
    expect(slowRun.mock.calls.length).toBeGreaterThan(2);
    orchestrator.stop();
  });

  it("backs off one repeatedly failing LLM without blocking the other side or the match clock", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const failingRun = vi.fn(async () => {
      throw new Error("Connection error");
    });
    const healthyRun = vi.fn(async () => createRunResult());
    (orchestrator as any).controllerByPlayer.player_1.run = failingRun;
    (orchestrator as any).controllerByPlayer.player_2.run = healthyRun;

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 8);

    expect(orchestrator.getGame().getTick()).toBe(8);
    expect(healthyRun).toHaveBeenCalledTimes(9);
    expect(failingRun.mock.calls.length).toBeLessThanOrEqual(4);
    expect(failingRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    orchestrator.stop();
  });

  it("warms up a selected first model request before starting the game clock", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const gameStartSpy = vi.spyOn(orchestrator.getGame(), "start");
    const warmup = vi.fn(async () => {
      expect(gameStartSpy).not.toHaveBeenCalled();
      return {
        assistantMessages: ["thinking"],
        stopReason: "tool_calls",
        hasPendingToolCalls: true,
        metrics: { modelRequests: 1 },
      };
    });
    (orchestrator as any).controllerByPlayer.player_1.warmup = warmup;
    (orchestrator as any).controllerByPlayer.player_1.run = vi.fn(async () => createRunResult());
    (orchestrator as any).controllerByPlayer.player_2.run = vi.fn(async () => createRunResult());

    await orchestrator.warmup({ player_1: true });
    expect(orchestrator.getGame().isGameRunning()).toBe(false);
    await orchestrator.start();

    expect(warmup).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: "player_1", tick: 0 }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(gameStartSpy).toHaveBeenCalledTimes(1);
    orchestrator.stop();
  });

  it("keeps only the bounded terminal UI feed in memory", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    for (let requestNumber = 1; requestNumber <= 600; requestNumber += 1) {
      (orchestrator as any).appendTerminalRequestEvent("player_1", requestNumber, requestNumber);
    }

    expect(orchestrator.getAITerminalFeed().events).toHaveLength(500);
    expect(orchestrator.getAITerminalFeed().events[0]?.id).toBe("evt_101");
    const oldestAvailable = await orchestrator.getTerminalHistory(201, 200);
    expect(oldestAvailable.events[0]?.id).toBe("evt_101");
    expect(oldestAvailable.events.at(-1)?.id).toBe("evt_200");
  });

  it("writes one lossless zstd Match Record and reuses it for repeated terminal saves", async () => {
    const recordDir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-record-"));
    const orchestrator = new GameOrchestrator({
      ...createMatchConfig(),
      runtime: { recordDir },
    });
    const runtime = orchestrator.getMatchRuntime();
    runtime.start();
    for (let index = 0; index < 5; index += 1) runtime.advanceOneTick();
    runtime.stop();

    const [firstPath, concurrentPath] = await Promise.all([
      orchestrator.saveRecord(),
      orchestrator.saveRecord(),
    ]);
    const secondPath = await orchestrator.saveRecord();
    const record = await readMatchRecordFile(firstPath);
    const compressed = await fs.readFile(firstPath);
    const json = Buffer.from(JSON.stringify(record));

    expect(firstPath).toMatch(/\.match\.zst$/);
    expect(zstdDecompressSync(compressed)).toEqual(json);
    expect(compressed.length).toBeLessThan(json.length);
    expect(record.initialState).toEqual(runtime.getGame().getInitialSnapshot()?.state);
    expect(record.finalState).toEqual(runtime.getGame().getState());
    expect(record.tickDeltas).toEqual(await runtime.getGame().getTickDeltasAsync());
    expect(firstPath).toBe(concurrentPath);
    expect(secondPath).toBe(firstPath);
    expect(await fs.readdir(recordDir)).toHaveLength(1);
    expect(record).toMatchObject({
      recordFormat: "match-record",
      initialState: { tick: 0 },
      finalState: { tick: 5 },
      metadata: { recordingProfile: "evaluation", includeTranscript: false },
    });
    expect(record.tickDeltas).toHaveLength(5);
    await fs.rm(recordDir, { recursive: true, force: true });
  });

  it("records full assistant output only when transcript is enabled", async () => {
    const recordDir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-record-"));
    const orchestrator = new GameOrchestrator({
      ...createMatchConfig(),
      debug: { recordingProfile: "evaluation", includeTranscript: true },
      runtime: { recordDir },
    });
    (orchestrator as any).controllerByPlayer.player_1.run = vi.fn(async () => createRunResult());

    await orchestrator.runAI("player_1");
    orchestrator.getMatchRuntime().start();
    orchestrator.getMatchRuntime().stop();
    const record = await readMatchRecordFile(await orchestrator.saveRecord());

    expect(record.aiTurns).toHaveLength(1);
    expect(record.aiTurns?.[0]?.assistantMessages).toEqual(["thinking"]);
    expect(record.metadata.systemPrompt).toContain("player_1");
    await fs.rm(recordDir, { recursive: true, force: true });
  });

  it("aborts an active controller run when stopped", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    let capturedSignal: AbortSignal | undefined;
    let signalReadyResolve: (() => void) | undefined;
    const signalReady = new Promise<void>((resolve) => { signalReadyResolve = resolve; });
    (orchestrator as any).controllerByPlayer.player_1.run = vi.fn(
      async (_input: AgentRunInput, _callbacks?: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        signalReadyResolve?.();
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return createRunResult("aborted");
      },
    );

    const run = orchestrator.runAI("player_1");
    await signalReady;
    orchestrator.stop();
    await run;

    expect(capturedSignal?.aborted).toBe(true);
  });
});
