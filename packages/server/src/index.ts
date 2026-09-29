import * as dotenv from "dotenv";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AITerminalEvent,
  ClientMessage,
  ClientStartBenchmarkMessage,
  CreateLLMPresetRequest,
  CreateStrategyPromptRequest,
  DEFAULT_CPU_DECISION_INTERVAL_TICKS,
  GameSnapshot,
  GameState,
  LiveMatchSetupSnapshot,
  LiveStateProjectionFrame,
  LiveStateSnapshot,
  MatchDebugOptions,
  MatchLLMConfig,
  MatchPromptSelection,
  MatchPromptSnapshot,
  MatchRegistryKind,
  MatchWarmupState,
  MatchWarmupOptions,
  OpenAICompatibleRuntimeConfig,
  PlayerId,
  PLAYER_IDS,
  GameLogDataMap,
  LOG_TYPES,
  MAX_CPU_DECISION_INTERVAL_TICKS,
  MIN_CPU_DECISION_INTERVAL_TICKS,
  ServerWarmupStatusMessage,
  ServerPromptReflectionStatusMessage,
  ServerMessage,
  TestLLMPresetRequest,
  TestLLMPresetResponse,
  UpdateLLMPresetRequest,
  UpdateStrategyPromptRequest,
  isClientMessage,
} from "@llmcraft/shared";
import {
  createLiveStateProjectionDelta,
  createLiveStateSnapshot,
} from "@llmcraft/record";
import WebSocket, { WebSocketServer } from "ws";
import { GameOrchestrator, GameOrchestratorConfig, MATCH_START_ABORTED } from "./GameOrchestrator";
import { BUILTIN_PRESET_SECRET, PresetStore } from "./PresetStore";
import {
  PromptStore,
  STRATEGY_PROMPT_CONTENT_MAX_LENGTH,
  STRATEGY_PROMPT_NAME_MAX_LENGTH,
  type ResolvedStrategyPrompt,
} from "./PromptStore";
import { describePromptReflectionError, type PromptReflectionOptions, type PromptReflectionResult } from "./PromptReflection";
import { classifyModelRequestError } from "./agent/ModelRequestRetry";
import { getPromptProvenance } from "./PromptProvenance";
import { BenchmarkOrchestrator } from "./benchmark/BenchmarkOrchestrator";
import { createLLMProvider } from "./createLLMProvider";
import { ControlSessionManager } from "./ControlHandler";
import { handleControlHttpRequest } from "./control/ControlRoutes";
import {
  MatchRegistry,
  type MatchRegistration,
  type RegisteredMatchHandle,
  type RegisteredMatchStatus,
} from "./MatchRegistry";
import { isSupportedRecordFileName, readRecordJsonText, recordFileEncoding } from "./RecordFile";
import {
  MAX_WEBSOCKET_BUFFERED_BYTES,
  shouldDeferLatestProjection,
} from "./WebSocketBackpressure";

dotenv.config();

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE_PATH);
const SERVER_PACKAGE_DIR = path.resolve(CURRENT_DIR, "..");
const WORKSPACE_ROOT = path.resolve(SERVER_PACKAGE_DIR, "..", "..");

const PORT = parseInt(process.env.PORT || "3101", 10);
const RECORDS_DIR = path.resolve(SERVER_PACKAGE_DIR, "logs", "records");
const VALID_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const FORBIDDEN_EXTRA_REQUEST_PARAMS = new Set(["model", "messages", "tools", "tool_choice", "stream", "signal"]);
const BROADCAST_TOTAL_WARNING_MS = 250;
const BROADCAST_PHASE_WARNING_MS = 150;
const BROADCAST_BUFFERED_WARNING_BYTES = MAX_WEBSOCKET_BUFFERED_BYTES;
const BROADCAST_PERF_WARNING_THROTTLE_MS = 2000;

export function getDefaultPresetPaths() {
  return {
    filePath: path.resolve(SERVER_PACKAGE_DIR, "data", "llm-presets.json"),
  };
}

export function getDefaultPromptPaths() {
  return {
    filePath: path.resolve(SERVER_PACKAGE_DIR, "data", "strategy-prompts.json"),
  };
}

const { filePath: PRESETS_FILE } = getDefaultPresetPaths();
const { filePath: PROMPTS_FILE } = getDefaultPromptPaths();

interface OrchestratorLike {
  getMatchId?(): string;
  getMatchStatus?(): RegisteredMatchStatus;
  warmup?(warmup: MatchWarmupOptions): Promise<void>;
  start(): Promise<void>;
  stop(): void;
  quiesce?: () => Promise<void>;
  waitForEnd?: () => Promise<{ status: string; state: GameState }>;
  reflectPrompt?: (playerId: PlayerId, options?: PromptReflectionOptions) => Promise<PromptReflectionResult>;
  saveRecord(): Promise<string>;
  getAITerminalFeed?: (sinceSequence?: number) => {
    sessionId: string;
    events: AITerminalEvent[];
    latestSequence: number;
    reset: boolean;
    hasMore: boolean;
  };
  getTerminalHistory?: (beforeSequence?: number, limit?: number) => Promise<{
    events: AITerminalEvent[];
    hasMore: boolean;
  }>;
  getGame(): {
    getState(): GameState | null;
    getTick?: () => number;
    getLogsTail?: (sinceCount: number) => { total: number; logs: GameState["logs"] };
    getAIOutputs?: () => Record<string, string>;
    getLatestSnapshot?: () => GameSnapshot | null;
    getDefinition?: () => { tickIntervalMs: number };
    addLog?: (
      type: typeof LOG_TYPES.PERF_WARNING,
      message: string,
      data: GameLogDataMap[typeof LOG_TYPES.PERF_WARNING]
    ) => unknown;
  };
}

interface BenchmarkCoordinatorLike {
  start(): Promise<void>;
  stop(): void;
  isRunning(): boolean;
  setWebSocket?(ws: Pick<WebSocket, "send"> | null): void;
}

export interface ServerState {
  presetStore: PresetStore;
  promptStore: PromptStore;
  matchRegistry: MatchRegistry;
  warmupMatch: {
    signature: string;
    matchId: string;
  } | null;
  activeBenchmark: BenchmarkCoordinatorLike | null;
  promptReflectionStatuses: Map<string, ServerPromptReflectionStatusMessage>;
  promptReflectionControllers: Map<string, AbortController>;
  controlSessions: ControlSessionManager;
  createOrchestrator: (config: GameOrchestratorConfig) => OrchestratorLike;
  createBenchmarkOrchestrator: (
    config: {
      presetId: string;
      llmConfig: OpenAICompatibleRuntimeConfig;
      cpuStrategy: ClientStartBenchmarkMessage["cpuStrategy"];
      rounds: number;
      decisionIntervalTicks?: number;
      recordReplay: boolean;
      concurrency?: number;
      debug?: ClientStartBenchmarkMessage["debug"];
    },
    ws: Pick<WebSocket, "send"> | null
  ) => BenchmarkCoordinatorLike;
  liveEnabled: boolean | null;
}

export function resolvePresetSecret(): string {
  return BUILTIN_PRESET_SECRET;
}

export function createPresetStore(options?: {
  filePath?: string;
}): PresetStore {
  return new PresetStore({
    filePath: options?.filePath || PRESETS_FILE,
    encryptionSecret: resolvePresetSecret(),
  });
}

export function createPromptStore(options?: { filePath?: string }): PromptStore {
  return new PromptStore({ filePath: options?.filePath || PROMPTS_FILE });
}

export function createServerState(
  presetStore: PresetStore,
  createOrchestrator?: (config: GameOrchestratorConfig) => OrchestratorLike,
  createBenchmarkOrchestrator?: ServerState["createBenchmarkOrchestrator"],
  promptStore: PromptStore = createPromptStore(),
): ServerState {
  const matchRegistry = new MatchRegistry();
  const orchestratorFactory = createOrchestrator ?? ((config: GameOrchestratorConfig) => new GameOrchestrator(config));
  return {
    presetStore,
    promptStore,
    matchRegistry,
    warmupMatch: null,
    activeBenchmark: null,
    promptReflectionStatuses: new Map(),
    promptReflectionControllers: new Map(),
    controlSessions: new ControlSessionManager(),
    createOrchestrator: orchestratorFactory,
    createBenchmarkOrchestrator: createBenchmarkOrchestrator
      ?? ((config, ws) => new BenchmarkOrchestrator(
        config,
        ws,
        undefined,
        matchRegistry,
      )),
    liveEnabled: null,
  };
}

const orchestratorAdapters = new WeakMap<object, OrchestratorLike & RegisteredMatchHandle>();

