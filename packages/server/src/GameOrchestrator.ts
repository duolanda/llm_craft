import {
  AgentRunInput,
  AgentModelRequestRecord,
  AgentToolCallRecord,
  AITerminalEvent,
  AITurnRecord,
  GameState,
  MatchLLMConfig,
  PlayerId,
  PLAYER_IDS,
  SavedAITurnRecord,
  TickDeltaRecord,
  LOG_TYPES,
  LOG_LEVELS,
  LOG_DISPLAY_TARGETS,
  AIFeedbackTarget,
  TICK_INTERVAL_MS,
  type Command,
} from "@llmcraft/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Game } from "./Game";
import { SubAgentParentContext } from "./LLMProvider";
import { createSystemPrompt } from "./SystemPrompt";
import { GameAgentBridge } from "./agent/GameAgentBridge";
import type { AgentRuntimeResult } from "./agent/AgentRuntime";
import { SubAgentTaskRegistry, SubAgentRunner, SpawnAgentInput } from "./agent/SubAgentTaskRegistry";
import { getHQUnderAttackAlertFromGameState } from "./HQAlert";
import { MatchJournal } from "./MatchJournal";
import { MatchRuntime } from "./MatchRuntime";
import { MatchRecorder } from "./MatchRecorder";
import type { MatchDefinition } from "./MatchDefinition";
import type { RegisteredMatchStatus } from "./MatchRegistry";
import type { JournalLifecycleService } from "./JournalLifecycle";
import type { Controller } from "./controller/Controller";
import { createController } from "./controller/createController";
import { ControllerDecisionScheduler } from "./controller/ControllerDecisionScheduler";

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE_PATH);
const SERVER_PACKAGE_DIR = path.resolve(CURRENT_DIR, "..");
const RECORDS_DIR = path.resolve(SERVER_PACKAGE_DIR, "logs", "records");
const LLM_DEBUG_DIR = path.resolve(SERVER_PACKAGE_DIR, "logs", "llm-debug");
export const MATCH_START_ABORTED = "MATCH_START_ABORTED";
const AI_RUNTIME_TOTAL_WARNING_MS = 5000;
const AI_RUNTIME_SYNC_PHASE_WARNING_MS = 150;
const AI_RUNTIME_WARNING_THROTTLE_MS = 2000;
const MAX_TERMINAL_EVENTS = 500;

type ControllerMap = Record<PlayerId, Controller>;
type BridgeMap = Record<PlayerId, GameAgentBridge>;

export interface AITerminalFeed {
  sessionId: string;
  events: AITerminalEvent[];
  latestSequence: number;
  reset: boolean;
  hasMore: boolean;
}

export interface GameOrchestratorRuntimeOptions {
  aiIntervalTicks?: number;
  aiIntervalTicksByPlayer?: Partial<Record<"player_1" | "player_2", number>>;
  recordDir?: string;
  transcriptDir?: string;
  matchDefinition?: MatchDefinition;
  journalLifecycle?: JournalLifecycleService;
}

export type GameOrchestratorConfig = MatchLLMConfig & {
  runtime?: GameOrchestratorRuntimeOptions;
};

export class GameOrchestrator {
  private game: Game;
  private readonly matchRuntime: MatchRuntime;
  private controllerByPlayer: ControllerMap;
  private readonly systemPromptByPlayer: Record<PlayerId, string>;
  private readonly decisionScheduler: ControllerDecisionScheduler;
  private bridgeByPlayer: BridgeMap;
  private lastAIDispatchTick = { player_1: -100, player_2: -100 };
  private aiInterval = 5;
  private aiIntervals = { player_1: 5, player_2: 5 };
  private isRunningAI = { player_1: false, player_2: false };
  private activeRunControllers: Partial<Record<PlayerId, AbortController>> = {};
  private warmupController: AbortController | null = null;
  private lastObservedTick = -1;
  private isPolling = false;
  private isPreparing = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private runSession = 0;
  private startedAt = new Date().toISOString();
  private journal: MatchJournal;
  private readonly recorder: MatchRecorder;
  private readonly transcriptEnabled: boolean;
  private readonly transcriptFilePath: string | null;
  private transcriptWriteChain = Promise.resolve();
  private transcriptSequence = 0;
  private aiTerminalSessionId = `terminal-${this.startedAt.replace(/[:.]/g, "-")}`;
  private aiTerminalEvents: AITerminalEvent[] = [];
  private aiTerminalEventSequence = 0;
  private aiRequestCounts = { player_1: 0, player_2: 0 };
  private warmupRequestNumbers: Partial<Record<PlayerId, number>> = {};
  private subAgentTaskRegistry = new SubAgentTaskRegistry();
  private lastAIRuntimeWarningAtMs: Partial<Record<PlayerId, number>> = {};

