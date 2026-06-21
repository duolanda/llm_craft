# LLMCraft AI API Contract

日期: 2026-06-17

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
  snapshots: GameSnapshot[];
  liveEnabled: boolean;
}
```

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

右侧 AI 指挥终端使用增量事件流，不复用 `state.snapshots[].aiOutputs`。

```ts
interface ServerAITerminalEventsMessage {
  type: "ai_terminal_events";
  sessionId: string | null;
  reset: boolean;
  events: AITerminalEvent[];
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

## 1. Agent Run 输入

每次 AI 被唤醒时，不再收到完整 `AIPromptPayload + JavaScript 执行环境`；旧 `full/delta` 兼容输入已从代码中移除。

当前模型收到的是：

- 固定 `system prompt`
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
- 当前采用 144x96 三战线大战场尺度：`soldier` 100 HP / 12 attack / range 1 / vision 5 / cost 60；`rifleman` 90 HP / 14 attack / range 3 / vision 6 / cost 70；`rocket_soldier` 80 HP / 24 attack / range 4 / vision 6 / cost 110；`light_tank` 300 HP / 30 attack / range 3 / vision 7 / cost 240
- 伤害按目标 armor 计算：`rifleman` 对 infantry 1.2x、vehicle 0.4x、structure 0.55x；`rocket_soldier` 对 infantry 0.45x、vehicle 2x、structure 1x；`light_tank` 对 infantry 0.7x、vehicle 1x、structure 1.2x
- 当前不启用战争迷雾读取层；agent 观察工具返回全图敌方实体、地形和资源。`visionRange` 仍用于单位自动索敌，不用于隐藏情报。
- `UNIT_STATS` / `BUILDING_STATS` 仍作为兼容导出存在

服务端核心逻辑通过 ruleset helper 读取单位数值、建筑数值、生产关系、成本和攻击能力判断；工具 schema 已接受新增 unit/building 类型。

## 2. 工具体系

### 2.1 只读观察工具

#### `get_map_state`

返回当前己方视野内信息：

```ts
{
  tick: number;
  width: number;
  height: number;
  fogOfWar: boolean;
  visibleTileCount: number;
  asciiMap: string;
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

- 当前默认地图为 `144 x 96`，`fogOfWar=false`；默认返回全图压缩信息。前端默认使用 3D 战场表现层，但 AI 工具仍使用底层战术坐标。
- `visibleTileCount` 为兼容字段；无迷雾时等于地图 tile 总数
- `asciiMap` 是无坐标轴的全图符号小地图，用于快速读取空间关系
- 精确坐标默认看 `units` 和 `buildings`；只有需要逐格地形时才传 `includeCells=true`
- `cells` 返回值按坐标分组，每个 `cell` 表示该位置上的地形与占用物
- 单位和建筑子项带 `relation` 字段，表示是己方还是敌方

默认符号约定：

```text
. empty
# obstacle
* resource
? unseen
H/B/F/D self hq/barracks/war_factory/refinery
S/I/R/T/W self soldier/rifleman/rocket_soldier/light_tank/worker
h/b/f/d enemy hq/barracks/war_factory/refinery
s/i/r/t/w enemy soldier/rifleman/rocket_soldier/light_tank/worker
```
- 默认不返回 `cells`，以降低上下文体积
- 传 `includeCells=true` 时只返回全图“有信息量”的格子：资源、障碍、单位、建筑
- 传 `includeEmptyTiles=true` 时会隐含 `includeCells=true`，返回完整地图格子信息（包括 empty）
- `unit` 是精简视图，不返回 `my / playerId / carryingCredits / carryCapacity / attackRange / intent` 等字段

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
    }>;
  };
  unitCosts: Record<UnitType, number>;
  buildingCosts: Partial<Record<BuildingType, number>>;
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
    };
    recommendedStructures: Array<{
      buildingType: "barracks" | "war_factory";
      cost: number;
      reason: string;
      suggestedSites: Position[];
    }>;
    recommendedProduction: Array<{
      buildingType: "barracks" | "war_factory";
      unitType: "rifleman" | "rocket_soldier" | "light_tank";
      reason: string;
    }>;
  };
}
```

`economyStatus` 是派生提示字段，用于减少 agent 每轮重复检查 worker 经济：`activeHarvesters` 表示已挂 `harvest_loop` 的 worker 数量，`idleWorkers` 表示还应优先安排采矿的 worker 数量，`resourceAssignments` 表示各资源点当前分配到的采矿 worker 数量。省略坐标调用 `start_harvest_loop` 时，系统会倾向选择较近且较少 worker 占用的资源点。

`techStatus` 是派生提示字段，用于减少 agent 每轮重复推理科技链：没有 `barracks` 时优先提示补兵营；已有 `barracks` 且钱够时提示补 `war_factory`；敌方出现 `light_tank` 或 `war_factory` 时提示从兵营补 `rocket_soldier`。

#### `get_my_units`

返回我方可直接操作单位：

```ts
{
  tick: number;
  units: Array<Unit & { hasActivePlan: boolean }>;
}
```

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
- 如果已经知道敌方目标 ID，尤其是 HQ / barracks / war_factory / 关键敌军，应优先使用 `attack`，不要用 `move_unit` 代替进攻命令

#### `attack_move_unit`

```ts
{
  unitId: string;
  x: number;
  y: number;
  priority?: Array<"worker" | "soldier" | "rifleman" | "rocket_soldier" | "light_tank" | "hq" | "barracks" | "war_factory">;
}
```

说明：

- 只接受有攻击能力的己方单位：`soldier`、`rifleman`、`rocket_soldier`、`light_tank`
- 单位会向目标点移动，并在到达前自动攻击范围内的角色匹配目标：`rifleman` 默认优先清步兵，`rocket_soldier` 默认优先打 `light_tank` / `war_factory`，`light_tank` 默认优先打 `hq` / `war_factory` / `barracks`
- 单位到达目标点后，`attack_move_unit` 命令结束，不会继续自动攻击后续靠近或新生产的敌方单位
- 这是无目标推进命令，只用于没有明确 `targetId` 时穿越危险区域或试探接敌
- 不用于指定攻击某个目标或建筑；点杀敌军、拆 HQ、拆 barracks、拆 war_factory 应使用 `attack`
- 显式 `priority` 会严格限制可攻击目标类型，不会 fallback 到未列出的建筑或单位

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
- 攻击敌方 HQ、barracks、war_factory 或关键敌军时，优先使用 `attack`，不要先用 `attack_move_unit` 或 `move_unit` 代替
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
  buildingType: "barracks" | "war_factory";
  x: number;
  y: number;
}
```

说明：

- 当前允许建造 `barracks` 和 `war_factory`
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
- `enemy_building_exists` / `enemy_unit_count_at_least` 用于表达反制触发，例如看到敌方 `war_factory` 或 `light_tank` 后补 `rocket_soldier`
- `args.unitId` 可以省略或设为 `"$unitId"`，表示 per-unit 展开时使用当前单位
- `spawn_unit` 的 `args.buildingId` 可使用 `"$hq"`、`"$barracks"` 或 `"$war_factory"`，在执行时解析为当前友方建筑
- plan 中的 `spawn_unit` / `build_structure` 会在当前 credits 不足时等待，不会入队必然失败的生产或建造命令；即时动作工具仍会返回 `insufficient_credits`
- 多个 active plan 在同一 tick 推进时共享同一份预算；较早生成的 `spawn_unit` / `build_structure` 会预留本 tick credits，后续付费 step 如果余额不够会等待下一次收入或下一轮推进
- `attack` call step 默认具备持续重试语义；也可以显式传 `retry: true`

示例：开局让两个 worker 挂矿，等钱够后造兵营，再持续造到 4 个 rifleman。

```json
{
  "unitIds": ["unit_1", "unit_2"],
  "loop": 1,
  "steps": [
    { "call": "start_harvest_loop", "args": { "unitId": "$unitId" }, "scope": "per_unit" },
    {
      "call": "build_structure",
      "args": { "unitId": "unit_1", "buildingType": "barracks", "x": 4, "y": 10 },
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
      "until": { "condition": "unit_count_at_least", "unitType": "rifleman", "count": 4 },
      "retry": true
    }
  ]
}
```

示例：已有稳定经济后，补 `war_factory` 并生产 1 台 `light_tank`。

```json
{
  "unitIds": ["unit_1"],
  "loop": 1,
  "steps": [
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
{ ok: true, taskId: string, status: "running", description: string }
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

### 3.2 `POST /api/control/sessions`

创建或绑定控制会话。

Request:
```ts
interface CreateControlSessionRequest {
  playerId: "player_1" | "player_2";
  gameId?: string; // defaults to "default"
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
    "gameId": "default",
    "playerId": "player_1",
    "createdAt": "2026-05-10T..."
  }
}
```

### 3.3 `GET /api/control/sessions/:sessionId/state`

Read combined map + player state for the session.

### 3.4 `POST /api/control/sessions/:sessionId/tools/:toolName`

Call an agent tool on behalf of the session's player. Control plane 只暴露可直接落到游戏状态的工具；provider-only 工具（目前为 `spawn_agent`）不通过 HTTP control API 暴露。

Read tools: `get_map_state`, `get_my_state`, `get_my_units`, `get_active_plans`, `get_recent_events`

Action tools: `move_unit`, `attack_move_unit`, `attack`, `spawn_unit`, `build_structure`, `start_harvest_loop`, `hold_unit`

Plan tool: `orchestrate_plan`

Request:
```ts
interface ControlToolCallRequest {
  args?: Record<string, unknown>;
}
```

Response uses the standard `ControlResponse` envelope with `kind` set to `"state"`, `"action_result"`, or `"plan_result"` depending on the tool.

## 4. 记录格式

当前 `aiTurns` 不再保存生成的 JavaScript 和沙箱错误，而是保存 agent 行为：

```ts
interface SavedAITurnRecord {
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
  };
  model: string;
  baseURL?: string;
  createdAt: string;
}
```

transcript 当前记录：

- summary
- assistant text
- tool calls
- commands
- plans
- metrics
- stop reason
