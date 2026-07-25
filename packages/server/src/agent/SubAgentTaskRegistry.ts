import { PlayerId } from "@llmcraft/shared";

export interface SpawnAgentInput {
  description: string;
  objective: string;
  assignedUnits?: string[];
  assignedBuildings?: string[];
  constraints?: string;
  successCriteria?: string;
}

export interface SpawnAgentStarted {
  ok: true;
  taskId: string;
  status: "running";
  description: string;
  controllerId: string;
}

export interface SpawnAgentFailedToStart {
  ok: false;
  error: string;
  hint?: string;
}

export type SpawnAgentResult = SpawnAgentStarted | SpawnAgentFailedToStart;

export type SubAgentRunner = (taskId: string, input: SpawnAgentInput, signal: AbortSignal) => Promise<string>;

interface PendingNotification {
  playerId: PlayerId;
  content: string;
}

interface ActiveTask {
  taskId: string;
  playerId: PlayerId;
  description: string;
  controller: AbortController;
  assignedUnits: string[];
  assignedBuildings: string[];
}

export class SubAgentTaskRegistry {
  private taskCounter = 0;
  private activeTasks = new Map<string, ActiveTask>();
  private notificationQueues: PendingNotification[] = [];

  constructor(private readonly maxConcurrentPerPlayer = 2) {}

  spawn(input: SpawnAgentInput, playerId: PlayerId, runner: SubAgentRunner): SpawnAgentResult {
    const assignedUnits = [...new Set(input.assignedUnits ?? [])];
    const assignedBuildings = [...new Set(input.assignedBuildings ?? [])];
    const activeForPlayer = [...this.activeTasks.values()].filter((task) => task.playerId === playerId);
    if (activeForPlayer.length >= this.maxConcurrentPerPlayer) {
      return {
        ok: false,
        error: "subagent_concurrency_limit",
        hint: `At most ${this.maxConcurrentPerPlayer} sub-agents may run concurrently for one player.`,
      };
    }
    const leasedUnits = new Set(activeForPlayer.flatMap((task) => task.assignedUnits));
    const leasedBuildings = new Set(activeForPlayer.flatMap((task) => task.assignedBuildings));
    const overlappingUnit = assignedUnits.find((unitId) => leasedUnits.has(unitId));
    const overlappingBuilding = assignedBuildings.find((buildingId) => leasedBuildings.has(buildingId));
    if (overlappingUnit || overlappingBuilding) {
      const resource = overlappingUnit ?? overlappingBuilding;
      return {
        ok: false,
        error: "resource_already_leased",
        hint: `${resource} is already leased by another active sub-agent.`,
      };
    }
    const taskId = `subtask_${++this.taskCounter}`;
    const controller = new AbortController();
    const task: ActiveTask = {
      taskId,
      playerId,
      description: input.description,
      controller,
      assignedUnits,
      assignedBuildings,
    };
    this.activeTasks.set(taskId, task);

    runner(taskId, input, controller.signal)
      .then((notification) => {
        if (this.activeTasks.has(taskId)) {
          this.notificationQueues.push({ playerId, content: notification });
          this.release(taskId);
        }
      })
      .catch((error) => {
        if (this.activeTasks.has(taskId)) {
          this.notificationQueues.push({
            playerId,
            content: this.formatFailureNotification(taskId, input, error),
          });
          this.release(taskId);
        }
      });

    return {
      ok: true,
      taskId,
      status: "running",
      description: input.description,
      controllerId: `subagent:${taskId}`,
    };
  }

  drainNotifications(playerId: PlayerId): string[] {
    const drained: string[] = [];
    this.notificationQueues = this.notificationQueues.filter((notification) => {
      if (notification.playerId === playerId) {
        drained.push(notification.content);
        return false;
      }
      return true;
    });
    return drained;
  }

  abortPlayer(playerId: PlayerId): void {
    this.activeTasks.forEach((task, taskId) => {
      if (task.playerId === playerId) {
        task.controller.abort();
        this.release(taskId);
      }
    });
    this.notificationQueues = this.notificationQueues.filter(
      (notification) => notification.playerId !== playerId
    );
  }

  abortAll(): void {
    this.activeTasks.forEach((task) => {
      task.controller.abort();
    });
    this.activeTasks.clear();
    this.notificationQueues = [];
  }

  private formatFailureNotification(taskId: string, input: SpawnAgentInput, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return [
      "<sub-agent-result>",
      `taskId: ${taskId}`,
      `description: ${input.description}`,
      "status: failed",
      `objective: ${input.objective}`,
      "result:",
      message,
      "</sub-agent-result>",
    ].join("\n");
  }

  private release(taskId: string): void {
    this.activeTasks.delete(taskId);
  }
}