  constructor(config: GameOrchestratorConfig) {
    const recordDir = config.runtime?.recordDir ?? RECORDS_DIR;
    this.matchRuntime = new MatchRuntime({
      definition: config.runtime?.matchDefinition,
      recordDir,
      journalLifecycle: config.runtime?.journalLifecycle,
    });
    this.journal = this.matchRuntime.getJournal();
    this.recorder = new MatchRecorder(this.matchRuntime);
    this.game = this.matchRuntime.getGame();
    this.aiInterval = config.runtime?.aiIntervalTicks ?? 5;
    this.aiIntervals = {
      player_1: config.runtime?.aiIntervalTicksByPlayer?.player_1 ?? this.aiInterval,
      player_2: config.runtime?.aiIntervalTicksByPlayer?.player_2 ?? this.aiInterval,
    };
    this.transcriptEnabled = Boolean(config.debug?.recordLLMTranscript);
    this.transcriptFilePath = this.transcriptEnabled
      ? path.join(config.runtime?.transcriptDir ?? LLM_DEBUG_DIR, `match-${this.startedAt.replace(/[:.]/g, "-")}.log`)
      : null;
    this.bridgeByPlayer = {
      player_1: new GameAgentBridge(this.game, PLAYER_IDS.PLAYER_1, {
        submitCommands: (commands, options) => this.submitCommands(PLAYER_IDS.PLAYER_1, commands, options),
      }),
      player_2: new GameAgentBridge(this.game, PLAYER_IDS.PLAYER_2, {
        submitCommands: (commands, options) => this.submitCommands(PLAYER_IDS.PLAYER_2, commands, options),
      }),
    };
    const definition = this.matchRuntime.getDefinition();
    this.systemPromptByPlayer = {
      player_1: createSystemPrompt(definition, PLAYER_IDS.PLAYER_1),
      player_2: createSystemPrompt(definition, PLAYER_IDS.PLAYER_2),
    };
    this.controllerByPlayer = {
      player_1: createController(PLAYER_IDS.PLAYER_1, config.player1, this.bridgeByPlayer.player_1, this.systemPromptByPlayer.player_1),
      player_2: createController(PLAYER_IDS.PLAYER_2, config.player2, this.bridgeByPlayer.player_2, this.systemPromptByPlayer.player_2),
    };
    this.decisionScheduler = new ControllerDecisionScheduler({
      intervalTicksByPlayer: this.aiIntervals,
    });
  }

  getGame(): Game {
    return this.game;
  }

  getMatchRuntime(): MatchRuntime {
    return this.matchRuntime;
  }

  getMatchId(): string {
    return this.matchRuntime.getMatchId();
  }

  getMatchStatus(): RegisteredMatchStatus {
    if (this.isPreparing) return "preparing";
    if (this.game.getWinner()) return "finished";
    return this.game.isGameRunning() ? "running" : "stopped";
  }

  getTranscriptFilePath(): string | null {
    return this.transcriptFilePath;
  }

  getAITerminalFeed(sinceSequence?: number): AITerminalFeed {
    const firstSequence = this.aiTerminalEvents.length > 0
      ? this.getTerminalEventSequence(this.aiTerminalEvents[0])
      : this.aiTerminalEventSequence + 1;
    const reset = sinceSequence === undefined || sinceSequence < firstSequence - 1;
    const events = reset
      ? this.aiTerminalEvents
      : this.aiTerminalEvents.filter((event) => this.getTerminalEventSequence(event) > sinceSequence);
    return {
      sessionId: this.aiTerminalSessionId,
      events: structuredClone(events),
      latestSequence: this.aiTerminalEventSequence,
      reset,
      hasMore: firstSequence > 1,
    };
  }

  getTerminalHistory(beforeSequence?: number, limit?: number) {
    return this.journal.readTerminalHistory(beforeSequence, limit);
  }

