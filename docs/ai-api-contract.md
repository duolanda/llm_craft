# LLMCraft AI API Contract

日期: 2026-07-16

这份文档只描述当前 AI 可依赖的接口契约。

它回答两个问题：

- 每次 agent run 会收到什么输入
- 当前可用的工具是什么、各自做什么

不包含战术建议，不包含未来计划。

## 0. 对局与设置接口

### 0.1 `GET /api/settings/presets`

返回服务端保存的模型预设摘要列表：

```ts
interface LLMPresetSummary {
  id: string;
  name: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  rpm?: number | null;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  extraRequestParams?: Record<string, unknown> | null;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### 0.2 `POST /api/settings/presets`

```ts
interface CreateLLMPresetRequest {
  name: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey: string;
  rpm?: number | null;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  extraRequestParams?: Record<string, unknown> | null;
}
```

### 0.3 `PUT /api/settings/presets/:id`

```ts
interface UpdateLLMPresetRequest {
  name: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey?: string;
  rpm?: number | null;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  extraRequestParams?: Record<string, unknown> | null;
}
```

说明：

- `reasoningEffort` 是 OpenAI-compatible 通用 `reasoning_effort` 入口；留空表示不显式传递 `reasoning_effort`。
- `extraRequestParams` 会合并到 chat completions 请求体；它是 LLMCraft 配置里的字段名，语义等价于 Python SDK 的 `extra_body` 内容，但不会在实际 HTTP body 外再包一层 `extra_body`。可用于 provider-specific 参数，例如 DeepSeek 的 `thinking`、`reasoning_effort` 或自定义 `max_tokens`。
- 合并顺序是先写入 `reasoningEffort` 对应的 `reasoning_effort`，再合并 `extraRequestParams`；因此 `extraRequestParams.reasoning_effort` 会覆盖 `reasoningEffort` 快捷字段。
- `extraRequestParams` 不能覆盖核心字段：`model`、`messages`、`tools`、`tool_choice`、`stream`、`signal`。

### 0.4 `POST /api/settings/presets/test`

测试当前预设配置是否能连通 OpenAI-compatible chat completions API。可用于已保存预设，也可用于尚未保存的新配置：

```ts
interface TestLLMPresetRequest {
  presetId?: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey?: string;
  rpm?: number | null;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  extraRequestParams?: Record<string, unknown> | null;
}

interface TestLLMPresetResponse {
  ok: true;
  model: string;
  baseURL?: string;
  latencyMs: number;
  responseText: string;
}
```

说明：

- 如果 `presetId` 指向已保存预设，且请求体未传 `apiKey`，服务端会使用该预设已保存的 API Key。
- 如果没有 `presetId`，必须传 `apiKey`。
- 响应不会返回明文 API Key。

### 0.5 WebSocket `prepare`

```json
{
  "type": "prepare",
  "player1PresetId": "preset-red",
  "player2PresetId": "preset-blue",
  "debug": {
    "recordLLMTranscript": true
  },
  "warmup": {
    "player_1": true,
    "player_2": false
  }
}
```

说明：

- 红蓝双方必须都选择预设
- 服务端会按两个 preset 创建或复用一套待开战 orchestrator
- `debug.recordLLMTranscript = true` 时，仅当前这一局会额外写出 transcript 到 `packages/server/logs/llm-debug/`
- `warmup.player_1/player_2 = true` 时，对应模型会在游戏 tick 启动前先收到首个真实 `AgentRunInput + tools` 请求。服务端只等待模型返回第一条 assistant message；如果该 message 包含 tool calls，会先挂起，不执行工具、不返回 tool result。
- 服务端会发送 `prepare_status`，告知前端准备中、已准备或失败。用户仍需另外发送 `start` 才会启动游戏时间。

### 0.6 WebSocket `start`

```json
{
  "type": "start",
  "player1PresetId": "preset-red",
  "player2PresetId": "preset-blue",
  "debug": {
    "recordLLMTranscript": true
  }
}
```

说明：

- 如果同一组预设和 debug 选项已有待开战 prepared orchestrator，`start` 会直接复用它并开始 tick；已挂起的首个 assistant/tool calls 会在正式开局后继续执行。
- 如果没有匹配的 prepared orchestrator，`start` 会创建普通实时对局并立即开始 tick。

### 0.7 WebSocket `reset`

```json
{
  "type": "reset",
  "player1PresetId": "preset-red",
  "player2PresetId": "preset-blue",
  "debug": {
    "recordLLMTranscript": true
  }
}
```

### 0.8 WebSocket `stop`

```json
{
  "type": "stop"
}
```

### 0.9 WebSocket `save_record`

```json
{
  "type": "save_record"
}
```

### 0.10 WebSocket `state`

```ts
interface ServerStateMessage {
  type: "state";
  state: GameState | null;
  frame?: StateProjectionFrameV1;
  aiOutputs: Record<string, string>;
  snapshots: GameSnapshot[];
  liveEnabled: boolean;
  matchStatus: "preparing" | "running" | "stopped" | "finished" | null;
}
```

`frame` 是正式 v1 投影：首帧、切换 match 和每 20 帧使用 keyframe，其余使用带 `baseFrameSequence` 的 exact delta。metadata 固定携带 `frameSequence / simulationTick / simulationTimeMs / tickIntervalMs / serverTimeMs`。delta 帧中的兼容 `state` 为 `null`，新客户端必须用 `@llmcraft/trace` projector 组装状态。`snapshots` 仅为旧客户端兼容字段。backlog 达 `1 MB` 时暂停可替换投影，排空后从上一个已发帧直接构建 latest delta，不补发过期中间帧。

客户端的有界 `SimulationFrameBuffer` 同时服务 Live 和 Replay；它按 simulation time 取前后帧，包到达时间只用于估算带缓冲延迟的当前模拟时间，不再决定单位移动速度。

### 0.11 WebSocket `error`

```ts
interface ServerErrorMessage {
  type: "error";
  message: string;
}
```

### 0.12 WebSocket `prepare_status`

```ts
type MatchPrepareState = "idle" | "preparing" | "ready" | "error";

interface ServerPrepareStatusMessage {
  type: "prepare_status";
  statuses: Partial<Record<"player_1" | "player_2", MatchPrepareState>>;
  message?: string;
}
```

### 0.13 WebSocket `ai_terminal_events`

右侧 AI 指挥终端使用增量事件流。完整事件会原样追加到当前对局的磁盘 journal；服务端和浏览器的实时缓存只驻留最近 `500` 条，旧事件通过 `load_terminal_history` 分页读取，不截断模型文本、工具参数或工具结果。游标落后于实时窗口时会发送 `reset=true` 和当前窗口。

```ts
interface ServerAITerminalEventsMessage {
  type: "ai_terminal_events";
  sessionId: string | null;
  reset: boolean;
  events: AITerminalEvent[];
  hasMore?: boolean;
}

type AITerminalEvent =
  | {
      id: string;
      kind: "request";
      playerId: "player_1" | "player_2";
      requestNumber: number;
      requestTick: number;
      createdAt: string;
    }
  | {
      id: string;
      kind: "assistant";
      playerId: "player_1" | "player_2";
      requestNumber: number;
      requestTick: number;
      createdAt: string;
      text: string;
    }
  | {
      id: string;
      kind: "tool_call";
      playerId: "player_1" | "player_2";
      requestNumber: number;
      requestTick: number;
      createdAt: string;
      toolCall: AgentToolCallRecord;
    };
