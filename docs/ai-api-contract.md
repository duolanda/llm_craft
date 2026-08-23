# LLMCraft AI API Contract

日期: 2026-08-09

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

- 如果同一组预设和记录选项已有预热 match，`start` 会复用它；已挂起的首个 assistant/tool calls 会在正式对局中继续执行。
- 如果没有匹配的预热 match，`start` 会创建实时对局并立即启动 tick，同时派发双方首次决策。
- 已有 live 正在运行时不会重复创建或启动。

`start` 不设置 tick-0 决策屏障；首次以及后续模型响应耗时都会消耗对局时间。手动 warmup 是显式的可选优化，只缓存选中模型的第一次供应商响应，不执行工具，也不改变后续决策的实时计时规则。

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
  "type": "save_record",
  "matchId": "match_..."
}
```

`save_record` 只接受明确指定的 live match；服务端不会再根据当前观察对象隐式选择 benchmark 或 control match。关闭录制的 live match 会被拒绝，且不会调用 MatchRecorder。

### 0.10 WebSocket `state`

```ts
interface ServerStateMessage {
  type: "state";
  frame: LiveStateProjectionFrame | null;
  liveEnabled: boolean;
  observedMatch: {
    matchId: string;
    kind: "live" | "control" | "benchmark";
    recordingEnabled: boolean;
  } | null;
  matchStatus: "warming_up" | "waiting_for_players" | "running" | "stopped" | "finished" | "failed" | null;
}
```

`frame` 在首帧、切换 match 和每 20 帧使用 keyframe，其余使用带 `baseFrameSequence` 的 exact delta。metadata 携带 `frameSequence / simulationTick / simulationTimeMs / tickIntervalMs`。`LiveStateProjectionFrame` 只包含当前动态实体、资源、投射物和胜负状态；其中 `LiveBuilding` 会携带观战 UI 所需的 `productionQueue`、`productionProgress` 和精简后的 `constructionProgress`，使实时观战与 Replay 都能展示逐建筑生产态势。历史 `logs`、静态 `tiles`、寻路缓存、rally point 和 AI 输出不进入状态帧。`observedMatch` 标识该投影所属的稳定 match，并告知客户端是否允许保存记录；live-only UI 行为不得仅凭 `winner` 或 `matchStatus` 推断。backlog 达 `1 MB` 时暂停可替换投影，排空后直接发送 latest delta，不补发过期中间帧。

生产状态沿用共享类型：`productionQueue` 是有序的 `ProductionOrder[]`，`productionProgress` 包含当前 `orderId / unitType / remainingTicks / totalTicks / paidCredits / totalCost / status` 及可选的 `missingPrerequisites`。生产中的建筑会因此在进度变化时进入 live delta；该数据是当前状态，不是历史生产记录。

地图通过一次性的 `map_init` 消息发送，日志通过有界的 `state_events` 增量消息发送，最新 AI 输出通过可替换的 `ai_output` 消息发送。完整 `GameState` 仍只属于服务端模拟、Match Record 和 Replay，不作为 live WebSocket 的 wire type。

```ts
interface ServerMapInitMessage {
  type: "map_init";
  matchId: string;
  width: number;
  height: number;
  tiles: Array<Array<Pick<Tile, "x" | "y" | "type">>>;
}

interface ServerStateEventsMessage {
  type: "state_events";
  matchId: string;
  reset: boolean;
  events: LiveLogEvent[];
}

interface ServerAIOutputMessage {
  type: "ai_output";
  matchId: string;
  outputs: Record<string, string>;
}
```

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
  "decisionIntervalTicks": 10,
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
- `decisionIntervalTicks` 只控制 built-in CPU，允许 `1` 到 `60`，省略时统一使用 `10`；LLM 仍在每个 committed tick 空闲时获得新决策机会
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
}
```

说明：

- benchmark progress 只报告完成数和胜负汇总，不拥有主画面的观察选择
- benchmark round 会分别注册到 `MatchRegistry`；当前观察对象和所有活跃 round 统一通过对局列表查询并由用户选择
- benchmark 启动或 round 结束不会覆盖用户已经选择的观察对象

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