function asRegisteredMatchHandle(orchestrator: OrchestratorLike): OrchestratorLike & RegisteredMatchHandle {
  if (orchestrator.getMatchId) {
    return orchestrator as OrchestratorLike & RegisteredMatchHandle;
  }
  const existing = orchestratorAdapters.get(orchestrator);
  if (existing) return existing;
  const matchId = `match_${randomUUID()}`;
  const adapter: OrchestratorLike & RegisteredMatchHandle = {
    getMatchId: () => matchId,
    getMatchStatus: orchestrator.getMatchStatus
      ? () => orchestrator.getMatchStatus!()
      : undefined,
    warmup: orchestrator.warmup ? (options) => orchestrator.warmup!(options) : undefined,
    start: () => orchestrator.start(),
    stop: () => orchestrator.stop(),
    quiesce: orchestrator.quiesce ? () => orchestrator.quiesce!() : undefined,
    waitForEnd: orchestrator.waitForEnd ? () => orchestrator.waitForEnd!() : undefined,
    reflectPrompt: orchestrator.reflectPrompt
      ? (playerId, options) => orchestrator.reflectPrompt!(playerId, options)
      : undefined,
    saveRecord: () => orchestrator.saveRecord(),
    getGame: () => orchestrator.getGame(),
    getAITerminalFeed: orchestrator.getAITerminalFeed
      ? (sinceSequence) => orchestrator.getAITerminalFeed!(sinceSequence)
      : undefined,
    getTerminalHistory: orchestrator.getTerminalHistory
      ? (beforeSequence, limit) => orchestrator.getTerminalHistory!(beforeSequence, limit)
      : undefined,
  };
  orchestratorAdapters.set(orchestrator, adapter);
  return adapter;
}

function registerOrchestrator(
  state: ServerState,
  orchestrator: OrchestratorLike,
  registration: MatchRegistration,
): OrchestratorLike & RegisteredMatchHandle {
  const handle = asRegisteredMatchHandle(orchestrator);
  state.matchRegistry.register(handle, registration);
  return handle;
}

function getRegisteredOrchestrator(state: ServerState, matchId: string): OrchestratorLike | null {
  const entry = state.matchRegistry.get(matchId);
  return entry ? entry.handle as OrchestratorLike : null;
}

function getActiveLiveMatch(state: ServerState) {
  return state.matchRegistry.list()
    .find((match) => (
      match.kind === "live"
      && (match.status === "warming_up"
        || match.status === "waiting_for_players"
        || match.status === "running")
    )) ?? null;
}

function promptReflectionKey(matchId: string, playerId: PlayerId): string {
  return `${matchId}:${playerId}`;
}

type StateMessagePayload = {
  type: "state";
  frame: LiveStateProjectionFrame | null;
  liveEnabled: boolean;
  observedMatch: {
    matchId: string;
    kind: MatchRegistryKind;
    recordingEnabled: boolean;
    setup?: LiveMatchSetupSnapshot;
    promptReflections?: Partial<Record<PlayerId, ServerPromptReflectionStatusMessage>>;
  } | null;
  matchStatus: RegisteredMatchStatus | null;
  benchmarkRunning: boolean;
};

type AITerminalMessagePayload = {
  type: "ai_terminal_events";
  sessionId: string | null;
  reset: boolean;
  events: AITerminalEvent[];
  hasMore: boolean;
};

async function refreshLiveEnabled(state: ServerState): Promise<boolean> {
  const presets = await state.presetStore.list();
  state.liveEnabled = presets.length > 0;
  return state.liveEnabled;
}

export function buildStateMessagePayload(
  state: ServerState,
  options: {
    frameSequence?: number;
    baseFrameSequence?: number;
    previousState?: LiveStateSnapshot | null;
    forceKeyframe?: boolean;
    snapshot?: LiveStateSnapshot | null;
  } = {},
): StateMessagePayload {
  const currentMatch = state.matchRegistry.getObserved();
  const game = currentMatch?.handle.getGame();
  // Callers that already hold a live snapshot for this tick pass it in so a
  // broadcast does not deep-clone the whole world more than once per tick.
  const fetchedState = options.snapshot === undefined ? game?.getState() ?? null : null;
  const currentSnapshot = options.snapshot !== undefined
    ? options.snapshot
    : fetchedState
      ? createLiveStateSnapshot(fetchedState)
      : null;
  const frameSequence = options.frameSequence ?? 1;
  const tickIntervalMs = game?.getDefinition?.().tickIntervalMs ?? 500;
  const metadata = currentSnapshot ? {
    frameSequence,
    simulationTick: currentSnapshot.tick,
    simulationTimeMs: currentSnapshot.tick * tickIntervalMs,
    tickIntervalMs,
  } : null;
  const keyframe = Boolean(currentSnapshot) && (
    options.forceKeyframe === true
    || !options.previousState
    || options.baseFrameSequence === undefined
    || frameSequence % 20 === 1
  );
  const frame: LiveStateProjectionFrame | null = !currentSnapshot || !metadata
    ? null
    : keyframe
      ? { kind: "keyframe", metadata, state: currentSnapshot }
      : {
          kind: "delta",
          metadata,
          baseFrameSequence: options.baseFrameSequence!,
          delta: createLiveStateProjectionDelta(options.previousState!, currentSnapshot),
        };

  return {
    type: "state",
    frame,
    liveEnabled: Boolean(state.liveEnabled),
    observedMatch: currentMatch
      ? {
          matchId: currentMatch.matchId,
          kind: currentMatch.kind,
          recordingEnabled: currentMatch.terminalPolicy !== "none",
          ...(currentMatch.liveSetup ? { setup: currentMatch.liveSetup } : {}),
          ...buildPromptReflectionSnapshot(state, currentMatch.matchId),
        }
      : null,
    matchStatus: currentMatch?.handle.getMatchStatus?.() ?? null,
    benchmarkRunning: state.activeBenchmark?.isRunning() ?? false,
  };
}

function buildPromptReflectionSnapshot(
  state: ServerState,
  matchId: string,
): { promptReflections?: Partial<Record<PlayerId, ServerPromptReflectionStatusMessage>> } {
  const promptReflections = Object.fromEntries(
    [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2]
      .map((playerId) => [playerId, state.promptReflectionStatuses.get(promptReflectionKey(matchId, playerId))] as const)
      .filter((entry): entry is readonly [PlayerId, ServerPromptReflectionStatusMessage] => Boolean(entry[1])),
  );
  return Object.keys(promptReflections).length > 0 ? { promptReflections } : {};
}

function buildAITerminalMessagePayload(
  sessionId: string | null,
  reset: boolean,
  events: AITerminalEvent[],
  hasMore = false,
): AITerminalMessagePayload {
  return {
    type: "ai_terminal_events",
    sessionId,
    reset,
    events,
    hasMore,
  };
}

function projectLiveLog(log: GameState["logs"][number]) {
  return {
    tick: log.tick,
    type: log.type,
    message: log.message,
    meta: {
      level: log.meta.level,
      owner: log.meta.owner,
    },
  };
}

function buildMatchSignature(input: {
  player1PresetId: string;
  player2PresetId: string;
  prompts?: Partial<Record<PlayerId, MatchPromptSelection>>;
  promptReflection?: Partial<Record<PlayerId, boolean>>;
  debug?: MatchDebugOptions;
}): string {
  const prompts = Object.fromEntries(
    [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2]
      .filter((playerId) => Boolean(input.prompts?.[playerId]))
      .map((playerId) => {
        const selection = input.prompts![playerId]!;
        return [playerId, {
          promptId: selection.promptId,
          versionId: selection.versionId,
        }];
      }),
  );
  const promptReflection = normalizePromptReflection(input.promptReflection);
  return JSON.stringify({
    player1PresetId: input.player1PresetId,
    player2PresetId: input.player2PresetId,
    prompts: Object.keys(prompts).length > 0 ? prompts : null,
    promptReflection: Object.keys(promptReflection).length > 0 ? promptReflection : null,
    debug: input.debug ?? null,
  });
}

function buildLiveMatchSetup(input: {
  player1PresetId: string;
  player2PresetId: string;
  promptReflection?: Partial<Record<PlayerId, boolean>>;
  debug?: MatchDebugOptions;
}, prompts: Partial<Record<PlayerId, MatchPromptSnapshot>>): LiveMatchSetupSnapshot {
  const recordingProfile = input.debug?.recordingProfile ?? "evaluation";
  const promptReflection = normalizePromptReflection(input.promptReflection);
  return {
    player1PresetId: input.player1PresetId,
    player2PresetId: input.player2PresetId,
    ...(Object.keys(prompts).length > 0 ? { prompts } : {}),
    ...(Object.keys(promptReflection).length > 0 ? { promptReflection } : {}),
    recordingProfile,
    includeTranscript: recordingProfile === "evaluation" && Boolean(input.debug?.includeTranscript),
  };
}

function normalizePromptReflection(
  input?: Partial<Record<PlayerId, boolean>>,
): Partial<Record<PlayerId, boolean>> {
  return Object.fromEntries(
    [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2]
      .filter((playerId) => input?.[playerId] === true)
      .map((playerId) => [playerId, true]),
  );
}

interface ResolvedMatchPrompts {
  configured: GameOrchestratorConfig["strategyPrompts"];
  snapshots: Partial<Record<PlayerId, MatchPromptSnapshot>>;
  byPlayer: Partial<Record<PlayerId, ResolvedStrategyPrompt>>;
}

