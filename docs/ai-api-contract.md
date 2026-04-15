# LLMCraft AI API Contract

日期: 2026-04-12

这份文档只描述当前 AI 可依赖的接口契约。

它回答两个问题：

- 每轮模型会收到什么消息
- 生成的 JavaScript 在沙箱里能访问什么全局对象和方法

不包含战术建议，不包含设计愿景，不包含未来计划。

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

说明：

- 不返回明文 `apiKey`
- `hasApiKey` 只表示服务端已保存可解密 token

### 0.2 `POST /api/settings/presets`

创建一个 OpenAI-compatible 预设：

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

更新一个已有预设：

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

说明：

- `apiKey` 缺省或空串时，服务端保留旧 token
- `rpm` 留空表示不限制；填写时必须为正整数

### 0.4 `DELETE /api/settings/presets/:id`

删除指定预设。

### 0.5 WebSocket `start`

当前实时对局启动消息为：

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
- 服务端会按两个 preset 分别解密并创建两套独立 provider
- `debug.recordLLMTranscript = true` 时，仅当前这一局会额外写出 LLM 完整 transcript 到 `packages/server/logs/llm-debug/`
- 若 preset 不存在、不可解密或启动失败，服务端会通过 `type = "error"` 返回可读错误消息

### 0.6 WebSocket `reset`

当前实时对局重置消息为：

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

说明：

- `reset` 会按当前红蓝预设创建一局新的初始状态
- `debug.recordLLMTranscript` 会跟随这次重置后的新对局配置
- `reset` 不会自动开始模拟
- 用户需要随后再发送 `start` 才会开始新一局

### 0.7 WebSocket `stop`

当前实时对局暂停消息为：

```json
{
  "type": "stop"
}
```

说明：

- `stop` 会停止当前 orchestrator 的实时模拟
- 如果当前没有正在运行的实时对局，服务端不会额外返回成功消息

### 0.8 WebSocket `save_record`

当前实时对局保存消息为：

```json
{
  "type": "save_record"
}
```

说明：

- 只有当前存在实时对局时才允许保存
- 若当前没有可保存的实时对局，服务端会通过 `type = "error"` 返回错误消息

### 0.9 WebSocket `state`

服务端会持续推送当前实时状态：

```ts
interface ServerStateMessage {
  type: "state";
  state: GameState | null;
  snapshots: GameSnapshot[];
  liveEnabled: boolean;
}
```

说明：

- `snapshots` 在实时模式下当前只发送最近 1 帧，用于展示最新 AI 输出，不再传最近 100 帧
- `liveEnabled` 是服务端缓存值，不会在每次状态推送时重新读取 preset 存储

### 0.10 WebSocket `error`

服务端错误消息为：

```ts
interface ServerErrorMessage {
  type: "error";
  message: string;
}
```

说明：

- 当前所有实时对局相关的可读错误都会通过该消息返回
- 典型场景包括：消息类型非法、未选择预设、预设不存在、API Key 无法解密、当前没有可保存对局等

### 0.11 WebSocket `record_saved`

服务端保存成功消息为：

```ts
interface ServerRecordSavedMessage {
  type: "record_saved";
  filePath: string;
}
```

说明：

- `filePath` 是服务端返回的实际保存路径
- 当前前端会据此提示用户记录文件保存位置

### 0.12 WebSocket 共享联合类型

当前 WebSocket 协议已统一收敛到 `packages/shared/src/ws-messages.ts`：

```ts
type ClientMessage =
  | StartMatchMessage
  | ResetMatchMessage
  | { type: "stop" }
  | { type: "save_record" }
  | ClientStartBenchmarkMessage;

type ServerMessage =
  | ServerStateMessage
  | ServerErrorMessage
  | ServerRecordSavedMessage
  | ServerBenchmarkProgressMessage
  | ServerBenchmarkCompleteMessage;
```

### 0.13 WebSocket `start_benchmark`