```

说明：

- `reset = true` 表示前端应清空当前终端历史，并用这条消息里的 `events` 作为新的基线
- `reset = false` 表示 `events` 是增量追加
- `request` 事件只用于在终端中画出 `Request #N · tick X` 分隔线
- `assistant` 事件显示模型文本输出
- `tool_call` 事件显示工具 badge；其参数和结果在展开后查看
- `request_error` 和 `request_finished` 不进入终端正文，错误仍通过 `error` 或游戏日志查看

历史分页：

```ts
interface ClientLoadTerminalHistoryMessage {
  type: "load_terminal_history";
  beforeSequence?: number;
  limit?: number; // 1-500
}

interface ServerTerminalHistoryPageMessage {
  type: "terminal_history_page";
  sessionId: string;
  events: AITerminalEvent[];
  hasMore: boolean;
}
```

### 0.14 WebSocket `record_saved`

```ts
interface ServerRecordSavedMessage {
  type: "record_saved";
  filePath: string;
}
```

### 0.15 WebSocket `start_benchmark`

```json
{
  "type": "start_benchmark",
  "presetId": "preset-red",
  "cpuStrategy": "rush",
  "rounds": 10,
  "concurrency": 4,
  "recordReplay": true,
  "decisionIntervalTicks": 10,
  "debug": {
    "recordLLMTranscript": false
  }
}
```

说明：

- benchmark 只支持 `LLM preset vs CPU strategy`
- 当前 CPU 策略支持 `random` 和 `rush`
- benchmark 与 live match 现在共用同一套 tool-calling runtime
- `concurrency` 可选，默认 `1`，允许 `1` 到 `10`；并发运行时完成顺序可能不同于 round 编号，最终结果按 round 编号输出
- `recordReplay=false` 表示 round 结束并 quiesce controller 后直接丢弃临时 journal；不会因为后台生命周期治理而偷偷生成 benchmark record

### 0.16 WebSocket `benchmark_progress`

```ts
interface ServerBenchmarkProgressMessage {
  type: "benchmark_progress";
  cpuStrategy: "random" | "rush";
  completedRounds: number;
  totalRounds: number;
  llmWins: number;
  cpuWins: number;
  draws: number;
  viewedRound?: number;
  activeRounds: Array<{
    round: number;
    llmSide: "player_1" | "player_2";
    tick: number;
  }>;
}
```

说明：

- `viewedRound` 是当前主画面正在显示的 benchmark round；并发运行时由服务端自动选择
- `activeRounds` 是仍在运行中的 round 列表，按 round 编号排序
- 当 `viewedRound` 对应 round 结束时，服务端会自动切到剩余活跃 round 中编号最小的一局

### 0.17 WebSocket `benchmark_complete`

```ts
interface ServerBenchmarkCompleteMessage {
  type: "benchmark_complete";
  completedRounds: number;
  totalRounds: number;
  llmWins: number;
  cpuWins: number;
  draws: number;
  llmWinRate: number;
  averageDurationTicks: number;
  medianDurationTicks?: number;
  p90DurationTicks?: number;
  llmWinRateConfidence95?: { low: number; high: number };
  positionBias?: number; // player_1 win rate - player_2 win rate
  stopped: boolean;
  rounds: ServerBenchmarkRoundResult[];
}
```

## 1. Agent Run 输入

每次 AI 被唤醒时，不再收到完整 `AIPromptPayload + JavaScript 执行环境`；旧 `full/delta` 兼容输入已从代码中移除。

当前模型收到的是：

- 从 `MatchDefinition + playerId` 生成的阵营相对 `system prompt`；我方/敌方 HQ、开局工地与推进方向会镜像，不再复用 player_1 坐标
- 持续对话历史
- 当前新的 `user` 消息，内容是 `AgentRunInput`

```ts
interface AgentRunInput {
  playerId: "player_1" | "player_2";
  tick: number;
  tickIntervalMs: number;
  summary: string;
}
```

字段说明：

- `playerId`: 当前 AI 阵营
- `tick`: 当前游戏 tick
- `tickIntervalMs`: tick 时长，当前固定 `500`
- `summary`: 从上次 run 到现在的关键变化，以及当前最值得关注的现状摘要

当我方 HQ 已处于敌方攻击范围内时，`summary` 会在最前面插入一行固定警告：

- `Alert: our HQ is under attack.`

当前 `summary` 不承载完整状态快照。模型应通过工具主动读取战场信息。

### 1.1 当前规则来源

当前 MVP 规则由 shared 默认 ruleset（`DEFAULT_RULESET`）描述。Phase 1 已加入最小 OpenRA-lite 多兵种层：

- 单位类型是 `worker | soldier | rifleman | rocket_soldier | light_tank`
- 建筑类型是 `hq | barracks | war_factory`
- `hq` 可生产 `worker`
- `barracks` 可生产 `soldier | rifleman | rocket_soldier`
- `war_factory` 可生产 `light_tank`
- 当前采用 144x96 三战线大战场尺度：`soldier` 115 HP / 10 damage / range 1 / vision 5 / cost 55 / reload 3；`rifleman` 95 HP / 9 damage / range 6 / vision 7 / cost 70 / reload 2；`rocket_soldier` 80 HP / 34 damage / range 6 / vision 7 / cost 110 / reload 8；`light_tank` 420 HP / 42 damage / range 5 / vision 7 / cost 240 / reload 6
- 伤害按目标 armor 计算：`soldier` 对 infantry 1x、vehicle 0.25x、structure 0.35x；`rifleman` 对 infantry 1.45x、vehicle 0.25x、structure 0.35x；`rocket_soldier` 对 infantry 0.35x、vehicle 2.25x、structure 0.9x；`light_tank` 对 infantry 0.8x、vehicle 1x、structure 0.9x
- 攻击结算为 weapon/projectile/warhead 模型：命令成功会生成 projectile，projectile 抵达后才造成伤害。`rocket_soldier` 和 `light_tank` 有 1 格 splash；`ok: true` 不表示目标 HP 已经立即变化。
- `GameState.projectiles?: ActiveProjectile[]` 暴露实时弹丸，用于客户端渲染。旧 compact-v2 录像可能没有该可选字段。
- 当前不启用战争迷雾读取层；agent 观察工具返回全图敌方实体、地形和资源。`visionRange` 仍用于单位自动索敌，不用于隐藏情报。
- 默认 `144x96` 地图暂不生成任何 `obstacle` 岩石；`obstacle` tile 语义仍保留。资源点避开中央主攻路线，当前默认坐标为：红方基地外侧 `(31,35) (34,39) (31,57) (34,61)`，蓝方基地外侧 `(112,35) (109,39) (112,57) (109,61)`，上/下侧翼 `(47,18) (50,22) (47,74) (50,78) (96,18) (93,22) (96,74) (93,78)`。
- `UNIT_STATS` / `BUILDING_STATS` 仍作为兼容导出存在

