import {
  CPUStrategyType,
  GameState,
  PlayerId,
} from "@llmcraft/shared";
import { GameAgentBridge } from "./agent/GameAgentBridge";
import { Game } from "./Game";

function chebyshevDistance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function chooseRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

interface MyState {
  tick?: number;
  credits?: number;
  hq?: Record<string, unknown> | null;
  buildings?: Record<string, unknown>[];
  canBuildBarracks?: boolean;
  canSpawnWorker?: boolean;
  canSpawnSoldier?: boolean;
  [key: string]: unknown;
}

interface MyUnit {
  id: string;
  type: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: string;
  attackRange: number;
  intent?: Record<string, unknown>;
  relation?: string;
  [key: string]: unknown;
}

interface MapBuilding {
  id: string;
  type: string;
  x: number;
  y: number;
  relation?: string;
  hp?: number;
  [key: string]: unknown;
}

/**
 * CPU 玩家后台循环。
 *
 * 直接通过 GameAgentBridge 操作，无需 GameOrchestrator 或 LLM provider。
 * 每 5 tick 执行一次决策，逻辑与 BenchmarkCPUProvider.runAgent() 一致。
 */
export class CpuPlayer {
  private interval: NodeJS.Timeout | null = null;
  private nextActTick = 0;
  private strategy: CPUStrategyType;
  private game: Game;
  private bridge: GameAgentBridge;

  constructor(game: Game, playerId: PlayerId, strategy: CPUStrategyType) {
    this.game = game;
    this.strategy = strategy;
    this.bridge = new GameAgentBridge(game, playerId);
  }

