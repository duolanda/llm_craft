# LLMCraft 当前 MVP 现状说明

日期: 2026-04-05

这份文档只描述当前代码真实行为，不描述理想设计。

如果 README、设计文档、计划文档和代码不一致，以代码为准。

## 1. 当前系统边界

- 前端: React + Vite + Canvas
- 后端: Node.js + TypeScript
- AI 请求方式: OpenAI Chat Completions，多轮连续对话
- AI 执行环境: 子进程 + Node `vm`
- 游戏 Tick: 500ms
- AI 思考频率: 默认每 5 tick 触发一次
- AI 对话窗口: 每个玩家保留最近 20 次 AI 调用的 `user / assistant` 往返

## 2. 当前 MVP 规则

- 建筑只保留 `hq` 和 `barracks`
- 单位只保留 `worker` 和 `soldier`
- 资源字段为 `credits`
- 开局每方是 `1 HQ + 2 Worker`
- `HQ` 只能生产 `Worker`
- `Barracks` 只能生产 `Soldier`
- `Worker` 可以瞬间建造 `Barracks`
- 建造会扣资源，并做位置合法校验
- `Barracks` 不能紧贴己方 `HQ` 建造，至少留出 1 格缓冲
- 胜负条件仍然是摧毁敌方 HQ

## 3. 模型每轮实际收到什么

每次调用模型，服务端发送：

- 固定 `system prompt`
- 最近窗口内的历史消息
- 当前新的一条 `user` 消息，内容是 `AIPromptPayload`

### 3.1 当前 `AIPromptPayload` 真实模式

- `mode = "full"`:
  - 发送完整 `AIStatePackage`
  - 用于首次调用，或滑动窗口即将失去最后一份完整基线时补发新的基线
- `mode = "delta"`:
  - 发送自上次 AI 调用后的增量变化
  - 包括 credits 变化、我方/敌方单位与建筑变化、最近事件、AI 反馈
- `summary`:
  - 基础上仍是“完整基线”或“增量状态”的说明文案
  - 当前若我方 HQ 已受损，或相对上一轮继续掉血，会在前面追加 `Alert: our HQ is under attack.`

也就是说，模型现在不是每次只看到“system + 当前完整状态 JSON”，而是在一个有限长度的持续对话里接收完整基线和后续增量。

当前上下文管理策略是：

- 每个玩家各自维护一份独立对话历史
- 历史采用滑动窗口，只保留最近 20 轮 `user / assistant` 往返
- 不再在满 20 轮时整段清空历史
- 当滑动裁剪会导致窗口里不再保留任何一条 `mode = "full"` 时，服务端会把当前轮升级成新的 `full`

### 3.2 当前 `AIStatePackage` 真实结构

当前真实结构见 [types.ts](/E:/Projects/llm_craft/packages/shared/src/types.ts)。

字段含义如下：

- `tick`: 当前 tick
- `my.resources.credits`: 我方当前资源
- `my.units`: 我方所有存活单位
- `my.buildings`: 我方所有存活建筑
- `enemies`: 敌方单位列表
- `enemyBuildings`: 敌方建筑列表
- `map.width` / `map.height`: 地图尺寸
- `map.tiles`: 当前只传非空地块，也就是障碍物和资源点
- `unitStats`: 单位静态属性表
- `eventsSinceLastCall`: 最近日志切片
- `aiFeedbackSinceLastCall`: 最近 AI 错误/命令反馈切片，包含短结构 `code + meta + hint`
- `gameTimeRemaining`: 剩余时间

### 3.3 当前发送给模型的完整基线大致长什么样

```json
{
  "tick": 25,
  "my": {
    "resources": {
      "credits": 120
    },
    "units": [
      {
        "id": "unit_1",
        "x": 3,
        "y": 9,
        "exists": true,
        "type": "worker",
        "hp": 50,
        "maxHp": 50,
        "state": "idle",
        "my": true,
        "playerId": "player_1",
        "attackRange": 0
      }
    ],
    "buildings": [
      {
        "id": "building_1",
        "x": 2,
        "y": 10,
        "exists": true,
        "type": "hq",
        "hp": 1000,
        "maxHp": 1000,
        "my": true,
        "playerId": "player_1",
        "productionQueue": []
      }
    ]
  },
  "enemies": [
    {
      "id": "unit_3",
      "type": "worker",
      "x": 16,
      "y": 9,
      "hp": 50,
      "maxHp": 50
    }
  ],
  "enemyBuildings": [
    {
      "id": "building_2",
      "type": "hq",
      "x": 17,
      "y": 10,
      "hp": 1000,
      "maxHp": 1000
    }
  ],
  "map": {
    "width": 20,
    "height": 20,
    "tiles": [
      { "x": 5, "y": 5, "type": "obstacle" },
      { "x": 8, "y": 2, "type": "resource" }
    ]
  },
  "unitStats": {
    "worker": { "hp": 50, "speed": 1, "attack": 0, "cost": 50, "attackRange": 0 },
    "soldier": { "hp": 100, "speed": 1, "attack": 15, "cost": 80, "attackRange": 1 }
  },
  "eventsSinceLastCall": [],
  "aiFeedbackSinceLastCall": [],
  "gameTimeRemaining": 587.5
}
```