服务端核心逻辑通过 ruleset helper 读取单位数值、建筑数值、生产关系、成本和攻击能力判断；工具 schema 已接受新增 unit/building 类型。

### 1.2 服务端命令交付契约

Agent 动作工具和 control-plane 动作现在都会先进入对局专属的 `CommandGateway`，不再直接依赖 HTTP/模型返回的墙钟先后顺序。当前共享契约为：

```ts
interface CommandEnvelopeV1 {
  envelopeVersion: 1;
  matchId: string;
  actorId: string;
  baseTick: number;
  applyAtTick: number;
  sequence: number;
  clientRequestId: string;
  commands: Command[];
}

interface CommandProvenance {
  controllerId: string;
  source: "macro_tool" | "mission" | "tactical" | "external" | "subagent" | "test";
  turnId?: string;
  toolCallId?: string;
  missionId?: string;
  parentControllerId?: string;
}
```

- 一个 envelope 整体接受或整体拒绝；任一 command 越权、ID 重复或字段无效时，不会部分入队。
- 完全相同的 `clientRequestId` + envelope 重试返回 `duplicate: true`，不会再执行；同一 ID 携带不同内容会返回 `idempotency_conflict`。
- 正式 envelope actor 必须与 command 的 `playerId` 一致；Controller/子 Agent 身份不伪装成新玩家，而是写入命令的 `provenance`。子 Agent 使用 `subagent:<taskId>` controllerId，并保留 parentControllerId/turnId。
- 命令只在 `applyAtTick` 的 tick 边界释放，同 tick 按 `actorId -> sequence -> clientRequestId` 稳定排序。
- tick 执行时每个 envelope 具有独立 checkpoint；其中任一命令失败会恢复整个 envelope 的世界修改，并为所有命令产生 `success: false` 的 `command_result` 与 `command_envelope_rolled_back`。如果整批路径命令超过该 tick 的剩余预算，也会以 `path_budget_exceeded` 整批回滚，不会把尾部命令延期到下一 tick。
- `MatchDefinition v2.rules.commandBudget` 版本化保存 `maxCommandsPerActorPerTick` 和 `maxPathCommandsPerTick`。默认值分别为 `100` 和 `4`；Gateway、Game 公平分配与 Trace manifest 消费同一份定义。旧 `MatchDefinition v1` 没有该字段，读取时固定解释为这两个历史默认值。Gateway 按 actor/apply tick跨 envelope 累计，拆分请求不能绕过；路径额度双方先等额保底，空余额以 simulation tick 轮换起点逐个借出。Game 仍保留 `command_budget_exceeded` 作为防御性执行不变量。
- 这是服务端内部交付契约；当前 action tool 的入参和返回格式不变，但“工具返回成功”表示命令已被接纳，不表示游戏规则已在当前 tick 执行成功。

`DomainEvent<TPayload>` v1 现在承载 Gateway 事实、命令结果和 SimulationCore outcome，基础字段为 `matchId / eventSequence / tick / type / actorId? / commandId? / entityIds? / payload`。`type` 是 shared 中的显式联合，不是任意字符串。它们由 MatchJournal 流式追加到临时 NDJSON，并进入正式 Trace v3；命令结果不需要解析 GameLog 文案。正式 replay projection 中的兼容 `commandResults` 已通过 `projectCommandResultEventToGameLog()` 从 `command_result` 事实生成；Game 内实时 UI/AI feedback 日志仍是兼容 adapter，不是权威事件总线。

Trace v3 的正式共享外形为 `MatchTraceRecordV3`，schemaVersion 固定为 `3`，包含 manifest、初始/最终 keyframe、完整 command submissions、state hashes、DomainEvents、AI turns、terminal events，以及显式标为派生缓存的 `replayProjection`。manifest 保存完整 `MatchDefinition`（含 ruleset/scenario/seed）、状态和 capability；capability 必须显式为 `complete / partial / absent`，缺少模型请求 span 等能力时不能静默假定存在。`@llmcraft/trace` 的 `validateMatchTraceRecordV3()` 会校验版本、capability、matchId、连续 event/submission sequence、keyframe/hash tick 边界、replay delta 边界和 SHA-256 格式。

活跃 MatchJournal 写入 manifest、command submissions、DomainEvents、AI/terminal 流、replay delta 和 hash v2 NDJSON；hash v2 包含确定性 RNG 状态。每个已提交 tick 的 replay delta 落盘后，MatchRuntime 会释放 Game 内兼容 delta 缓存。每个服务进程拥有 owner metadata，每局使用带随机 journalId 的独立 workspace，相同 matchId 不会清空已有目录。正式 `saveRecord()` 会先等待 controller/CPU/transcript 写入安静，再固定一致 cut，以 64 KiB gzip chunk 流式写 `.trace.json.gz` 临时文件，`fsync` 后原子 rename。相同 cut 的并发保存去重，校验失败会移除临时文件；终局成功后 workspace 被 seal 并删除，历史 terminal 分页从压缩 Trace 按需读取。读取边界同时接受历史 `.json` 和当前 `.json.gz`。

服务器启动会跳过仍存活的 owner，将失活 owner 和超过安全宽限期的旧版 journal 搬入 durable orphan recovery 目录并保留 provenance。record、benchmark record、两类 transcript 和 orphan journal 使用分组的最大年龄、条目数和容量策略；版本化 pins、同名 `.keep` sidecar 和目录 `.llmcraft-keep` 都是不可删除项。正式 artifact 默认仅 dry-run，只有显式 apply 才删除；orphan recovery 目录会自动应用自身策略。

`@llmcraft/trace` 是唯一跨 server/client 的 record 适配层：`projectRecordToGameRecord()` 同时接受 compact-v2 和 replay-capability 完整的 Trace v3；`migrateCompactV2ToTraceV3()` 必须由调用者提供 MatchDefinition，并把旧记录没有的 command submissions、DomainEvents、state hashes 等 capability 标记为 `absent`，禁止补造事实。Replay/Diagnostics 通过 projector 消费派生 `GameRecord`；Analyzer 对 Trace 的命令指标直接读取 DomainEvent，Transcript Viewer 直接读取 AI turns、tools、commands 和关联事件。`modelRequestSpans/toolCallSpans=partial` 时，工具必须显示能力缺口，不能伪造完整 waterfall。

`tick_error` 的兼容日志数据可带 `attemptedTick / committedTick / committed`。`committed: false` 表示 SimulationCore 失败且权威状态已回滚；`committed: true` 表示 tick 已提交、随后 Trace Journal 写入失败。后一种情况必须 fail-stop，且不会产生虚假的 `simulation_tick_failed`。

整批回滚时，每个兼容 `command_invalid` 结果的 `result_data` 至少含 `hint`，并可含 `reason: "command_failed" | "command_budget_exceeded" | "path_budget_exceeded"`、`failedCommandId`、`failedResultCode` 和 `failedResultType`；消费者应以 `success: false` 与 envelope rollback event 判断事实，不把批内早先一条命令原本的局部成功当成已提交状态。

## 2. 工具体系

### 2.1 只读观察工具

#### `get_map_state`

返回全图结构化战场信息：