- 单位类型是 `worker | soldier | rifleman | rocket_soldier | commando | light_tank | flame_tank | heavy_tank`；`soldier` 只为旧录像、既有状态和战斗目标兼容保留，standard 新对局不可生产
- 建筑类型是 `hq | barracks | war_factory | refinery | machine_gun_turret | anti_tank_turret | tech_center`
- `hq` 可生产 `worker`
- `barracks` 可生产 `rifleman | rocket_soldier`；完成 `tech_center` 后还可生产全局限造 1 名的 `commando`
- `war_factory` 是 T2 生产建筑，可生产 `light_tank | flame_tank`；完成 `tech_center` 后还可生产 `heavy_tank`
- `refinery` 是 worker 的采矿卸载点，不生产单位
- `machine_gun_turret` 是 T1 反步兵防御，要求已完成 `barracks`；`anti_tank_turret` 是 T2 反装甲防御，要求已完成 `war_factory`
- 科技层级由已完成建筑推导：基础为 T1，完成 `war_factory` 为 T2，完成 `tech_center` 为 T3；`war_factory` 要求 `barracks`，`tech_center` 要求 `war_factory`
- 当前采用 144x96 三战线大战场尺度。车辆为：`light_tank` 420 HP / speed 1 / 42 damage / range 5 / cost 240 / build 14 / reload 6；`flame_tank` 560 HP / speed 1 / 6 damage per tick / range 3 / vision 7 / cost 320 / build 18 / windup 1 / pulse interval 1；`heavy_tank` 850 HP / speed 0.6 / 90 damage / range 6 / cost 520 / build 26 / reload 8
- `commando` 为 T3 特种兵：160 HP / speed 1.3 / range 7 / vision 10 / cost 600 / build 24。远程步枪命中即秒杀 infantry；攻击 structure 时会改用射程 1 的 C4，命中即摧毁建筑；对 vehicle 的伤害固定为 0。玩家的存活单位和所有生产队列中最多合计 1 名，死亡后才能再次生产；它仍属于 infantry，但免疫轻坦、火焰坦克和重坦的移动碾压
- 伤害按目标 armor 计算：`rifleman` 偏反步兵，`rocket_soldier` 偏反车辆；`light_tank` 对 infantry / vehicle / structure 的系数为 0.8 / 1 / 0.9，`flame_tank` 为 4 / 0.2 / 4，`heavy_tank` 为 0.7 / 1.35 / 1.15。火焰坦克每 tick 伤害脉冲的基础伤害为 6，直击三类护甲分别造成 24 / 1 / 24 伤害；它以高于轻坦的生命和持续贴住目标的反步兵/攻坚 DPS 换取完全放弃载具对拼能力，而不是载具对拼升级
- 攻击结算为 weapon/projectile/warhead 模型：单位和防御塔都生成 projectile，projectile 抵达后才造成伤害。`rocket_soldier` 的最小射程会实际阻止近身开火；指定攻击和 attack-move 遇到最小射程内的目标时会先退到合法射界。`flame_tank` 会先进入 1 tick 权威前摇，目标仍合法时进入持续喷火状态并每 tick 生成一个复用同一 warhead/splash 管线的伤害脉冲；切换目标、离开射程、移动、stop 或 hold 会立即中断，重新接敌需要再次前摇。`ok: true` 不表示目标 HP 已经立即变化。
- `GameState.projectiles?: ActiveProjectile[]` 暴露实时弹丸，用于客户端渲染。
- `Unit.attackWindup?: { targetId; startedTick; completesAtTick }` 暴露当前权威攻击前摇，录像 delta 同步记录该字段，客户端只据此表现点火提示。
- `Unit.attackStream?: { targetId; startedTick }` 暴露当前权威持续攻击，录像 delta 同步记录该字段；客户端据此显示连续喷火，并有意隐藏仅用于伤害结算的逐 tick 火焰 projectile。
- 当前不启用战争迷雾读取层；agent 观察工具返回全图敌方实体、地形和资源。`visionRange` 仍是服务端权威的自主战斗感知半径：无持续 intent 的 idle 战斗单位会在其中自动获取目标，实际伤害命中时会优先反应视野内的伤害来源；武器 `range/minRange` 只决定能否开火。
- 自主获取的 `attack` intent 额外携带 `autoEngagement?: { originX; originY }`，表示警戒起点。目标离开单位当前视野或以该起点为中心的 `visionRange` 后，单位停止追击并回到无 intent 的 idle。它是模拟状态而不是可提交的命令参数，live WebSocket 精简 intent 不投影该起点。
- 默认 `144x96` 地图暂不生成任何 `obstacle` 岩石；`obstacle` tile 语义仍保留。资源点避开中央主攻路线，当前默认坐标为：红方基地外侧 `(31,35) (34,39) (31,57) (34,61)`，蓝方基地外侧 `(112,35) (109,39) (112,57) (109,61)`，上/下侧翼 `(47,18) (50,22) (47,74) (50,78) (96,18) (93,22) (96,74) (93,78)`。
- `UNIT_STATS` / `BUILDING_STATS` 是 `standard` ruleset 的便捷只读视图，供 UI、诊断和测试使用
- `ENTITY_GEOMETRY` 是模拟碰撞和已发布 GLB 主体共用的格尺寸规格；车辆炮管、天线和排气附件不属于碰撞主体

