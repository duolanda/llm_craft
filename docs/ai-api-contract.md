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

### 0.5 WebSocket `warmup`

```json
{
  "type": "warmup",
  "player1PresetId": "preset-red",
  "player2PresetId": "preset-blue",
  "debug": {
    "recordingProfile": "evaluation",
    "includeTranscript": true
  },
  "warmup": {
    "player_1": true,
    "player_2": false
  }
}
```

说明：

- 红蓝双方必须都选择预设
- 服务端会按两个 preset 创建或复用一个尚未启动的 live match
- `warmup.player_1/player_2 = true` 时，对应模型会在游戏 tick 启动前先收到首个真实 `AgentRunInput + tools` 请求。服务端只等待模型返回第一条 assistant message；如果该 message 包含 tool calls，会先挂起，不执行工具、不返回 tool result。
- 服务端会发送 `warmup_status`，告知前端预热中、已完成或失败。用户仍需另外发送 `start` 才会启动游戏时间。
- warmup 不创建第二局，也不启动 tick；已有 live 正在运行时会被拒绝。

### 0.6 WebSocket `start`

```json
{
  "type": "start",
  "player1PresetId": "preset-red",
  "player2PresetId": "preset-blue",
  "debug": {
    "recordingProfile": "evaluation",
    "includeTranscript": true
  }
}
```

说明：

- 如果同一组预设和记录选项已有预热 match，`start` 会复用它并开始 tick；已挂起的首个 assistant/tool calls 会在正式开局后继续执行。
- 如果没有匹配的预热 match，`start` 会创建实时对局并立即开始 tick。
- 已有 live 正在运行时不会重复创建或启动。

### 0.7 WebSocket `reset`

```json
{
  "type": "reset",
  "player1PresetId": "preset-red",
  "player2PresetId": "preset-blue",
  "debug": {
    "recordingProfile": "evaluation",
    "includeTranscript": true
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
  frame?: StateProjectionFrame;
  aiOutputs: Record<string, string>;
  snapshots: GameSnapshot[];
  liveEnabled: boolean;
  matchStatus: "warming_up" | "waiting_for_players" | "running" | "stopped" | "finished" | "failed" | null;
}
```

`frame` 在首帧、切换 match 和每 20 帧使用 keyframe，其余使用带 `baseFrameSequence` 的 exact delta。metadata 携带 `frameSequence / simulationTick / simulationTimeMs / tickIntervalMs / serverTimeMs`。delta 帧中的 `state` 为 `null`，客户端用 `@llmcraft/record` projector 组装状态。backlog 达 `1 MB` 时暂停可替换投影，排空后直接发送 latest delta，不补发过期中间帧。

客户端的有界 `SimulationFrameBuffer` 同时服务 Live 和 Replay；它按 simulation time 取前后帧，包到达时间只用于估算带缓冲延迟的当前模拟时间，不再决定单位移动速度。

### 0.11 WebSocket `error`

```ts
interface ServerErrorMessage {
  type: "error";
  message: string;
}
```

### 0.12 WebSocket `warmup_status`

```ts
type MatchWarmupState = "idle" | "warming_up" | "ready" | "error";

interface ServerWarmupStatusMessage {
  type: "warmup_status";
  statuses: Partial<Record<"player_1" | "player_2", MatchWarmupState>>;
  message?: string;
}
```

### 0.13 WebSocket `ai_terminal_events`