```ts
{
  tick: number;
  width: number;
  height: number;
  units: Array<{
    id: string;
    type: UnitType;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    state: UnitState;
    relation: "self" | "enemy";
  }>;
  buildings: Array<{
    id: string;
    type: BuildingType;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    relation: "self" | "enemy";
  }>;
  resources: Array<{
    x: number;
    y: number;
    remaining: number;
  }>;
  cells?: Array<{
    x: number;
    y: number;
    tile: TileType;
    unit?: {
      id: string;
      type: UnitType;
      x: number;
      y: number;
      hp: number;
      maxHp: number;
      state: UnitState;
      relation: "self" | "enemy";
    };
    building?: {
      id: string;
      type: BuildingType;
      x: number;
      y: number;
      hp: number;
      maxHp: number;
      relation: "self" | "enemy";
    };
  }>;
}
```

说明：

- 当前默认地图为 `144 x 96`；当前没有战争迷雾，默认返回全图结构化信息。前端默认使用 3D 战场表现层，但 AI 工具仍使用底层战术坐标。
- `fogOfWar`、`visibleTileCount` 和 `asciiMap` 已移除；默认读取不再消耗上下文返回符号地图
- 精确坐标默认看 `units` 和 `buildings`；只有需要逐格地形时才传 `includeCells=true`
- `cells` 返回值按坐标分组，每个 `cell` 表示该位置上的地形与占用物
- 单位和建筑子项带 `relation` 字段，表示是己方还是敌方；关系由观察玩家与权威 `playerId` 派生，共享 `Unit` / `Building` 类型不再保存含义不稳定的 `my` 布尔值
- 默认不返回 `cells`，以降低上下文体积
- 传 `includeCells=true` 时只返回全图“有信息量”的格子：资源、障碍、单位、建筑
- 传 `includeEmptyTiles=true` 时会隐含 `includeCells=true`，返回完整地图格子信息（包括 empty）
- `unit` 是精简视图，不返回 `playerId / carryingCredits / carryCapacity / attackRange / intent` 等字段；`my` 已从权威实体类型删除，不属于任何观察接口契约

### 2.1.1 旧读取结果折叠

在同一个长 run 中，新的同名同参数读取会替代旧读取结果。provider 不删除 assistant 文本，也不删除 tool-call 配对；只会把旧 read tool result 的大 JSON 折叠成 tombstone：

```ts
{
  expired: true;
  reason: "superseded_by_new_read";
  toolName: string;
  args: unknown;
  observedTick: number | null;
  message: string;
}
```

折叠粒度是 `toolName + normalizedArgs`。例如新的 `get_map_state({})` 只会折叠旧的同参数 `get_map_state`，不会折叠 `includeCells: true` 或 `includeEmptyTiles: true` 的旧结果。动作工具结果不会被该机制折叠。

#### `get_my_state`

返回我方经济与建筑状态：

```ts
{
  tick: number;
  credits: number;
  hq: Building | null;
  buildings: Building[];
  productionQueues: Array<{ buildingId: string; queue: UnitType[] }>;
  canBuildBarracks: boolean;
  canBuildWarFactory: boolean;
  canBuildRefinery: boolean;
  canSpawnWorker: boolean;
  canSpawnSoldier: boolean;
  canSpawnRifleman: boolean;
  canSpawnRocketSoldier: boolean;
  canSpawnLightTank: boolean;
  economyStatus: {
    workers: number;
    activeHarvesters: number;
    idleWorkers: number;
    carryingCredits: number;
    resourceAssignments: Array<{
      x: number;
      y: number;
      assignedHarvesters: number;
      distanceToHq: number | null;
    }>;
    recommendations: Array<{
      action: string;
      reason: string;
      unitIds?: string[];
      target?: number;
    }>;
  };
  unitCosts: Record<UnitType, number>;
  buildingCosts: Partial<Record<BuildingType, number>>;
  buildingConstructionTicks: Partial<Record<BuildingType, number>>;
  techStatus: {
    own: {
      workers: number;
      combatUnits: number;
      riflemen: number;
      rocketSoldiers: number;
      lightTanks: number;
      barracks: number;
      warFactories: number;
    };
    enemy: {
      hasWarFactory: boolean;
      lightTanks: number;
      rocketSoldiers: number;
    };
    attackWindow: {
      ready: boolean;
      combatUnits: number;
      groupedCombatUnits: number;
      unitIds: string[];
      targetId: string | null; // enemy HQ
      assemblyPoint: Position | null;
      reason: string;
    };
    productionWarnings: Array<{
      type: "enemy_anti_armor_mass";
      avoidUnitType: "light_tank";
      preferredUnitType: "rifleman";
      reason: string;
    }>;
    recommendedStructures: Array<{
      workerId: string;
      buildingType: "barracks" | "war_factory" | "refinery";
      cost: number;
      constructionTicks: number;
      reason: string;
      suggestedSites: Array<Position & {
        workerPosition: Position;
      }>;
    }>;
    recommendedProduction: Array<{
      buildingId: string;
      buildingType: "hq" | "barracks" | "war_factory";
      unitType: "worker" | "rifleman" | "rocket_soldier" | "light_tank";
      reason: string;
    }>;
  };
}
```

`economyStatus` 是派生提示字段，用于减少 agent 每轮重复检查 worker 经济：`activeHarvesters` 表示已挂 `harvest_loop` 的 worker 数量，`idleWorkers` 表示当前空闲 worker 数量，`resourceAssignments` 表示各资源点当前分配到的采矿 worker 数量。默认开局建议维持 3 个 harvester 并保留 1 个 builder；省略坐标调用 `start_harvest_loop` 时，系统会倾向选择较近且较少 worker 占用的资源点。

`techStatus` 是派生提示字段，用于减少 agent 每轮重复推理科技链：没有已完成 `barracks` 时优先提示补兵营；约 6 个战斗单位形成第一波，或敌方出现 `light_tank` / `war_factory` 后，才提示补 `war_factory`；敌方装甲科技出现时提示从空闲兵营补 `rocket_soldier`。`attackWindow` 按 12 格内最大局部集群判断，不把分散在整张地图上的总兵力误算成可出击兵团；未成军时会给出 `assemblyPoint` 并明确禁止单兵添油。敌方至少有 3 个火箭兵且我方步枪兵屏障不足时，`productionWarnings` 会要求暂停推荐 `light_tank`、优先补 `rifleman`。`recommendedStructures` 和 `recommendedProduction` 会尽量携带可直接调用工具的 `workerId` / `buildingId`；每个 `suggestedSites` 项同时给出建筑中心和 footprint 外的 `workerPosition`，必须成对使用，不能让 worker 站在建筑中心。施工中的建筑会出现在 `buildings` 中并带 `constructionProgress`，但不会计入 `techStatus.own`、不会满足 `building_exists`，也不能生产。

`build_structure` 在 `insufficient_credits`、`invalid_build_position` 或 `worker_too_far` 时还会返回同形状的 `suggestedPlacements`，并在 `hint` 中说明“先移动 workerPosition，再对建筑中心建造”。

#### `get_my_units`

返回我方可直接操作单位：