当前 benchmark 启动消息为：

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
- 当前 CPU 策略仅支持 `random` 和 `rush`
- benchmark 会先停止当前 live 对局，再串行跑完整个批次
- 每一局会交替让 LLM 处于红方 / 蓝方，用于减少出生位偏差
- `decisionIntervalTicks` 只用于控制 benchmark 中 CPU 一侧的决策间隔，单位是 tick；LLM 一侧保持默认 5 tick 调度
- `recordReplay = true` 时，每个已完成 round 会自动保存 1 份回放到 `packages/server/logs/benchmark-records/`
- 同一已结束对局的重复保存会复用已生成文件，不应再额外创建重复回放文件
- `debug.recordLLMTranscript = true` 时，每个已完成 round 会额外生成 1 份 LLM Debug 日志到 `packages/server/logs/benchmark-llm-debug/`
- benchmark 回放与 transcript 目前都以时间戳命名；在当前串行执行模型下通常不会冲突，但命名并非强唯一

### 0.14 WebSocket `benchmark_progress`

服务端在每局结束后推送当前汇总进度：

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

### 0.15 WebSocket `benchmark_complete`

服务端在 benchmark 完成或被用户停止后推送最终结果：

```ts
interface ServerBenchmarkCompleteMessage {
  type: "benchmark_complete";
  cpuStrategy: "random" | "rush";
  presetId: string;
  totalRounds: number;
  completedRounds: number;
  llmWins: number;
  cpuWins: number;
  draws: number;
  llmWinRate: number;
  averageDurationTicks: number;
  stopped: boolean;
  rounds: Array<{
    round: number;
    llmSide: "player_1" | "player_2";
    winner: "llm" | "cpu" | "draw";
    durationTicks: number;
    recordPath?: string;
    transcriptPath?: string;
  }>;
}
```

说明：

- `stopped = true` 表示 benchmark 在全部局数完成前被用户中止
- `rounds` 里只包含实际跑完的局，不包含中止时未完成的当前局

## 1. 输入结构

每次模型调用都会收到：

- `system prompt`
- 最近 20 次 AI 对话窗口内的历史 `user / assistant` 消息
- 当前这一轮新的 `user` 消息

当前新的 `user` 消息内容是：

```ts
JSON.stringify(AIPromptPayload, null, 2)
```

当前 `AIPromptPayload` 结构：

```ts
interface AIPromptPayload {
  mode: "full" | "delta";
  tick: number;
  tickIntervalMs: number;
  summary: string;
  state: AIStatePackage | null;
  delta: {
    creditsChanged?: number;
    myUnitChanges: Array<{
      id: string;
      type: "worker" | "soldier";
      change: "created" | "removed" | "moved" | "damaged" | "updated";
      x?: number;
      y?: number;
      hp?: number;
      maxHp?: number;
      state?: string;
    }>;
    myBuildingChanges: Array<{
      id: string;
      type: "hq" | "barracks";
      change: "created" | "removed" | "damaged" | "updated";
      x?: number;
      y?: number;
      hp?: number;
      maxHp?: number;
    }>;
    enemyUnitChanges: Array<{
      id: string;
      type: string;
      change: "created" | "removed" | "moved" | "damaged" | "updated";
      x?: number;
      y?: number;
      hp?: number;
      maxHp?: number;
    }>;
    enemyBuildingChanges: Array<{
      id: string;
      type: string;
      change: "created" | "removed" | "damaged" | "updated";
      x?: number;
      y?: number;
      hp?: number;
      maxHp?: number;
    }>;
    events: GameLog[];
    aiFeedback: AIFeedback[];
  } | null;
}
```

说明：

- `mode = "full"` 时，`state` 为完整基线状态，`delta = null`
- `mode = "delta"` 时，`state = null`，变化写在 `delta`
- 对话历史采用滑动窗口，保留最近 20 轮 `user / assistant`
- 当窗口滚动将导致历史里不再保留任何一条 `mode = "full"` 基线时，服务端会把当前轮升级为一次新的 `mode = "full"`
- `summary` 不是纯固定文案；服务端可以在前面追加短告警行，用于强调当前高风险态势
- 当前已实现的告警只有一条：当我方 HQ 已受损或本轮继续掉血时，会追加 `Alert: our HQ is under attack.`

## 2. `AIStatePackage`

完整基线状态的结构如下：