服务端核心逻辑通过 ruleset helper 读取单位数值、建筑数值、当前生产关系、成本和攻击能力判断；standard 的生产 helper 会过滤兼容性退役单位，即使底层 legacy ruleset 数据仍保留其历史数值和建筑关联。工具 schema 已接受新增 unit/building 类型。

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
    phase: UnitState;
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
      phase: UnitState;
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
- `unit` 是精简视图，不返回 `playerId / carryingCredits / carryCapacity / attackRange / intent` 等字段；`phase` 只表示当前 tick 的瞬时模拟阶段，不能据此判断持久任务是否存在；`my` 已从权威实体类型删除，不属于任何观察接口契约

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
  productionQueues: Array<{
    buildingId: string;
    queue: ProductionOrder[];
    progress: ProductionProgress | null;
  }>;
  canBuildBarracks: boolean;
  canBuildWarFactory: boolean;
  canBuildRefinery: boolean;
  canBuildTechCenter: boolean;
  canQueueWorker: boolean;
  canQueueSoldier: boolean; // 兼容字段；standard 恒为 false
  canQueueRifleman: boolean;
  canQueueRocketSoldier: boolean;
  canQueueLightTank: boolean;
  queueAvailability: Record<UnitType, boolean>;
  retiredProductionUnitTypes: UnitType[]; // standard 当前为 ["soldier"]
  economyStatus: {
    workers: number;
    assignedHarvesters: number;
    activeHarvesters: number;
    stalledHarvesters: Array<{
      unitId: string;
      reason: "resource_depleted" | "delivery_blocked" | "path_blocked";
      carryingCredits: number;
    }>;
    idleWorkers: number;
    carryingCredits: number;
    resourceAssignments: Array<{
      x: number;
      y: number;
      assignedHarvesters: number;
      remaining: number;
      distanceToHq: number | null;
    }>;
  };
  unitCosts: Record<UnitType, number>;
  buildingCosts: Partial<Record<BuildingType, number>>;
  buildingConstructionTicks: Partial<Record<BuildingType, number>>;
  buildOptions: Array<{
    buildingType: Exclude<BuildingType, "hq">;
    cost: number;
    constructionTicks: number;
    prerequisiteMet: boolean;
    missingPrerequisites: BuildingType[];
    affordable: boolean;
    availableBuilderIds: string[];
  }>;
  techStatus: {
    own: {
      tier: 1 | 2 | 3;
      workers: number;
      combatUnits: number;
      unitsByType: Record<UnitType, number>;
      riflemen: number;
      rocketSoldiers: number;
      lightTanks: number;
      barracks: number;
      warFactories: number;
      refineries: number;
      techCenters: number;
    };
    enemy: {
      tier: 1 | 2 | 3;
      hasWarFactory: boolean;
      lightTanks: number; // 兼容字段；当前返回已观察敌方全部 vehicle 数量
      rocketSoldiers: number;
    };
  };
}
```

`economyStatus`、`techStatus` 和 `buildOptions` 只提供客观事实与合法选项，不推荐固定 worker 数量、兵种、科技路线、出兵规模或攻击时机。`assignedHarvesters` 表示仍挂有 `harvest_loop` 意图的 worker 数量；`activeHarvesters` 排除已经停滞的 worker；`stalledHarvesters` 报告资源耗尽、满载无法交付，或连续 12 tick 没有位移和 credits 变化的 `path_blocked`。`resourceAssignments` 同时给出各资源点分配数和剩余量，不是矿点容量上限。`buildOptions` 只返回成本、前置条件和可用 worker，不预计算候选工地；`build_structure` 省略坐标时自动选址，显式坐标非法时才在失败结果中返回少量 `suggestedPlacements`。施工中的建筑会出现在 `buildings` 中并带 `constructionProgress`，但不会计入已完成科技，也不能生产。

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
  units: Array<Omit<Unit, "path" | "state"> & {
    phase: UnitState;
    remainingPathSteps?: number;
    hasActivePlan: boolean;
  }>;
}
```

`groups` 按 `role + intent` 聚合，目的是让 agent 直接看见例如 `combat + hold` 或 `combat + none` 的大批部队。只有 `intent: none` 才是可自动索敌的普通 idle；`phase: idle` 只是当前 tick 的瞬时模拟阶段，例如采矿循环等待下一步时也可以是 `phase: "idle"`、`intent.type: "harvest_loop"`，这不表示任务丢失。精确微操可以继续使用 `units` 里的 unit id；即时移动、attack-move、attack、stop 和 hold 也可使用执行时动态 `selection`，不需要先读再复制一批容易过期的 ID。单元详情不返回完整逐格 `path`，只保留 `pathTarget` 和可选的 `remainingPathSteps`，避免长路径重复占据模型上下文。

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
  largestGroupUnitIds: string[];
}
```

`groupedCombatUnits` 和 `largestGroupUnitIds` 只描述当前最大局部兵团，不产生集结、编队或进攻建议。

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
  waiting?: AgentPlanWaitingDiagnostic;
  commandCount?: number;
}

interface AgentPlanWaitingDiagnostic {
  code: string;
  message: string;
  details?: Record<string, unknown>;
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
  waiting?: AgentPlanWaitingDiagnostic;
  lastAttempt?: AgentPlanAttemptRecord;
}
```