async function resolveMatchPrompts(
  promptStore: PromptStore,
  selections?: Partial<Record<PlayerId, MatchPromptSelection>>,
): Promise<ResolvedMatchPrompts> {
  const byPlayer: Partial<Record<PlayerId, ResolvedStrategyPrompt>> = {};
  for (const playerId of [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2]) {
    const selection = selections?.[playerId];
    if (!selection) continue;
    if (
      typeof selection.promptId !== "string"
      || !selection.promptId.trim()
      || typeof selection.versionId !== "string"
      || !selection.versionId.trim()
    ) {
      throw new Error("PROMPT_SELECTION_INVALID");
    }
    byPlayer[playerId] = await promptStore.resolve({
      promptId: selection.promptId,
      versionId: selection.versionId,
    });
  }

  const configured = Object.fromEntries(
    Object.entries(byPlayer).map(([playerId, prompt]) => [playerId, {
      content: prompt.content,
      snapshot: prompt.snapshot,
    }]),
  ) as GameOrchestratorConfig["strategyPrompts"];
  const snapshots = Object.fromEntries(
    Object.entries(byPlayer).map(([playerId, prompt]) => [playerId, prompt.snapshot]),
  ) as Partial<Record<PlayerId, MatchPromptSnapshot>>;
  return { configured, snapshots, byPlayer };
}

function withResolvedPrompts(
  config: MatchLLMConfig,
  prompts: ResolvedMatchPrompts,
): GameOrchestratorConfig {
  return Object.keys(prompts.configured ?? {}).length > 0
    ? { ...config, strategyPrompts: prompts.configured }
    : config;
}

function liveTerminalPolicy(debug?: MatchDebugOptions): "save" | "none" {
  return debug?.recordingProfile === "off" ? "none" : "save";
}

function sendWarmupStatus(
  ws: Pick<WebSocket, "send">,
  statuses: Partial<Record<PlayerId, MatchWarmupState>>,
  message?: string
): void {
  ws.send(JSON.stringify({
    type: "warmup_status",
    statuses,
    message,
  } satisfies ServerWarmupStatusMessage));
}

function normalizeWarmupOptions(warmup?: MatchWarmupOptions): MatchWarmupOptions {
  return {
    player_1: Boolean(warmup?.player_1),
    player_2: Boolean(warmup?.player_2),
  };
}

function setCorsHeaders(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return JSON.parse(raw || "{}") as T;
}

function normalizePresetRpm(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error("RPM 必须是正整数，留空表示不限制。");
  }
  return value;
}

function normalizeReasoningEffort(value: unknown): CreateLLMPresetRequest["reasoningEffort"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !VALID_REASONING_EFFORTS.has(value)) {
    throw new Error("reasoning_effort 必须是 minimal、low、medium、high、xhigh 或留空。");
  }
  return value as CreateLLMPresetRequest["reasoningEffort"];
}

function normalizeExtraRequestParams(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("高级请求参数必须是 JSON object。");
  }

  const params = value as Record<string, unknown>;
  for (const key of Object.keys(params)) {
    if (FORBIDDEN_EXTRA_REQUEST_PARAMS.has(key)) {
      throw new Error(`高级请求参数不能覆盖 ${key}。`);
    }
  }

  return Object.keys(params).length > 0 ? params : null;
}

function validateCreatePresetRequest(body: CreateLLMPresetRequest): CreateLLMPresetRequest {
  if (!body.name?.trim()) {
    throw new Error("预设名称不能为空。");
  }
  if (!body.baseURL?.trim()) {
    throw new Error("Base URL 不能为空。");
  }
  if (!body.model?.trim()) {
    throw new Error("模型名称不能为空。");
  }
  if (!body.apiKey?.trim()) {
    throw new Error("API Key 不能为空。");
  }
  if (body.providerType !== "openai-compatible") {
    throw new Error("当前仅支持 OpenAI-compatible 预设。");
  }

  return {
    ...body,
    name: body.name.trim(),
    baseURL: body.baseURL.trim(),
    model: body.model.trim(),
    apiKey: body.apiKey.trim(),
    rpm: normalizePresetRpm(body.rpm),
    reasoningEffort: normalizeReasoningEffort(body.reasoningEffort),
    extraRequestParams: normalizeExtraRequestParams(body.extraRequestParams),
  };
}

function validateUpdatePresetRequest(body: UpdateLLMPresetRequest): UpdateLLMPresetRequest {
  if (!body.name?.trim()) {
    throw new Error("预设名称不能为空。");
  }
  if (!body.baseURL?.trim()) {
    throw new Error("Base URL 不能为空。");
  }
  if (!body.model?.trim()) {
    throw new Error("模型名称不能为空。");
  }
  if (body.providerType !== "openai-compatible") {
    throw new Error("当前仅支持 OpenAI-compatible 预设。");
  }

  return {
    ...body,
    name: body.name.trim(),
    baseURL: body.baseURL.trim(),
    model: body.model.trim(),
    apiKey: body.apiKey?.trim(),
    rpm: normalizePresetRpm(body.rpm),
    reasoningEffort: normalizeReasoningEffort(body.reasoningEffort),
    extraRequestParams: normalizeExtraRequestParams(body.extraRequestParams),
  };
}

async function validateTestPresetRequest(
  body: TestLLMPresetRequest,
  presetStore: PresetStore
): Promise<OpenAICompatibleRuntimeConfig> {
  if (!body.baseURL?.trim()) {
    throw new Error("Base URL 不能为空。");
  }
  if (!body.model?.trim()) {
    throw new Error("模型名称不能为空。");
  }
  if (body.providerType !== "openai-compatible") {
    throw new Error("当前仅支持 OpenAI-compatible 预设。");
  }

  let apiKey = body.apiKey?.trim() ?? "";
  if (!apiKey && body.presetId) {
    const savedConfig = await presetStore.getRuntimeConfig(body.presetId);
    apiKey = savedConfig.apiKey;
  }
  if (!apiKey) {
    throw new Error("测试 API 前必须填写 API Key，或选择一个已保存 Key 的预设。");
  }

  return {
    providerType: "openai-compatible",
    apiKey,
    baseURL: body.baseURL.trim(),
    model: body.model.trim(),
    rpm: normalizePresetRpm(body.rpm) ?? null,
    reasoningEffort: normalizeReasoningEffort(body.reasoningEffort) ?? null,
    extraRequestParams: normalizeExtraRequestParams(body.extraRequestParams) ?? null,
  };
}

function parsePresetId(urlPath: string): string {
  const presetId = decodeURIComponent(urlPath.replace("/api/settings/presets/", ""));
  if (!presetId || presetId.includes("/")) {
    throw new Error("预设 ID 无效。");
  }
  return presetId;
}

function sendPresetError(res: http.ServerResponse, error: unknown) {
  if (error instanceof SyntaxError) {
    sendJson(res, 400, { error: "请求体不是有效的 JSON。" });
    return;
  }
  if (error instanceof Error) {
    if (error.message === "PRESET_NOT_FOUND") {
      sendJson(res, 404, { error: "指定的预设不存在。" });
      return;
    }
    sendJson(res, 400, { error: error.message });
    return;
  }
  sendJson(res, 500, { error: "预设操作失败。" });
}

function validatePromptName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("策略名称不能为空。");
  const name = value.trim();
  if (name.length > STRATEGY_PROMPT_NAME_MAX_LENGTH) {
    throw new Error(`策略名称不能超过 ${STRATEGY_PROMPT_NAME_MAX_LENGTH} 个字符。`);
  }
  return name;
}

function validatePromptContent(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Prompt 内容不能为空。");
  const content = value.trim();
  if (content.length > STRATEGY_PROMPT_CONTENT_MAX_LENGTH) {
    throw new Error(`Prompt 内容不能超过 ${STRATEGY_PROMPT_CONTENT_MAX_LENGTH} 个字符。`);
  }
  return content;
}

function validateCreatePromptRequest(body: unknown): CreateStrategyPromptRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Prompt 请求格式无效。");
  }
  const input = body as Record<string, unknown>;
  return {
    name: validatePromptName(input.name),
    content: validatePromptContent(input.content),
  };
}

function validateUpdatePromptRequest(body: unknown): UpdateStrategyPromptRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Prompt 请求格式无效。");
  }
  const input = body as Record<string, unknown>;
  if (input.name === undefined && input.content === undefined) {
    throw new Error("请至少提供名称或 Prompt 内容。");
  }
  return {
    ...(input.name !== undefined ? { name: validatePromptName(input.name) } : {}),
    ...(input.content !== undefined ? { content: validatePromptContent(input.content) } : {}),
  };
}

function parsePromptId(urlPath: string): string {
  const promptId = decodeURIComponent(urlPath.replace("/api/prompts/", ""));
  if (!promptId || promptId.includes("/")) throw new Error("Prompt ID 无效。");
  return promptId;
}

