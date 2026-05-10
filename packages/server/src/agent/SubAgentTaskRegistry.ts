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
}

export class SubAgentTaskRegistry {
  private taskCounter = 0;
  private activeTasks = new Map<string, ActiveTask>();
  private notificationQueues: PendingNotification[] = [];

  spawn(input: SpawnAgentInput, playerId: PlayerId, runner: SubAgentRunner): SpawnAgentResult {
    const taskId = `subtask_${++this.taskCounter}`;
    const controller = new AbortController();
    const task: ActiveTask = {
      taskId,
      playerId,
      description: input.description,
      controller,
    };
    this.activeTasks.set(taskId, task);

    runner(taskId, input, controller.signal)
      .then((notification) => {
        if (this.activeTasks.has(taskId)) {
          this.notificationQueues.push({ playerId, content: notification });
          this.activeTasks.delete(taskId);
        }
      })
      .catch(() => {
        this.activeTasks.delete(taskId);
      });

    return {
      ok: true,
      taskId,
      status: "running",
      description: input.description,
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
        this.activeTasks.delete(taskId);
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
}