  /** 启动 CPU 循环。每 200ms 检查一次，但只每 5 tick 行动一次。 */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), 200);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private tick(): void {
    const state = this.game.getState();
    if (!state) return;
    if (state.winner) {
      this.stop();
      return;
    }

    // 每 10 tick 执行一次（与 benchmark 默认一致）
    if (state.tick < this.nextActTick) return;
    this.nextActTick = state.tick + 10;

    try {
      this.runDecision(state);
    } catch (err) {
      console.error("CPU player error:", err);
    }
  }

  private runDecision(state: GameState): void {
    const myStateResult = this.bridge.getMyState();
    const myUnitsResult = this.bridge.getMyUnits();
    const mapResult = this.bridge.getMapState({ includeCells: false });

    const myState = myStateResult.result as MyState;
    const myUnitsPayload = myUnitsResult.result as { units?: MyUnit[] };
    const mapState = mapResult.result as {
      tick?: number;
      width?: number;
      height?: number;
      units?: MyUnit[];
      buildings?: MapBuilding[];
      cells?: Record<string, unknown>[];
      [key: string]: unknown;
    };

    const myUnits = myUnitsPayload?.units ?? [];
    const credits = typeof myState?.credits === "number" ? (myState.credits as number) : 0;
    const hq = (myState?.hq ?? null) as Record<string, unknown> | null;
    const buildings = Array.isArray(myState?.buildings) ? myState.buildings : [];
    const barracksBuildings = buildings.filter((b) => b.type === "barracks");
    const hasBarracks = barracksBuildings.length > 0;
    const workers = myUnits.filter((u) => u.type === "worker");
    const soldiers = myUnits.filter((u) => u.type === "soldier");
    const mapBuildings: MapBuilding[] = Array.isArray(mapState?.buildings)
      ? (mapState.buildings as MapBuilding[])
      : [];
    const mapUnits: MyUnit[] = Array.isArray(mapState?.units)
      ? (mapState.units as MyUnit[])
      : [];
    const enemyHQ = (mapBuildings.find(
      (b) => b?.relation === "enemy" && b.type === "hq",
    ) ?? null) as Record<string, unknown> | null;

    const canBuildBarracks = credits >= 120;
    const canSpawnWorker = credits >= 50;
    const canSpawnSoldier = credits >= 80;

    const issueWorkerEconomy = () => {
      for (const worker of workers) {
        const intent = worker.intent;
        if (intent?.type !== "harvest_loop" && worker.state === "idle") {
          this.bridge.startHarvestLoop(worker.id);
        }
      }
    };

    if (this.strategy === "random") {
      if (workers.length === 0 && canSpawnWorker && hq) {
        this.bridge.spawnUnit(hq.id as string, "worker");
      } else if (!hasBarracks && canBuildBarracks && workers[0] && hq) {
        const offset = (hq.x as number) < 11 ? 2 : -2;
        this.bridge.buildStructure(
          workers[0].id,
          "barracks",
          { x: (hq.x as number) + offset, y: hq.y as number },
        );
      } else {
        const candidatePlans: Array<
          "mine" | "spawn-worker" | "spawn-soldier" | "attack"
        > = ["mine"];
        if (canSpawnWorker && workers.length < 4 && hq) {
          candidatePlans.push("spawn-worker");
        }
        if (hasBarracks && canSpawnSoldier) {
          candidatePlans.push("spawn-soldier");
        }
        if (soldiers.length > 0 || hasBarracks) {
          candidatePlans.push("attack");
        }

        const selectedPlan = chooseRandom(candidatePlans);
        issueWorkerEconomy();

        if (selectedPlan === "spawn-worker" && hq) {
          this.bridge.spawnUnit(hq.id as string, "worker");
        } else if (selectedPlan === "spawn-soldier") {
          for (const barracks of barracksBuildings) {
            this.bridge.spawnUnit(barracks.id as string, "soldier");
          }
        } else if (selectedPlan === "attack" && enemyHQ) {
          const shouldAttackThisTurn = Math.random() > 0.75;
          if (soldiers.length === 0 && barracksBuildings.length > 0 && canSpawnSoldier) {
            for (const barracks of barracksBuildings) {
              this.bridge.spawnUnit(barracks.id as string, "soldier");
            }
          } else {
            for (const soldier of soldiers) {
              this.bridge.attackMoveUnit(
                soldier.id,
                { x: enemyHQ.x as number, y: enemyHQ.y as number },
              );
              if (shouldAttackThisTurn) {
                this.bridge.attackTarget(soldier.id, enemyHQ.id as string);
              }
            }
          }
        }
      }
    } else {
      // "rush" strategy
      const enemyUnits = mapUnits.filter((u) => u?.relation === "enemy");
      const isHQUnderPressure = hq
        ? enemyUnits.some(
            (enemy) =>
              chebyshevDistance(
                enemy as { x: number; y: number },
                hq as { x: number; y: number },
              ) <= 2,
          )
        : false;

      if (hq && workers.length < 2 && canSpawnWorker) {
        this.bridge.spawnUnit(hq.id as string, "worker");
      }

      if (!hasBarracks && canBuildBarracks && workers[0] && hq) {
        const offset = (hq.x as number) < 11 ? 2 : -2;
        this.bridge.buildStructure(
          workers[0].id,
          "barracks",
          { x: (hq.x as number) + offset, y: hq.y as number },
        );
      }

      if (hasBarracks && canSpawnSoldier) {
        for (const barracks of barracksBuildings) {
          this.bridge.spawnUnit(barracks.id as string, "soldier");
        }
      }

      issueWorkerEconomy();

      if (isHQUnderPressure) {
        const pressuredEnemies = enemyUnits.filter(
          (enemy) =>
            hq &&
            chebyshevDistance(
              enemy as { x: number; y: number },
              hq as { x: number; y: number },
            ) <= 2,
        );
        for (const soldier of soldiers) {
          const closestThreat = pressuredEnemies.reduce<MyUnit | null>(
            (best, enemy) => {
              if (!best) return enemy;
              return chebyshevDistance(soldier, enemy) <
                chebyshevDistance(soldier, best)
                ? enemy
                : best;
            },
            null,
          );
          if (closestThreat) {
            const inRange = chebyshevDistance(soldier, closestThreat) <= soldier.attackRange;
            if (inRange) {
              this.bridge.attackTarget(soldier.id, closestThreat.id);
            } else {
              this.bridge.attackMoveUnit(soldier.id, {
                x: closestThreat.x,
                y: closestThreat.y,
              });
            }
            continue;
          }
          if (enemyHQ) {
            this.bridge.attackMoveUnit(soldier.id, {
              x: enemyHQ.x as number,
              y: enemyHQ.y as number,
            });
          }
        }
      } else {
        for (const soldier of soldiers) {
          if (!enemyHQ) {
            const closestEnemy = enemyUnits[0];
            if (closestEnemy) {
              this.bridge.attackTarget(soldier.id, closestEnemy.id);
            }
            continue;
          }
          const inRange = chebyshevDistance(soldier, enemyHQ as { x: number; y: number }) <= soldier.attackRange;
          if (inRange) {
            this.bridge.attackTarget(soldier.id, enemyHQ.id as string);
          } else {
            this.bridge.attackMoveUnit(soldier.id, {
              x: enemyHQ.x as number,
              y: enemyHQ.y as number,
            });
          }
        }
      }

      if (!hasBarracks && !canBuildBarracks && canSpawnWorker && hq && workers.length < 4) {
        this.bridge.spawnUnit(hq.id as string, "worker");
      }
    }
  }
}
