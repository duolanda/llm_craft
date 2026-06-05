import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunInput, Command, DEFAULT_MAP_LAYOUT, MAP_WIDTH, TICK_INTERVAL_MS } from "@llmcraft/shared";
import { GameOrchestrator } from "../GameOrchestrator";

function createMatchConfig() {
  return {
    player1: {
      providerType: "openai-compatible" as const,
      apiKey: "test-key-1",
      baseURL: "https://api.one.test/v1",
      model: "test-model",
    },
    player2: {
      providerType: "openai-compatible" as const,
      apiKey: "test-key-2",
      baseURL: "https://api.two.test/v1",
      model: "test-model",
    },
  };
}

function createRunResult(overrides?: {
  commands?: Command[];
  stopReason?: string;
}) {
  return {
    assistantMessages: ["thinking"],
    toolCalls: [],
    plans: [],
    commands: overrides?.commands ?? [],
    stopReason: overrides?.stopReason ?? "model_stopped",
    metrics: {
      modelRequests: 1,
      toolCalls: 0,
      stallDetected: overrides?.stopReason === "stall_detected",
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

  it("uses different provider configs for player 1 and player 2", () => {
    const orchestrator = new GameOrchestrator({
      player1: {
        providerType: "openai-compatible",
        apiKey: "key-1",
        baseURL: "https://api.one.test/v1",
        model: "model-one",
      },
      player2: {
        providerType: "openai-compatible",
        apiKey: "key-2",
        baseURL: "https://api.two.test/v1",
        model: "model-two",
      },
    });

    expect((orchestrator as any).llm1.getModel()).toBe("model-one");
    expect((orchestrator as any).llm2.getModel()).toBe("model-two");
    expect((orchestrator as any).llm1.getBaseURL()).toBe("https://api.one.test/v1");
    expect((orchestrator as any).llm2.getBaseURL()).toBe("https://api.two.test/v1");
  });

  it("does not start multiple polling loops when start is called twice", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const gameStartSpy = vi.spyOn(orchestrator.getGame(), "start");
    const runSpy = vi.fn(async (_input: AgentRunInput) => createRunResult());
    (orchestrator as any).runtimeByPlayer.player_1.run = runSpy;
    (orchestrator as any).runtimeByPlayer.player_2.run = runSpy;

    await orchestrator.start();
    await orchestrator.start();

    vi.advanceTimersByTime(350);
    await vi.runOnlyPendingTimersAsync();

    expect(gameStartSpy).toHaveBeenCalledTimes(1);
    orchestrator.stop();
  });

  it("prepares selected first turns before the game clock starts", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const gameStartSpy = vi.spyOn(orchestrator.getGame(), "start");
    const warmupSpy = vi.fn(async () => {
      expect(gameStartSpy).not.toHaveBeenCalled();
      return {
        assistantMessages: ["thinking"],
        stopReason: "tool_calls",
        hasPendingToolCalls: true,
        metrics: { modelRequests: 1 },
      };
    });
    const runSpy = vi.fn(async (_input: AgentRunInput) => createRunResult());
    (orchestrator as any).runtimeByPlayer.player_1.warmup = warmupSpy;
    (orchestrator as any).runtimeByPlayer.player_1.run = runSpy;
    (orchestrator as any).runtimeByPlayer.player_2.run = runSpy;

    await orchestrator.prepare({ player_1: true });
    await orchestrator.start();

    expect(warmupSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: "player_1",
        tick: 0,
        summary: expect.stringContaining("tick=0"),
      }),
      expect.objectContaining({
        onAssistantMessage: expect.any(Function),
      }),
      expect.any(AbortSignal)
    );
    expect(gameStartSpy).toHaveBeenCalledTimes(1);
    expect(orchestrator.getGame().getState().tick).toBe(0);
    orchestrator.stop();
  });

  it("stops scheduling runs after stop is called", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const run1 = vi.fn(async (_input: AgentRunInput) => createRunResult());
    const run2 = vi.fn(async (_input: AgentRunInput) => createRunResult());
    (orchestrator as any).runtimeByPlayer.player_1.run = run1;
    (orchestrator as any).runtimeByPlayer.player_2.run = run2;

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(150);
    const callCountBeforeStop = run1.mock.calls.length + run2.mock.calls.length;

    orchestrator.stop();
    await vi.advanceTimersByTimeAsync(1000);

    expect(run1.mock.calls.length + run2.mock.calls.length).toBe(callCountBeforeStop);
  });

  it("saveRecord preserves the true initial snapshot after long runs", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const game = orchestrator.getGame();

    game.start();
    for (let i = 0; i < 1001; i++) {
      game.tickUpdate();
    }
    game.stop();

    const recordPath = await orchestrator.saveRecord();
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));

    expect(record.initialState.tick).toBe(0);
    expect(record.finalState.tick).toBe(1001);
    expect(record.tickDeltas.length).toBe(1001);

    await fs.unlink(recordPath);
  });

  it("saveRecord reuses the same file for unchanged finished state", async () => {
    const recordDir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-record-"));
    const orchestrator = new GameOrchestrator({
      ...createMatchConfig(),
      runtime: {
        recordDir,
      },
    });
    const game = orchestrator.getGame();

    game.start();
    for (let i = 0; i < 5; i++) {
      game.tickUpdate();
    }
    game.stop();

    const firstPath = await orchestrator.saveRecord();
    const secondPath = await orchestrator.saveRecord();
    const files = await fs.readdir(recordDir);

    expect(secondPath).toBe(firstPath);
    expect(files).toHaveLength(1);

    await fs.rm(recordDir, { recursive: true, force: true });
  });

  it("records tool-runtime results in ai turn records", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    (orchestrator as any).isPolling = true;
    (orchestrator as any).runtimeByPlayer.player_1.run = vi.fn(async (input: AgentRunInput) =>
      createRunResult({
        commands: [
          {
            id: "cmd_1",
            type: "hold",
            unitId: "worker-1",
            playerId: "player_1",
          },
        ],
        stopReason: "stall_detected",
      })
    );

    await orchestrator.runAI("player_1");

    const turns = (orchestrator as any).aiTurns;
    expect(turns).toHaveLength(1);
    expect(turns[0].runInput.tick).toBe(0);
    expect(turns[0].stopReason).toBe("stall_detected");
    expect(turns[0].metrics.stallDetected).toBe(true);
    expect(turns[0].commands).toHaveLength(1);
    expect(orchestrator.getGame().getAIFeedback("player_1")[0]?.message).toContain("read-only tool use");
  });

  it("does not re-queue commands returned by the runtime after the run completes", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const queueSpy = vi.spyOn(orchestrator.getGame(), "queueCommand");
    (orchestrator as any).isPolling = true;
    (orchestrator as any).runtimeByPlayer.player_1.run = vi.fn(async (_input: AgentRunInput) =>
      createRunResult({
        commands: [
          {
            id: "cmd_1",
            type: "hold",
            unitId: "worker-1",
            playerId: "player_1",
          },
        ],
      })
    );

    await orchestrator.runAI("player_1");

    expect(queueSpy).not.toHaveBeenCalled();
  });

  it("supports different AI intervals per player", async () => {
    const orchestrator = new GameOrchestrator({
      ...createMatchConfig(),
      runtime: {
        aiIntervalTicksByPlayer: {
          player_1: 2,
          player_2: 6,
        },
      },
    });
    const run1 = vi.fn(async (_input: AgentRunInput) => createRunResult());
    const run2 = vi.fn(async (_input: AgentRunInput) => createRunResult());
    (orchestrator as any).runtimeByPlayer.player_1.run = run1;
    (orchestrator as any).runtimeByPlayer.player_2.run = run2;

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 6 + 200);

    expect(run1.mock.calls.length).toBeGreaterThan(run2.mock.calls.length);
    orchestrator.stop();
  });

  it("prepends the HQ-under-attack alert to summary when enemy soldiers are already in range", () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const game = orchestrator.getGame();
    const enemySoldier = game
      .getUnitManager()
      .createUnit("soldier", DEFAULT_MAP_LAYOUT.player1Hq.x + 1, DEFAULT_MAP_LAYOUT.player1Hq.y, "player_2");
    enemySoldier.attackRange = 1;

    const runInput = (orchestrator as any).buildRunInput("player_1", game.getState()) as AgentRunInput;

    expect(runInput.summary.startsWith("Alert: our HQ is under attack.")).toBe(true);
  });

  it("aborts the active run when stop is called", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    (orchestrator as any).isPolling = true;
    let capturedSignal: AbortSignal | undefined;
    let resolveSignalReady: (() => void) | null = null;
    const signalReady = new Promise<void>((resolve) => {
      resolveSignalReady = resolve;
    });
    (orchestrator as any).runtimeByPlayer.player_1.run = vi.fn(
      async (_input: AgentRunInput, _callbacks?: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        resolveSignalReady?.();
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return createRunResult({ stopReason: "aborted" });
      }
    );

    const runPromise = orchestrator.runAI("player_1");
    await signalReady;
    orchestrator.stop();
    await runPromise;

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("writes a readable transcript file when per-match debug recording is enabled", async () => {
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const appendFileSpy = vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);
    const orchestrator = new GameOrchestrator({
      ...createMatchConfig(),
      debug: { recordLLMTranscript: true },
    });

    (orchestrator as any).isPolling = true;
    (orchestrator as any).runtimeByPlayer.player_1.run = vi.fn(async (_input: AgentRunInput, callbacks?: {
      onAssistantMessage?: (message: string) => void;
      onToolCall?: (record: { toolCallId: string; toolName: string; args: unknown; result: unknown; isError: boolean }) => void;
    }) => {
      callbacks?.onAssistantMessage?.("scouted map");
      callbacks?.onToolCall?.({
        toolCallId: "tool_1",
        toolName: "get_map_state",
        args: {},
        result: { width: MAP_WIDTH },
        isError: false,
      });
      return {
        ...createRunResult(),
        assistantMessages: ["scouted map"],
        toolCalls: [
          {
            toolCallId: "tool_1",
            toolName: "get_map_state",
            args: {},
            result: { width: MAP_WIDTH },
            isError: false,
          },
        ],
      };
    });

    await orchestrator.runAI("player_1");

    expect(mkdirSpy).toHaveBeenCalled();
    expect(appendFileSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    const transcript = appendFileSpy.mock.calls.map((call) => String(call[1])).join("");
    expect(transcript).toContain("(system)");
    expect(transcript).toContain("(user)");
    expect(transcript).toContain("player=player_1");
    expect(transcript).toContain("--- summary ---");
    expect(transcript).toContain("[assistant transcript=tx_1 player=player_1 requestTick=0]");
    expect(transcript).toContain("[tool_call transcript=tx_1 player=player_1 requestTick=0]");
    expect(transcript).toContain("[result transcript=tx_1 player=player_1 requestTick=0]");
    expect(transcript).toContain("get_map_state");
  });

  it("streams transcript entries before a stopped run is discarded", async () => {
    const appendFileSpy = vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as never);
    const orchestrator = new GameOrchestrator({
      ...createMatchConfig(),
      debug: { recordLLMTranscript: true },
    });

    (orchestrator as any).isPolling = true;
    (orchestrator as any).runtimeByPlayer.player_1.run = vi.fn(
      async (_input: AgentRunInput, callbacks?: {
        onAssistantMessage?: (message: string) => void;
        onToolCall?: (record: { toolCallId: string; toolName: string; args: unknown; result: unknown; isError: boolean }) => void;
      }) => {
        callbacks?.onAssistantMessage?.("opening move");
        callbacks?.onToolCall?.({
          toolCallId: "tool_2",
          toolName: "get_my_units",
          args: {},
          result: [{ id: "unit_1" }],
          isError: false,
        });
        orchestrator.stop();
        return {
          ...createRunResult(),
          assistantMessages: ["opening move"],
          toolCalls: [
            {
              toolCallId: "tool_2",
              toolName: "get_my_units",
              args: {},
              result: [{ id: "unit_1" }],
              isError: false,
            },
          ],
        };
      }
    );

    await orchestrator.runAI("player_1");

    const transcript = appendFileSpy.mock.calls.map((call) => String(call[1])).join("");
    expect(transcript).toContain("opening move");
    expect(transcript).toContain("get_my_units");
    expect(transcript).toContain("--- result ---");
    expect(transcript).toContain("[assistant transcript=tx_1 player=player_1 requestTick=0]");
    expect(transcript).toContain("[tool_call transcript=tx_1 player=player_1 requestTick=0]");
  });
});