说明：

- `currentStep` 是当前正在等待或推进的 step
- `waitingReason` 是兼容用的人类可读摘要；`waiting.code/message/details` 是权威结构化诊断，例如 `insufficient_credits`、`worker_not_adjacent`、`production_queue_busy`、`same_order_active`、`attack_reloading` 或 `target_missing`
- `same_order_active`、`unit_moving`、`unit_moving_to_target` 和部分 `worker_not_adjacent` 诊断会明确说明计划仍在正常执行，不需要重新注册
- `lastAttempt` 记录最近一次推进尝试；`command_created` 表示该 tick 已生成命令，`advanced` 表示 step 已推进，`failed` 表示计划失败

#### `get_recent_events`

返回最近的 AI-facing 反馈和关键事件：

```ts
{
  tick: number;
  events: GameLog[];
}
```

Agent session 还会把少量需要立即注意的事件作为 EVA 消息插入下一次模型请求：`building_completed`、`unit_spawned`、己方 `unit_destroyed`，以及任一己方建筑正在遭受攻击。相同事件按 tick 和实体 ID 去重；不会为 HQ 单独增加 `hq_lost` 之类的冗余事件。

### 2.2 即时动作工具

`move_unit`、`attack_move_unit`、`attack`、`stop_unit` 和 `hold_unit` 接受两种互斥的单位选择方式：

```ts
type DynamicUnitSelection = "all_combat" | "idle_combat" | UnitType;
type CombatUnitType = Exclude<UnitType, "worker">;

type UnitSubject =
  | { unitIds: string[]; selection?: never }
  | { unitIds?: never; selection: DynamicUnitSelection };
```

- `unitIds` 用于精确微操；`selection` 在工具真正执行时根据实时存活单位解析，避免同一模型响应中的状态查询与动作并行时复制到过期 ID
- `all_combat` 选择当前全部存活战斗单位，包括已有 active plan 的单位；即时动作按后命令优先的 RTS 语义中断所有被选中单位的当前 plan
- `idle_combat` 选择没有 active plan、瞬时为 idle，且没有任何持续 intent 的战斗单位；明确 hold 不再被视为普通空闲
- 具体 `UnitType`（例如 `light_tank`）选择当前全部存活的该类己方单位；战斗工具只接受能攻击的单位类型
- 如果特种兵、骚扰队或其他独立分队必须继续当前 plan，对主力显式传入 `unitIds` 并排除这些单位，不要使用 `all_combat`
- 必须且只能提供 `unitIds` 或 `selection` 之一；动态选择无匹配单位时返回 `empty_unit_selection`
- 动态选择成功的批量结果额外返回 `selection` 和实际解析出的 `selectedUnitIds`

#### `move_unit`

```ts
{
  unitIds?: string[];
  selection?: DynamicUnitSelection;
  x: number;
  y: number;
}
```

说明：

- 语义等同于 RTS 中框选一个或多个单位后下达同一移动命令
- 目标格被占用时，寻路层会尽量分配附近可达格，并通过 `move_adjusted` 返回实际落点

#### `attack_move_unit`

```ts
{
  unitIds?: string[];
  selection?: "all_combat" | "idle_combat" | CombatUnitType;
  x: number;
  y: number;
  priority?: AttackTargetType[];
}
```

说明：

- 语义等同于框选多个战斗单位后下达同一无目标推进命令
- 单位会向目标点移动，并在到达前自动攻击范围内的角色匹配目标：反步兵、反装甲、攻城单位分别按 ruleset 的目标顺序索敌；攻城单位不会攻击落入自身最小射程的目标
- 单位到达目标点后，`attack_move_unit` 命令结束并回到无 intent 的 idle；后续敌人进入其自身视野时，仍会按普通 idle 规则自动交战
- 这是无目标推进命令，只用于没有明确 `targetId` 时穿越危险区域或试探接敌
- 不用于指定攻击某个目标或建筑；点杀敌军或拆指定建筑应使用 `attack`
- 显式 `priority` 只调整索敌顺序：列出的类型会被提前，未列出的类型仍可攻击，并按该兵种的默认相对顺序作为 fallback；需要点杀某个单位或建筑时使用 `attack(targetId)`。射程外单位会持续追击；建筑目标按射程和来向为同批攻击者预约互不重叠的近侧射击位，单位进入射程后立即停止移动并开火。对同一目标重复调用不会重置仍在执行的追击路径

#### `attack`

```ts
{
  unitIds?: string[];
  selection?: "all_combat" | "idle_combat" | CombatUnitType;
  targetId: string;
}
```

