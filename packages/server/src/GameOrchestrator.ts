import {
  AIStatePackage,
  AITurnRecord,
  GameRecord,
  GameState,
  MAP_HEIGHT,
  MAP_WIDTH,
  SavedAITurnRecord,
  TickDeltaRecord,
} from "@llmcraft/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { Game } from "./Game";
import { AISandbox } from "./AISandbox";
import { AIStatePackageBuilder } from "./AIStatePackageBuilder";
import { createLLMProvider } from "./createLLMProvider";
import { LLMProvider, LLMProviderConfig } from "./LLMProvider";
import { SYSTEM_PROMPT } from "./SystemPrompt";

export class GameOrchestrator {
  private game: Game;
  private ai1: AISandbox;
  private ai2: AISandbox;
  private llm1: LLMProvider;
  private llm2: LLMProvider;
  private lastAIDispatchTick = { player_1: -100, player_2: -100 };
  private aiInterval = 5; // AI 每 5 个 tick 思考一次
  private isRunningAI = { player_1: false, player_2: false }; // 防止并发调用
  private aiDirty = { player_1: true, player_2: true };
  private lastObservedTick = -1;
  private isPolling = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private runSession = 0;
  private startedAt = new Date().toISOString();
  private lastAIState: Record<string, AIStatePackage | null> = { player_1: null, player_2: null };
  private aiTurns: AITurnRecord[] = [];
  private aiWindowSize = 20;

  constructor(config: LLMProviderConfig) {
    this.game = new Game();
    this.ai1 = new AISandbox("player_1");
    this.ai2 = new AISandbox("player_2");
    this.llm1 = createLLMProvider(config);
    this.llm2 = createLLMProvider(config);
  }

  getGame(): Game {
    return this.game;
  }

  async runAI(playerId: string, sessionId = this.runSession): Promise<void> {
    // 防止并发调用
    if (this.isRunningAI[playerId as keyof typeof this.isRunningAI]) return;
    this.isRunningAI[playerId as keyof typeof this.isRunningAI] = true;

    try {
      const state = this.game.getState();
      this.aiDirty[playerId as keyof typeof this.aiDirty] = false;
      this.lastAIDispatchTick[playerId as keyof typeof this.lastAIDispatchTick] = state.tick;

      const packageBuilder = AIStatePackageBuilder;
      const aiPackage = packageBuilder.build(
        playerId,
        state,
        this.game,
        this.lastAIState[playerId]?.tick
      );

      const sandbox = playerId === "player_1" ? this.ai1 : this.ai2;
      const llm = playerId === "player_1" ? this.llm1 : this.llm2;
      const shouldForceFullState = llm.shouldForceFullState();
      const promptPayload = packageBuilder.buildPromptPayload(
        aiPackage,
        this.lastAIState[playerId],
        shouldForceFullState
      );
      const { code, requestMessages } = await llm.generateCode(promptPayload);
      if (!this.isPolling || sessionId !== this.runSession) {
        return;
      }

      const latestState = this.game.getState();
      if (latestState.winner) {
        return;
      }

      const latestAIPackage = packageBuilder.build(
        playerId,
        latestState,
        this.game,
        this.lastAIState[playerId]?.tick
      );

      this.game.setAIOutput(playerId, code);

      const { commands, errorMessage } = await sandbox.executeCode(code, latestAIPackage);
      if (!this.isPolling || sessionId !== this.runSession) {
        return;
      }
      if (errorMessage) {
        this.game.addAIFeedback(playerId, "execution", "error", errorMessage, { code });
      }
      for (const cmd of commands) {
        this.game.queueCommand(cmd);
      }
      this.aiTurns.push({
        playerId,
        requestTick: state.tick,
        executeTick: latestState.tick,
        requestMessages,
        promptPayload,
        response: code,
        commands,
        errorMessage,
        model: llm.getModel(),
        baseURL: llm.getBaseURL(),
        createdAt: new Date().toISOString(),
      });
      this.lastAIState[playerId] = latestAIPackage;
    } catch (e) {
      console.error(`AI 错误 ${playerId}:`, e);
      this.game.addAIFeedback(
        playerId,
        "generation",
        "error",
        e instanceof Error ? e.message : String(e)
      );
    } finally {
      this.isRunningAI[playerId as keyof typeof this.isRunningAI] = false;
    }
  }