右侧 AI 指挥终端使用有界的内存增量事件流，服务端最多保留最近 `500` 条。完整长期内容只有在 evaluation Match Record 开启 `includeTranscript` 时保存。游标落后于实时窗口时会发送 `reset=true` 和当前窗口。

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
  "debug": {
    "includeTranscript": false
  }
}
```

说明：

- benchmark 只支持 `LLM preset vs CPU strategy`
- 当前 CPU 策略支持 `random` 和 `rush`
- benchmark 与 live match 现在共用同一套 tool-calling runtime
- `concurrency` 可选，默认 `1`，允许 `1` 到 `10`；并发运行时完成顺序可能不同于 round 编号，最终结果按 round 编号输出
- `recordReplay=false` 表示 round 不生成 Match Record

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

当前规则由 shared 的 `standard` ruleset 描述：

- 单位类型是 `worker | soldier | rifleman | rocket_soldier | light_tank`
- 建筑类型是 `hq | barracks | war_factory | refinery`
- `hq` 可生产 `worker`
- `barracks` 可生产 `soldier | rifleman | rocket_soldier`
- `war_factory` 可生产 `light_tank`
- `refinery` 是 worker 的采矿卸载点，不生产单位
- 当前采用 144x96 三战线大战场尺度：`soldier` 115 HP / 10 damage / range 1 / vision 5 / cost 55 / reload 3；`rifleman` 95 HP / 9 damage / range 6 / vision 7 / cost 70 / reload 2；`rocket_soldier` 80 HP / 34 damage / range 6 / vision 7 / cost 110 / reload 8；`light_tank` 420 HP / 42 damage / range 5 / vision 7 / cost 240 / reload 6
- 伤害按目标 armor 计算：`soldier` 对 infantry 1x、vehicle 0.25x、structure 0.35x；`rifleman` 对 infantry 1.45x、vehicle 0.25x、structure 0.35x；`rocket_soldier` 对 infantry 0.35x、vehicle 2.25x、structure 0.9x；`light_tank` 对 infantry 0.8x、vehicle 1x、structure 0.9x
- 攻击结算为 weapon/projectile/warhead 模型：命令成功会生成 projectile，projectile 抵达后才造成伤害。`rocket_soldier` 和 `light_tank` 有 1 格 splash；`ok: true` 不表示目标 HP 已经立即变化。
- `GameState.projectiles?: ActiveProjectile[]` 暴露实时弹丸，用于客户端渲染。
- 当前不启用战争迷雾读取层；agent 观察工具返回全图敌方实体、地形和资源。`visionRange` 仍用于单位自动索敌，不用于隐藏情报。
- 默认 `144x96` 地图暂不生成任何 `obstacle` 岩石；`obstacle` tile 语义仍保留。资源点避开中央主攻路线，当前默认坐标为：红方基地外侧 `(31,35) (34,39) (31,57) (34,61)`，蓝方基地外侧 `(112,35) (109,39) (112,57) (109,61)`，上/下侧翼 `(47,18) (50,22) (47,74) (50,78) (96,18) (93,22) (96,74) (93,78)`。
- `UNIT_STATS` / `BUILDING_STATS` 是 `standard` ruleset 的便捷只读视图，供 UI、诊断和测试使用

服务端核心逻辑通过 ruleset helper 读取单位数值、建筑数值、生产关系、成本和攻击能力判断；工具 schema 已接受新增 unit/building 类型。

### 1.2 服务端命令交付契约

Agent、CLI 和 built-in CPU 都通过 `GameplayController` 生成命令，再由当前 `MatchRuntime` 提交到对局专属 `CommandGateway`：

```ts
interface CommandEnvelope {
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
  source: "macro_tool" | "mission" | "tactical" | "external" | "subagent" | "cpu";
  turnId?: string;
  toolCallId?: string;
  missionId?: string;
  parentControllerId?: string;
}
```

- Gateway 对 envelope 做整体结构接纳；任一 command 越权、ID 重复或字段无效时，整份输入不入队。
- `commands` 是数组，是因为同一 committed tick 可能同时推进多个 plan 或持续攻击；普通即时 tool 通常只提交一条。CLI action batch 不会为了“批量”而强行合成一个可回滚 envelope。
- 完全相同的 `clientRequestId` + envelope 重试返回 `duplicate: true`，不会再执行；同一 ID 携带不同内容会返回 `idempotency_conflict`。
- envelope actor 必须与 command 的 `playerId` 一致；决策来源写入命令 `provenance`，不会伪装成新玩家。
- 命令只在 `applyAtTick` 的 tick 边界释放，同 tick 按 `actorId -> sequence -> clientRequestId` 稳定排序。
- 进入 Game 后每条命令独立执行。一条失败会产生自己的 command result，但不会撤销同 envelope 中已经成功的命令。
- 不存在每 actor 命令数、每 tick 路径命令数或重新寻路次数额度。
- 不存在 envelope/tick checkpoint 或失败回滚。SimulationCore 意外抛错时该局直接 fail-stop。
- action tool 返回成功表示命令已接纳；实际规则结果在后续 tick 的 command feedback 中出现。

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
  units: Array<Unit & {
    hasActivePlan: boolean;
  }>;
}
```

`groups` 按 `role + intent` 聚合，目的是让 agent 直接看见例如 `combat + hold` 或 `combat + none` 的大批闲置部队；具体操作仍使用 `units` 里的 unit id。

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
- `waitingReason` 只在 active plan 当前没有生成命令时出现，例如等待 `when` 条件、等待 `until`、等待 credits 或等待命令前置条件
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

- 一次控制一个或多个己方战斗单位，给每个单位分配不同推进落点
- `battle_line` 是角色化编队：`light_tank` 前排，`soldier/rifleman` 居中，`rocket_soldier` 后排
- 编队只影响目的地分配和默认攻击优先级；它不会强制 AI 攒兵，也不会自动替 AI 选择战略路线
- 大军团推进、正面压制、侧翼小队推进时优先使用本工具，避免逐单位反复调用 `attack_move_unit`
- 工具会为所有合法成员立即生成 `attack_move` 命令；结果返回 `commandIds`、`formation` 和每个单位的 `assignments`，没有跨 tick 释放队列

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
- 多个 active plan 在同一 tick 推进时按顺序检查实际可用 credits；较早生成的 `spawn_unit` / `build_structure` 会预留本 tick credits，后续付费 step 如果余额不够会等待下一次收入或下一轮推进
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