说明：

- 框选的所有合法战斗单位对同一 `targetId` 下达持续攻击命令
- `targetId` 必须来自全图情报中的敌方单位或建筑 ID
- 这是有明确目标 ID 时的默认战斗命令；即使目标很远，系统也会让单位向目标移动，进入射程后持续攻击；目标进入武器最小射程内时，单位会先退到合法射界，避免原地重复提交超近攻击
- 聚焦目标在观察后、首次批量命令提交前死亡时，系统会从当前全图情报中选择一个替代目标，并让该批全部合法攻击者统一追击；替代目标不受各单位当时的攻击范围或自动索敌视野限制，远处单位同样先移动再攻击。成功结果携带批量级 `targetId` 和 `retargetedFrom`
- 持续攻击中目标消失时，各单位也会从当前战场目标中重选并继续追击。排序先看正在威胁友军的目标，再按兵种默认优先级、距离、残血和稳定 ID
- 全图没有合法替代目标时，首次调用返回 `target_missing`、`targetStatus`、紧凑的 `availableEnemyTargets` 和完整 `availableEnemyTargetCount`；持续攻击则清掉旧追击路径并回到 idle
- `targetStatus` 在目标曾被当前控制器观察且后来消失时为 `destroyed`；友军 ID 为 `not_enemy`；其他未知 ID 为 `invalid_id`

#### `spawn_unit`

```ts
{
  buildingId: string;
  units: Array<{
    unitType: "worker" | "rifleman" | "rocket_soldier" | "commando" | "light_tank" | "flame_tank" | "heavy_tank";
    count: number; // 1..100
  }>;
}
```

`units` 是追加到该建筑的有限批次，严格按数组顺序生产。standard 中请求 `soldier` 会返回 `invalid_spawn_request`，旧录像或已有状态中的 soldier 仍可正常观察、移动、攻击和回放。每座建筑每种可生产单位最多保留 100 个待生产单位；同一调用中重复兵种也会合并计入该上限。`commando` 另有玩家级限造：存活单位与所有建筑已排队数量合计不得超过 1，达到上限时新请求返回 `unit_limit_reached`；兼容导入的已有超额队列会显示 `waiting_for_unit_limit`，在名额释放后继续。入队不扣全款，ProductionSystem 按生产进度逐 tick 扣款；credits 不够时当前单位暂停且不丢进度。T3 当前单位开始后即使 `tech_center` 被摧毁也会完成，后续 T3 单位转为 `waiting_for_prerequisite`，重建后自动恢复。

```ts
interface ProductionOrder {
  orderId: string;
  unitType: UnitType;
  count: number;
  remainingCount: number;
}

interface ProductionProgress {
  orderId: string;
  unitType: UnitType;
  remainingTicks: number;
  totalTicks: number;
  paidCredits: number;
  totalCost: number;
  status: "producing" | "waiting_for_credits" | "waiting_for_spawn" | "waiting_for_prerequisite" | "waiting_for_unit_limit";
  missingPrerequisites?: BuildingType[];
}
```

#### `get_production_queue`

```ts
{ buildingIds?: string[] }
```

省略 `buildingIds` 时返回全部己方 HQ、兵营和重工。结果包含严格有序的 `queue`、当前 `progress`、`pendingByUnitType`、每兵种上限、当前 credits，以及逐单位的 `productionOptions[].unlocked/missingPrerequisites`。

#### `cancel_production`

```ts
{ orderIds: string[] } | { buildingIds: string[] }
```

两种模式必须二选一：`orderIds` 取消指定批次，`buildingIds` 清空指定建筑的全部队列。当前尚未完成的单位已经支付多少就退多少；尚未开始的队列项未扣款，无需退款。生产建筑被摧毁时执行相同的清队列和退款规则。

#### `cancel_plan`

```ts
{ planIds: string[] }
```

按 `get_active_plans` 返回的 `planId` 立即终止一个或多个 active plan。它只负责 MissionRuntime 计划，不接受生产 `orderId`；生产队列仍使用 `cancel_production`。global plan 显式绑定的单位死亡后会自动转为 `failed` 并从 active 列表移除，不会以 `assigned_unit_missing` 无限等待。

#### `build_structure`

```ts
{
  unitId: string;
  buildingType: Exclude<BuildingType, "hq">;
  x?: number;
  y?: number;
}
```

说明：