  async start(): Promise<void> {
    if (this.isPolling) return;

    this.runSession++;
    this.isPolling = true;
    this.lastObservedTick = -1;
    this.aiDirty = { player_1: true, player_2: true };
    this.game.start();

    // 轮询 AI 更新
    const poll = async () => {
      if (!this.isPolling) return;

      const state = this.game.getState();
      if (state.winner) {
        this.stop();
        return;
      }

      if (state.tick !== this.lastObservedTick) {
        this.lastObservedTick = state.tick;
        this.aiDirty.player_1 = true;
        this.aiDirty.player_2 = true;
      }

      for (const playerId of ["player_1", "player_2"]) {
        if (
          this.aiDirty[playerId as keyof typeof this.aiDirty] &&
          !this.isRunningAI[playerId as keyof typeof this.isRunningAI] &&
          state.tick - this.lastAIDispatchTick[playerId as keyof typeof this.lastAIDispatchTick] >=
            this.aiInterval
        ) {
          void this.runAI(playerId, this.runSession);
        }
      }

      this.pollTimeout = setTimeout(poll, 100);
    };

    await poll();
  }

  stop(): void {
    this.isPolling = false;
    this.runSession++;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    this.game.stop();
  }

  async saveRecord(): Promise<string> {
    const snapshots = this.game.getSnapshots();
    const initialState = snapshots[0]?.state || this.game.getState();
    const record: GameRecord = {
      metadata: {
        startedAt: this.startedAt,
        savedAt: new Date().toISOString(),
        endedAt: this.game.getWinner() || !this.game.isGameRunning() ? new Date().toISOString() : undefined,
        status: this.game.getWinner() ? "finished" : this.game.isGameRunning() ? "running" : "stopped",
        winner: this.game.getWinner(),
        aiIntervalTicks: this.aiInterval,
        aiContextWindowTurns: this.aiWindowSize,
        map: {
          width: MAP_WIDTH,
          height: MAP_HEIGHT,
        },
        recordFormat: "compact-v2",
        systemPrompt: SYSTEM_PROMPT,
        players: [
          {
            playerId: "player_1",
            model: this.llm1.getModel(),
            baseURL: this.llm1.getBaseURL(),
          },
          {
            playerId: "player_2",
            model: this.llm2.getModel(),
            baseURL: this.llm2.getBaseURL(),
          },
        ],
      },
      initialState,
      finalState: this.game.getState(),
      tickDeltas: this.buildTickDeltas(snapshots),
      commandResults: this.game.getCommandResults(),
      aiTurns: this.buildSavedAITurns(),
    };

    const recordsDir = path.resolve(process.cwd(), "logs", "records");
    await fs.mkdir(recordsDir, { recursive: true });
    const fileName = `match-${record.metadata.savedAt.replace(/[:.]/g, "-")}.json`;
    const filePath = path.join(recordsDir, fileName);
    await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
    return filePath;
  }

  private buildSavedAITurns(): SavedAITurnRecord[] {
    return this.aiTurns.map((turn) => ({
      playerId: turn.playerId,
      requestTick: turn.requestTick,
      executeTick: turn.executeTick,
      windowMessageCount: turn.requestMessages.length,
      promptPayload: turn.promptPayload,
      response: turn.response,
      commands: turn.commands,
      errorMessage: turn.errorMessage,
      model: turn.model,
      baseURL: turn.baseURL,
      createdAt: turn.createdAt,
    }));
  }

