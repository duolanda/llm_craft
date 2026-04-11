import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIPromptPayload, AIStatePackage } from "@llmcraft/shared";
import { GameOrchestrator } from "../GameOrchestrator";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type GenerateCodeResult = {
  code: string;
  requestMessages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
};

function createEmptyGenerateCodeResult(): GenerateCodeResult {
  return { code: "", requestMessages: [] };
}

type ExecuteCodeResult = {
  commands: Array<Record<string, never>>;
  errorMessage: string | undefined;
};

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

  it("should not start multiple polling loops when start is called twice", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const gameStartSpy = vi.spyOn(orchestrator.getGame(), "start");
    (orchestrator as any).llm1 = {
      shouldForceFullState: () => false,
      generateCode: vi.fn<[AIPromptPayload], Promise<GenerateCodeResult>>(
        async () => createEmptyGenerateCodeResult()
      ),
      getModel: () => "test-model",
      getBaseURL: () => "https://api.one.test/v1",
    };
    (orchestrator as any).llm2 = {
      shouldForceFullState: () => false,
      generateCode: vi.fn<[AIPromptPayload], Promise<GenerateCodeResult>>(
        async () => createEmptyGenerateCodeResult()
      ),
      getModel: () => "test-model",
      getBaseURL: () => "https://api.two.test/v1",
    };
    (orchestrator as any).ai1 = {
      executeCode: vi.fn<[string, AIStatePackage], Promise<ExecuteCodeResult>>(async () => ({
        commands: [],
        errorMessage: undefined,
      })),
    };
    (orchestrator as any).ai2 = {
      executeCode: vi.fn<[string, AIStatePackage], Promise<ExecuteCodeResult>>(async () => ({
        commands: [],
        errorMessage: undefined,
      })),
    };

    await orchestrator.start();
    await orchestrator.start();

    vi.advanceTimersByTime(350);
    await vi.runOnlyPendingTimersAsync();

    expect(gameStartSpy).toHaveBeenCalledTimes(1);

    orchestrator.stop();
  });

  it("should stop scheduling polls after stop is called", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const player1GenerateCode = vi.fn<[AIPromptPayload], Promise<GenerateCodeResult>>(
      async () => createEmptyGenerateCodeResult()
    );
    const player2GenerateCode = vi.fn<[AIPromptPayload], Promise<GenerateCodeResult>>(
      async () => createEmptyGenerateCodeResult()
    );

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
      executeCode: vi.fn<[string, AIStatePackage], Promise<ExecuteCodeResult>>(async () => ({
        commands: [],
        errorMessage: undefined,
      })),
    };
    (orchestrator as any).ai2 = {
      executeCode: vi.fn<[string, AIStatePackage], Promise<ExecuteCodeResult>>(async () => ({
        commands: [],
        errorMessage: undefined,
      })),
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

  it("dispatches the next AI turn immediately after a slow request finishes once the interval is already satisfied", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const player1Deferred = createDeferred<GenerateCodeResult>();
    const player1GenerateCode = vi.fn<[AIPromptPayload], Promise<GenerateCodeResult>>(
      () => player1Deferred.promise
    );
    const player2GenerateCode = vi.fn<[AIPromptPayload], Promise<GenerateCodeResult>>(
      async () => createEmptyGenerateCodeResult()
    );

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

    player1Deferred.resolve(createEmptyGenerateCodeResult());
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(150);

    expect(player1GenerateCode).toHaveBeenCalledTimes(2);
    const secondCall = player1GenerateCode.mock.calls.at(1);
    if (!secondCall) {
      throw new Error("Expected second generateCode call");
    }
    expect(secondCall[0].tick).toBeGreaterThanOrEqual(5);

    orchestrator.stop();
  });

  it("executes generated code against the latest state snapshot after a slow LLM response", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const player1Deferred = createDeferred<GenerateCodeResult>();
    const player1GenerateCode = vi.fn<[AIPromptPayload], Promise<GenerateCodeResult>>(
      () => player1Deferred.promise
    );
    const player2GenerateCode = vi.fn<[AIPromptPayload], Promise<GenerateCodeResult>>(
      async () => createEmptyGenerateCodeResult()
    );
    const player1ExecuteCode = vi.fn<[string, AIStatePackage], Promise<ExecuteCodeResult>>(async () => ({
      commands: [],
      errorMessage: undefined,
    }));

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
      executeCode: vi.fn<[string, AIStatePackage], Promise<ExecuteCodeResult>>(async () => ({
        commands: [],
        errorMessage: undefined,
      })),
    };

    await orchestrator.start();

    expect(player1GenerateCode).toHaveBeenCalledTimes(1);
    const firstCall = player1GenerateCode.mock.calls.at(0);
    if (!firstCall) {
      throw new Error("Expected first generateCode call");
    }
    const requestTick = firstCall[0].tick;

    await vi.advanceTimersByTimeAsync(3100);
    player1Deferred.resolve(createEmptyGenerateCodeResult());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    expect(player1ExecuteCode).toHaveBeenCalledTimes(1);
    const executionCall = player1ExecuteCode.mock.calls.at(0);
    if (!executionCall) {
      throw new Error("Expected executeCode call");
    }
    const executionPackage = executionCall[1];
    if (!executionPackage) {
      throw new Error("Expected execution package");
    }
    expect(executionPackage.tick).toBeGreaterThan(requestTick);

    const savedTurns = (orchestrator as any).buildSavedAITurns();
    const savedTurn = savedTurns.find((turn: { playerId: string }) => turn.playerId === "player_1");
    expect(savedTurn?.requestTick).toBe(requestTick);
    expect(savedTurn?.executeTick).toBe(executionPackage.tick);
    orchestrator.stop();
  });

  it("forces a full payload when the provider requests a fresh baseline", async () => {
    const orchestrator = new GameOrchestrator(createMatchConfig());
    const player1GenerateCode = vi.fn<[AIPromptPayload], Promise<GenerateCodeResult>>(
      async () => createEmptyGenerateCodeResult()
    );
    const player2GenerateCode = vi.fn<[AIPromptPayload], Promise<GenerateCodeResult>>(
      async () => createEmptyGenerateCodeResult()
    );

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
      executeCode: vi.fn<[string, AIStatePackage], Promise<ExecuteCodeResult>>(async () => ({
        commands: [],
        errorMessage: undefined,
      })),
    };
    (orchestrator as any).ai2 = {
      executeCode: vi.fn<[string, AIStatePackage], Promise<ExecuteCodeResult>>(async () => ({
        commands: [],
        errorMessage: undefined,
      })),
    };

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(150);

    expect(player1GenerateCode).toHaveBeenCalled();
    const firstCall = player1GenerateCode.mock.calls.at(0);
    if (!firstCall) {
      throw new Error("Expected first generateCode call");
    }
    expect(firstCall[0].mode).toBe("full");

    orchestrator.stop();
  });
});