- 当前允许建造 `barracks`、`war_factory`、`refinery`、`machine_gun_turret`、`anti_tank_turret` 和 `tech_center`
- `war_factory` 与 `machine_gun_turret` 需要已完成 `barracks`；`anti_tank_turret` 与 `tech_center` 需要已完成 `war_factory`
- 省略 `x/y` 时自动选择合法工地；普通生产建筑优先沿 HQ 朝战场方向横向展开，同批尚未落地的建造计划会预留 footprint 外一格，避免贴边或竖向封住 HQ 出口；`refinery` 按可缩短的矿点交付路线排序。显式传入时使用指定建筑中心
- worker 不在 footprint 旁时，工具会注册持久建造任务，自动移动；只有工人实际与完整 footprint 相邻时才进入建造步骤
- 建造成功会立即扣 credits 并创建施工中的建筑；施工中建筑占地、可被攻击，但不能生产，也不满足科技前置
- 施工会占用该 worker；如果建造前处于 `harvest_loop`，完工后自动恢复原采矿循环；没有原任务可恢复时自动选择矿路开始采矿
- 默认施工时间：`barracks` 12 ticks，`war_factory` 18 ticks，`refinery` 16 ticks，`machine_gun_turret` 14 ticks，`anti_tank_turret` 20 ticks，`tech_center` 28 ticks
- `refinery` 是交付点，不改变 worker 每 tick 的采集速度；收益来自缩短矿点与交付点之间的反复路线，因此贴 HQ 建造通常收益很小
- 自动选址成功时，结果中的 `estimatedRouteSaving` 和 `nearbyResources` 说明该工地对矿点路线的影响
- 建筑必须建在空地上，且要给己方 `HQ` 周围留出一圈空地
- 如果位置不合法，失败返回的 `hint` 会直接给出附近可行位置示例

#### `start_harvest_loop`

```ts
{
  unitIds: string[];
  x?: number;
  y?: number;
}
```

说明：

- `unitIds` 接受一个或多个己方 `worker`；同一批显式坐标会应用到所有选中 worker
- 让 worker 进入内建采矿循环，在资源点和最近的己方已完成 HQ/refinery 之间自动往返
- 开局 worker 和没有显式 rally point 的新 worker 默认已经获得自动采矿循环；该工具主要用于主动改派、从 hold/移动任务恢复或显式指定矿点
- 省略 `x/y` 时，游戏按反复交付路程、worker 初始路程和当前分配数自动选择矿点；交付路程权重更高，避免近矿尚可用时仅为分散分配跑去远矿
- 单个矿点最多保留 2 个 worker；超出后内建循环会自动改派到下一条高效路线，避免多个单位围住单格矿点
- 显式传入 `x/y` 会尊重该矿点，只应在需要主动覆盖自动选择时使用
- 当前矿点耗尽后，持续采矿循环会自动选择下一条可用路线；worker 只要进入已完成 HQ/refinery 的交付范围就能卸货，即使其位置仍是资源格
- 常规采矿应优先使用这个工具，不要用多步 plan 手写 worker 往返路线
- 已经处于同一 `harvest_loop` 的 worker 即使瞬时 `phase` 为 `idle`，也视为已有任务；相同调用返回 `status: "already_active"` 且不会重启路径。只有 `path_blocked`、矿点失效或主动改派时才需要重发

#### `stop_unit`

```ts
{
  unitIds?: string[];
  selection?: DynamicUnitSelection;
}
```

- 取消单位当前路径、攻击前摇/持续攻击、持续 attack 追踪和 active plan，然后回到无 intent 的 idle
- idle 战斗单位会继续按自身 `visionRange` 自动索敌；因此 stop 是“取消当前命令”，不是“禁止自动交战”
- worker 被 stop 后也会留在普通 idle；需要恢复采矿时使用 `start_harvest_loop`

#### `hold_unit`

```ts
{
  unitIds?: string[];
  selection?: DynamicUnitSelection;
}
```

- 取消单位当前路径、攻击前摇/持续攻击、持续 attack 追踪和 active plan，然后进入持久 hold intent
- hold 战斗单位会在自身视野与武器射程内自动开火，但绝不移动追击；最小射程仍然生效
- 系统任务完成或目标消失不再自动生成 hold；只有显式 `hold_unit` 动作（包括 plan step）才进入该状态

#### `set_rally_point`

```ts
{
  buildingIds: string[];
  x?: number;
  y?: number;
  mode?: "move" | "attack_move";
}
```

说明：

- 接受一个或多个己方 HQ、兵营或重工；同一批建筑共享目标
- 同时传入整数 `x/y` 时设置持久集结点；同时省略时清除，不能只传一个坐标
- `mode` 默认 `move`；兵营和重工可选 `attack_move`，让新战斗单位在前往集结点时攻击沿途敌人
- HQ 只生产 worker，因此其集结点仅支持 `move`
- 集结点或其他单位的预留终点被占时，每个新单位会解析到目标附近的可达格；不会等待原格清空
- `move` 不主动索敌；`attack_move` 会按单位默认目标优先级索敌
- 清除集结点不会取消已经出发单位的移动命令