  private buildTickDeltas(snapshots: Array<{ tick: number; state: GameState; aiOutputs: Record<string, string> }>): TickDeltaRecord[] {
    if (snapshots.length <= 1) {
      return [];
    }

    const deltas: TickDeltaRecord[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      const previous = snapshots[i - 1];
      const current = snapshots[i];
      deltas.push({
        tick: current.tick,
        players: current.state.players.map((player, playerIndex) => {
          const previousPlayer = previous.state.players[playerIndex];
          return {
            playerId: player.id,
            credits:
              player.resources.credits !== previousPlayer.resources.credits
                ? player.resources.credits
                : undefined,
            units: this.diffUnits(previousPlayer.units, player.units),
            buildings: this.diffBuildings(previousPlayer.buildings, player.buildings),
          };
        }),
        newLogs:
          current.state.logs.length >= previous.state.logs.length
            ? current.state.logs.slice(previous.state.logs.length)
            : current.state.logs,
        aiOutputs: this.diffAIOutputs(previous.aiOutputs, current.aiOutputs),
        winner: current.state.winner !== previous.state.winner ? current.state.winner : undefined,
      });
    }

    return deltas;
  }

  private diffUnits(previousUnits: GameState["players"][number]["units"], currentUnits: GameState["players"][number]["units"]) {
    const previousMap = new Map(previousUnits.map((unit) => [unit.id, unit]));
    const currentMap = new Map(currentUnits.map((unit) => [unit.id, unit]));
    const changes: TickDeltaRecord["players"][number]["units"] = [];

    for (const unit of currentUnits) {
      const previousUnit = previousMap.get(unit.id);
      if (!previousUnit) {
        changes.push({
          id: unit.id,
          type: unit.type,
          change: "created",
          x: unit.x,
          y: unit.y,
          hp: unit.hp,
          maxHp: unit.maxHp,
          state: unit.state,
          attackRange: unit.attackRange,
        });
        continue;
      }

      const moved = previousUnit.x !== unit.x || previousUnit.y !== unit.y;
      const damaged = previousUnit.hp !== unit.hp;
      const updated = previousUnit.state !== unit.state;

      if (moved || damaged || updated) {
        changes.push({
          id: unit.id,
          type: unit.type,
          change: moved ? "moved" : damaged ? "damaged" : "updated",
          x: unit.x,
          y: unit.y,
          hp: unit.hp,
          maxHp: unit.maxHp,
          state: unit.state,
          attackRange: unit.attackRange,
        });
      }
    }

    for (const unit of previousUnits) {
      if (!currentMap.has(unit.id)) {
        changes.push({
          id: unit.id,
          type: unit.type,
          change: "removed",
        });
      }
    }

    return changes;
  }

  private diffBuildings(previousBuildings: GameState["players"][number]["buildings"], currentBuildings: GameState["players"][number]["buildings"]) {
    const previousMap = new Map(previousBuildings.map((building) => [building.id, building]));
    const currentMap = new Map(currentBuildings.map((building) => [building.id, building]));
    const changes: TickDeltaRecord["players"][number]["buildings"] = [];

    for (const building of currentBuildings) {
      const previousBuilding = previousMap.get(building.id);
      if (!previousBuilding) {
        changes.push({
          id: building.id,
          type: building.type,
          change: "created",
          x: building.x,
          y: building.y,
          hp: building.hp,
          maxHp: building.maxHp,
          productionQueue: building.productionQueue,
        });
        continue;
      }

      const damaged = previousBuilding.hp !== building.hp;
      const updated =
        JSON.stringify(previousBuilding.productionQueue) !== JSON.stringify(building.productionQueue);

      if (damaged || updated) {
        changes.push({
          id: building.id,
          type: building.type,
          change: damaged ? "damaged" : "updated",
          x: building.x,
          y: building.y,
          hp: building.hp,
          maxHp: building.maxHp,
          productionQueue: building.productionQueue,
        });
      }
    }

    for (const building of previousBuildings) {
      if (!currentMap.has(building.id)) {
        changes.push({
          id: building.id,
          type: building.type,
          change: "removed",
        });
      }
    }

    return changes;
  }

  private diffAIOutputs(previousOutputs: Record<string, string>, currentOutputs: Record<string, string>) {
    const diff: Record<string, string> = {};
    for (const key of Object.keys(currentOutputs)) {
      if (currentOutputs[key] !== previousOutputs[key]) {
        diff[key] = currentOutputs[key];
      }
    }
    return diff;
  }
}
