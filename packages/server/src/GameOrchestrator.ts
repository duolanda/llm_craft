import {
  AIStatePackage,
  AITurnRecord,
  GameRecord,
  GameState,
  MatchLLMConfig,
  MAP_HEIGHT,
  MAP_WIDTH,
  SavedAITurnRecord,
  TickDeltaRecord,
  LOG_TYPES,
  LOG_LEVELS,
  LOG_DISPLAY_TARGETS,
  PlayerId,
  AIFeedbackTarget
} from "@llmcraft/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AISandboxErrorType } from "./AISandbox";
import { Game } from "./Game";
import { AISandbox } from "./AISandbox";
import { AIStatePackageBuilder } from "./AIStatePackageBuilder";
import { createLLMProvider } from "./createLLMProvider";
import { LLMProvider } from "./LLMProvider";
import { SYSTEM_PROMPT } from "./SystemPrompt";

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE_PATH);
const SERVER_PACKAGE_DIR = path.resolve(CURRENT_DIR, "..");
const RECORDS_DIR = path.resolve(SERVER_PACKAGE_DIR, "logs", "records");
const LLM_DEBUG_DIR = path.resolve(SERVER_PACKAGE_DIR, "logs", "llm-debug");

type RecordedAITurn = AITurnRecord & { errorType?: AISandboxErrorType };
type SavedRecordedAITurn = SavedAITurnRecord & { errorType?: AISandboxErrorType };

export interface GameOrchestratorRuntimeOptions {
  aiIntervalTicks?: number;
  aiIntervalTicksByPlayer?: Partial<Record<"player_1" | "player_2", number>>;
  recordDir?: string;
  transcriptDir?: string;
}

export type GameOrchestratorConfig = MatchLLMConfig & {
  runtime?: GameOrchestratorRuntimeOptions;
};

export class GameOrchestrator {
  private game: Game;
  private ai1: AISandbox;
  private ai2: AISandbox;
  private llm1: LLMProvider;
  private llm2: LLMProvider;
  private lastAIDispatchTick = { player_1: -100, player_2: -100 };
  private aiInterval = 5; // 兼容记录格式，表示默认 AI 间隔
  private aiIntervals = { player_1: 5, player_2: 5 };
  private isRunningAI = { player_1: false, player_2: false }; // 防止并发调用
  private aiDirty = { player_1: true, player_2: true };
  private lastObservedTick = -1;
  private isPolling = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private runSession = 0;
  private startedAt = new Date().toISOString();
  private lastAIState: Record<string, AIStatePackage | null> = { player_1: null, player_2: null };
  private aiTurns: RecordedAITurn[] = [];
  private aiWindowSize = 20;
  private readonly transcriptEnabled: boolean;
  private readonly transcriptFilePath: string | null;
  private readonly recordDir: string;
  private lastSavedRecordSignature: string | null = null;
  private lastSavedRecordPath: string | null = null;
  private transcriptWriteChain = Promise.resolve();

  constructor(config: GameOrchestratorConfig) {
    this.game = new Game();
    this.ai1 = new AISandbox("player_1");
    this.ai2 = new AISandbox("player_2");
    this.aiInterval = config.runtime?.aiIntervalTicks ?? 5;
    this.aiIntervals = {
      player_1: config.runtime?.aiIntervalTicksByPlayer?.player_1 ?? this.aiInterval,
      player_2: config.runtime?.aiIntervalTicksByPlayer?.player_2 ?? this.aiInterval,
    };
    this.recordDir = config.runtime?.recordDir ?? RECORDS_DIR;
    this.transcriptEnabled = Boolean(config.debug?.recordLLMTranscript);
    this.transcriptFilePath = this.transcriptEnabled
      ? path.join(config.runtime?.transcriptDir ?? LLM_DEBUG_DIR, `match-${this.startedAt.replace(/[:.]/g, "-")}.log`)
      : null;
    this.llm1 = createLLMProvider(config.player1);
    this.llm2 = createLLMProvider(config.player2);
  }

  getGame(): Game {
    return this.game;
  }