这些工具会先做明显无效请求的即时校验，例如单位/建筑不存在、目标不是敌人、worker 不能攻击等。校验失败时返回 `ok: false`、`error`、`hint`，且不会入队。只要服务端已经掌握恢复所需事实，失败结果会直接附带紧凑候选，例如 `availableFriendlyUnits`、`availableAttackers`、`availableWorkers`、`availableProductionBuildings`、`availableEnemyTargets` 或 `nearbyResources`，hint 不再要求额外调用状态读取工具。

批量 `move_unit` / `attack_move_unit` / `attack` / `stop_unit` / `hold_unit` 会把相同候选列表提升到批量结果顶层，不在每个单位的子结果中重复。批量失败也会在顶层返回具体 `error`、`message`、`hint` 和 `failedUnitIds`，不会退化成 `unknown error`；候选默认有数量上限，敌方目标返回完整计数，并优先包含敌方建筑和距离攻击者最近的单位。

成功和失败结果都会带当前 `tick`。如果本轮还没有调用过只读工具，动作/计划工具会附带 `no_recent_read` warning，但不会仅因为 warning 拒绝入队。读过一次之后不会因为模型推理或工具调用跨过若干 tick 而产生过期警告；动作仍使用调用时的实时状态验证对象和规则：

```ts
{
  tick: number;
  ok: boolean;
  commandId?: string;
  error?: string;
  hint?: string;
  warning?: {
    type: "no_recent_read";
    message: string;
    currentTick: number;
  };
}
```

这些工具只负责把命令加入当前 tick 的 command queue。真正的移动、攻击、建造、产兵依然由 `Game` 逐 tick 结算。

### 2.3 持久计划入口 `orchestrate_plan`

这是 LLM、HTTP control 和 CLI 共用的多 tick 计划工具。step 的 `call` 与 `args` 复用其支持的 2.2 节即时动作工具名称和动作参数，内部 `MissionRuntime` 在每个 committed tick 推进；生产队列工具不属于 plan call。per-unit plan 必须在注册时通过顶层 `unitIds` 固定所属单位，不能使用只在单次即时动作执行时解析的动态 `selection`。

```ts
interface OrchestratePlanInput {
  unitIds?: string[];
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
  | "build_structure"
  | "start_harvest_loop"
  | "stop_unit"
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
  | { condition: "worker_adjacent_to_build_footprint"; buildingType: BuildingType; x: number; y: number }
  | { condition: "target_in_range"; targetId: string }
  | { condition: "target_destroyed"; targetId: string }
  | { condition: "credits_at_least"; amount: number }
  | { condition: "building_exists"; buildingType: BuildingType; count?: number; x?: number; y?: number }
  | { condition: "enemy_building_exists"; buildingType: BuildingType; count?: number }
  | { condition: "unit_count_at_least"; unitType: UnitType; count: number }
  | { condition: "enemy_unit_count_at_least"; unitType: UnitType; count: number }
  | { condition: "production_queue_empty"; buildingId?: string; buildingType?: BuildingType };
```

说明：

- `orchestrate_plan` 只注册计划，不会在一次 tool call 内跑完整段脚本
- 计划会在后续 tick 自动推进
- 即时动作会打断相关单位的当前计划
- 新 plan 接管单位时，其首个移动或追击 step 会覆盖注册前遗留的移动目标；同一 step 已经下发后则等待当前移动，不每 tick 重发
- 如果单位已有合适的 active plan，不要每个 run 都重复注册同一个计划
- `steps` 只接受 call step，把现有动作工具调用注册成持续计划
- `scope = "per_unit"` 会对 `unitIds` 中每个存活单位展开并要求 `unitIds`；`scope = "global"` 只执行一次，纯建造计划可省略 `unitIds`
- `when` 是执行前置条件，未满足时等待；`until` 是完成条件，满足后推进到下一 step
- global step 如果在 `args.unitId` 中指定具体单位，`when` / `until` 的 `arrived`、`near_position`、`worker_adjacent_to_build_footprint`、`enemy_in_range`、`hq_in_range` 和 `target_in_range` 会基于该单位判断
- `enemy_building_exists` / `enemy_unit_count_at_least` 可用于表达侦察或战术触发
- `args.unitId` 可以省略或设为 `"$unitId"`，表示 per-unit 展开时使用当前单位
- 生产不属于 plan call；用 `spawn_unit` 一次追加有限队列，并用 `get_production_queue` / `cancel_production` 检查或调整。`production_queue_empty` 只保留为其他 plan step 的显式条件，使用时必须指定 `buildingId` 或 `buildingType`
- plan 中的 `build_structure` 会在当前 credits 不足时等待；它可省略 x/y 自动选址，自行移动 worker，footprint 被临时占据时立即换址
- `building_exists` 用于 `build_structure` 时默认跟随该 step 当前的 x/y，因此换址后会等待新位置的建筑完成，并在完成边界先结束步骤而非重复 build
- 多个 active plan 在同一 tick 推进时按顺序检查实际可用 credits；较早生成的 `build_structure` 会预留本 tick credits，后续付费 step 如果余额不够会等待下一次收入或下一轮推进
- `attack` call step 默认具备持续重试语义；也可以显式传 `retry: true`
- waypoint 由多个 `move_unit` / `attack_move_unit` step 依次表达。绕后、分兵多线、夹击、避开正面交战等对路线敏感的行动，应为每支分队显式分配 `unitIds` 并注册独立 plan：先设己方一侧的路线入口点，再沿所选路线设置后续路径点并接近目标。单个远端 waypoint 只约束终点，不约束实际行进路线

