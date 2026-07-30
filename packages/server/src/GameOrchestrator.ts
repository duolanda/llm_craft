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
  LOG_TYPES,
  LOG_LEVELS,
  LOG_DISPLAY_TARGETS,
  AIFeedbackTarget,
  type MatchRecordingOptions,
  type Command,
} from "@llmcraft/shared";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Game } from "./Game";
import { SubAgentParentContext } from "./LLMProvider";
import { createSystemPrompt } from "./SystemPrompt";
import { GameplayController } from "./controller/GameplayController";
import type { AgentRuntimeResult } from "./agent/AgentRuntime";
import { SubAgentTaskRegistry, SubAgentRunner, SpawnAgentInput } from "./agent/SubAgentTaskRegistry";
import { getHQUnderAttackAlertFromGameState } from "./HQAlert";
import { MatchRuntime } from "./MatchRuntime";
import { MatchRecorder } from "./MatchRecorder";
import type { MatchDefinition } from "./MatchDefinition";
import type { RegisteredMatchStatus } from "./MatchRegistry";
import type { DecisionController } from "./controller/DecisionController";
import { createDecisionController } from "./controller/createDecisionController";
import {
  isCPUDecisionTick,
  resolveCPUDecisionIntervalTicks,
} from "./controller/CPUDecisionSchedule";

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE_PATH);
const SERVER_PACKAGE_DIR = path.resolve(CURRENT_DIR, "..");
const RECORDS_DIR = path.resolve(SERVER_PACKAGE_DIR, "logs", "records");
export const MATCH_START_ABORTED = "MATCH_START_ABORTED";
const AI_RUNTIME_TOTAL_WARNING_MS = 5000;
const AI_RUNTIME_SYNC_PHASE_WARNING_MS = 150;
const AI_RUNTIME_WARNING_THROTTLE_MS = 2000;
const MAX_TERMINAL_EVENTS = 500;

type ControllerMap = Record<PlayerId, DecisionController>;
type GameplayControllerMap = Record<PlayerId, GameplayController>;

export interface AITerminalFeed {
  sessionId: string;
  events: AITerminalEvent[];
  latestSequence: number;
  reset: boolean;
  hasMore: boolean;
}

export interface GameOrchestratorRuntimeOptions {
  recordDir?: string;
  matchDefinition?: MatchDefinition;
  /** Applies only to built-in CPU controllers. */
  decisionIntervalTicks?: number;
}

export type GameOrchestratorConfig = MatchLLMConfig & {
  runtime?: GameOrchestratorRuntimeOptions;
};

export class GameOrchestrator {
  private game: Game;
  private readonly matchRuntime: MatchRuntime;
  private controllerByPlayer: ControllerMap;
  private readonly systemPromptByPlayer: Record<PlayerId, string>;
  private gameplayControllerByPlayer: GameplayControllerMap;
  private readonly cpuDecisionIntervalTicks: number;
  private lastAIDispatchTick = { player_1: -1, player_2: -1 };
  private isRunningAI = { player_1: false, player_2: false };
  private activeRunControllers: Partial<Record<PlayerId, AbortController>> = {};
  private warmupController: AbortController | null = null;
  private isStarted = false;
  private isWarmingUp = false;
  private unsubscribeTick: (() => void) | null = null;
  private unsubscribeEnded: (() => void) | null = null;
  private runSession = 0;
  private startedAt = new Date().toISOString();
  private readonly recorder: MatchRecorder;
  private readonly recording: MatchRecordingOptions;
  private readonly savedAITurns: SavedAITurnRecord[] = [];
  private aiTerminalSessionId = `terminal-${this.startedAt.replace(/[:.]/g, "-")}`;
  private aiTerminalEvents: AITerminalEvent[] = [];
  private aiTerminalEventSequence = 0;
  private aiRequestCounts = { player_1: 0, player_2: 0 };
  private warmupRequestNumbers: Partial<Record<PlayerId, number>> = {};
  private subAgentTaskRegistry = new SubAgentTaskRegistry();
  private lastAIRuntimeWarningAtMs: Partial<Record<PlayerId, number>> = {};