Control session 是访问令牌；同一玩家的多个 session 共享 `ControlPlaneMatch` 中的 player 级运行时状态，包括 active plans、短期 target cache 和持续 attack orders。`orchestrate_plan` 注册后由已提交 tick 事件推进，不依赖发起该 plan 的 session 后续继续存活。

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

创建 control match；如果已经存在 `waiting_for_players` 或 `running` 的 control match，则直接返回该对局。CLI 收到 `reused: true` 后只显示现有信息，不再创建另一份 session。返回的 `matchId` 是后续 session、保存、停止和观战选择的稳定身份。

Request:

```ts
interface StartControlGameRequest {
  cpu?: "random" | "rush"; // omitted for two-external-controller PVP
}
```

Response (201；复用已有对局时为 200 且 `reused: true`):

```json
{
  "ok": true,
  "tick": 0,
  "kind": "state",
  "data": {
    "matchId": "match_abc123",
    "status": "waiting_for_players",
    "reused": false
  }
}
```

`cpu` 仅表示 `player_2` 使用内建规则对手，主要用于单 agent 控制链路与 LLM-vs-CPU benchmark。CPU 是判断当前模型与提示词是否达到最低可用水平的基线；规则正确性和性能规模由测试与专门检查覆盖。

### 3.3 MatchRegistry 管理端点

`GET /api/control/matches` 返回所有已注册 live/control/benchmark match，以及 WebSocket/Web UI 当前投影的 `observedMatchId`：

```ts
interface MatchRegistrySummary {
    matchId: string;
    kind: "live" | "control" | "benchmark";
    status: "warming_up" | "waiting_for_players" | "running" | "stopped" | "finished" | "failed";
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
- `POST /api/control/matches/:matchId/save-record`：保存已经停止或结束的指定 match；运行中对局应先 stop，服务端不会持续重写大 JSON。
- `POST /api/control/matches/:matchId/stop`：quiesce、停止并保存指定 match，不影响其他 match；成功响应包含 `filePath`。

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

批量调用一组即时 action tools。该入口不接受 read tools 或 `orchestrate_plan`；每个 action 独立校验和提交，合法 action 保留，非法 action 只在对应结果中失败，不回滚同一批次内已经接受的 action。

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

相同 `clientRequestId` 与相同 canonical actions 重试返回原结果并标记 `data.duplicate: true`；同一 ID 携带不同动作返回 `batch_submission_rejected`。响应 `kind` 固定为 `batch_result`，`data.results` 保留每个 action 的独立结果；成功与失败并存时 `data.partialSuccess` 为 `true`。

### 3.9 `POST /api/control/sessions/:sessionId/save-record`

保存该 session 所绑定 match 的 Match Record，返回实际 `matchId` 与 `filePath`。它与 `POST /api/control/matches/:matchId/save-record` 使用同一个 `MatchRecorder`，不会产生另一套 control-plane record schema。

## 4. 记录格式

保存文件统一称为 Match Record，格式为单个 `.match.json`：

```ts
interface MatchRecord {
  recordFormat: "match-record";
  matchId: string;
  definition: MatchDefinition;
  metadata: {
    startedAt: string;
    savedAt: string;
    endedAt?: string;
    status: "running" | "stopped" | "finished" | "failed";
    winner: PlayerId | null;
    recordingProfile: "replay" | "evaluation";
    includeTranscript: boolean;
    systemPrompt?: string;
    players: Array<{
      playerId: PlayerId;
      model: string;
      baseURL?: string;
    }>;
  };
  initialState: GameState;
  finalState: GameState;
  tickDeltas: TickDeltaRecord[];
  commandResults?: GameLog[];
  aiTurns?: SavedAITurnRecord[];
}
```

记录档位：

- `off`：不保存 Match Record。
- `replay`：保存初始状态、逐 tick delta 和终态，足以供前端回放。
- `evaluation`：在 replay 内容上增加命令结果和 `aiTurns`，供 benchmark 与 agent 行为分析。

`includeTranscript` 只在 evaluation 档位生效。关闭时仍保留 tool calls、commands、plans、性能指标和停止原因，但清空 assistant 原文与各模型请求的 messages；开启时才保存完整模型输出和请求消息。前端 transcript 页面直接从 Match Record 的 `aiTurns` 投影，不另写一种 transcript 文件。

`SavedAITurnRecord` 记录一次 agent turn 的输入 tick、工具调用、计划、命令、停止原因与模型请求指标。`metrics.contextWindow` 是当前 `ContextWindowLimiter` 的机械限长报告，包含裁剪前后消息数/字节数；它不是持久 memory，也不声称已经完成语义压缩。当前默认上限为 80 条消息、总计 1 MiB、单条 32 KiB，后续应由真正能生成模型可读摘要的 compactor 替代。

Benchmark complete 消息除原有胜负和平均时长外，可返回 `llmWinRateConfidence95 / positionBias / medianDurationTicks / p90DurationTicks`。`BenchmarkRunner` 只负责 benchmark trial 的并发执行和结果聚合；`analyze-record.mjs` 是面向开发者和 agent 的独立离线分析工具。