## 4. AI 代码执行时真正能访问什么

模型看到的是消息。

沙箱运行代码时能访问的是另一套全局对象，由 [AISandbox.ts](/E:/Projects/llm_craft/packages/server/src/AISandbox.ts) 注入，由 [APIBridge.ts](/E:/Projects/llm_craft/packages/server/src/APIBridge.ts) 构造。

当前可直接访问的全局对象只有这些：

- `game`
- `me`
- `enemies`
- `enemyBuildings`
- `aiFeedbackSinceLastCall`
- `map`
- `unitStats`
- `utils`

不存在兼容层。未列出的变量名都不应该假设存在。

## 5. 每个全局对象当前到底是什么

### 5.1 `game`

```js
game = {
  tick: number,
  timeRemaining: number
}
```

### 5.2 `me`

```js
me = {
  units: WrappedUnit[],
  buildings: WrappedBuilding[],
  resources: {
    credits: number
  },
  hq: WrappedBuilding | null,
  workers: WrappedUnit[],
  soldiers: WrappedUnit[]
}
```

其中 `WrappedUnit` 在原单位字段基础上，额外提供：

```js
unit.moveTo({ x, y })
unit.attack(targetId)
unit.attackInRange(targetPriority?)
unit.holdPosition()
unit.build("barracks", { x, y })
```

其中 `WrappedBuilding` 在原建筑字段基础上，额外提供：

```js
building.spawnUnit("worker" | "soldier")
```

当前能做的事：

- 遍历我方单位和建筑
- 读取单位位置、血量、状态、攻击范围
- 让单位移动、攻击、待命
- 让单位在执行时按优先级自动攻击当前射程内的对象
- 让 Worker 建兵营
- 让建筑产兵
- 直接把 `moveTo` 指到建筑格或拥堵格，系统会自动尝试改到附近可达格

补充说明：

- `unit.attack(targetId)` 是指定具体目标 ID
- `unit.attackInRange(targetPriority?)` 是到执行时再按优先级挑当前射程内目标
- `unit.attackInRange()` 默认优先级是 `["hq", "soldier", "worker", "barracks"]`

当前不能做的事：

- 不能直接删除、瞬移、治疗单位
- 不能建造除 `barracks` 以外的建筑
- 不能绕过建筑权限直接让 HQ 产 Soldier
- 不能修改资源数值

### 5.3 `enemies`

```js
enemies = [
  { id, type, x, y, hp, maxHp },
  ...
]
```

注意：

- 沙箱里的 `enemies` 当前只包含敌方单位
- 敌方建筑单独放在 `enemyBuildings`
- 其中类型现在只会出现 `worker`、`soldier`

如果只想要敌方单位，需要自己筛：

```js
const enemyUnits = enemies.filter(
  e => e.type === "worker" || e.type === "soldier"
);
```

### 5.4 `enemyBuildings`

```js
enemyBuildings = [
  { id, type, x, y, hp, maxHp },
  ...
]
```

### 5.5 `aiFeedbackSinceLastCall`

```js
aiFeedbackSinceLastCall = [
  {
    tick: number,
    phase: "generation" | "execution" | "command",
    severity: "error" | "warning",
    message: string,
    code?: string,
    meta?: {
      x?: number,
      y?: number,
      requestedX?: number,
      requestedY?: number,
      targetId?: string,
      hint?: string
    }
  }
]
```

### 5.6 `map`

```js
map = {
  width: number,
  height: number,
  tiles: Array<{ x, y, type }>,
  getTile(x, y)
}
```

注意：

- `map.tiles` 不是整张地图的 20x20 全量格子
- 当前只包含非空地块，也就是资源点和障碍物
- `map.getTile(x, y)` 如果该位置不在 `map.tiles` 中，会返回 `{ x, y, type: "empty" }`

### 5.7 `unitStats`

```js
unitStats = {
  worker: { hp, speed, attack, cost, attackRange },
  soldier: { hp, speed, attack, cost, attackRange }
}
```

### 5.8 `utils`

```js
utils = {
  getRange(a, b),
  inRange(a, b, range),
  findClosestByRange(from, targets)
}
```

## 6. AI 当前实际能做到什么

基于现有接口，AI 当前可以稳定做这些事：

- 生产 Worker / Soldier
- 控制单位移动到指定目标点
- 让 Soldier 攻击目标
- 让 Worker 建造 Barracks
- 基于 `enemyBuildings` 直接冲敌方 HQ
- 基于 `enemies` 进行最近目标选择
- 基于 `map.tiles` 找资源点和障碍物
- 基于 `aiFeedbackSinceLastCall` 避免重复同类错误
- 基于滑动窗口内的多轮对话历史延续短期战术

## 7. AI 当前做不到什么

当前接口和规则下，AI 还做不到这些事：