function parsePromptActivationPath(urlPath: string): { promptId: string; versionId: string } | null {
  const match = urlPath.match(/^\/api\/prompts\/([^/]+)\/versions\/([^/]+)\/activate$/);
  if (!match) return null;
  return {
    promptId: decodeURIComponent(match[1]!),
    versionId: decodeURIComponent(match[2]!),
  };
}

function sendPromptError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof SyntaxError) {
    sendJson(res, 400, { error: "请求体不是有效的 JSON。" });
    return;
  }
  if (error instanceof Error) {
    if (error.message === "PROMPT_NOT_FOUND") {
      sendJson(res, 404, { error: "指定的策略 Prompt 不存在。" });
      return;
    }
    if (error.message === "PROMPT_VERSION_NOT_FOUND") {
      sendJson(res, 404, { error: "指定的 Prompt 版本不存在。" });
      return;
    }
    if (error.message === "PROMPT_IN_USE") {
      sendJson(res, 409, { error: "这个策略正在被运行中或暂停中的对局使用，暂时不能删除。" });
      return;
    }
    sendJson(res, 400, { error: error.message });
    return;
  }
  sendJson(res, 500, { error: "Prompt 操作失败。" });
}

function isPromptInUse(state: ServerState, promptId: string): boolean {
  return state.matchRegistry.list().some((match) => {
    if (
      match.kind !== "live"
      || (match.status !== "warming_up" && match.status !== "running" && match.status !== "stopped")
    ) {
      return false;
    }
    const prompts = state.matchRegistry.get(match.matchId)?.liveSetup?.prompts;
    return prompts?.player_1?.promptId === promptId || prompts?.player_2?.promptId === promptId;
  });
}

