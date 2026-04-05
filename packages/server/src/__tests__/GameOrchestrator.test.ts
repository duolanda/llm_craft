import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameOrchestrator } from "../GameOrchestrator";

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
    const runAISpy = vi.spyOn(orchestrator, "runAI").mockResolvedValue();

    await orchestrator.start();
    await orchestrator.start();

    vi.advanceTimersByTime(350);
    await vi.runOnlyPendingTimersAsync();

    expect(runAISpy).toHaveBeenCalledTimes(2);

    orchestrator.stop();
  });

  it("should stop scheduling polls after stop is called", async () => {
    const orchestrator = new GameOrchestrator({ apiKey: "test-key", model: "test-model" });
    const runAISpy = vi.spyOn(orchestrator, "runAI").mockResolvedValue();

    await orchestrator.start();

    vi.advanceTimersByTime(150);
    await vi.runOnlyPendingTimersAsync();
    const callCountBeforeStop = runAISpy.mock.calls.length;

    orchestrator.stop();

    vi.advanceTimersByTime(500);
    await vi.runOnlyPendingTimersAsync();

    expect(runAISpy.mock.calls.length).toBe(callCountBeforeStop);
  });
});