- 直接读取“严格可见单位”与“严格不可见单位”的差异
- 直接拿到完整全图空地列表
- 建造除 `barracks` 之外的建筑
- 直接控制单位走某条精确路径
- 直接查询命令是否在下发瞬间成功，只能靠后续反馈和记录知道
- 依赖无限长跨轮记忆

## 8. 当前记录机制

当前已经有对局记录保存能力。

保存内容包括：

- 对局元数据：开始时间、保存时间、双方模型、Base URL、AI 调用间隔、窗口大小
- `initialState`
- `finalState`
- `tickDeltas`
- `commandResults`
- `aiTurns`

其中 `aiTurns` 会保存：

- 当轮 tick
- 发给模型的消息列表
- 本轮 `promptPayload`
- 模型返回代码
- 沙箱产生命令
- 执行错误信息

当前前端支持在暂停或运行中点击“保存记录”，把当前对局写到 `logs/records/`。

当前前端也支持基于保存记录做逐 tick 回放，具体表现为：

- 可从服务端 `logs/records/` 列表选择记录
- 可直接导入本地 `match-*.json`
- 可播放、暂停、拖动进度条、切换倍速
- 会同步显示该 tick 的战场状态、日志、AI 输出
- 会尽量恢复单位的移动目标点和攻击目标/攻击落点

当前服务端额外暴露两个回放读取接口：

- `GET /api/replay/records`
- `GET /api/replay/records/:fileName`

补充说明：

- 当前保存记录不再依赖滚动快照窗口，长局也会保留真正的开局状态
- 快照在保存时会深拷贝，避免早期 tick 被后续状态污染
- 回放是基于记录重建状态流，不是重新执行整场模拟，因此少量引擎内部瞬时状态不保证完全复现

当前“不能完全还原”的部分，主要包括这些：

- 单位的完整寻路过程
  - 记录里不会逐步保存每个单位每一 tick 的整条 `path`
  - 回放只能可靠看到单位当前位置，以及在部分情况下恢复出的目标点
  - 如果单位中途因为碰撞、绕路、重新寻路而改变路径，回放不保证完整呈现每次内部路径重算

- 某些运行时临时字段的逐 tick 原貌
  - 例如 `path`、`pathTarget`、`lastAttackTick` 这类运行时字段，并不是每一帧都完整持久化
  - 回放里这类信息只能按需要做近似恢复，不能视为原始运行时快照

- `intent` 的完整历史
  - 保存记录不会在每个 tick 直接保存所有单位的完整 `intent`
  - 回放里的移动目标、攻击目标，主要是根据 `commandResults`、`tickDeltas`、日志和状态变化反推出来的
  - `move` 通常能较稳定恢复目标格
  - `attack(targetId)` 通常能较稳定恢复目标对象
  - `attackInRange(priority)` 只能根据该 tick 的受伤/移除变化推断实际命中目标；如果同 tick 内有多个可能候选，回放展示可能只是最合理近似

- tick 内部执行顺序的细粒度中间态
  - 当前记录适合重建“每个 tick 结束后状态”
  - 不适合重建“这个 tick 内先处理了哪条命令、再移动、再攻击、再结算资源”这种逐子阶段可视化
  - 也就是说，回放不是子帧级别的 deterministic trace

- 引擎内部派生判断过程
  - 例如某次 `moveTo` 为什么最终绕到某个格、某次 `attackInRange` 为什么优先选中了 A 而不是 B
  - 这些结果大多能从最终状态和日志推断，但内部筛选过程本身并没有完整持久化

- 纯日志未覆盖的失败上下文
  - 当前只会保存关键 `commandResults` 和部分 `aiFeedback/newLogs`
  - 如果某个分析依赖更细的局部上下文，而该上下文没进入记录，回放就无法补出来

所以当前应把回放理解为：

- 能可靠用于看整局过程、做战术分析、定位大部分行为问题
- 不能等同于“把原始引擎每个内部字段、每个子阶段都逐位复刻出来”

## 9. 当前规则的真实实现

### 9.1 胜负条件

- 一方 HQ 被摧毁，则另一方获胜

### 9.2 移动

- Worker / Soldier: 每 tick 最多移动 1 格
- `moveTo` 是给目标点，系统自动寻路
- 如果目标格不可站，系统会自动改到附近最近的可达格
- 障碍物不可通行
- 单位碰撞会阻挡移动
- 非整数坐标会被拒绝

### 9.3 攻击

- Soldier 可以攻击单位和建筑
- Worker 当前 `attackRange = 0`
- 当前攻击范围按 8 邻域计算
- 对 `attackRange = 1` 的 Soldier，上下左右和四个斜角相邻格都算射程内
- 目标不在攻击范围内，命令失败
- 攻击同队目标会失败

### 9.4 建造与产兵

- 只有 Worker 可以建造 Barracks
- 建造是瞬间完成
- 建造会扣除 `120 credits`
- `HQ` 只能生产 `Worker`
- `Barracks` 只能生产 `Soldier`
- 产兵会在建筑附近找空位生成单位

## 10. 后续讨论时的优先级

如果文档和代码不一致，按这个顺序理解：

1. 当前代码真实行为
2. 这份现状文档
3. README
4. 历史设计文档 / 计划文档
