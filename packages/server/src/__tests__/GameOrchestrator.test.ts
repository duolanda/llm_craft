import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameOrchestrator } from "../GameOrchestrator";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("GameOrchestrator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should not start multiple polling loops when start is called twice", async () => {
    const orchestrator = new GameOrchestrator({ apiKey: "test-key", model: "test-model" });
    const gameStartSpy = vi.spyOn(orchestrator.getGame(), "start");

    await orchestrator.start();
    await orchestrator.start();

    vi.advanceTimersByTime(350);
    await vi.runOnlyPendingTimersAsync();

    expect(gameStartSpy).toHaveBeenCalledTimes(1);

    orchestrator.stop();
  });

  it("should stop scheduling polls after stop is called", async () => {
    const orchestrator = new GameOrchestrator({ apiKey: "test-key", model: "test-model" });
    const player1GenerateCode = vi.fn(async () => ({ code: "", requestMessages: [] as [] }));
    const player2GenerateCode = vi.fn(async () => ({ code: "", requestMessages: [] as [] }));

    (orchestrator as any).llm1 = {
      shouldForceFullState: () => false,
      generateCode: player1GenerateCode,
      getModel: () => "test-model",
      getBaseURL: () => undefined,
    };
    (orchestrator as any).llm2 = {
      shouldForceFullState: () => false,
      generateCode: player2GenerateCode,
      getModel: () => "test-model",
      getBaseURL: () => undefined,
    };
    (orchestrator as any).ai1 = {
      executeCode: vi.fn(async () => ({ commands: [], errorMessage: undefined })),
    };
    (orchestrator as any).ai2 = {
      executeCode: vi.fn(async () => ({ commands: [], errorMessage: undefined })),
    };

    await orchestrator.start();

    vi.advanceTimersByTime(150);
    await vi.runOnlyPendingTimersAsync();
    const callCountBeforeStop = player1GenerateCode.mock.calls.length + player2GenerateCode.mock.calls.length;

    orchestrator.stop();

    vi.advanceTimersByTime(500);
    await vi.runOnlyPendingTimersAsync();

    expect(player1GenerateCode.mock.calls.length + player2GenerateCode.mock.calls.length).toBe(callCountBeforeStop);
  });

  it("saveRecord preserves the true initial snapshot after long runs", async () => {
    const orchestrator = new GameOrchestrator({ apiKey: "test-key", model: "test-model" });
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

  it("dispatches the next AI turn immediately after a slow request finishes once the interval is already satisfied", async () => {
    const orchestrator = new GameOrchestrator({ apiKey: "test-key", model: "test-model" });
    const player1Deferred = createDeferred<{ code: string; requestMessages: [] }>();
    const player1GenerateCode = vi.fn(() => player1Deferred.promise);
    const player2GenerateCode = vi.fn(async () => ({ code: "", requestMessages: [] as [] }));

    (orchestrator as any).llm1 = {
      shouldForceFullState: () => false,
      generateCode: player1GenerateCode,
      getModel: () => "test-model",
      getBaseURL: () => undefined,
    };
    (orchestrator as any).llm2 = {
      shouldForceFullState: () => false,
      generateCode: player2GenerateCode,
      getModel: () => "test-model",
      getBaseURL: () => undefined,
    };
    (orchestrator as any).ai1 = {
      executeCode: vi.fn(async () => ({ commands: [], errorMessage: undefined })),
    };
    (orchestrator as any).ai2 = {
      executeCode: vi.fn(async () => ({ commands: [], errorMessage: undefined })),
    };

    await orchestrator.start();

    expect(player1GenerateCode).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3100);
    expect(player1GenerateCode).toHaveBeenCalledTimes(1);

    player1Deferred.resolve({ code: "", requestMessages: [] });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(150);

    expect(player1GenerateCode).toHaveBeenCalledTimes(2);
    expect(player1GenerateCode.mock.calls[1][0].tick).toBeGreaterThanOrEqual(5);

    orchestrator.stop();
  });

  it("executes generated code against the latest state snapshot after a slow LLM response", async () => {
    const orchestrator = new GameOrchestrator({ apiKey: "test-key", model: "test-model" });
    const player1Deferred = createDeferred<{ code: string; requestMessages: [] }>();
    const player1GenerateCode = vi.fn(() => player1Deferred.promise);
    const player2GenerateCode = vi.fn(async () => ({ code: "", requestMessages: [] as [] }));
    const player1ExecuteCode = vi.fn(async () => ({ commands: [], errorMessage: undefined }));

    (orchestrator as any).llm1 = {
      shouldForceFullState: () => false,
      generateCode: player1GenerateCode,
      getModel: () => "test-model",
      getBaseURL: () => undefined,
    };
    (orchestrator as any).llm2 = {
      shouldForceFullState: () => false,
      generateCode: player2GenerateCode,
      getModel: () => "test-model",
      getBaseURL: () => undefined,
    };
    (orchestrator as any).ai1 = {
      executeCode: player1ExecuteCode,
    };
    (orchestrator as any).ai2 = {
      executeCode: vi.fn(async () => ({ commands: [], errorMessage: undefined })),
    };

    await orchestrator.start();

    expect(player1GenerateCode).toHaveBeenCalledTimes(1);
    const requestTick = player1GenerateCode.mock.calls[0][0].tick;

    await vi.advanceTimersByTimeAsync(3100);
    player1Deferred.resolve({ code: "", requestMessages: [] });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    expect(player1ExecuteCode).toHaveBeenCalledTimes(1);
    const executionPackage = player1ExecuteCode.mock.calls[0][1];
    expect(executionPackage.tick).toBeGreaterThan(requestTick);

    const savedTurns = (orchestrator as any).buildSavedAITurns();
    const savedTurn = savedTurns.find((turn: { playerId: string }) => turn.playerId === "player_1");
    expect(savedTurn?.requestTick).toBe(requestTick);
    expect(savedTurn?.executeTick).toBe(executionPackage.tick);
    orchestrator.stop();
  });

  it("forces a full payload when the provider requests a fresh baseline", async () => {
    const orchestrator = new GameOrchestrator({ apiKey: "test-key", model: "test-model" });
    const player1GenerateCode = vi.fn(async () => ({ code: "", requestMessages: [] as [] }));
    const player2GenerateCode = vi.fn(async () => ({ code: "", requestMessages: [] as [] }));

    (orchestrator as any).llm1 = {
      shouldForceFullState: () => true,
      generateCode: player1GenerateCode,
      getModel: () => "test-model",
      getBaseURL: () => undefined,
    };
    (orchestrator as any).llm2 = {
      shouldForceFullState: () => false,
      generateCode: player2GenerateCode,
      getModel: () => "test-model",
      getBaseURL: () => undefined,
    };
    (orchestrator as any).ai1 = {
      executeCode: vi.fn(async () => ({ commands: [], errorMessage: undefined })),
    };
    (orchestrator as any).ai2 = {
      executeCode: vi.fn(async () => ({ commands: [], errorMessage: undefined })),
    };

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(150);

    expect(player1GenerateCode).toHaveBeenCalled();
    expect(player1GenerateCode.mock.calls[0][0].mode).toBe("full");

    orchestrator.stop();
  });
});