  async runAI(playerId: PlayerId, sessionId = this.runSession): Promise<void> {
    if (this.isRunningAI[playerId]) {
      return;
    }
    this.isRunningAI[playerId] = true;
    const runStartedAt = performance.now();
    const timings: Record<string, number> = {};
    let requestTick: number | undefined;
    let runtimeResult: AgentRuntimeResult | undefined;
    let runInput: AgentRunInput | undefined;
    let turnId: string | undefined;
    let controllerDescriptor: ReturnType<Controller["getDescriptor"]> | undefined;
    const observedModelRequests: AgentModelRequestRecord[] = [];
    const observedToolCalls: AgentToolCallRecord[] = [];

    try {
      const stateStartedAt = performance.now();
      const state = this.game.getState();
      timings.getStateMs = performance.now() - stateStartedAt;
      requestTick = state.tick;
      this.lastAIDispatchTick[playerId] = state.tick;
      const buildInputStartedAt = performance.now();
      runInput = this.buildRunInput(playerId, state);
      timings.buildInputMs = performance.now() - buildInputStartedAt;
      const controllerRuntime = this.controllerByPlayer[playerId];
      const controller = new AbortController();
      this.activeRunControllers[playerId] = controller;
      const warmupRequestNumber = this.warmupRequestNumbers[playerId];
      const requestNumber = warmupRequestNumber ?? ++this.aiRequestCounts[playerId];
      controllerDescriptor = controllerRuntime.getDescriptor();
      turnId = `turn_${this.getMatchId()}_${playerId}_${requestNumber}`;
      const transcriptRunId = `tx_${++this.transcriptSequence}`;
      if (warmupRequestNumber === undefined) {
        this.appendTerminalRequestEvent(playerId, requestNumber, state.tick);
      }
      const transcriptStartStartedAt = performance.now();
      await this.writeTranscriptRequestStart(transcriptRunId, playerId, state.tick, runInput);
      timings.transcriptStartMs = performance.now() - transcriptStartStartedAt;
      let callbackSyncMs = 0;
      const runtimeStartedAt = performance.now();
      const result = await controllerRuntime.run(runInput, {
        traceContext: {
          turnId,
          controllerId: controllerDescriptor.controllerId,
        },
        onAssistantMessage: (message) => {
          const callbackStartedAt = performance.now();
          this.appendTerminalAssistantEvent(playerId, requestNumber, state.tick, message);
          void this.writeTranscriptAssistantMessage(transcriptRunId, playerId, state.tick, message);
          callbackSyncMs += performance.now() - callbackStartedAt;
        },
        onToolCall: (record) => {
          observedToolCalls.push(structuredClone(record));
          const callbackStartedAt = performance.now();
          this.appendTerminalToolCallEvent(playerId, requestNumber, state.tick, record);
          void this.writeTranscriptToolCall(transcriptRunId, playerId, state.tick, record);
          callbackSyncMs += performance.now() - callbackStartedAt;
        },
        onModelRequest: (record) => {
          observedModelRequests.push(structuredClone(record));
        },
        onPerformanceWarning: (warning) => {
          this.game.addLog(LOG_TYPES.PERF_WARNING, `Provider phase ${warning.phase} took ${Math.round(warning.elapsedMs ?? 0)}ms`, {
            scope: "ai_runtime",
            phase: `provider:${warning.phase}`,
            elapsedMs: warning.elapsedMs !== undefined ? Math.round(warning.elapsedMs) : undefined,
            requestTick: state.tick,
            playerId,
            bytes: warning.bytes,
            details: warning.details,
          });
        },
        spawnSubAgent: (args, context) => this.handleSpawnSubAgent(playerId, args, context),
        drainSubAgentNotifications: () => this.subAgentTaskRegistry.drainNotifications(playerId),
      }, controller.signal);
      timings.runtimeMs = performance.now() - runtimeStartedAt;
      timings.callbackSyncMs = callbackSyncMs;
      runtimeResult = result;
      const latestStateStartedAt = performance.now();
      const latestState = this.game.getState();
      timings.latestStateMs = performance.now() - latestStateStartedAt;
      const transcriptCompleteStartedAt = performance.now();
      await this.writeTranscriptRunComplete(transcriptRunId, playerId, state.tick, latestState.tick, result);
      timings.transcriptCompleteMs = performance.now() - transcriptCompleteStartedAt;
      this.maybeLogAIRuntimePerformance(playerId, state.tick, performance.now() - runStartedAt, timings, result);
      const createdAt = new Date().toISOString();
      this.journal.appendAITurn({
        turnId,
        controllerId: controllerDescriptor.controllerId,
        decisionKind: "macro",
        playerId,
        requestTick: state.tick,
        executeTick: latestState.tick,
        runInput,
        assistantMessages: result.assistantMessages,
        toolCalls: result.toolCalls,
        plans: result.plans,
        commands: result.commands,
        stopReason: result.stopReason,
        metrics: result.metrics,
        model: controllerDescriptor.model ?? "unknown",
        baseURL: controllerDescriptor.baseURL,
        createdAt,
      });

      // A turn that finishes because quiesce/stop aborted the controller is still
      // part of the match history. Persist it before rejecting stale UI/runtime
      // side effects from an earlier run session.
      if (!this.isPolling || sessionId !== this.runSession) {
        return;
      }

      const assistantPreview = result.assistantMessages.at(-1) ?? `tool-calls=${result.toolCalls.length}`;
      this.game.setAIOutput(playerId, assistantPreview);

      if (latestState.winner) {
        return;
      }

      if (result.stopReason === "stall_detected") {
        this.game.addLog(
          LOG_TYPES.AI_GENERATION_ERROR,
          "Agent run stopped after repeated read-only tool use with no actionable progress.",
          undefined,
          {
            level: LOG_LEVELS.WARNING,
            owner: playerId,
            feedbackTarget: playerId as AIFeedbackTarget,
            displayTarget: LOG_DISPLAY_TARGETS.BACKEND,
          }
        );
      }

    } catch (error) {
      this.maybeLogAIRuntimePerformance(
        playerId,
        requestTick ?? this.game.getState().tick,
        performance.now() - runStartedAt,
        timings,
        runtimeResult
      );
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (requestTick !== undefined && runInput && turnId && controllerDescriptor) {
        this.journal.appendAITurn({
          turnId,
          controllerId: controllerDescriptor.controllerId,
          decisionKind: "macro",
          playerId,
          requestTick,
          executeTick: this.game.getState().tick,
          runInput,
          assistantMessages: [],
          toolCalls: observedToolCalls,
          plans: this.bridgeByPlayer[playerId].takeRunPlans(),
          commands: this.bridgeByPlayer[playerId].takeIssuedCommands(),
          stopReason: "runtime_error",
          metrics: {
            modelRequests: observedModelRequests.length,
            toolCalls: observedToolCalls.length,
            stallDetected: false,
            modelRequestRecords: observedModelRequests,
          },
          model: controllerDescriptor.model ?? "unknown",
          baseURL: controllerDescriptor.baseURL,
          createdAt: new Date().toISOString(),
        });
      }
      this.game.addLog(
        LOG_TYPES.AI_GENERATION_ERROR,
        errorMessage,
        undefined,
        {
          level: LOG_LEVELS.ERROR,
          owner: playerId,
          feedbackTarget: playerId as AIFeedbackTarget,
          displayTarget: LOG_DISPLAY_TARGETS.BACKEND,
        }
      );
      await this.writeTranscript(
        [
          `[${new Date().toISOString()}] player=${playerId} requestTick=${this.game.getState().tick} stopReason=runtime_error`,
          "--- error ---",
          errorMessage,
          "==========",
          "",
        ].join("\n")
      );
    } finally {
      delete this.warmupRequestNumbers[playerId];
      delete this.activeRunControllers[playerId];
      this.isRunningAI[playerId] = false;
    }
  }

