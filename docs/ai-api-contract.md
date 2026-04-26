# LLMCraft AI API Contract

日期: 2026-04-19

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
}
```

### 0.4 WebSocket `start`

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

- 红蓝双方必须都选择预设
- 服务端会按两个 preset 分别创建两套独立 provider
- `debug.recordLLMTranscript = true` 时，仅当前这一局会额外写出 transcript 到 `packages/server/logs/llm-debug/`

### 0.5 WebSocket `reset`

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

### 0.6 WebSocket `stop`

```json
{
  "type": "stop"
}
```

### 0.7 WebSocket `save_record`

```json
{
  "type": "save_record"
}
```

### 0.8 WebSocket `state`

```ts
interface ServerStateMessage {
  type: "state";
  state: GameState | null;
  snapshots: GameSnapshot[];
  liveEnabled: boolean;
}
```

### 0.9 WebSocket `error`

```ts
interface ServerErrorMessage {
  type: "error";
  message: string;
}
```

### 0.10 WebSocket `ai_terminal_events`

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

### 0.11 WebSocket `record_saved`

```ts
interface ServerRecordSavedMessage {
  type: "record_saved";
  filePath: string;
}
```

### 0.12 WebSocket `start_benchmark`

```json
{
  "type": "start_benchmark",
  "presetId": "preset-red",
  "cpuStrategy": "rush",
  "rounds": 10,
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

## 2. 工具体系

### 2.1 只读观察工具

#### `get_map_state`

返回当前全图可见信息：

```ts
{
  tick: number;
  width: number;
  height: number;
  cells: Array<{
    x: number;
    y: number;
    tile: TileType;
    unit?: {
      id: string;
      type: UnitType;
      hp: number;
      state: UnitState;
      relation: "self" | "enemy";
    };
    building?: {
      id: string;
      type: BuildingType;
      hp: number;
      maxHp: number;
      relation: "self" | "enemy";
    };
  }>;
}
```

说明：

- 当前地图很小，且没有战争迷雾，所以直接返回全图可见信息
- 返回值按坐标分组，每个 `cell` 表示该位置上的地形与占用物
- 单位和建筑子项带 `relation` 字段，表示是己方还是敌方
- 默认只返回“有信息量”的格子：资源、障碍、单位、建筑；只有传 `includeEmptyTiles=true` 时才返回完整格子信息（包括 empty）
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

折叠粒度是 `toolName + normalizedArgs`。例如新的 `get_map_state({ includeEmptyTiles: false })` 只会折叠旧的同参数 `get_map_state`，不会折叠 `includeEmptyTiles: true` 的旧结果。动作工具结果不会被该机制折叠。

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
  canSpawnWorker: boolean;
  canSpawnSoldier: boolean;
}
```

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

#### `attack_unit`

```ts
{
  unitId: string;
  targetId: string;
}
```

#### `attack_in_range`

```ts
{
  unitId: string;
  priority?: Array<"hq" | "soldier" | "worker" | "barracks">;
}
```

#### `spawn_unit`

```ts
{
  buildingId: string;
  unitType: "worker" | "soldier";
}
```

#### `build_structure`

```ts
{
  unitId: string;
  buildingType: "barracks";
  x: number;
  y: number;
}
```

说明：

- 当前只允许建造 `barracks`
- 兵营必须建在空地上，且要给己方 `HQ` 周围留出一圈空地
- 如果位置不合法，失败返回的 `hint` 会直接给出附近可行位置示例

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
  loop?: number; // -1 表示无限循环
  steps: PlanStep[];
}
```

```ts
type PlanStep =
  | { do: "move_to"; x: number; y: number; formation?: "direct" | "spread" }
  | { do: "attack_in_range"; priority?: Array<"hq" | "soldier" | "worker" | "barracks"> }
  | { do: "hold_position" }
  | { do: "wait_until"; condition: PlanCondition; maxTicks?: number }
  | { do: "branch"; if: PlanCondition; then: PlanStep[]; else?: PlanStep[] }
  | { do: "stop" };
```

```ts
type PlanCondition =
  | "cargo_full"
  | "cargo_empty"
  | "hq_in_range"
  | "enemy_in_range"
  | { all: PlanCondition[] }
  | { any: PlanCondition[] }
  | { not: PlanCondition };
```

说明：

- `orchestrate_plan` 只注册计划，不会在一次 tool call 内跑完整段脚本
- 计划会在后续 tick 自动推进
- 即时动作会打断相关单位的当前计划

## 3. 记录格式

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
