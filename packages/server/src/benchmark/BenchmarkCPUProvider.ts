import { AgentRunInput, AgentToolCallRecord, BuiltinCPURuntimeConfig } from "@llmcraft/shared";
import { LLMProvider, RunAgentOptions, RunAgentResult } from "../LLMProvider";

function chebyshevDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function chooseRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

export class BenchmarkCPUProvider implements LLMProvider {
  constructor(private readonly config: BuiltinCPURuntimeConfig) {}

  async runAgent(_input: AgentRunInput, options: RunAgentOptions): Promise<RunAgentResult> {
    if (options.signal?.aborted) {
      return {
        assistantMessages: [],
        toolCalls: [],
        plans: [],
        stopReason: "aborted",
        metrics: {
          modelRequests: 0,
          toolCalls: 0,
          stallDetected: false,
        },
      };
    }

    let toolCallId = 0;
    const toolCalls: AgentToolCallRecord[] = [];
    const callTool = async (toolName: string, args: unknown) => {
      const execution = await options.executeTool(toolName, args);
      const toolCallRecord = {
        toolCallId: `cpu_tool_${++toolCallId}`,
        toolName,
        args,
        result: execution.result,
        isError:
          execution.result instanceof Object && "ok" in (execution.result as Record<string, unknown>)
            ? (execution.result as Record<string, unknown>).ok === false
            : false,
      };
      toolCalls.push(toolCallRecord);
      options.onToolCall?.(toolCallRecord);
      return execution.result as any;
    };

    const runtime = options.getRuntimeState();
    const myState = (runtime.myState ?? {}) as any;
    const myUnits = Array.isArray(runtime.myUnits) ? runtime.myUnits : [];
    const mapState = (runtime.mapState ?? {}) as any;

    const credits = typeof myState?.credits === "number" ? myState.credits : 0;
    const hq = myState?.hq ?? null;
    const buildings = Array.isArray(myState?.buildings) ? myState.buildings : [];
    const barracksBuildings = buildings.filter((building: any) => building.type === "barracks");
    const hasBarracks = barracksBuildings.length > 0;
    const workers = myUnits.filter((unit: any) => unit.type === "worker");
    const soldiers = myUnits.filter((unit: any) => unit.type === "soldier");
    const mapCells = Array.isArray(mapState?.cells) ? mapState.cells : [];
    const enemyHQ = mapCells
      .filter((cell: any) => cell?.building?.relation === "enemy" && cell.building.type === "hq")
      .map((cell: any) => ({ x: cell.x, y: cell.y, ...cell.building }))[0] ?? null;
    const resourceTiles = mapCells.filter((cell: any) => cell?.tile === "resource");

    const canBuildBarracks = credits >= 120;
    const canSpawnWorker = credits >= 50;
    const canSpawnSoldier = credits >= 80;

    const issueWorkerEconomy = async () => {
      for (const worker of workers) {
        const carryingFull = worker.carryingCredits >= worker.carryCapacity;
        if (carryingFull && hq) {
          await callTool("move_unit", { unitId: worker.id, x: hq.x, y: hq.y });
          continue;
        }
        if (worker.state === "idle" && resourceTiles.length > 0) {
          const nearestResource = resourceTiles.reduce((best: any, tile: any) => {
            if (!best) return tile;
            return chebyshevDistance(worker, tile) < chebyshevDistance(worker, best) ? tile : best;
          }, null);
          if (nearestResource) {
            await callTool("move_unit", { unitId: worker.id, x: nearestResource.x, y: nearestResource.y });
          }
        }
      }
    };

    if (this.config.strategy === "random") {
      if (workers.length === 0 && canSpawnWorker && hq) {
        await callTool("spawn_unit", { buildingId: hq.id, unitType: "worker" });
      } else if (!hasBarracks && canBuildBarracks && workers[0] && hq) {
        const offset = hq.x < (mapState?.width ?? 21) / 2 ? 2 : -2;
        await callTool("build_structure", {
          unitId: workers[0].id,
          buildingType: "barracks",
          x: hq.x + offset,
          y: hq.y,
        });
      } else {
        const candidatePlans: Array<"mine" | "spawn-worker" | "spawn-soldier" | "attack"> = ["mine"];
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
        await issueWorkerEconomy();

        if (selectedPlan === "spawn-worker" && hq) {
          await callTool("spawn_unit", { buildingId: hq.id, unitType: "worker" });
        } else if (selectedPlan === "spawn-soldier") {
          for (const barracks of barracksBuildings) {
            await callTool("spawn_unit", { buildingId: barracks.id, unitType: "soldier" });
          }
        } else if (selectedPlan === "attack" && enemyHQ) {
          const shouldAttackThisTurn = Math.random() > 0.75;
          if (soldiers.length === 0 && barracksBuildings.length > 0 && canSpawnSoldier) {
            for (const barracks of barracksBuildings) {
              await callTool("spawn_unit", { buildingId: barracks.id, unitType: "soldier" });
            }
          } else {
            for (const soldier of soldiers) {
              await callTool("move_unit", { unitId: soldier.id, x: enemyHQ.x, y: enemyHQ.y });
              if (shouldAttackThisTurn) {
                await callTool("attack_in_range", {
                  unitId: soldier.id,
                  priority: ["hq", "soldier", "worker", "barracks"],
                });
              }
            }
          }
        }
      }
    } else {
      const enemyUnits = mapCells
        .filter((cell: any) => cell?.unit?.relation === "enemy")
        .map((cell: any) => ({ x: cell.x, y: cell.y, ...cell.unit }));
      const isHQUnderPressure = hq
        ? enemyUnits.some((enemy: any) => chebyshevDistance(enemy, hq) <= 2)
        : false;

      if (hq && workers.length < 2 && canSpawnWorker) {
        await callTool("spawn_unit", { buildingId: hq.id, unitType: "worker" });
      }

      if (!hasBarracks && canBuildBarracks && workers[0] && hq) {
        const offset = hq.x < (mapState?.width ?? 21) / 2 ? 2 : -2;
        await callTool("build_structure", {
          unitId: workers[0].id,
          buildingType: "barracks",
          x: hq.x + offset,
          y: hq.y,
        });
      }

      if (hasBarracks && canSpawnSoldier) {
        for (const barracks of barracksBuildings) {
          await callTool("spawn_unit", { buildingId: barracks.id, unitType: "soldier" });
        }
      }

      await issueWorkerEconomy();

      if (isHQUnderPressure) {
        const pressuredEnemies = enemyUnits.filter((enemy: any) => hq && chebyshevDistance(enemy, hq) <= 2);
        for (const soldier of soldiers) {
          const closestThreat = pressuredEnemies.reduce((best: any, enemy: any) => {
            if (!best) return enemy;
            return chebyshevDistance(soldier, enemy) < chebyshevDistance(soldier, best) ? enemy : best;
          }, null);
          if (closestThreat) {
            const inRange = chebyshevDistance(soldier, closestThreat) <= soldier.attackRange;
            if (inRange) {
              await callTool("attack_in_range", {
                unitId: soldier.id,
                priority: ["soldier", "worker", "barracks", "hq"],
              });
            } else {
              await callTool("move_unit", { unitId: soldier.id, x: closestThreat.x, y: closestThreat.y });
            }
            continue;
          }
          if (enemyHQ) {
            await callTool("move_unit", { unitId: soldier.id, x: enemyHQ.x, y: enemyHQ.y });
          }
        }
      } else {
        for (const soldier of soldiers) {
          if (!enemyHQ) {
            await callTool("attack_in_range", {
              unitId: soldier.id,
              priority: ["soldier", "worker", "barracks", "hq"],
            });
            continue;
          }
          const inRange = chebyshevDistance(soldier, enemyHQ) <= soldier.attackRange;
          if (inRange) {
            await callTool("attack_in_range", {
              unitId: soldier.id,
              priority: ["hq", "soldier", "worker", "barracks"],
            });
          } else {
            await callTool("move_unit", { unitId: soldier.id, x: enemyHQ.x, y: enemyHQ.y });
          }
        }
      }

      if (!hasBarracks && !canBuildBarracks && canSpawnWorker && hq && workers.length < 4) {
        await callTool("spawn_unit", { buildingId: hq.id, unitType: "worker" });
      }
    }

    return {
      assistantMessages: [],
      toolCalls,
      plans: [],
      stopReason: "cpu_turn_complete",
      metrics: {
        modelRequests: 1,
        toolCalls: toolCalls.length,
        stallDetected: false,
      },
    };
  }

  getModel(): string {
    return `cpu-${this.config.strategy}`;
  }

  getBaseURL(): string | undefined {
    return undefined;
  }
}