  async start(): Promise<void> {
    if (this.isPolling) {
      return;
    }

    this.runSession++;
    const sessionId = this.runSession;
    this.isPolling = true;
    this.lastObservedTick = -1;
    this.decisionScheduler.reset(this.game.getState().tick);
    this.matchRuntime.start();

    const poll = async () => {
      if (!this.isPolling) {
        return;
      }

      const state = this.game.getState();
      if (state.winner) {
        this.stop();
        return;
      }

      if (state.tick !== this.lastObservedTick) {
        this.lastObservedTick = state.tick;
        for (const playerId of [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2]) {
          const planCommands = this.controllerByPlayer[playerId].advancePlans();
          this.submitCommands(playerId, planCommands);
        }
      }

      const scheduledPlayers = this.decisionScheduler.select(state.tick, this.isRunningAI);
      for (const playerId of scheduledPlayers) {
        void this.runAI(playerId, this.runSession);
      }

      this.pollTimeout = setTimeout(poll, 100);
    };

    await poll();
  }

  private submitCommands(
    playerId: PlayerId,
    commands: readonly Command[],
    options: { clientRequestId?: string } = {},
  ): { duplicate: boolean } {
    if (commands.length === 0) return { duplicate: false };
    const result = this.matchRuntime.submitCommands(playerId, commands, options);
    if (!result.accepted) {
      throw new Error(`CommandGateway rejected ${result.clientRequestId}: ${result.code} (${result.message})`);
    }
    return { duplicate: result.duplicate };
  }