```ts
{
  tick: number;
  groups: Array<{
    role: "combat" | "worker";
    intent: string;
    count: number;
    unitIds: string[];
    types: Partial<Record<UnitType, number>>;
    center?: Position;
    hasActivePlanCount: number;
  }>;
  pendingGroupMoves: {
    count: number;
    unitIds: string[];
  };
  units: Array<Unit & {
    hasActivePlan: boolean;
    hasPendingGroupMove: boolean;
  }>;
}
```

`groups` 按 `role + intent` 聚合，目的是让 agent 直接看见例如 `combat + hold` 或 `combat + none` 的大批闲置部队；具体操作仍使用 `units` 里的 unit id。`attack_move_group` 超出当 tick 寻路份额的成员会进入 `pendingGroupMoves`，短暂显示 idle 不代表漏下命令；对这些单位立刻补发逐个移动会取消其已接受的编队任务。

#### `get_army_summary`

返回紧凑战斗态势，不改变游戏状态：

```ts
{
  tick: number;
  myCounts: Record<UnitType, number>;
  enemyCounts: Record<UnitType, number>;
  combatUnits: number;
  readyCombatUnits: number;
  reloadingCombatUnits: number;
  groupedCombatUnits: number;
  assemblyPoint: Position | null;
  recommendedFormation: "line" | "battle_line";
  recommendations: Array<{
    action: string;
    reason: string;
    formation?: "battle_line";
    unitIds?: string[];
    targetId?: string;
    minimumGroupSize?: number;
    avoidUnitType?: UnitType;
  }>;
}
```

说明：

- 这是给 agent 的读工具，用于判断是否缺反坦克、缺步兵掩护、是否适合用 `attack_move_group` 组织军团推进；少于 6 个彼此靠近的战斗单位时会推荐在 `assemblyPoint` 重新集结
- `recommendations` 是非强制提示，不会替 agent 自动造兵或自动分兵

#### `get_active_plans`

返回当前仍在生效的高层计划：

```ts
{
  tick: number;
  plans: AgentPlanRecord[];
}
```

`AgentPlanRecord` 包含计划的完整 steps、当前 step 下标和可选诊断字段：

```ts
interface AgentPlanAttemptRecord {
  tick: number;
  stepIndex: number;
  call: PlanCallToolName;
  status: "waiting" | "command_created" | "advanced" | "failed";
  detail?: string;
  commandCount?: number;
}

interface AgentPlanRecord {
  planId: string;
  unitIds: string[];
  scope?: PlanStepScope;
  loop: number;
  steps: PlanStep[];
  currentStepIndex: number;
  status: "active" | "completed" | "interrupted" | "failed";
  currentStep?: PlanStep;
  waitingReason?: string;
  lastAttempt?: AgentPlanAttemptRecord;
}
```

说明：

- `currentStep` 是当前正在等待或推进的 step
- `waitingReason` 只在 active plan 当前没有生成命令时出现，例如等待 `when` 条件、等待 `until`、等待预算或等待命令前置条件
- `lastAttempt` 记录最近一次推进尝试；`command_created` 表示该 tick 已生成命令，`advanced` 表示 step 已推进，`failed` 表示计划失败

#### `get_recent_events`

返回最近的 AI-facing 反馈和关键事件：

```ts
{
  tick: number;
  events: GameLog[];
}
```

### 2.2 即时动作工具

#### `move_unit`

```ts
{
  unitId: string;
  x: number;
  y: number;
}
```

说明：

- 主要用于 worker 移动或 combat unit 精确换位
- 如果已经知道敌方目标 ID，尤其是 HQ / barracks / war_factory / refinery / 关键敌军，应优先使用 `attack`，不要用 `move_unit` 代替进攻命令

#### `attack_move_unit`

```ts
{
  unitId: string;
  x: number;
  y: number;
  priority?: Array<"worker" | "soldier" | "rifleman" | "rocket_soldier" | "light_tank" | "hq" | "barracks" | "war_factory" | "refinery">;
}
```

说明：

- 只接受有攻击能力的己方单位：`soldier`、`rifleman`、`rocket_soldier`、`light_tank`
- 单位会向目标点移动，并在到达前自动攻击范围内的角色匹配目标：`rifleman` 默认优先清火箭/步兵，`rocket_soldier` 默认优先打 `light_tank`，`light_tank` 默认优先打敌方装甲和反装甲支援，其后才拆生产建筑/HQ/精炼厂
- 单位到达目标点后，`attack_move_unit` 命令结束，不会继续自动攻击后续靠近或新生产的敌方单位
- 这是无目标推进命令，只用于没有明确 `targetId` 时穿越危险区域或试探接敌
- 不用于指定攻击某个目标或建筑；点杀敌军、拆 HQ、拆 barracks、拆 war_factory、拆 refinery 应使用 `attack`
- 显式 `priority` 会严格限制可攻击目标类型，不会 fallback 到未列出的建筑或单位

#### `attack_move_group`

```ts
{
  unitIds: string[];
  x: number;
  y: number;
  formation?: "line" | "column" | "wedge" | "dispersed" | "battle_line";
}
```

说明：

- 一次控制 1-100 个己方战斗单位，给每个单位分配不同推进落点
- `battle_line` 是角色化编队：`light_tank` 前排，`soldier/rifleman` 居中，`rocket_soldier` 后排
- 编队只影响目的地分配和默认攻击优先级；它不会强制 AI 攒兵，也不会自动替 AI 选择战略路线
- 大军团推进、正面压制、侧翼小队推进时优先使用本工具，避免逐单位反复调用 `attack_move_unit`
- 结果中的 `queuedNow` 是本 tick 立即下发数，`scheduled` 是已接受并会由 Bridge 跨后续 tick 下发的数量；`scheduled > 0` 时不要因单位暂时 idle 而补发逐个移动，先检查 `get_my_units.pendingGroupMoves`

#### `attack`

```ts
{
  unitId: string;
  targetId: string;
}
```

说明：

- 只接受有攻击能力的己方单位：`soldier`、`rifleman`、`rocket_soldier`、`light_tank`
- `targetId` 必须来自全图情报中的敌方单位或建筑 ID
- 这是有明确目标 ID 时的默认战斗命令；即使目标很远，系统也会让单位向目标移动，进入射程后持续攻击
- 攻击敌方 HQ、barracks、war_factory、refinery 或关键敌军时，优先使用 `attack`，不要先用 `attack_move_unit` 或 `move_unit` 代替
- 目标已经消失但曾被读取过时，系统会自动降级为移动到该目标最后记录的位置；调用方不需要也不能传坐标
- 未知目标 ID 返回 `ok: false` 和 `hint`

#### `spawn_unit`

```ts
{
  buildingId: string;
  unitType: "worker" | "soldier" | "rifleman" | "rocket_soldier" | "light_tank";
}
```

#### `build_structure`

```ts
{
  unitId: string;
  buildingType: "barracks" | "war_factory" | "refinery";
  x: number;
  y: number;
}
```

说明：