```ts
interface AIStatePackage {
  tick: number;
  my: {
    resources: {
      credits: number;
    };
    units: Unit[];
    buildings: Building[];
  };
  enemies: Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
  }>;
  enemyBuildings: Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
  }>;
  map: {
    width: number;
    height: number;
    tiles: Array<{
      x: number;
      y: number;
      type: "empty" | "obstacle" | "resource";
    }>;
  };
  unitStats: {
    worker: UnitStats;
    soldier: UnitStats;
  };
  eventsSinceLastCall: GameLog[];
  aiFeedbackSinceLastCall: AIFeedback[];
  gameTimeRemaining: number;
}
```

说明：

- `enemies` 在输入 JSON 中只包含敌方单位
- `enemyBuildings` 单独包含敌方建筑
- `map.tiles` 当前只包含非空地块，也就是障碍物和资源点
- `eventsSinceLastCall` 和 `aiFeedbackSinceLastCall` 是最近切片，不是严格一次性消费队列

## 3. 沙箱全局对象

AI 代码在子进程中的 Node `vm` 上下文里运行。

当前仅保证以下全局对象存在：

- `game`
- `me`
- `enemies`
- `enemyBuildings`
- `aiFeedbackSinceLastCall`
- `map`
- `unitStats`
- `utils`

不要假设存在其他全局变量。

## 3.5 AI 执行记录中的错误字段

实时对局保存的 `aiTurns` 记录中，当前会同时保存：

```ts
type AITurnErrorType = string;
```

说明：

- `errorType = "vm_timeout"` 表示 AI 代码在子进程 `vm` 中执行超时
- `errorType = "parent_timeout"` 表示父进程在等待子进程结果时超时，通常代表进程启动、IPC 或主线程调度异常偏慢
- JS 编译/运行错误会保留原始 `error.name`，例如 `"SyntaxError"`、`"ReferenceError"`、`"TypeError"`
- `errorMessage` 仍保留可直接阅读的文本，用于 UI 和日志展示

当前默认固定布局为：

- 地图尺寸: `21 x 21`
- `HQ`: `(2,10)` / `(18,10)`
- 左右资源点: `(2,7)`、`(2,13)`、`(18,7)`、`(18,13)`
- 上下资源点: `(7,2)`、`(13,2)`、`(7,18)`、`(13,18)`
- 中轴障碍: `x = 10`，`y = 8..12`

## 4. 全局对象定义

### 4.1 `game`

```ts
const game: {
  tick: number;
  timeRemaining: number;
};
```

### 4.2 `me`

```ts
const me: {
  units: WrappedUnit[];
  buildings: WrappedBuilding[];
  resources: {
    credits: number;
  };
  hq: WrappedBuilding | null;
  workers: WrappedUnit[];
  soldiers: WrappedUnit[];
};
```

`WrappedUnit` 在普通单位字段基础上，额外提供：

```ts
unit.moveTo(pos: { x: number; y: number }): void;
unit.attack(targetId: string): void;
unit.attackInRange(targetPriority?: string[]): void;
unit.holdPosition(): void;
unit.build(buildingType: "barracks", pos: { x: number; y: number }): void;
```

`WrappedBuilding` 在普通建筑字段基础上，额外提供：

```ts
building.spawnUnit(unitType: "worker" | "soldier"): void;
```

规则说明：

- `hq` 只能 `spawnUnit("worker")`
- `barracks` 只能 `spawnUnit("soldier")`
- `worker.build("barracks", ...)` 是当前唯一可建造的建筑命令

### 4.3 `enemies`

```ts
const enemies: Array<{
  id: string;
  type: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
}>;
```

说明：

- 沙箱里的 `enemies` 是“敌方单位 + 敌方建筑”的合并列表
- 输入 JSON 的 `enemies` 和沙箱里的 `enemies` 不是同一个语义层次
- 如果只要敌方单位，需要按 `type` 自己筛选

### 4.4 `enemyBuildings`

```ts
const enemyBuildings: Array<{
  id: string;
  type: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
}>;
```

### 4.5 `aiFeedbackSinceLastCall`

```ts
const aiFeedbackSinceLastCall: Array<{
  tick: number;
  phase: "generation" | "execution" | "command";
  severity: "error" | "warning";
  message: string;
  errorType?: string;
  code?: string;
  meta?: {
    x?: number;
    y?: number;
    requestedX?: number;
    requestedY?: number;
    targetId?: string;
    hint?: string;
  };
}>;
```