  getTranscriptFilePath(): string | null {
    return this.transcriptFilePath;
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
      const { code, rawResponse, requestMessages, errorMessage: providerErrorMessage } =
        await llm.generateCode(promptPayload);
      if (providerErrorMessage) {
        this.game.addLog(
          LOG_TYPES.AI_GENERATION_ERROR,
          providerErrorMessage,
          undefined,
          { level: LOG_LEVELS.WARNING, owner: playerId as PlayerId, feedbackTarget: playerId as AIFeedbackTarget, displayTarget: LOG_DISPLAY_TARGETS.BACKEND }
        );
      }
      if (!this.isPolling || sessionId !== this.runSession) {
        await this.writeTranscript(
          this.formatTranscriptEntry({
            createdAt: new Date().toISOString(),
            playerId,
            requestTick: state.tick,
            executeTick: undefined,
            mode: promptPayload.mode,
            model: llm.getModel(),
            requestMessages,
            rawResponse,
            parsedCode: code,
            providerErrorMessage,
            commands: undefined,
            sandboxErrorMessage: "本轮响应返回后，对局已停止，未执行沙箱。",
            sandboxErrorType: undefined,
          })
        );
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

      const { commands, errorType, errorMessage } = await sandbox.executeCode(code, latestAIPackage);
      if (!this.isPolling || sessionId !== this.runSession) {
        return;
      }
      if (errorMessage) {
        this.game.addLog(
          LOG_TYPES.AI_EXECUTION_ERROR,
          errorMessage,
          { code, errorType: errorType ?? "unknown" },
          { level: LOG_LEVELS.ERROR, owner: playerId as PlayerId, feedbackTarget: playerId as AIFeedbackTarget, displayTarget: LOG_DISPLAY_TARGETS.BACKEND }
        );
      } else if (commands.length === 0) {
        this.game.addLog(
          LOG_TYPES.AI_EXECUTION_ERROR,
          "Generated code executed successfully but produced no commands. Issue at least one build, spawn, move, attack, attackInRange, or hold command when units or buildings can act.",
          { code, errorType: "no_commands" },
          { level: LOG_LEVELS.WARNING, owner: playerId as PlayerId, feedbackTarget: playerId as AIFeedbackTarget, displayTarget: LOG_DISPLAY_TARGETS.BACKEND }
        );
      }
      for (const cmd of commands) {
        this.game.queueCommand(cmd);
      }
      const createdAt = new Date().toISOString();
      this.aiTurns.push({
        playerId,
        requestTick: state.tick,
        executeTick: latestState.tick,
        requestMessages,
        promptPayload,
        response: code,
        commands,
        errorType,
        errorMessage,
        model: llm.getModel(),
        baseURL: llm.getBaseURL(),
        createdAt,
      });
      await this.writeTranscript(
        this.formatTranscriptEntry({
          createdAt,
          playerId,
          requestTick: state.tick,
          executeTick: latestState.tick,
          mode: promptPayload.mode,
          model: llm.getModel(),
          requestMessages,
          rawResponse,
          parsedCode: code,
          providerErrorMessage,
          commands,
          sandboxErrorMessage: errorMessage,
          sandboxErrorType: errorType,
        })
      );
      // Track what the LLM actually saw, not the later state used for sandbox execution.
      // Otherwise feedback/events that occur while a slow request is in flight are skipped
      // from future prompts even though they were never sent to the model.
      this.lastAIState[playerId] = aiPackage;
    } catch (e) {
      console.error(`AI 错误 ${playerId}:`, e);
      const errorMessage = e instanceof Error ? e.message : String(e);
      this.game.addLog(
        LOG_TYPES.AI_GENERATION_ERROR,
        errorMessage,
        undefined,
        { level: LOG_LEVELS.ERROR, owner: playerId as PlayerId, feedbackTarget: playerId as AIFeedbackTarget, displayTarget: LOG_DISPLAY_TARGETS.BACKEND }
      );
      await this.writeTranscript(
        this.formatTranscriptEntry({
          createdAt: new Date().toISOString(),
          playerId,
          requestTick: this.game.getState().tick,
          executeTick: undefined,
          mode: "delta",
          model: playerId === "player_1" ? this.llm1.getModel() : this.llm2.getModel(),
          requestMessages: [],
          rawResponse: "",
          parsedCode: "",
          providerErrorMessage: errorMessage,
          commands: undefined,
          sandboxErrorMessage: "AI 调度阶段抛出异常，未完成本轮执行。",
          sandboxErrorType: undefined,
        })
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
            this.aiIntervals[playerId as keyof typeof this.aiIntervals]
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
    const state = this.game.getState();
    const recordStatus = this.game.getWinner() ? "finished" : this.game.isGameRunning() ? "running" : "stopped";
    const recordSignature = JSON.stringify({
      tick: state.tick,
      winner: this.game.getWinner(),
      status: recordStatus,
      aiTurns: this.aiTurns.length,
      commandResults: this.game.getCommandResults().length,
    });

    if (this.lastSavedRecordSignature === recordSignature && this.lastSavedRecordPath) {
      return this.lastSavedRecordPath;
    }

    const snapshots = this.game.getSnapshots();
    const initialState = snapshots[0]?.state || state;
    const record: GameRecord = {
      metadata: {
        startedAt: this.startedAt,
        savedAt: new Date().toISOString(),
        endedAt: this.game.getWinner() || !this.game.isGameRunning() ? new Date().toISOString() : undefined,
        status: recordStatus,
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
      finalState: state,
      tickDeltas: this.buildTickDeltas(snapshots),
      commandResults: this.game.getCommandResults(),
      aiTurns: this.buildSavedAITurns(),
    };

    await fs.mkdir(this.recordDir, { recursive: true });
    const fileName = `match-${record.metadata.savedAt.replace(/[:.]/g, "-")}.json`;
    const filePath = path.join(this.recordDir, fileName);
    await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
    this.lastSavedRecordSignature = recordSignature;
    this.lastSavedRecordPath = filePath;
    return filePath;
  }

  private buildSavedAITurns(): SavedRecordedAITurn[] {
    return this.aiTurns.map((turn) => ({
      playerId: turn.playerId,
      requestTick: turn.requestTick,
      executeTick: turn.executeTick,
      windowMessageCount: turn.requestMessages.length,
      promptPayload: turn.promptPayload,
      response: turn.response,
      commands: turn.commands,
      errorType: turn.errorType,
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

  private formatTranscriptEntry(input: {
    createdAt: string;
    playerId: string;
    requestTick: number;
    executeTick?: number;
    mode: "full" | "delta";
    model: string;
    requestMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    rawResponse: string;
    parsedCode: string;
    providerErrorMessage?: string;
    commands?: unknown[];
    sandboxErrorMessage?: string;
    sandboxErrorType?: string;
  }): string {
    return [
      `[${input.createdAt}] player=${input.playerId} mode=${input.mode} requestTick=${input.requestTick} executeTick=${input.executeTick ?? "n/a"} model=${input.model}`,
      "--- request ---",
      input.requestMessages.length > 0
        ? input.requestMessages.map((message) => `(${message.role})\n${message.content}`).join("\n\n")
        : "(none)",
      "--- response ---",
      input.rawResponse || "(empty)",
      "--- parsed_code ---",
      input.parsedCode || "(empty)",
      "--- provider_error ---",
      input.providerErrorMessage || "(none)",
      "--- commands ---",
      input.commands && input.commands.length > 0 ? JSON.stringify(input.commands, null, 2) : "(none)",
      "--- sandbox ---",
      input.sandboxErrorMessage
        ? `${input.sandboxErrorType ? `type=${input.sandboxErrorType}\n` : ""}${input.sandboxErrorMessage}`
        : "(none)",
      "==========",
      "",
    ].join("\n");
  }

  private async writeTranscript(content: string): Promise<void> {
    if (!this.transcriptEnabled || !this.transcriptFilePath) {
      return;
    }

    this.transcriptWriteChain = this.transcriptWriteChain.then(async () => {
      await fs.mkdir(LLM_DEBUG_DIR, { recursive: true });
      await fs.appendFile(this.transcriptFilePath!, content, "utf8");
    });

    await this.transcriptWriteChain;
  }
}
