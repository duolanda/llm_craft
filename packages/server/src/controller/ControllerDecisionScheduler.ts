import { PLAYER_IDS, type PlayerId } from "@llmcraft/shared";

export interface ControllerDecisionSchedulerOptions {
  intervalTicksByPlayer: Record<PlayerId, number>;
}

/**
 * Allocates macro decision starts in simulation time.
 *
 * Each controller owns its own interval and in-flight guard. Outer turn counts
 * are not a fairness primitive because one tool-calling turn may remain active
 * for many simulation ticks while another converges quickly.
 */
export class ControllerDecisionScheduler {
  private nextEligibleTick: Record<PlayerId, number> = {
    player_1: 0,
    player_2: 0,
  };

  constructor(private readonly options: ControllerDecisionSchedulerOptions) {
    for (const interval of Object.values(options.intervalTicksByPlayer)) {
      if (!Number.isSafeInteger(interval) || interval <= 0) {
        throw new Error("Controller decision intervals must be positive integers.");
      }
    }
  }

  reset(startTick = 0): void {
    this.nextEligibleTick = {
      player_1: startTick,
      player_2: startTick,
    };
  }

  select(
    simulationTick: number,
    running: Readonly<Record<PlayerId, boolean>>,
  ): PlayerId[] {
    return this.selectIndependent(simulationTick, running);
  }

  private selectIndependent(
    simulationTick: number,
    running: Readonly<Record<PlayerId, boolean>>,
  ): PlayerId[] {
    const selected: PlayerId[] = [];
    for (const playerId of [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2]) {
      if (running[playerId] || simulationTick < this.nextEligibleTick[playerId]) {
        continue;
      }
      this.nextEligibleTick[playerId] = simulationTick + this.options.intervalTicksByPlayer[playerId];
      selected.push(playerId);
    }
    return selected;
  }
}