- 当前允许建造 `barracks`、`war_factory` 和 `refinery`
- `war_factory` 需要己方已有一个已完成的 `barracks`
- worker 必须先移动到目标建筑完整 footprint 的相邻 1 格内，才能开始施工
- 建造成功会立即扣 credits 并创建施工中的建筑；施工中建筑占地、可被攻击，但不能生产，也不满足科技前置
- 施工会占用该 worker，施工完成前不能移动、采矿或接收其他命令
- 默认施工时间：`barracks` 12 ticks，`war_factory` 18 ticks，`refinery` 16 ticks
- `refinery` 是矿场/精炼厂，可建在前线矿附近，worker 采矿后会向最近的 HQ 或已完成 refinery 交付
- 建筑必须建在空地上，且要给己方 `HQ` 周围留出一圈空地
- 如果位置不合法，失败返回的 `hint` 会直接给出附近可行位置示例

#### `start_harvest_loop`

```ts
{
  unitId: string;
  x?: number;
  y?: number;
}
```

说明：

- 只接受己方 `worker`
- 让 worker 进入内建采矿循环，在资源点和己方 HQ 之间自动往返
- 省略 `x/y` 时，游戏会自动选择最近资源点
- 常规采矿应优先使用这个工具，不要用 `orchestrate_plan` 手写 worker 往返路线
- 已经处于 `harvest_loop` 的 worker 默认视为已有任务，除非被堵、资源选择错误或需要改派，不要每轮重复调用

#### `hold_unit`

```ts
{
  unitId: string;
}
```

这些工具会先做明显无效请求的即时校验，例如单位/建筑不存在、目标不是敌人、worker 不能攻击等。校验失败时返回 `ok: false`、`error`、`hint`，且不会入队。

成功和失败结果都会带当前 `tick`。如果本轮最后一次只读工具调用距离当前超过 10 ticks，或本轮还没有调用过只读工具，动作/计划工具会附带 `warning`，但不会仅因为 warning 拒绝入队：

```ts
{
  tick: number;
  ok: boolean;
  commandId?: string;
  error?: string;
  hint?: string;
  warning?: {
    type: "state_stale" | "no_recent_read";
    message: string;
    currentTick: number;
    lastReadTick?: number;
    ageTicks?: number;
    staleAfterTicks: number;
  };
}
```

这些工具只负责把命令加入当前 tick 的 command queue。真正的移动、攻击、建造、产兵依然由 `Game` 逐 tick 结算。

### 2.3 高层编排工具 `orchestrate_plan`

这是当前唯一的高层计划工具。

```ts
interface OrchestratePlanInput {
  unitIds: string[];
  replaceExisting?: boolean;
  scope?: PlanStepScope;
  loop?: number; // -1 表示无限循环
  steps: PlanStep[];
}
```

```ts
interface PlanStep {
  call: PlanCallToolName;
  args: Record<string, unknown>;
  scope?: PlanStepScope;
  when?: PlanStepCondition;
  until?: PlanStepCondition;
  retry?: boolean;
  maxTicks?: number;
}
```

```ts
type PlanCallToolName =
  | "move_unit"
  | "attack_move_unit"
  | "attack"
  | "spawn_unit"
  | "build_structure"
  | "start_harvest_loop"
  | "hold_unit";
```

```ts
type PlanStepScope = "global" | "per_unit";
```

```ts
type PlanStepCondition =
  | { condition: "arrived" }
  | { condition: "enemy_in_range" }
  | { condition: "hq_in_range" }
  | { condition: "near_position"; x: number; y: number; distance?: number }
  | { condition: "target_in_range"; targetId: string }
  | { condition: "target_destroyed"; targetId: string }
  | { condition: "credits_at_least"; amount: number }
  | { condition: "building_exists"; buildingType: BuildingType; count?: number }
  | { condition: "enemy_building_exists"; buildingType: BuildingType; count?: number }
  | { condition: "unit_count_at_least"; unitType: UnitType; count: number }
  | { condition: "enemy_unit_count_at_least"; unitType: UnitType; count: number }
  | { condition: "production_queue_empty"; buildingId?: string; buildingType?: BuildingType };
```

说明：

- `orchestrate_plan` 只注册计划，不会在一次 tool call 内跑完整段脚本
- 计划会在后续 tick 自动推进
- 即时动作会打断相关单位的当前计划
- 如果单位已有合适的 active plan，不要每个 run 都重复注册同一个计划
- `steps` 只接受 call step，把现有动作工具调用注册成持续计划
- `scope = "per_unit"` 会对 `unitIds` 中每个存活单位展开；`scope = "global"` 只执行一次
- `when` 是执行前置条件，未满足时等待；`until` 是完成条件，满足后推进到下一 step
- global step 如果在 `args.unitId` 中指定具体单位，`when` / `until` 的 `arrived`、`near_position`、`enemy_in_range`、`hq_in_range` 和 `target_in_range` 会基于该单位判断
- `enemy_building_exists` / `enemy_unit_count_at_least` 用于表达反制触发，例如看到敌方 `war_factory` 或 `light_tank` 后补 `rocket_soldier`
- `args.unitId` 可以省略或设为 `"$unitId"`，表示 per-unit 展开时使用当前单位
- `spawn_unit` 的 `args.buildingId` 可使用 `"$hq"`、`"$barracks"` 或 `"$war_factory"`，在执行时解析为当前友方建筑
- plan 中的 `spawn_unit` / `build_structure` 会在当前 credits 不足时等待，不会入队必然失败的生产或建造命令；`build_structure` 仍要求 worker 已经在 footprint 相邻 1 格内，因此常见计划应先用 `move_unit` 把 builder 移到工地旁；即时动作工具仍会返回 `insufficient_credits`
- 多个 active plan 在同一 tick 推进时共享同一份预算；较早生成的 `spawn_unit` / `build_structure` 会预留本 tick credits，后续付费 step 如果余额不够会等待下一次收入或下一轮推进
- `attack` call step 默认具备持续重试语义；也可以显式传 `retry: true`

示例：先用即时 `start_harvest_loop` 把另外 3 个开局 worker 挂矿，再为保留的 builder 注册兵营计划并持续造到第一波 6 个 rifleman。

```json
{
  "unitIds": ["worker_builder"],
  "loop": 1,
  "steps": [
    {
      "call": "move_unit",
      "args": { "unitId": "worker_builder", "x": 1, "y": 10 },
      "scope": "global",
      "until": { "condition": "near_position", "x": 1, "y": 10, "distance": 1 },
      "retry": true
    },
    {
      "call": "build_structure",
      "args": { "unitId": "worker_builder", "buildingType": "barracks", "x": 4, "y": 10 },
      "scope": "global",
      "when": { "condition": "credits_at_least", "amount": 120 },
      "until": { "condition": "building_exists", "buildingType": "barracks" },
      "retry": true
    },
    {
      "call": "spawn_unit",
      "args": { "buildingId": "$barracks", "unitType": "rifleman" },
      "scope": "global",
      "when": { "condition": "production_queue_empty", "buildingType": "barracks" },
      "until": { "condition": "unit_count_at_least", "unitType": "rifleman", "count": 6 },
      "retry": true
    }
  ]
}
```

示例：第一波约 6 个战斗单位已经形成，或敌方装甲科技已出现时，补 `war_factory` 并生产 1 台 `light_tank`。