  constructor(config: GameOrchestratorConfig) {
    const recordDir = config.runtime?.recordDir ?? RECORDS_DIR;
    this.cpuDecisionIntervalTicks = resolveCPUDecisionIntervalTicks(
      config.runtime?.decisionIntervalTicks,
    );
    this.matchRuntime = new MatchRuntime({
      definition: config.runtime?.matchDefinition,
    });
    this.recorder = new MatchRecorder(this.matchRuntime, recordDir);
    this.game = this.matchRuntime.getGame();
    this.recording = {
      profile: config.debug?.recordingProfile ?? "evaluation",
      includeTranscript: config.debug?.includeTranscript ?? false,
    };
    this.gameplayControllerByPlayer = {
      player_1: new GameplayController(this.game, PLAYER_IDS.PLAYER_1, {
        submitCommands: (commands, options) => this.submitCommands(PLAYER_IDS.PLAYER_1, commands, options),
      }),
      player_2: new GameplayController(this.game, PLAYER_IDS.PLAYER_2, {
        submitCommands: (commands, options) => this.submitCommands(PLAYER_IDS.PLAYER_2, commands, options),
      }),
    };
    const definition = this.matchRuntime.getDefinition();
    this.systemPromptByPlayer = {
      player_1: createSystemPrompt(definition, PLAYER_IDS.PLAYER_1),
      player_2: createSystemPrompt(definition, PLAYER_IDS.PLAYER_2),
    };
    this.controllerByPlayer = {
      player_1: createDecisionController(PLAYER_IDS.PLAYER_1, config.player1, this.gameplayControllerByPlayer.player_1, this.systemPromptByPlayer.player_1),
      player_2: createDecisionController(PLAYER_IDS.PLAYER_2, config.player2, this.gameplayControllerByPlayer.player_2, this.systemPromptByPlayer.player_2),
    };
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
    if (this.isWarmingUp) return "warming_up";
    const status = this.matchRuntime.getStatus();
    if (status === "created") return "waiting_for_players";
    return status;
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
    const upperBound = beforeSequence ?? Number.POSITIVE_INFINITY;
    const pageSize = Math.max(1, Math.min(limit ?? 100, 500));
    const eligible = this.aiTerminalEvents
      .filter((event) => this.getTerminalEventSequence(event) < upperBound);
    const events = eligible.slice(-pageSize);
    return Promise.resolve({
      events: structuredClone(events),
      hasMore: eligible.length > events.length,
    });
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
    let controllerDescriptor: ReturnType<DecisionController["getDescriptor"]> | undefined;
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
      if (warmupRequestNumber === undefined) {
        this.appendTerminalRequestEvent(playerId, requestNumber, state.tick);
      }
      let callbackSyncMs = 0;
      const runtimeStartedAt = performance.now();
      const result = await controllerRuntime.run(runInput, {
        runContext: {
          turnId,
          controllerId: controllerDescriptor.controllerId,
        },
        onAssistantMessage: (message) => {
          const callbackStartedAt = performance.now();
          this.appendTerminalAssistantEvent(playerId, requestNumber, state.tick, message);
          callbackSyncMs += performance.now() - callbackStartedAt;
        },
        onToolCall: (record) => {
          observedToolCalls.push(structuredClone(record));
          const callbackStartedAt = performance.now();
          this.appendTerminalToolCallEvent(playerId, requestNumber, state.tick, record);
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
      this.maybeLogAIRuntimePerformance(playerId, state.tick, performance.now() - runStartedAt, timings, result);
      const createdAt = new Date().toISOString();
      this.savedAITurns.push({
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
      if (!this.isStarted || sessionId !== this.runSession) {
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
        this.savedAITurns.push({
          turnId,
          controllerId: controllerDescriptor.controllerId,
          decisionKind: "macro",
          playerId,
          requestTick,
          executeTick: this.game.getState().tick,
          runInput,
          assistantMessages: [],
          toolCalls: observedToolCalls,
          plans: this.gameplayControllerByPlayer[playerId].takeRunPlans(),
          commands: this.gameplayControllerByPlayer[playerId].takeIssuedCommands(),
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
    } finally {
      delete this.warmupRequestNumbers[playerId];
      delete this.activeRunControllers[playerId];
      this.isRunningAI[playerId] = false;
    }
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    this.runSession++;
    const sessionId = this.runSession;
    this.isStarted = true;
    this.unsubscribeTick = this.matchRuntime.onTickCommitted((state) => {
      this.handleCommittedTick(state, sessionId);
    });
    this.unsubscribeEnded = this.matchRuntime.onEnded(() => {
      this.handleRuntimeEnded(sessionId);
    });
    this.matchRuntime.start();
    this.dispatchControllersForState(this.game.getState(), sessionId);
  }

  waitForEnd() {
    return this.matchRuntime.waitForEnd();
  }

  private handleCommittedTick(state: GameState, sessionId: number): void {
    if (!this.isStarted || sessionId !== this.runSession) return;
    for (const playerId of [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2]) {
      this.submitCommands(playerId, this.gameplayControllerByPlayer[playerId].handleCommittedTick());
    }
    if (!state.winner) this.dispatchControllersForState(state, sessionId);
  }

  private dispatchControllersForState(state: GameState, sessionId: number): void {
    for (const playerId of [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2]) {
      if (
        !this.isRunningAI[playerId]
        && this.isDecisionDue(playerId, state.tick)
      ) {
        void this.runAI(playerId, sessionId);
      }
    }
  }

  private isDecisionDue(playerId: PlayerId, tick: number): boolean {
    const lastDispatchTick = this.lastAIDispatchTick[playerId];
    if (this.controllerByPlayer[playerId].getDescriptor().kind === "llm") {
      return lastDispatchTick < tick;
    }
    return isCPUDecisionTick(tick, lastDispatchTick, this.cpuDecisionIntervalTicks);
  }

  private handleRuntimeEnded(sessionId: number): void {
    if (sessionId !== this.runSession) return;
    this.isStarted = false;
    this.unsubscribeRuntimeEvents();
    this.activeRunControllers.player_1?.abort();
    this.activeRunControllers.player_2?.abort();
    this.subAgentTaskRegistry.abortAll();
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
    this.isStarted = false;
    this.isWarmingUp = false;
    this.runSession++;
    this.warmupController?.abort();
    this.activeRunControllers.player_1?.abort();
    this.activeRunControllers.player_2?.abort();
    this.subAgentTaskRegistry.abortAll();
    this.unsubscribeRuntimeEvents();
    this.matchRuntime.stop();
  }

  private unsubscribeRuntimeEvents(): void {
    this.unsubscribeTick?.();
    this.unsubscribeEnded?.();
    this.unsubscribeTick = null;
    this.unsubscribeEnded = null;
  }

  async quiesce(): Promise<void> {
    this.stop();
    for (let attempt = 0; attempt < 3_000; attempt++) {
      if (
        !this.isRunningAI.player_1
        && !this.isRunningAI.player_2
        && this.warmupController === null
      ) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for agent work to quiesce before saving the Match Record.");
  }

  async warmup(warmup: Partial<Record<PlayerId, boolean>>): Promise<void> {
    if (this.isStarted) {
      throw new Error("MATCH_ALREADY_RUNNING");
    }
    if (this.isWarmingUp) {
      return;
    }

    this.runSession++;
    const sessionId = this.runSession;
    this.isWarmingUp = true;
    try {
      await this.runWarmups(sessionId, warmup);
    } finally {
      if (sessionId === this.runSession) {
        this.isWarmingUp = false;
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
    if (!this.isWarmingUp || sessionId !== this.runSession || signal.aborted) {
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
      if (result.stopReason === "aborted" || !this.isWarmingUp || sessionId !== this.runSession) {
        throw new Error(MATCH_START_ABORTED);
      }
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.message === MATCH_START_ABORTED)) {
        throw new Error(MATCH_START_ABORTED);
      }

      throw new Error(`模型预热失败（${playerId === PLAYER_IDS.PLAYER_1 ? "红方" : "蓝方"}）: ${this.formatErrorMessage(error)}`);
    }
  }

  async saveRecord(): Promise<string> {
    if (this.game.getWinner() || !this.game.isGameRunning()) {
      await this.quiesce();
    }
    return this.recorder.save({
      startedAt: this.startedAt,
      recording: this.recording,
      systemPrompt: JSON.stringify(this.systemPromptByPlayer),
      players: [
        {
          playerId: PLAYER_IDS.PLAYER_1,
          model: this.getDecisionControllerDescriptor(PLAYER_IDS.PLAYER_1).model ?? "unknown",
          baseURL: this.getDecisionControllerDescriptor(PLAYER_IDS.PLAYER_1).baseURL,
        },
        {
          playerId: PLAYER_IDS.PLAYER_2,
          model: this.getDecisionControllerDescriptor(PLAYER_IDS.PLAYER_2).model ?? "unknown",
          baseURL: this.getDecisionControllerDescriptor(PLAYER_IDS.PLAYER_2).baseURL,
        },
      ],
      aiTurns: structuredClone(this.savedAITurns),
    });
  }

  private buildRunInput(playerId: PlayerId, state: GameState): AgentRunInput {
    const tickIntervalMs = this.matchRuntime.getDefinition().tickIntervalMs;
    const me = state.players.find((player) => player.id === playerId)!;
    const enemy = state.players.find((player) => player.id !== playerId)!;
    const myHQ = me.buildings.find((building) => building.type === "hq");
    const enemyHQ = enemy.buildings.find((building) => building.type === "hq");
    const recentFeedback = this.game
      .getAIFeedback(playerId, this.lastAIDispatchTick[playerId])
      .slice(-5)
      .map((log) => log.message);

    const summaryLines = [
      `tick=${state.tick}, intervalMs=${tickIntervalMs}`,
      `myCredits=${me.resources.credits}, myWorkers=${me.units.filter((unit) => unit.type === "worker" && unit.exists).length}, mySoldiers=${me.units.filter((unit) => unit.type === "soldier" && unit.exists).length}`,
      `enemyWorkers=${enemy.units.filter((unit) => unit.type === "worker" && unit.exists).length}, enemySoldiers=${enemy.units.filter((unit) => unit.type === "soldier" && unit.exists).length}`,
      myHQ ? `myHQHp=${myHQ.hp}/${myHQ.maxHp}` : "myHQMissing=true",
      enemyHQ ? `enemyHQHp=${enemyHQ.hp}/${enemyHQ.maxHp}` : "enemyHQMissing=true",
      `activePlans=${this.gameplayControllerByPlayer[playerId].getActivePlans().length}`,
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
      tickIntervalMs,
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

  private getDecisionControllerDescriptor(playerId: PlayerId) {
    return this.controllerByPlayer[playerId].getDescriptor();
  }

  private formatErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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

}