最小自动建造计划只需指定 worker 和建筑类型；坐标省略时自动选择，后续动态占位会自动换址：

```json
{
  "steps": [{
    "call": "build_structure",
    "args": { "unitId": "unit_1", "buildingType": "barracks" },
    "until": { "condition": "building_exists", "buildingType": "barracks" },
    "retry": true
  }]
}
```

示例：开局 worker 会自动采矿；为 builder 注册兵营建造计划会暂时覆盖其采矿任务，完工后自动恢复。兵营完成后另用一次 `spawn_unit({ buildingId, units: [{ unitType: "rifleman", count: 6 }] })` 注册有限生产批次。

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
    }
  ]
}
```

示例：需要补 `war_factory` 时注册建造计划；完成后用独立生产工具追加坦克批次。

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
- 为保持资源租赁边界，子 Agent 的单位动作只暴露显式 `unitIds`，不能使用会扩展到未租赁单位的动态 `selection`
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

`cpu` 仅表示 `player_2` 使用内建规则对手，主要用于单 agent 控制链路与 LLM-vs-CPU benchmark。CPU 是判断当前模型与提示词是否达到最低可用水平的基线；规则正确性和性能规模由测试与专门检查覆盖。ControlPlane CPU 使用服务端统一的 `decisionIntervalTicks=10`，成功响应会返回实际采用的值；CLI 不维护另一套默认值。

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

Read tools: `get_map_state`, `get_my_state`, `get_my_units`, `get_army_summary`, `get_production_queue`, `get_active_plans`, `get_recent_events`

Action tools: `move_unit`, `attack_move_unit`, `attack`, `spawn_unit`, `cancel_production`, `set_rally_point`, `build_structure`, `start_harvest_loop`, `stop_unit`, `hold_unit`

Plan tool: `orchestrate_plan`

同一个 plan tool 也包含在 LLM provider 收到的 tool definitions 中。

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
    tool: "move_unit" | "attack_move_unit" | "attack" |
      "spawn_unit" | "cancel_production" | "set_rally_point" | "build_structure" | "start_harvest_loop" | "stop_unit" | "hold_unit";
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

`GameState` 中的 `Unit.heading?: number` 是模拟层权威车体朝向，`Building.heading?: number` 是防御塔权威炮塔朝向；两者均为 XY 平面弧度，`0` 指向 `+X`。相应的 `TickDeltaRecord` 在实体创建或朝向变化时携带同名字段；客户端必须沿最短角度表现该值，不能根据到达顺序不稳定的弹丸或单位 intent 重新推断。旧记录没有该字段时，读取端继续使用兼容默认朝向。

记录档位：

- `off`：不保存 Match Record。
- `replay`：保存初始状态、逐 tick delta 和终态，足以供前端回放。
- `evaluation`：在 replay 内容上增加命令结果和 `aiTurns`，供 benchmark 与 agent 行为分析。

Control-plane match 默认使用 `evaluation` 且关闭 transcript，因此 CLI 命令链及其 `controllerId/source` provenance 会进入 `commandResults`；显式选择 replay 档位时才只保留回放状态。

`includeTranscript` 只在 evaluation 档位生效。关闭时仍保留 tool calls、commands、plans、性能指标和停止原因，但清空 assistant 原文与各模型请求的 messages；开启时才保存完整模型输出和请求消息。前端 transcript 页面直接从 Match Record 的 `aiTurns` 投影，不另写一种 transcript 文件。

`SavedAITurnRecord` 记录一次 agent turn 的输入 tick、工具调用、计划、命令、停止原因与模型请求指标。`metrics.contextWindow` 是当前 `ContextWindowLimiter` 的机械限长报告，包含裁剪前后消息数/字节数；它不是持久 memory，也不声称已经完成语义压缩。当前默认上限为 80 条消息、总计 1 MiB、单条 32 KiB，后续应由真正能生成模型可读摘要的 compactor 替代。

Benchmark complete 消息除原有胜负和平均时长外，可返回 `llmWinRateConfidence95 / positionBias / medianDurationTicks / p90DurationTicks`。`BenchmarkRunner` 只负责 benchmark trial 的并发执行和结果聚合；`analyze-record.mjs` 是面向开发者和 agent 的独立离线分析工具。