```json
{
  "unitIds": ["unit_1"],
  "loop": 1,
  "steps": [
    {
      "call": "move_unit",
      "args": { "unitId": "unit_1", "x": 0, "y": 12 },
      "scope": "global",
      "until": { "condition": "near_position", "x": 0, "y": 12, "distance": 1 },
      "retry": true
    },
    {
      "call": "build_structure",
      "args": { "unitId": "unit_1", "buildingType": "war_factory", "x": 4, "y": 12 },
      "scope": "global",
      "when": { "condition": "credits_at_least", "amount": 220 },
      "until": { "condition": "building_exists", "buildingType": "war_factory" },
      "retry": true
    },
    {
      "call": "spawn_unit",
      "args": { "buildingId": "$war_factory", "unitType": "light_tank" },
      "scope": "global",
      "when": { "condition": "production_queue_empty", "buildingType": "war_factory" },
      "until": { "condition": "unit_count_at_least", "unitType": "light_tank", "count": 1 },
      "retry": true
    }
  ]
}
```

示例：敌方出现 `light_tank` 后，从兵营补到 2 个 `rocket_soldier`。

```json
{
  "unitIds": ["unit_1"],
  "replaceExisting": false,
  "loop": -1,
  "steps": [
    {
      "call": "spawn_unit",
      "args": { "buildingId": "$barracks", "unitType": "rocket_soldier" },
      "scope": "global",
      "when": { "condition": "enemy_unit_count_at_least", "unitType": "light_tank", "count": 1 },
      "until": { "condition": "unit_count_at_least", "unitType": "rocket_soldier", "count": 2 },
      "retry": true
    }
  ]
}
```

示例：一队战斗单位先移动攻击到敌方 HQ 附近，再集火 HQ。

```json
{
  "unitIds": ["unit_5", "unit_6"],
  "loop": 1,
  "steps": [
    {
      "call": "attack_move_unit",
      "args": { "unitId": "$unitId", "x": 18, "y": 10 },
      "until": { "condition": "near_position", "x": 18, "y": 10, "distance": 2 },
      "maxTicks": 40
    },
    {
      "call": "attack",
      "args": { "unitId": "$unitId", "targetId": "building_2" },
      "until": { "condition": "target_destroyed", "targetId": "building_2" },
      "retry": true
    }
  ]
}
```

### 2.4 子 Agent 工具 `spawn_agent`

`spawn_agent` 是唯一的子 Agent 派生工具，**只有父 Agent 可用**。

#### 输入

```ts
interface SpawnAgentInput {
  description: string;
  objective: string;
  assignedUnits?: string[];
  assignedBuildings?: string[];
  constraints?: string;
  successCriteria?: string;
}
```

#### 输出（即时返回）

```ts
// 成功
{ ok: true, taskId: string, controllerId: string, status: "running", description: string }
// 失败
{ ok: false, error: string, hint?: string }
```

#### 子 Agent 完成通知

子 Agent 完成后，结果会注入父 Agent 的下一次模型请求：

```xml
<sub-agent-result>
taskId: ...
description: ...
status: completed | failed | aborted
objective: ...
result:
...
</sub-agent-result>
```

#### 使用规则

- `spawn_agent` 由父 Agent 自主选择是否调用，不由服务端触发
- 父 Agent 必须已完成总体规划、侦察和局势评估
- 子 Agent 是执行 worker，不是战略规划者
- 子 Agent 可使用全部游戏工具，但不能调用 `spawn_agent`
- 分配到不同子 Agent 的 unitIds / buildingIds 必须互不重叠
- 每玩家默认最多同时运行 2 个子 Agent；重叠 lease 返回 `resource_already_leased`，超限返回 `subagent_concurrency_limit`
- 子 Agent 工具调用中任一 `unitId/unitIds/buildingId` 未租赁时返回 `resource_not_leased`，不会生成命令
- `spawn_agent` 调用后立即返回 `taskId`，不等待子 Agent 完成
- 子 Agent 结果会在后续消息中以 `<sub-agent-result>` 标签注入

## 3. Control Plane HTTP API

新增控制面 HTTP API，允许外部进程通过 REST 调用控制玩家行动。这些端点与现有 WebSocket 协议并行运行。

Control session 是访问令牌；同一玩家的多个 session 共享 `ControlPlaneMatch` 中的 player 级运行时状态，包括 active plans、target memory 和持续 attack orders。`orchestrate_plan` 注册后由 control-plane match loop 随 tick 推进，不依赖发起该 plan 的 session 后续继续存活。

### 3.1 ControlResponse envelope

所有控制端点返回统一 envelope：

```ts
interface ControlResponse<T = unknown> {
  ok: boolean;
  tick: number;
  kind: "state" | "selection" | "action_result" | "plan_result" | "batch_result";
  data: T;
  warnings?: Array<{ type: string; message: string }>;
  error?: {
    code: string;
    message: string;
    hint?: string;
  };
}
```

### 3.2 `POST /api/control/start-game`

创建新的 control match。该操作不会停止现有 live、control 或 benchmark match；返回的 `matchId` 是后续 session、保存、停止和观战选择的稳定身份。

Request:

```ts
interface StartControlGameRequest {
  cpu?: "random" | "rush"; // omitted for two-external-controller PVP
}
```

Response (201):

```json
{
  "ok": true,
  "tick": 0,
  "kind": "state",
  "data": {
    "matchId": "match_abc123",
    "status": "waiting_for_players"
  }
}
```

`cpu` 仅表示 `player_2` 使用当前兼容的内建规则对手，主要用于单 agent 控制链路与 LLM-vs-CPU benchmark。CPU-vs-CPU 不属于产品对局、模型分析样本或平衡样本；确定性规则回归应使用 test driver/smoke 路径。

### 3.3 MatchRegistry 管理端点

`GET /api/control/matches` 返回所有已注册 live/control/benchmark match，以及 WebSocket/Web UI 当前投影的 `observedMatchId`：

```ts
interface MatchRegistrySummary {
    matchId: string;
    kind: "live" | "control" | "benchmark";
    status: "preparing" | "waiting_for_players" | "running" | "stopped" | "finished" | "failed";
    tick: number;
    winner: "player_1" | "player_2" | null;
    createdAt: string;
    label?: string;
    parentId?: string;
    observed: boolean;
}

interface MatchRegistryListResponse {
  matches: MatchRegistrySummary[];
  observedMatchId: string | null;
}
```

- `POST /api/control/matches/:matchId/observe`：只切换 WebSocket/Web UI 的观察投影，不停止或暂停其他 match。
- `POST /api/control/matches/:matchId/save-record`：对指定 match 做稳定 cut，并通过统一 `MatchRecorder` 保存 Trace v3。
- `POST /api/control/matches/:matchId/stop`：quiesce、停止并保存指定 match，不影响其他 match；成功响应包含 `filePath`。

### 3.4 Storage 生命周期端点

- `GET /api/control/storage/retention`：逐 artifact 返回年龄/数量/容量策略的 dry-run 报告，包含保护状态、删除原因和预计释放容量。
- `POST /api/control/storage/cleanup`：请求 `{ "apply": false }` 等同 dry-run；只有 `{ "apply": true }` 才删除报告中的正式 artifact。
- `GET /api/control/storage/journals`：只读扫描当前 owner、失活 owner和 legacy journal。
- `POST /api/control/storage/recover-journals`：默认预览；只有 `{ "apply": true }` 才把可恢复孤儿隔离到 durable recovery 目录。