  stop(): void {
    this.isPolling = false;
    this.isPreparing = false;
    this.runSession++;
    this.warmupController?.abort();
    this.activeRunControllers.player_1?.abort();
    this.activeRunControllers.player_2?.abort();
    this.subAgentTaskRegistry.abortAll();
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    this.matchRuntime.stop();
  }

  async quiesce(): Promise<void> {
    this.stop();
    for (let attempt = 0; attempt < 3_000; attempt++) {
      if (
        !this.isRunningAI.player_1
        && !this.isRunningAI.player_2
        && this.warmupController === null
      ) {
        await this.transcriptWriteChain;
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for agent/transcript work to quiesce before journal finalization.");
  }

  async prepare(warmup: Partial<Record<PlayerId, boolean>>): Promise<void> {
    if (this.isPolling) {
      throw new Error("MATCH_ALREADY_RUNNING");
    }
    if (this.isPreparing) {
      return;
    }

    this.runSession++;
    const sessionId = this.runSession;
    this.isPreparing = true;
    try {
      await this.runWarmups(sessionId, warmup);
    } finally {
      if (sessionId === this.runSession) {
        this.isPreparing = false;
      }
    }
  }

  private async runWarmups(sessionId: number, warmup: Partial<Record<PlayerId, boolean>>): Promise<void> {
    const warmupPlayers = [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2].filter(
      (playerId) => warmup[playerId]
    );
    if (warmupPlayers.length === 0) {
      return;
    }

    const controller = new AbortController();
    this.warmupController = controller;
    try {
      await Promise.all(warmupPlayers.map((playerId) => this.runWarmup(playerId, sessionId, controller.signal)));
    } finally {
      if (this.warmupController === controller) {
        this.warmupController = null;
      }
    }
  }

  private async runWarmup(playerId: PlayerId, sessionId: number, signal: AbortSignal): Promise<void> {
    if (!this.isPreparing || sessionId !== this.runSession || signal.aborted) {
      throw new Error(MATCH_START_ABORTED);
    }

    const requestNumber = ++this.aiRequestCounts[playerId];
    this.warmupRequestNumbers[playerId] = requestNumber;
    const runInput = this.buildRunInput(playerId, this.game.getState());
    this.appendTerminalRequestEvent(playerId, requestNumber, 0);
    try {
      const result = await this.controllerByPlayer[playerId].warmup(
        runInput,
        {
          onAssistantMessage: (message) => {
            this.appendTerminalAssistantEvent(playerId, requestNumber, 0, message);
          },
        },
        signal
      );
      if (result.stopReason === "aborted" || !this.isPreparing || sessionId !== this.runSession) {
        throw new Error(MATCH_START_ABORTED);
      }
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.message === MATCH_START_ABORTED)) {
        throw new Error(MATCH_START_ABORTED);
      }

      throw new Error(`模型准备失败（${playerId === PLAYER_IDS.PLAYER_1 ? "红方" : "蓝方"}）: ${this.formatErrorMessage(error)}`);
    }
  }

  async saveRecord(): Promise<string> {
    if (this.game.getWinner() || !this.game.isGameRunning()) {
      await this.quiesce();
    }
    return this.recorder.save({
      startedAt: this.startedAt,
      aiIntervalTicks: this.aiInterval,
      systemPrompt: JSON.stringify(this.systemPromptByPlayer),
      players: [
        {
          playerId: PLAYER_IDS.PLAYER_1,
          model: this.getControllerDescriptor(PLAYER_IDS.PLAYER_1).model ?? "unknown",
          baseURL: this.getControllerDescriptor(PLAYER_IDS.PLAYER_1).baseURL,
        },
        {
          playerId: PLAYER_IDS.PLAYER_2,
          model: this.getControllerDescriptor(PLAYER_IDS.PLAYER_2).model ?? "unknown",
          baseURL: this.getControllerDescriptor(PLAYER_IDS.PLAYER_2).baseURL,
        },
      ],
    });
  }

