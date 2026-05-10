import { describe, expect, it, vi } from "vitest";
import { SubAgentTaskRegistry, SpawnAgentInput } from "../agent/SubAgentTaskRegistry";

function createInput(overrides?: Partial<SpawnAgentInput>): SpawnAgentInput {
  return {
    description: "test task",
    objective: "do something",
    assignedUnits: ["unit_1"],
    assignedBuildings: [],
    ...overrides,
  };
}

describe("SubAgentTaskRegistry", () => {
  it("spawn returns immediately with status running and a taskId", () => {
    const registry = new SubAgentTaskRegistry();
    const runner = vi.fn(async () => "completed");
    const result = registry.spawn(createInput(), "player_1", runner);

    expect(result).toEqual({
      ok: true,
      taskId: expect.any(String),
      status: "running",
      description: "test task",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.taskId).toMatch(/^subtask_\d+$/);
    }
  });

  it("runner receives taskId, input, and signal", async () => {
    const registry = new SubAgentTaskRegistry();
    const runner = vi.fn(async (_taskId: string, _input: SpawnAgentInput, _signal: AbortSignal) => "completed");
    const input = createInput({ description: "receive test" });

    registry.spawn(input, "player_1", runner);

    // Wait for microtask
    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalledTimes(1);
    });

    const [receivedTaskId, receivedInput, receivedSignal] = runner.mock.calls[0];
    expect(receivedTaskId).toMatch(/^subtask_\d+$/);
    expect(receivedInput.description).toBe("receive test");
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal.aborted).toBe(false);
  });

  it("drainNotifications returns completed results for a player", async () => {
    const registry = new SubAgentTaskRegistry();
    const runner = vi.fn(async () => "<sub-agent-result>done</sub-agent-result>");

    registry.spawn(createInput({ description: "task1" }), "player_1", runner);
    registry.spawn(createInput({ description: "task2" }), "player_2", runner);

    // Wait for both runners to complete
    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalledTimes(2);
    });

    // Small delay for promise resolution
    await new Promise((resolve) => setTimeout(resolve, 50));

    const p1Notifications = registry.drainNotifications("player_1");
    expect(p1Notifications.length).toBeGreaterThanOrEqual(1);

    const p2Notifications = registry.drainNotifications("player_2");
    expect(p2Notifications.length).toBeGreaterThanOrEqual(1);

    // Empty after drain
    expect(registry.drainNotifications("player_1")).toHaveLength(0);
  });

  it("abortPlayer aborts active tasks and clears notifications for a player", async () => {
    const registry = new SubAgentTaskRegistry();
    const abortSpy = vi.fn();
    const runner = vi.fn(async (_taskId: string, _input: SpawnAgentInput, signal: AbortSignal) => {
      signal.addEventListener("abort", () => abortSpy());
      // Never resolve - wait for abort
      await new Promise(() => {});
      return "should not reach";
    });

    registry.spawn(createInput(), "player_1", runner);

    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalledTimes(1);
    });

    registry.abortPlayer("player_1");
    expect(abortSpy).toHaveBeenCalled();
  });

  it("abortAll aborts all active tasks and clears all notifications", () => {
    const registry = new SubAgentTaskRegistry();
    const runner = vi.fn(async () => "done");

    registry.spawn(createInput(), "player_1", runner);
    registry.spawn(createInput(), "player_2", runner);

    registry.abortAll();
    expect(registry.drainNotifications("player_1")).toHaveLength(0);
    expect(registry.drainNotifications("player_2")).toHaveLength(0);
  });
});