async function listRecordEntries() {
  try {
    const entries = await fs.readdir(RECORDS_DIR, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isSupportedRecordFileName(entry.name))
        .map(async (entry) => {
          const fullPath = path.join(RECORDS_DIR, entry.name);
          const stat = await fs.stat(fullPath);
          return {
            fileName: entry.name,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            encoding: recordFileEncoding(entry.name),
          };
        })
    );
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: ServerState
): Promise<void> {
  try {
    if (!req.url) {
      sendJson(res, 400, { error: "缺少请求 URL。" });
      return;
    }

    if (req.method === "OPTIONS") {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/api/replay/records") {
      const records = await listRecordEntries();
      sendJson(res, 200, { records });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/replay/records/")) {
      const requestedFile = decodeURIComponent(url.pathname.replace("/api/replay/records/", ""));
      const safeFileName = path.basename(requestedFile);
      if (!isSupportedRecordFileName(safeFileName) || safeFileName !== requestedFile) {
        sendJson(res, 400, { error: "记录文件名无效。" });
        return;
      }

      const fullPath = path.join(RECORDS_DIR, safeFileName);
      try {
        const content = await readRecordJsonText(fullPath);
        setCorsHeaders(res);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          sendJson(res, 404, { error: "记录不存在。" });
          return;
        }
        console.error("读取记录失败:", error);
        sendJson(res, 500, { error: "读取记录失败。" });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings/presets") {
      const presets = await state.presetStore.list();
      state.liveEnabled = presets.length > 0;
      sendJson(res, 200, { presets });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/presets") {
      try {
        const body = await readJsonBody<CreateLLMPresetRequest>(req);
        const validatedBody = validateCreatePresetRequest(body);
        const preset = await state.presetStore.create(validatedBody);
        state.liveEnabled = true;
        sendJson(res, 201, { preset });
      } catch (error) {
        sendPresetError(res, error);
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/presets/test") {
      try {
        const body = await readJsonBody<TestLLMPresetRequest>(req);
        const runtimeConfig = await validateTestPresetRequest(body, state.presetStore);
        const provider = createLLMProvider(runtimeConfig);
        const startedAt = Date.now();
        const result = await provider.testConnection();
        sendJson(res, 200, {
          ok: true,
          model: provider.getModel(),
          baseURL: provider.getBaseURL(),
          latencyMs: Date.now() - startedAt,
          responseText: result.responseText,
        } satisfies TestLLMPresetResponse);
      } catch (error) {
        if (error instanceof SyntaxError) {
          sendJson(res, 400, { error: "请求体不是有效的 JSON。" });
          return;
        }
        if (error instanceof Error) {
          const statusCode = error.message === "PRESET_NOT_FOUND" || error.message === "PRESET_DECRYPT_FAILED"
            ? 400
            : error.message.includes("不能为空") || error.message.includes("必须")
              ? 400
              : 502;
          const message = error.message === "PRESET_NOT_FOUND"
            ? "指定的预设不存在。"
            : error.message === "PRESET_DECRYPT_FAILED"
              ? "预设中的 API Key 无法解密。请重新填写该预设的 API Key。"
              : statusCode === 502
                ? `API 测试失败: ${error.message}`
                : error.message;
          sendJson(res, statusCode, { error: message });
          return;
        }
        sendJson(res, 502, { error: "API 测试失败。" });
      }
      return;
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/settings/presets/")) {
      try {
        const presetId = parsePresetId(url.pathname);
        const body = await readJsonBody<UpdateLLMPresetRequest>(req);
        const validatedBody = validateUpdatePresetRequest(body);
        const preset = await state.presetStore.update(presetId, validatedBody);
        state.liveEnabled = true;
        sendJson(res, 200, { preset });
      } catch (error) {
        sendPresetError(res, error);
      }
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/settings/presets/")) {
      try {
        const presetId = parsePresetId(url.pathname);
        await state.presetStore.delete(presetId);
        await refreshLiveEnabled(state);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendPresetError(res, error);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/prompts") {
      sendJson(res, 200, { prompts: await state.promptStore.list() });
      return;
    }

    const provenancePath = /^\/api\/prompts\/([^/]+)\/provenance$/.exec(url.pathname);
    if (req.method === "GET" && provenancePath) {
      const promptId = decodeURIComponent(provenancePath[1]!);
      const prompt = (await state.promptStore.list()).find((item) => item.id === promptId);
      if (!prompt) {
        sendJson(res, 404, { error: "策略不存在。" });
        return;
      }
      sendJson(res, 200, { provenance: await getPromptProvenance(prompt, RECORDS_DIR) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/prompts") {
      try {
        const body = validateCreatePromptRequest(await readJsonBody<CreateStrategyPromptRequest>(req));
        sendJson(res, 201, { prompt: await state.promptStore.create(body) });
      } catch (error) {
        sendPromptError(res, error);
      }
      return;
    }

    const activationPath = parsePromptActivationPath(url.pathname);
    if (req.method === "POST" && activationPath) {
      try {
        const prompt = await state.promptStore.activateVersion(
          activationPath.promptId,
          activationPath.versionId,
        );
        sendJson(res, 200, { prompt });
      } catch (error) {
        sendPromptError(res, error);
      }
      return;
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/prompts/")) {
      try {
        const promptId = parsePromptId(url.pathname);
        const body = validateUpdatePromptRequest(await readJsonBody<UpdateStrategyPromptRequest>(req));
        sendJson(res, 200, { prompt: await state.promptStore.update(promptId, body) });
      } catch (error) {
        sendPromptError(res, error);
      }
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/prompts/")) {
      try {
        const promptId = parsePromptId(url.pathname);
        if (isPromptInUse(state, promptId)) throw new Error("PROMPT_IN_USE");
        await state.promptStore.delete(promptId);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendPromptError(res, error);
      }
      return;
    }

    if (await handleControlHttpRequest(req, res, url, state, { sendJson, readJsonBody })) {
      return;
    }

    sendJson(res, 404, { error: "未找到请求资源。" });
  } catch (error) {
    console.error("HTTP 处理失败:", error);
    sendJson(res, 500, { error: "服务器内部错误。" });
  }
}

type ClientMessageContext = {
  data: { toString(): string };
  ws: WebSocket;
  state: ServerState;
};

function schedulePromptReflections(options: {
  orchestrator: OrchestratorLike;
  state: ServerState;
  ws: Pick<WebSocket, "send">;
  prompts: ResolvedMatchPrompts;
  promptReflection?: Partial<Record<PlayerId, boolean>>;
}): void {
  const targets = [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2].filter(
    (playerId) => options.promptReflection?.[playerId] === true,
  );
  if (targets.length === 0 || !options.orchestrator.waitForEnd) return;

  void options.orchestrator.waitForEnd().then(async ({ status, state: finalState }) => {
    if (status !== "finished" || !finalState.winner) return;
    await Promise.all(targets.map((playerId) => runPromptReflection({
      orchestrator: options.orchestrator,
      state: options.state,
      ws: options.ws,
      playerId,
      prompt: options.prompts.byPlayer[playerId],
    })));
  }).catch((error) => {
    console.error("Prompt reflection scheduling failed:", error);
  });
}

async function runPromptReflection(options: {
  orchestrator: OrchestratorLike;
  state: ServerState;
  ws: Pick<WebSocket, "send">;
  playerId: PlayerId;
  prompt?: ResolvedStrategyPrompt;
}): Promise<void> {
  const matchId = options.orchestrator.getMatchId?.() ?? "unknown";
  const key = promptReflectionKey(matchId, options.playerId);
  const existing = options.state.promptReflectionStatuses.get(key);
  if (existing?.status === "running" || existing?.status === "completed") {
    sendPromptReflectionStatus(options.state, options.ws, existing);
    return;
  }

  const side = options.playerId === PLAYER_IDS.PLAYER_1 ? "红方" : "蓝方";
  const controller = new AbortController();
  options.state.promptReflectionControllers.set(key, controller);
  let retryCount = 0;
  const statusBase = {
    type: "prompt_reflection_status" as const,
    matchId,
    playerId: options.playerId,
    ...(options.prompt ? { promptId: options.prompt.snapshot.promptId } : {}),
  };
  sendPromptReflectionStatus(options.state, options.ws, {
    ...statusBase,
    status: "running",
    canCancel: true,
    message: `${side}正在沉淀本局策略…`,
  });

  try {
    if (!options.orchestrator.reflectPrompt) throw new Error("PROMPT_REFLECTION_SESSION_UNAVAILABLE");
    const { title, content, model } = await options.orchestrator.reflectPrompt(options.playerId, {
      signal: controller.signal,
      onRetry: (progress) => {
        if (controller.signal.aborted) return;
        if (progress.phase === "retrying") retryCount = progress.attempt;
        sendPromptReflectionStatus(options.state, options.ws, {
          ...statusBase,
          status: "running",
          canCancel: true,
          message: progress.phase === "waiting"
            ? `${side}${describePromptReflectionError(progress.error)}；${progress.delayMs / 1000} 秒后重试（${progress.attempt}/${progress.maxAttempts}）…`
            : `${side}正在重试策略沉淀（${progress.attempt}/${progress.maxAttempts}）…`,
        });
      },
    });
    controller.signal.throwIfAborted();
    // Once persistence starts, finish that commit instead of claiming a cancelled write.
    options.state.promptReflectionControllers.delete(key);
    if (options.prompt && content.trim() === options.prompt.content.trim()) {
      sendPromptReflectionStatus(options.state, options.ws, {
        ...statusBase,
        status: "completed",
        message: `${side}复盘后认为当前策略无需调整。`,
      });
      return;
    }
    sendPromptReflectionStatus(options.state, options.ws, {
      ...statusBase,
      status: "running",
      canCancel: false,
      message: `${side}正在保存策略…`,
    });
    if (options.prompt) {
      const version = await options.state.promptStore.addVersion(options.prompt.snapshot.promptId, {
        title,
        model,
        content,
        source: "reflection",
        basedOnVersionId: options.prompt.snapshot.versionId,
        matchId,
        playerId: options.playerId,
        activate: false,
      });
      sendPromptReflectionStatus(options.state, options.ws, {
        ...statusBase,
        status: "completed",
        versionId: version.id,
        message: `${side}已生成策略 v${version.version}，需手动采用。`,
      });
      return;
    }

    const created = await options.state.promptStore.createFromReflection({
      name: title,
      model,
      content,
      matchId,
      playerId: options.playerId,
    });
    sendPromptReflectionStatus(options.state, options.ws, {
      ...statusBase,
      promptId: created.id,
      status: "completed",
      versionId: created.activeVersionId,
      message: `${side}已将本局经验沉淀为新策略“${created.name}”。`,
    });
  } catch (error) {
    const cancelled = controller.signal.aborted || classifyModelRequestError(error) === "cancelled";
    if (!cancelled) console.error(`Prompt reflection failed for ${options.playerId}:`, error);
    sendPromptReflectionStatus(options.state, options.ws, {
      ...statusBase,
      status: cancelled ? "cancelled" : "failed",
      message: cancelled
        ? `${side}已取消策略沉淀，策略库未发生变化。`
        : `${side}策略沉淀失败${retryCount > 0 ? `（已自动重试 ${retryCount} 次）` : ""}：${describePromptReflectionError(error)}。策略库未发生变化。`,
    });
  } finally {
    if (options.state.promptReflectionControllers.get(key) === controller) {
      options.state.promptReflectionControllers.delete(key);
    }
  }
}

function sendPromptReflectionStatus(
  state: ServerState,
  ws: Pick<WebSocket, "send">,
  payload: ServerPromptReflectionStatusMessage,
): void {
  state.promptReflectionStatuses.set(promptReflectionKey(payload.matchId, payload.playerId), payload);
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // A closed initiating socket must not cancel the persisted reflection.
  }
}

export async function handleClientMessage({ data, ws, state }: ClientMessageContext): Promise<void> {
  try {
    const parsed = JSON.parse(data.toString());
    if (!isClientMessage(parsed)) {
      ws.send(JSON.stringify({
        type: "error",
        message: "未知的消息类型。",
      } satisfies ServerMessage));
      return;
    }

    const message: ClientMessage = parsed;

    if (message.type === "warmup") {
      if (!message.player1PresetId || !message.player2PresetId) {
        ws.send(JSON.stringify({
          type: "error",
        message: "预热模型前必须为红蓝双方选择预设。",
        } satisfies ServerMessage));
        return;
      }

      const warmup = normalizeWarmupOptions(message.warmup);
      const warmupPlayers = [PLAYER_IDS.PLAYER_1, PLAYER_IDS.PLAYER_2].filter((playerId) => warmup[playerId]);
      if (warmupPlayers.length === 0) {
        ws.send(JSON.stringify({
          type: "error",
          message: "至少选择一方进行模型预热。",
        } satisfies ServerMessage));
        return;
      }

      const resolvedPrompts = await resolveMatchPrompts(state.promptStore, message.prompts);
      const signature = buildMatchSignature(message);
      const activeLive = getActiveLiveMatch(state);
      if (activeLive?.status === "running") {
        ws.send(JSON.stringify({
          type: "error",
          message: "已有实时对局正在运行。请先停止或重置当前对局。",
        } satisfies ServerMessage));
        return;
      }
      if (
        state.warmupMatch
        && state.warmupMatch.signature !== signature
      ) {
        state.matchRegistry.remove(state.warmupMatch.matchId, { stop: true });
        state.warmupMatch = null;
      }
      if (
        activeLive?.status === "waiting_for_players"
        && state.matchRegistry.get(activeLive.matchId)?.signature !== signature
      ) {
        state.matchRegistry.remove(activeLive.matchId, { stop: true });
      }
      const player1 = await state.presetStore.getRuntimeConfig(message.player1PresetId);
      const player2 = await state.presetStore.getRuntimeConfig(message.player2PresetId);
      let orchestrator = state.warmupMatch?.signature === signature
        ? getRegisteredOrchestrator(state, state.warmupMatch.matchId)
        : getActiveLiveMatch(state)?.status === "waiting_for_players"
          ? getRegisteredOrchestrator(state, getActiveLiveMatch(state)!.matchId)
          : null;

      if (!orchestrator) {
        orchestrator = registerOrchestrator(state, state.createOrchestrator(withResolvedPrompts({
          player1,
          player2,
          debug: message.debug,
        }, resolvedPrompts)), {
          kind: "live",
          signature,
          liveSetup: buildLiveMatchSetup(message, resolvedPrompts.snapshots),
          observe: true,
          terminalPolicy: liveTerminalPolicy(message.debug),
        });
        state.warmupMatch = { signature, matchId: orchestrator.getMatchId!() };
      } else {
        state.matchRegistry.observe(orchestrator.getMatchId!());
      }

      sendWarmupStatus(
        ws,
        Object.fromEntries(warmupPlayers.map((playerId) => [playerId, "warming_up"])) as Partial<Record<PlayerId, MatchWarmupState>>,
        "模型预热中。"
      );

      try {
        await orchestrator.warmup?.(warmup);
      } catch (error) {
        sendWarmupStatus(
          ws,
          Object.fromEntries(warmupPlayers.map((playerId) => [playerId, "error"])) as Partial<Record<PlayerId, MatchWarmupState>>,
          error instanceof Error && error.message.startsWith("模型预热失败") ? error.message : "模型预热失败。"
        );
        throw error;
      }

      sendWarmupStatus(
        ws,
        Object.fromEntries(warmupPlayers.map((playerId) => [playerId, "ready"])) as Partial<Record<PlayerId, MatchWarmupState>>,
        "模型预热完成，可以启动模拟。"
      );
      return;
    }

    if (message.type === "start") {
      if (!message.player1PresetId || !message.player2PresetId) {
        ws.send(JSON.stringify({
          type: "error",
          message: "启动对局前必须为红蓝双方选择预设。",
        } satisfies ServerMessage));
        return;
      }

      const resolvedPrompts = await resolveMatchPrompts(state.promptStore, message.prompts);
      const signature = buildMatchSignature(message);
      const activeLive = getActiveLiveMatch(state);
      const observedLive = state.matchRegistry.list().find((match) => match.kind === "live" && match.observed) ?? null;
      if (activeLive?.status === "running") {
        state.matchRegistry.observe(activeLive.matchId);
        ws.send(JSON.stringify({
          type: "error",
          message: "已有实时对局正在运行，不会重复启动。请先停止或重置当前对局。",
        } satisfies ServerMessage));
        return;
      }
      if (state.warmupMatch && state.warmupMatch.signature !== signature) {
        state.matchRegistry.remove(state.warmupMatch.matchId, { stop: true });
        state.warmupMatch = null;
      }
      if (
        activeLive?.status === "waiting_for_players"
        && state.matchRegistry.get(activeLive.matchId)?.signature !== signature
      ) {
        state.matchRegistry.remove(activeLive.matchId, { stop: true });
      }
      const previousObservedId = state.matchRegistry.getObservedMatchId();
      const resumableMatch = observedLive?.status === "stopped"
        && state.matchRegistry.get(observedLive.matchId)?.signature === signature
        ? getRegisteredOrchestrator(state, observedLive.matchId)
        : null;
      const warmedMatch = state.warmupMatch?.signature === signature
        ? getRegisteredOrchestrator(state, state.warmupMatch.matchId)
        : activeLive?.status === "waiting_for_players"
          && state.matchRegistry.get(activeLive.matchId)?.signature === signature
          ? getRegisteredOrchestrator(state, activeLive.matchId)
          : resumableMatch;
      const configs: Record<PlayerId, OpenAICompatibleRuntimeConfig> = {
        player_1: await state.presetStore.getRuntimeConfig(message.player1PresetId),
        player_2: await state.presetStore.getRuntimeConfig(message.player2PresetId),
      };
      const createdNew = !warmedMatch;
      const nextOrchestrator = warmedMatch ?? registerOrchestrator(
        state,
        state.createOrchestrator(withResolvedPrompts({
          player1: configs.player_1,
          player2: configs.player_2,
          debug: message.debug,
        }, resolvedPrompts)),
        {
          kind: "live",
          signature,
          liveSetup: buildLiveMatchSetup(message, resolvedPrompts.snapshots),
          observe: true,
          terminalPolicy: liveTerminalPolicy(message.debug),
        },
      );
      const nextMatchId = nextOrchestrator.getMatchId!();
      state.matchRegistry.observe(nextMatchId);

      try {
        await nextOrchestrator.start();
      } catch (error) {
        await state.matchRegistry.stopAndSave(nextMatchId);
        if (createdNew) state.matchRegistry.remove(nextMatchId);
        if (previousObservedId && state.matchRegistry.get(previousObservedId)) {
          state.matchRegistry.observe(previousObservedId);
        }
        if (error instanceof Error && error.message === MATCH_START_ABORTED) {
          return;
        }
        throw error;
      }

      state.warmupMatch = null;
      schedulePromptReflections({
        orchestrator: nextOrchestrator,
        state,
        ws,
        prompts: resolvedPrompts,
        promptReflection: message.promptReflection,
      });
      return;
    }

    if (message.type === "pause_match") {
      const targetMatch = state.matchRegistry.get(message.matchId);
      if (!targetMatch || targetMatch.kind !== "live") {
        ws.send(JSON.stringify({
          type: "error",
          message: "指定的实时对局不存在。",
        } satisfies ServerMessage));
        return;
      }
      const targetStatus = state.matchRegistry.list()
        .find((match) => match.matchId === targetMatch.matchId)?.status;
      if (targetStatus !== "running") {
        ws.send(JSON.stringify({
          type: "error",
          message: "只能暂停正在运行的实时对局。",
        } satisfies ServerMessage));
        return;
      }
      state.matchRegistry.stop(targetMatch.matchId);
      if (state.warmupMatch?.matchId === targetMatch.matchId) {
        state.warmupMatch = null;
      }
      return;
    }

    if (message.type === "cancel_prompt_reflection") {
      if (
        typeof message.matchId !== "string" || !message.matchId
        || (message.playerId !== PLAYER_IDS.PLAYER_1 && message.playerId !== PLAYER_IDS.PLAYER_2)
      ) {
        ws.send(JSON.stringify({ type: "error", message: "取消策略沉淀的对局或玩家无效。" } satisfies ServerMessage));
        return;
      }
      const key = promptReflectionKey(message.matchId, message.playerId);
      const existing = state.promptReflectionStatuses.get(key);
      const controller = state.promptReflectionControllers.get(key);
      if (existing?.status === "running" && controller) {
        sendPromptReflectionStatus(state, ws, { ...existing, canCancel: false, message: "正在取消策略沉淀…" });
        controller.abort();
      } else if (existing) {
        sendPromptReflectionStatus(state, ws, existing);
      } else {
        ws.send(JSON.stringify({ type: "error", message: "没有可取消的策略沉淀。" } satisfies ServerMessage));
      }
      return;
    }

    if (message.type === "reflect_prompt") {
      if (message.playerId !== PLAYER_IDS.PLAYER_1 && message.playerId !== PLAYER_IDS.PLAYER_2) {
        ws.send(JSON.stringify({
          type: "error",
          message: "策略沉淀的玩家无效。",
        } satisfies ServerMessage));
        return;
      }
      const targetMatch = state.matchRegistry.get(message.matchId);
      const targetStatus = state.matchRegistry.list()
        .find((match) => match.matchId === message.matchId)?.status;
      const orchestrator = getRegisteredOrchestrator(state, message.matchId);
      const finalState = orchestrator?.getGame().getState() ?? null;
      if (
        !targetMatch
        || targetMatch.kind !== "live"
        || targetStatus !== "finished"
        || !orchestrator
        || !finalState?.winner
      ) {
        ws.send(JSON.stringify({
          type: "error",
          message: "只能复盘已经正常分出胜负的实时对局。",
        } satisfies ServerMessage));
        return;
      }

      const existingReflection = state.promptReflectionStatuses.get(
        promptReflectionKey(message.matchId, message.playerId),
      );
      if (existingReflection?.status === "running" || existingReflection?.status === "completed") {
        sendPromptReflectionStatus(state, ws, existingReflection);
        return;
      }

      const promptSnapshot = targetMatch.liveSetup?.prompts?.[message.playerId];
      let prompt: ResolvedStrategyPrompt | undefined;
      try {
        prompt = promptSnapshot
          ? await state.promptStore.resolve({
              promptId: promptSnapshot.promptId,
              versionId: promptSnapshot.versionId,
            })
          : undefined;
      } catch (error) {
        console.error(`Prompt reflection setup failed for ${message.playerId}:`, error);
        sendPromptReflectionStatus(state, ws, {
          type: "prompt_reflection_status",
          matchId: message.matchId,
          playerId: message.playerId,
          ...(promptSnapshot ? { promptId: promptSnapshot.promptId } : {}),
          status: "failed",
          message: `${message.playerId === PLAYER_IDS.PLAYER_1 ? "红方" : "蓝方"}的原策略已不可用，无法沉淀本局。`,
        });
        return;
      }
      void runPromptReflection({
        orchestrator,
        state,
        ws,
        playerId: message.playerId,
        prompt,
      });
      return;
    }

    if (message.type === "stop_benchmark") {
      state.activeBenchmark?.stop();
      state.activeBenchmark = null;
      return;
    }

    if (message.type === "load_terminal_history") {
      const orchestrator = state.matchRegistry.getObserved()?.handle;
      if (!orchestrator?.getTerminalHistory || !orchestrator.getAITerminalFeed) {
        return;
      }
      const page = await orchestrator.getTerminalHistory(message.beforeSequence, message.limit);
      ws.send(JSON.stringify({
        type: "terminal_history_page",
        sessionId: orchestrator.getAITerminalFeed().sessionId,
        events: page.events,
        hasMore: page.hasMore,
      } satisfies ServerMessage));
      return;
    }

    if (message.type === "reset") {
      if (!message.player1PresetId || !message.player2PresetId) {
        ws.send(JSON.stringify({
          type: "error",
          message: "重置对局前必须为红蓝双方选择预设。",
        } satisfies ServerMessage));
        return;
      }

      const targetMatch = state.matchRegistry.get(message.matchId);
      if (!targetMatch || targetMatch.kind !== "live") {
        ws.send(JSON.stringify({
          type: "error",
          message: "指定的实时对局不存在。",
        } satisfies ServerMessage));
        return;
      }

      const player1 = await state.presetStore.getRuntimeConfig(message.player1PresetId);
      const player2 = await state.presetStore.getRuntimeConfig(message.player2PresetId);
      const resolvedPrompts = await resolveMatchPrompts(state.promptStore, message.prompts);
      const nextOrchestrator = registerOrchestrator(
        state,
        state.createOrchestrator(withResolvedPrompts({ player1, player2, debug: message.debug }, resolvedPrompts)),
        {
          kind: "live",
          signature: buildMatchSignature(message),
          liveSetup: buildLiveMatchSetup(message, resolvedPrompts.snapshots),
          observe: true,
          terminalPolicy: liveTerminalPolicy(message.debug),
        },
      );
      state.warmupMatch = null;
      if (targetMatch.matchId !== nextOrchestrator.getMatchId!()) {
        await state.matchRegistry.stopAndSave(targetMatch.matchId);
        state.matchRegistry.remove(targetMatch.matchId);
      }
      return;
    }

    if (message.type === "save_record") {
      const targetMatch = message.matchId ? state.matchRegistry.get(message.matchId) : undefined;
      if (!targetMatch || targetMatch.kind !== "live") {
        ws.send(JSON.stringify({
          type: "error",
          message: "指定的实时对局不存在。",
        } satisfies ServerMessage));
        return;
      }
      if (targetMatch.terminalPolicy === "none") {
        ws.send(JSON.stringify({
          type: "error",
          message: "该实时对局已关闭录制，无法保存记录。",
        } satisfies ServerMessage));
        return;
      }

      const filePath = await state.matchRegistry.save(targetMatch.matchId);
      ws.send(JSON.stringify({
        type: "record_saved",
        matchId: targetMatch.matchId,
        fileName: path.basename(filePath),
      } satisfies ServerMessage));
      return;
    }

    if (message.type === "start_benchmark") {
      if (!message.presetId) {
        ws.send(JSON.stringify({
          type: "error",
          message: "启动 benchmark 前必须选择一个 LLM 预设。",
        } satisfies ServerMessage));
        return;
      }

      if (!Number.isInteger(message.rounds) || message.rounds <= 0 || message.rounds > 100) {
        ws.send(JSON.stringify({
          type: "error",
          message: "Benchmark 局数必须是 1 到 100 之间的整数。",
        } satisfies ServerMessage));
        return;
      }

      if (
        message.concurrency !== undefined &&
        (!Number.isInteger(message.concurrency) || message.concurrency <= 0 || message.concurrency > 10)
      ) {
        ws.send(JSON.stringify({
          type: "error",
          message: "Benchmark 并发数必须是 1 到 10 之间的整数。",
        } satisfies ServerMessage));
        return;
      }

      if (
        message.decisionIntervalTicks !== undefined
        && (
          !Number.isInteger(message.decisionIntervalTicks)
          || message.decisionIntervalTicks < MIN_CPU_DECISION_INTERVAL_TICKS
          || message.decisionIntervalTicks > MAX_CPU_DECISION_INTERVAL_TICKS
        )
      ) {
        ws.send(JSON.stringify({
          type: "error",
          message: `CPU 决策间隔必须是 ${MIN_CPU_DECISION_INTERVAL_TICKS} 到 ${MAX_CPU_DECISION_INTERVAL_TICKS} 之间的整数。`,
        } satisfies ServerMessage));
        return;
      }


      const activeLive = getActiveLiveMatch(state);
      if (activeLive?.status === "running" || activeLive?.status === "warming_up") {
        ws.send(JSON.stringify({
          type: "error",
          message: "启动 Benchmark 前请先暂停实时对局。",
        } satisfies ServerMessage));
        return;
      }
      if (state.activeBenchmark?.isRunning()) {
        ws.send(JSON.stringify({
          type: "error",
          message: "Benchmark 已在运行。",
        } satisfies ServerMessage));
        return;
      }

      const llmConfig = await state.presetStore.getRuntimeConfig(message.presetId);
      if (llmConfig.providerType !== "openai-compatible") {
        throw new Error("BENCHMARK_PRESET_INVALID");
      }

      const previousObservedId = state.matchRegistry.getObservedMatchId();
      const benchmarkOrchestrator = state.createBenchmarkOrchestrator(
        {
          presetId: message.presetId,
          llmConfig,
          cpuStrategy: message.cpuStrategy,
          rounds: message.rounds,
          decisionIntervalTicks: message.decisionIntervalTicks
            ?? DEFAULT_CPU_DECISION_INTERVAL_TICKS,
          recordReplay: message.recordReplay ?? true,
          concurrency: message.concurrency,
          debug: message.debug,
        },
        ws
      );

      state.activeBenchmark = benchmarkOrchestrator;
      state.warmupMatch = null;

      try {
        await benchmarkOrchestrator.start();
      } catch (error) {
        benchmarkOrchestrator.stop();
        state.activeBenchmark = null;
        if (previousObservedId && state.matchRegistry.get(previousObservedId)) {
          state.matchRegistry.observe(previousObservedId);
        }
        throw error;
      }

      return;
    }
  } catch (error) {
    console.error("消息错误:", error);
    ws.send(JSON.stringify({
      type: "error",
      message: error instanceof Error
        ? error.message === "PRESET_NOT_FOUND"
          ? "所选预设不存在或已被删除。"
          : error.message === "PRESET_DECRYPT_FAILED"
            ? "预设中的 API Key 无法解密。请重新填写该预设的 API Key。"
            : error.message === "PROMPT_NOT_FOUND" || error.message === "PROMPT_VERSION_NOT_FOUND"
              ? "所选策略 Prompt 或版本不存在，请重新选择。"
              : error.message === "PROMPT_SELECTION_INVALID"
                ? "策略 Prompt 选择无效，请重新选择。"
                : error.message === "BENCHMARK_PRESET_INVALID"
                  ? "Benchmark 只能使用 OpenAI-compatible 预设。"
                  : error.message.startsWith("模型预热失败")
                    ? error.message
                    : "处理客户端消息失败。"
        : "处理客户端消息失败。",
    } satisfies ServerMessage));
  }
}

function createServer(state: ServerState) {
  const server = http.createServer((req, res) => {
    void handleHttpRequest(req, res, state);
  });

  const wss = new WebSocketServer({ server });
  let terminalSweepRunning = false;
  const terminalSweep = setInterval(() => {
    if (terminalSweepRunning) return;
    terminalSweepRunning = true;
    void state.matchRegistry.finalizeTerminalMatches()
      .then((results) => {
        for (const result of results) {
          if (!result.ok) console.error(`对局 ${result.matchId} 自动收尾失败: ${result.error}`);
        }
      })
      .finally(() => {
        terminalSweepRunning = false;
      });
  }, 1_000);
  terminalSweep.unref();
  server.once("close", () => clearInterval(terminalSweep));

  wss.on("connection", (ws) => {
    console.log("客户端已连接");
    state.activeBenchmark?.setWebSocket?.(ws);
    let isSendingState = false;
    let lastAITerminalSessionId: string | null = null;
    let lastAITerminalEventSequence = 0;
    let lastStateTick: number | null | undefined;
    let lastStateOrchestrator: RegisteredMatchHandle | null = null;
    let lastStateLiveEnabled: boolean | null = null;
    let lastStateMatchStatus: RegisteredMatchStatus | null = null;
    let lastStateBenchmarkRunning: boolean | null = null;
    let lastStateBroadcastWarningAtMs = 0;
    let lastAITerminalBroadcastWarningAtMs = 0;
    let lastProjectedState: LiveStateSnapshot | null = null;
    let lastFrameSequence = 0;
    let lastEventsMatchId: string | null = null;
    let lastStateLogCount = 0;
    let lastAIOutputKey: string | null = null;
    let lastMapMatchId: string | null = null;

    const logBroadcastPerfWarning = (
      phase: "state" | "ai_terminal",
      elapsedMs: number,
      details: Record<string, unknown>,
      lastWarningAtMs: number
    ): number => {
      const now = performance.now();
      const bytes = typeof details.bytes === "number" ? details.bytes : undefined;
      const shouldWarn =
        elapsedMs > BROADCAST_TOTAL_WARNING_MS ||
        (typeof details.buildMs === "number" && details.buildMs > BROADCAST_PHASE_WARNING_MS) ||
        (typeof details.stringifyMs === "number" && details.stringifyMs > BROADCAST_PHASE_WARNING_MS) ||
        (typeof details.sendMs === "number" && details.sendMs > BROADCAST_PHASE_WARNING_MS) ||
        ws.bufferedAmount > BROADCAST_BUFFERED_WARNING_BYTES;

      if (!shouldWarn || now - lastWarningAtMs <= BROADCAST_PERF_WARNING_THROTTLE_MS) {
        return lastWarningAtMs;
      }

      const game = state.matchRegistry.getObserved()?.handle.getGame();
      const tick = typeof details.tick === "number" ? details.tick : game?.getState()?.tick;
      game?.addLog?.(LOG_TYPES.PERF_WARNING, `${phase} broadcast took ${Math.round(elapsedMs)}ms`, {
        scope: "state_broadcast",
        phase,
        elapsedMs: Math.round(elapsedMs),
        tick: typeof tick === "number" ? tick : undefined,
        bytes,
        details: {
          ...details,
          bufferedAmount: ws.bufferedAmount,
        },
      });
      return now;
    };

    const sendState = async (force = false) => {
      if (
        isSendingState
        || ws.readyState !== WebSocket.OPEN
        || shouldDeferLatestProjection(ws.bufferedAmount)
      ) {
        return;
      }
      const currentOrchestrator = state.matchRegistry.getObserved()?.handle ?? null;
      const currentTick = currentOrchestrator?.getGame().getTick?.();
      const currentMatchStatus = currentOrchestrator?.getMatchStatus?.() ?? null;
      const currentBenchmarkRunning = state.activeBenchmark?.isRunning() ?? false;
      if (
        !force
        && currentOrchestrator === lastStateOrchestrator
        && currentTick === lastStateTick
        && state.liveEnabled === lastStateLiveEnabled
        && currentMatchStatus === lastStateMatchStatus
        && currentBenchmarkRunning === lastStateBenchmarkRunning
      ) {
        return;
      }
      isSendingState = true;
      try {
        if (state.liveEnabled === null) {
          await refreshLiveEnabled(state);
        }
        const startedAt = performance.now();
        // One full-world read per broadcast; the resulting live snapshot is
        // reused for the wire frame, map_init, and the next delta baseline.
        const currentGameState = currentOrchestrator?.getGame().getState() ?? null;
        const currentLiveState = currentGameState
          ? createLiveStateSnapshot(currentGameState)
          : null;
        const buildStartedAt = performance.now();
        const matchChanged = currentOrchestrator !== lastStateOrchestrator;
        if (matchChanged) {
          lastProjectedState = null;
          lastFrameSequence = 0;
        }
        const nextFrameSequence = lastFrameSequence + 1;
        const payload = buildStateMessagePayload(state, {
          frameSequence: nextFrameSequence,
          baseFrameSequence: lastFrameSequence || undefined,
          previousState: lastProjectedState,
          forceKeyframe: force || matchChanged,
          snapshot: currentLiveState,
        });
        const buildMs = performance.now() - buildStartedAt;
        const currentMatchId = state.matchRegistry.getObserved()?.matchId
          ?? currentOrchestrator?.getMatchId()
          ?? null;
        if (currentMatchId && currentMatchId !== lastMapMatchId && currentGameState) {
          const currentState = currentGameState;
          const mapPayload = {
            type: "map_init" as const,
            matchId: currentMatchId,
            width: currentState.tiles[0]?.length ?? 0,
            height: currentState.tiles.length,
            tiles: currentState.tiles.map((row) => row.map(({ x, y, type }) => ({ x, y, type }))),
          };
          const mapSerialized = JSON.stringify(mapPayload);
          ws.send(mapSerialized);
          lastMapMatchId = currentMatchId;
        }
        const stringifyStartedAt = performance.now();
        const serialized = JSON.stringify(payload);
        const stringifyMs = performance.now() - stringifyStartedAt;
        const sendStartedAt = performance.now();
        ws.send(serialized);
        lastProjectedState = currentLiveState ? structuredClone(currentLiveState) : null;
        lastFrameSequence = payload.frame?.metadata.frameSequence ?? lastFrameSequence;
        lastStateOrchestrator = currentOrchestrator;
        lastStateTick = currentTick;
        lastStateLiveEnabled = state.liveEnabled;
        lastStateMatchStatus = currentMatchStatus;
        lastStateBenchmarkRunning = currentBenchmarkRunning;
        const sendMs = performance.now() - sendStartedAt;
        const elapsedMs = performance.now() - startedAt;
        lastStateBroadcastWarningAtMs = logBroadcastPerfWarning(
          "state",
          elapsedMs,
          {
            buildMs: Math.round(buildMs),
            stringifyMs: Math.round(stringifyMs),
            sendMs: Math.round(sendMs),
            bytes: Buffer.byteLength(serialized, "utf8"),
            tick: payload.frame?.metadata.simulationTick,
          },
          lastStateBroadcastWarningAtMs
        );
      } finally {
        isSendingState = false;
      }
    };

    const sendStateEvents = () => {
      if (ws.readyState !== WebSocket.OPEN || shouldDeferLatestProjection(ws.bufferedAmount)) return;
      const observed = state.matchRegistry.getObserved();
      const game = observed?.handle.getGame();
      const matchId = observed?.matchId ?? null;
      if (!matchId || !game) {
        lastEventsMatchId = null;
        lastStateLogCount = 0;
        return;
      }

      // Cheap tail read; avoids a full-world clone on every sweep.
      const tail = game.getLogsTail?.(lastEventsMatchId === matchId ? lastStateLogCount : 0);
      if (!tail) return;
      const reset = matchId !== lastEventsMatchId || tail.total < lastStateLogCount;
      const events = (reset ? tail.logs.slice(-20) : tail.logs).map(projectLiveLog);
      if (!reset && events.length === 0) return;

      const payload = {
        type: "state_events" as const,
        matchId,
        reset,
        events,
      };
      ws.send(JSON.stringify(payload));
      lastEventsMatchId = matchId;
      lastStateLogCount = tail.total;
    };

    const sendAIOutputs = () => {
      if (ws.readyState !== WebSocket.OPEN || shouldDeferLatestProjection(ws.bufferedAmount)) return;
      const observed = state.matchRegistry.getObserved();
      const matchId = observed?.matchId ?? null;
      if (!matchId) {
        lastAIOutputKey = null;
        return;
      }
      const outputs = observed?.handle.getGame().getAIOutputs?.() ?? {};
      const outputKey = `${matchId}:${JSON.stringify(outputs)}`;
      if (outputKey === lastAIOutputKey) return;
      ws.send(JSON.stringify({
        type: "ai_output",
        matchId,
        outputs,
      }));
      lastAIOutputKey = outputKey;
    };

    const sendAITerminalEvents = () => {
      const observedHandle = state.matchRegistry.getObserved()?.handle;
      let feed = observedHandle?.getAITerminalFeed?.(lastAITerminalEventSequence) ?? null;
      if (feed && feed.sessionId !== lastAITerminalSessionId) {
        feed = observedHandle?.getAITerminalFeed?.() ?? feed;
      }
      const sessionId = feed?.sessionId ?? null;
      const events = feed?.events ?? [];
      const sendPayload = (reset: boolean, nextEvents: AITerminalEvent[]) => {
        if (
          ws.readyState !== WebSocket.OPEN
          || shouldDeferLatestProjection(ws.bufferedAmount)
        ) {
          return false;
        }
        const startedAt = performance.now();
        const buildStartedAt = performance.now();
        const payload = buildAITerminalMessagePayload(sessionId, reset, nextEvents, feed?.hasMore ?? false);
        const buildMs = performance.now() - buildStartedAt;
        const stringifyStartedAt = performance.now();
        const serialized = JSON.stringify(payload);
        const stringifyMs = performance.now() - stringifyStartedAt;
        const sendStartedAt = performance.now();
        ws.send(serialized);
        const sendMs = performance.now() - sendStartedAt;
        const elapsedMs = performance.now() - startedAt;
        lastAITerminalBroadcastWarningAtMs = logBroadcastPerfWarning(
          "ai_terminal",
          elapsedMs,
          {
            buildMs: Math.round(buildMs),
            stringifyMs: Math.round(stringifyMs),
            sendMs: Math.round(sendMs),
            bytes: Buffer.byteLength(serialized, "utf8"),
            reset,
            events: nextEvents.length,
          },
          lastAITerminalBroadcastWarningAtMs
        );
        return true;
      };

      if (sessionId !== lastAITerminalSessionId) {
        if (sendPayload(true, events)) {
          lastAITerminalSessionId = sessionId;
          lastAITerminalEventSequence = feed?.latestSequence ?? 0;
        }
        return;
      }

      if (events.length > 0) {
        if (sendPayload(Boolean(feed?.reset), events)) {
          lastAITerminalEventSequence = feed?.latestSequence ?? lastAITerminalEventSequence;
        }
      }
    };

    void sendState(true);
    sendStateEvents();
    sendAIOutputs();
    sendAITerminalEvents();
    const interval = setInterval(() => {
      void sendState();
      sendStateEvents();
      sendAIOutputs();
      sendAITerminalEvents();
    }, 100);

    ws.on("message", (data) => {
      void handleClientMessage({ data, ws, state });
    });

    ws.on("close", () => {
      console.log("客户端已断开");
      clearInterval(interval);
    });
  });

  return { server, wss };
}

export function startServer() {
  const state = createServerState(createPresetStore());
  const { server, wss } = createServer(state);

  console.log("启动 LLMCraft 服务器...");
  console.log(`HTTP/WebSocket 服务器运行在端口 ${PORT}`);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在保存并关闭服务器...`);
    const forcedExit = setTimeout(() => {
      console.error("服务器优雅关闭超时。");
      process.exit(1);
    }, 10_000);
    forcedExit.unref();

    state.activeBenchmark?.stop();
    for (const controller of state.promptReflectionControllers.values()) controller.abort();
    const results = await state.matchRegistry.stopAndSaveAll();
    for (const result of results) {
      if (!result.ok) console.error(`对局 ${result.matchId} 关闭保存失败: ${result.error}`);
    }
    for (const client of wss.clients) client.close();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => wss.close(() => resolve())),
    ]);
    clearTimeout(forcedExit);
    process.exit(results.every((result) => result.ok) ? 0 : 1);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  server.listen(PORT);
  return { server, wss, state };
}

if (process.env.VITEST !== "true") {
  startServer();
}