  async discardJournal(): Promise<void> {
    const result = await this.journal.discard();
    if (!result.cleaned) {
      throw new Error(result.error ?? `Unable to discard journal ${result.directory}.`);
    }
  }

  private buildRunInput(playerId: PlayerId, state: GameState): AgentRunInput {
    const me = state.players.find((player) => player.id === playerId)!;
    const enemy = state.players.find((player) => player.id !== playerId)!;
    const myHQ = me.buildings.find((building) => building.type === "hq");
    const enemyHQ = enemy.buildings.find((building) => building.type === "hq");
    const recentFeedback = this.game
      .getAIFeedback(playerId, this.lastAIDispatchTick[playerId])
      .slice(-5)
      .map((log) => log.message);

    const summaryLines = [
      `tick=${state.tick}, intervalMs=${TICK_INTERVAL_MS}`,
      `myCredits=${me.resources.credits}, myWorkers=${me.units.filter((unit) => unit.type === "worker" && unit.exists).length}, mySoldiers=${me.units.filter((unit) => unit.type === "soldier" && unit.exists).length}`,
      `enemyWorkers=${enemy.units.filter((unit) => unit.type === "worker" && unit.exists).length}, enemySoldiers=${enemy.units.filter((unit) => unit.type === "soldier" && unit.exists).length}`,
      myHQ ? `myHQHp=${myHQ.hp}/${myHQ.maxHp}` : "myHQMissing=true",
      enemyHQ ? `enemyHQHp=${enemyHQ.hp}/${enemyHQ.maxHp}` : "enemyHQMissing=true",
      `activePlans=${this.controllerByPlayer[playerId].getActivePlans().length}`,
    ];
    const alert = getHQUnderAttackAlertFromGameState(state, playerId);
    if (alert) {
      summaryLines.unshift(alert);
    }

    if (recentFeedback.length > 0) {
      summaryLines.push(`recentEvents=${recentFeedback.join(" | ")}`);
    }

    return {
      playerId,
      tick: state.tick,
      tickIntervalMs: TICK_INTERVAL_MS,
      summary: summaryLines.join("\n"),
    };
  }

  private appendTerminalRequestEvent(playerId: PlayerId, requestNumber: number, requestTick: number): void {
    this.appendTerminalEvent({
      id: `evt_${++this.aiTerminalEventSequence}`,
      kind: "request",
      playerId,
      requestNumber,
      requestTick,
      createdAt: new Date().toISOString(),
    });
  }

  private appendTerminalAssistantEvent(
    playerId: PlayerId,
    requestNumber: number,
    requestTick: number,
    text: string
  ): void {
    this.appendTerminalEvent({
      id: `evt_${++this.aiTerminalEventSequence}`,
      kind: "assistant",
      playerId,
      requestNumber,
      requestTick,
      createdAt: new Date().toISOString(),
      text,
    });
  }

  private appendTerminalToolCallEvent(
    playerId: PlayerId,
    requestNumber: number,
    requestTick: number,
    toolCall: AgentToolCallRecord
  ): void {
    this.appendTerminalEvent({
      id: `evt_${++this.aiTerminalEventSequence}`,
      kind: "tool_call",
      playerId,
      requestNumber,
      requestTick,
      createdAt: new Date().toISOString(),
      toolCall: structuredClone(toolCall),
    });
  }

  private appendTerminalEvent(event: AITerminalEvent): void {
    this.journal.appendTerminalEvent(event);
    this.aiTerminalEvents.push(event);
    if (this.aiTerminalEvents.length > MAX_TERMINAL_EVENTS) {
      this.aiTerminalEvents.splice(0, this.aiTerminalEvents.length - MAX_TERMINAL_EVENTS);
    }
  }

  private getTerminalEventSequence(event: AITerminalEvent): number {
    const sequence = Number(event.id.replace(/^evt_/, ""));
    return Number.isFinite(sequence) ? sequence : 0;
  }