保留策略配置键采用 `LLMCRAFT_RETENTION_<GROUP>_MAX_AGE_DAYS / MAX_ENTRIES / MAX_MIB`；group 为 `RECORDS / BENCHMARK_RECORDS / LLM_DEBUG / BENCHMARK_LLM_DEBUG / ORPHAN_JOURNALS`。`LLMCRAFT_RETENTION_APPLY_ON_STARTUP=true` 才会在启动时自动清理正式 artifact。

### 3.5 `POST /api/control/sessions`

创建或绑定控制会话。

Request:
```ts
interface CreateControlSessionRequest {
  playerId: "player_1" | "player_2";
  gameId?: string; // stable matchId; omitted = observed/latest control match
}
```

Response (201):
```json
{
  "ok": true,
  "tick": 0,
  "kind": "state",
  "data": {
    "sessionId": "cs_abc12345",
    "gameId": "match_abc123",
    "playerId": "player_1",
    "createdAt": "2026-05-10T..."
  }
}
```

session 创建后始终绑定这一具体 `gameId`；之后 observed match 改变不会把 session 悄悄迁到另一局。若原 match 已被移除，session 路由返回 `410`。

### 3.6 `GET /api/control/sessions/:sessionId/state`

Read combined map + player state for the session.

### 3.7 `POST /api/control/sessions/:sessionId/tools/:toolName`

Call an agent tool on behalf of the session's player. Control plane 只暴露可直接落到游戏状态的工具；provider-only 工具（目前为 `spawn_agent`）不通过 HTTP control API 暴露。

Read tools: `get_map_state`, `get_my_state`, `get_my_units`, `get_army_summary`, `get_active_plans`, `get_recent_events`

Action tools: `move_unit`, `attack_move_unit`, `attack_move_group`, `attack`, `spawn_unit`, `build_structure`, `start_harvest_loop`, `hold_unit`

Plan tool: `orchestrate_plan`

Request:
```ts
interface ControlToolCallRequest {
  args?: Record<string, unknown>;
}
```

Response uses the standard `ControlResponse` envelope with `kind` set to `"state"`, `"action_result"`, or `"plan_result"` depending on the tool.

### 3.8 `POST /api/control/sessions/:sessionId/actions`

原子提交一组即时 action tools。该入口不接受 read tools 或 `orchestrate_plan`；请求在 controller 预校验阶段任一 action 失败时不会产生 CommandEnvelope，已经发生的 plan interrupt、attack order 等 controller 状态也会恢复。全部通过后只产生一个 CommandEnvelope，并在模拟 tick 内整批提交或回滚。

```ts
interface ControlActionBatchRequest {
  clientRequestId: string;
  actions: Array<{
    tool: "move_unit" | "attack_move_unit" | "attack_move_group" | "attack" |
      "spawn_unit" | "build_structure" | "start_harvest_loop" | "hold_unit";
    args?: Record<string, unknown>;
  }>;
}
```

约束：`actions.length` 为 `1-100`。相同 `clientRequestId` 与相同 canonical actions 重试返回原结果并标记 `data.duplicate: true`；同一 ID 携带不同动作返回 `batch_submission_rejected`。响应 `kind` 固定为 `batch_result`，`data.results` 保留每个 action 的预校验结果。

### 3.9 `POST /api/control/sessions/:sessionId/save-record`

保存该 session 所绑定 match 的 Trace v3，返回实际 `matchId` 与 `filePath`。它与 `POST /api/control/matches/:matchId/save-record` 使用同一个 `MatchRecorder`，不会产生另一套 control-plane record schema。

## 4. 记录格式

当前 `aiTurns` 不再保存生成的 JavaScript 和沙箱错误，而是保存 agent 行为：

```ts
interface SavedAITurnRecord {
  turnId?: string;
  controllerId?: string;
  decisionKind?: "macro" | "tactical";
  playerId: PlayerId;
  requestTick: number;
  executeTick: number;
  runInput: AgentRunInput;
  assistantMessages: string[];
  toolCalls: AgentToolCallRecord[];
  plans: AgentPlanRecord[];
  commands: Command[];
  stopReason: string;
  metrics: {
    modelRequests: number;
    toolCalls: number;
    stallDetected: boolean;
    modelRequestRecords?: Array<{
      requestIndex: number;
      phase: "warmup" | "turn" | "subagent";
      requestId?: string;
      model?: string;
      finishReason: string;
      latencyMs?: number;
      messageCount: number;
      toolCount: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
      status?: "success" | "error";
      attempt?: number;
      retryOfRequestIndex?: number;
      error?: string;
      messagesVersion?: 1;
      messagesHash?: string;
      messages?: unknown[];
    }>;
    memory?: {
      policyVersion: 1;
      maxMessages: number;
      maxBytes: number;
      messagesBefore: number;
      messagesAfter: number;
      bytesBefore: number;
      bytesAfter: number;
      droppedMessages: number;
      truncatedMessages: number;
    };
  };
  model: string;
  baseURL?: string;
  createdAt: string;
}
```

`modelRequestRecords` 是 Phase 3A 的内部模型请求事实。warmup 与后续 tool-loop 请求共用同一 turn 链；每次显式尝试都有 success/error、attempt/retryOf、错误文本、messages v1 快照及 SHA-256。OpenAI SDK 内建重试已关闭，避免出现无法审计的隐式请求。当前子 Agent 自身的 model request span 尚未并入父 turn，因此 `modelRequestSpans` capability 仍为 `partial`。

`memory` 记录 AgentSession 在该 turn 结束时执行的 `MemoryPolicy v1`。默认持久历史上限为 `80` 条消息、`1 MiB`，单条消息默认不超过 `32 KiB`。压缩按 user 边界删除完整旧段，避免留下没有 assistant tool call 的孤立 tool result；过大的旧工具观察会替换成 `memory_policy_oversize` tombstone，并要求下轮重新读取当前状态。它只压缩模型会话历史，不删除 MatchJournal / Trace 中已经记录的事实。

Trace 派生的 compact metadata 现在额外保存 `tickIntervalMs` 和 `rulesetId`，分析器和 Replay 必须优先使用它们；旧 compact-v2 缺少字段时才回退到历史 `500ms / default-v1` 解释。Analysis v1 的 facts 与 Detector 分层：每个 metric value 带 metric id/version、scope、value 和 `sourcePaths`，Detector 另行保存 id/version/ruleset/operator/threshold/severity，finding 记录实际适用的 ruleset；不得把启发式标签伪装成原始事实。CSV 输出保留这些版本和来源字段。

Benchmark complete 消息除原有胜负和平均时长外，返回可选 `llmWinRateConfidence95 / positionBias / medianDurationTicks / p90DurationTicks`。通用 Experiment Manifest v1 记录 experimentId、baseline、fixed variables、concurrency 和显式 trials（seed/repeat/side/variables）；结果文件按 trialId 恢复，只跳过 `completed` trial，失败 trial 可在下次运行重试。恢复时必须校验 baseline/fixed/trials 与原 Manifest 相同，并从已完成 trial 的 payload 重建完整 benchmark 汇总，禁止把不同实验混到同一 experimentId。

transcript 当前记录：

- summary
- assistant text
- tool calls
- commands
- plans
- metrics
- stop reason