### 4.6 `map`

```ts
const map: {
  width: number;
  height: number;
  tiles: Array<{
    x: number;
    y: number;
    type: "empty" | "obstacle" | "resource";
  }>;
  getTile(x: number, y: number): {
    x: number;
    y: number;
    type: "empty" | "obstacle" | "resource";
  };
};
```

说明：

- `map.tiles` 只包含非空地块
- `map.getTile(x, y)` 对空地返回 `{ x, y, type: "empty" }`

### 4.7 `unitStats`

```ts
const unitStats: {
  worker: {
    hp: number;
    speed: number;
    attack: number;
    cost: number;
    attackRange: number;
  };
  soldier: {
    hp: number;
    speed: number;
    attack: number;
    cost: number;
    attackRange: number;
  };
};
```

### 4.8 `utils`

```ts
const utils: {
  getRange(a: { x: number; y: number }, b: { x: number; y: number }): number;
  inRange(a: { x: number; y: number }, b: { x: number; y: number }, range: number): boolean;
  findClosestByRange(from: { x: number; y: number }, targets: Array<{ x: number; y: number }>): any;
};
```

## 5. 当前保证的行为

- `unit.moveTo(...)` 会下发移动命令，实际移动由游戏系统逐 tick 执行
- 如果 `moveTo` 的目标格不可站，系统会自动改到附近最近的可达格
- 当 `moveTo` 被自动改点时，`aiFeedbackSinceLastCall` 会出现 `code = "move_adjusted"`，并在 `meta.x / meta.y` 返回实际目标格
- `unit.attack(...)` 会下发攻击命令，目标需要在攻击范围内
- `unit.attackInRange(targetPriority?)` 会在命令真正执行时，按优先级重新选择当前射程内目标
- `unit.attackInRange()` 的默认优先级是 `["hq", "soldier", "worker", "barracks"]`
- `unit.attackInRange(["hq", "soldier", "worker"])` 适合在 AI 返回延迟较大时减少目标过期
- 当前攻击范围按 8 邻域计算；对 `attackRange = 1` 的 Soldier，上下左右和四个斜角相邻格都算射程内
- `unit.holdPosition()` 会下发待命命令
- `unit.build("barracks", ...)` 会下发建造兵营命令
- `building.spawnUnit(...)` 会下发产兵命令，但必须满足建筑类型权限
- 沙箱运行时错误会被捕获并作为该轮 AI 失败返回，不应导致服务端进程退出

补充规则：

- `barracks` 不能紧贴己方 `HQ` 建造，至少要留出 1 格缓冲
- 当前命令失败反馈会尽量给出短结构：`code + meta + hint`

## 6. 当前不保证的行为

- 不保证严格战争迷雾
- 不保证 `eventsSinceLastCall` / `aiFeedbackSinceLastCall` 是严格单次消费
- 不保证输入 JSON 和沙箱全局对象完全同构
- 不保证存在未在本文列出的兼容变量名

## 7. 最小示例

```js
const barracks = me.buildings.find(b => b.type === "barracks");
const enemyHQ = enemyBuildings.find(b => b.type === "hq");

if (!barracks && me.workers[0] && me.resources.credits >= unitStats.worker.cost + 120) {
  me.workers[0].build("barracks", { x: me.hq.x + 2, y: me.hq.y });
}

if (barracks && me.resources.credits >= unitStats.soldier.cost) {
  barracks.spawnUnit("soldier");
}

if (enemyHQ) {
  me.soldiers.forEach(s => {
    const inRange = Math.max(Math.abs(s.x - enemyHQ.x), Math.abs(s.y - enemyHQ.y)) <= s.attackRange;
    if (inRange) {
      s.attackInRange(["hq", "soldier", "worker", "barracks"]);
    } else {
      s.moveTo({ x: enemyHQ.x, y: enemyHQ.y });
    }
  });
}
```

说明：

- 上面示例里的 `moveTo({ x: enemyHQ.x, y: enemyHQ.y })` 是允许的；如果目标是建筑格，系统会自动吸附到附近可站格