  private handleSpawnSubAgent(
    playerId: PlayerId,
    args: unknown,
    context: SubAgentParentContext,
  ): { effect: "read"; result: unknown } {
    const controller = this.controllerByPlayer[playerId];
    if (!controller.runSubAgentTask) {
      return {
        effect: "read",
        result: { ok: false, error: "spawn_agent_unavailable" },
      };
    }
    const input = args as SpawnAgentInput;
    const runner: SubAgentRunner = (taskId, spawnInput, signal) =>
      controller.runSubAgentTask!({
        taskId,
        description: spawnInput.description,
        objective: spawnInput.objective,
        assignedUnits: spawnInput.assignedUnits,
        assignedBuildings: spawnInput.assignedBuildings,
        constraints: spawnInput.constraints,
        successCriteria: spawnInput.successCriteria,
        parentContext: context,
        signal,
      });
    return {
      effect: "read",
      result: this.subAgentTaskRegistry.spawn(input, playerId, runner),
    };
  }

  private getControllerDescriptor(playerId: PlayerId) {
    return this.controllerByPlayer[playerId].getDescriptor();
  }

  private formatErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
          carryingCredits: unit.carryingCredits,
          carryCapacity: unit.carryCapacity,
          intent: unit.intent ?? null,
          constructingBuildingId: unit.constructingBuildingId ?? null,
        });
        continue;
      }

      const moved = previousUnit.x !== unit.x || previousUnit.y !== unit.y;
      const damaged = previousUnit.hp !== unit.hp;
      const carryingChanged = previousUnit.carryingCredits !== unit.carryingCredits;
      const updated =
        previousUnit.state !== unit.state ||
        carryingChanged ||
        previousUnit.constructingBuildingId !== unit.constructingBuildingId ||
        JSON.stringify(previousUnit.intent ?? null) !== JSON.stringify(unit.intent ?? null);

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
          carryingCredits: unit.carryingCredits,
          carryCapacity: unit.carryCapacity,
          intent: unit.intent ?? null,
          constructingBuildingId: unit.constructingBuildingId ?? null,
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
          productionProgress: building.productionProgress ?? null,
          constructionProgress: building.constructionProgress ?? null,
        });
        continue;
      }

      const damaged = previousBuilding.hp !== building.hp;
      const updated =
        JSON.stringify(previousBuilding.productionQueue) !== JSON.stringify(building.productionQueue) ||
        JSON.stringify(previousBuilding.productionProgress) !== JSON.stringify(building.productionProgress) ||
        JSON.stringify(previousBuilding.constructionProgress) !== JSON.stringify(building.constructionProgress);

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
          productionProgress: building.productionProgress ?? null,
          constructionProgress: building.constructionProgress ?? null,
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

  private formatTranscriptRequestStart(
    transcriptRunId: string,
    playerId: PlayerId,
    requestTick: number,
    input: AgentRunInput
  ): string {
    return [
      `[${new Date().toISOString()}] transcript=${transcriptRunId} player=${playerId} requestTick=${requestTick} model=${this.getControllerDescriptor(playerId).model ?? "unknown"}`,
      "--- request ---",
      "(system)",
      this.systemPromptByPlayer[playerId],
      "",
      "(user)",
      JSON.stringify(input, null, 2),
      "--- summary ---",
      input.summary,
      "--- stream ---",
      "",
    ].join("\n");
  }

  private formatTranscriptAssistantMessage(
    transcriptRunId: string,
    playerId: PlayerId,
    requestTick: number,
    message: string
  ): string {
    return [
      `[assistant transcript=${transcriptRunId} player=${playerId} requestTick=${requestTick}]`,
      message,
      "",
    ].join("\n");
  }

  private formatTranscriptToolCall(
    transcriptRunId: string,
    playerId: PlayerId,
    requestTick: number,
    toolCall: AgentToolCallRecord
  ): string {
    return [
      `[tool_call transcript=${transcriptRunId} player=${playerId} requestTick=${requestTick}]`,
      JSON.stringify(toolCall, null, 2),
      "",
    ].join("\n");
  }

  private formatTranscriptRunComplete(
    transcriptRunId: string,
    playerId: PlayerId,
    requestTick: number,
    executeTick: number,
    result: AgentRuntimeResult
  ): string {
    return [
      `[result transcript=${transcriptRunId} player=${playerId} requestTick=${requestTick}]`,
      "--- result ---",
      `executeTick=${executeTick}`,
      `stopReason=${result.stopReason}`,
      "--- commands ---",
      result.commands.length > 0 ? JSON.stringify(result.commands, null, 2) : "(none)",
      "--- plans ---",
      result.plans.length > 0 ? JSON.stringify(result.plans, null, 2) : "(none)",
      "--- metrics ---",
      JSON.stringify(result.metrics, null, 2),
      "==========",
      "",
    ].join("\n");
  }

  private maybeLogAIRuntimePerformance(
    playerId: PlayerId,
    requestTick: number,
    elapsedMs: number,
    timings: Record<string, number>,
    result?: AgentRuntimeResult
  ): void {
    const slowSyncPhase = Object.entries(timings).find(([phase, durationMs]) => {
      if (phase === "runtimeMs") {
        return false;
      }
      return durationMs > AI_RUNTIME_SYNC_PHASE_WARNING_MS;
    });
    const shouldWarn = elapsedMs > AI_RUNTIME_TOTAL_WARNING_MS || Boolean(slowSyncPhase);
    const now = performance.now();
    const lastWarningAtMs = this.lastAIRuntimeWarningAtMs[playerId] ?? 0;

    if (!shouldWarn || now - lastWarningAtMs <= AI_RUNTIME_WARNING_THROTTLE_MS) {
      return;
    }

    this.lastAIRuntimeWarningAtMs[playerId] = now;
    this.game.addLog(LOG_TYPES.PERF_WARNING, `AI runtime for ${playerId} took ${Math.round(elapsedMs)}ms`, {
      scope: "ai_runtime",
      phase: slowSyncPhase?.[0] ?? "run",
      elapsedMs: Math.round(elapsedMs),
      requestTick,
      playerId,
      details: {
        timings: Object.fromEntries(
          Object.entries(timings).map(([phase, durationMs]) => [phase, Math.round(durationMs)])
        ),
        stopReason: result?.stopReason,
        modelRequests: result?.metrics.modelRequests,
        toolCalls: result?.metrics.toolCalls,
        commands: result?.commands.length,
        plans: result?.plans.length,
        assistantMessages: result?.assistantMessages.length,
      },
    });
  }

  private async writeTranscriptRequestStart(
    transcriptRunId: string,
    playerId: PlayerId,
    requestTick: number,
    input: AgentRunInput
  ): Promise<void> {
    if (!this.transcriptEnabled || !this.transcriptFilePath) {
      return;
    }

    await this.writeTranscript(this.formatTranscriptRequestStart(transcriptRunId, playerId, requestTick, input));
  }

  private async writeTranscriptAssistantMessage(
    transcriptRunId: string,
    playerId: PlayerId,
    requestTick: number,
    message: string
  ): Promise<void> {
    if (!this.transcriptEnabled || !this.transcriptFilePath) {
      return;
    }

    await this.writeTranscript(this.formatTranscriptAssistantMessage(transcriptRunId, playerId, requestTick, message));
  }

  private async writeTranscriptToolCall(
    transcriptRunId: string,
    playerId: PlayerId,
    requestTick: number,
    toolCall: AgentToolCallRecord
  ): Promise<void> {
    if (!this.transcriptEnabled || !this.transcriptFilePath) {
      return;
    }

    await this.writeTranscript(this.formatTranscriptToolCall(transcriptRunId, playerId, requestTick, toolCall));
  }

  private async writeTranscriptRunComplete(
    transcriptRunId: string,
    playerId: PlayerId,
    requestTick: number,
    executeTick: number,
    result: AgentRuntimeResult
  ): Promise<void> {
    if (!this.transcriptEnabled || !this.transcriptFilePath) {
      return;
    }

    await this.writeTranscript(this.formatTranscriptRunComplete(transcriptRunId, playerId, requestTick, executeTick, result));
  }

  private async writeTranscript(content: string): Promise<void> {
    if (!this.transcriptEnabled || !this.transcriptFilePath) {
      return;
    }

    this.transcriptWriteChain = this.transcriptWriteChain.then(async () => {
      await fs.mkdir(path.dirname(this.transcriptFilePath!), { recursive: true });
      await fs.appendFile(this.transcriptFilePath!, content, "utf8");
    });

    await this.transcriptWriteChain;
  }
}
