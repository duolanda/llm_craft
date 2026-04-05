# LLMCraft 当前 MVP 现状说明

日期: 2026-04-05

这份文档只描述当前代码真实行为，不描述理想设计。

如果 README、设计文档、计划文档和代码不一致，以代码为准。

## 1. 当前系统边界

- 前端: React + Vite + Canvas
- 后端: Node.js + TypeScript
- AI 请求方式: 每次单独调用一次 OpenAI Chat Completions
- AI 执行环境: `vm2`
- 游戏 Tick: 500ms
- AI 思考频率: 默认每 5 tick 触发一次

## 2. 模型每轮实际收到什么

每次调用模型，服务端发送两部分输入：

- `system prompt`
- `JSON.stringify(AIStatePackage, null, 2)`

也就是说，模型这一轮“知道什么”，完全取决于 `AIStatePackage` 的当前内容。

### 2.1 当前 `AIStatePackage` 真实结构

当前真实结构见 [types.ts](/E:/Projects/llm_craft/packages/shared/src/types.ts#L113)。

字段含义如下：

- `tick`: 当前 tick
- `my.resources`: 我方资源
- `my.units`: 我方所有存活单位
- `my.buildings`: 我方所有存活建筑
- `enemies`: 敌方单位列表
- `enemyBuildings`: 敌方建筑列表
- `map.width` / `map.height`: 地图尺寸
- `map.tiles`: 当前只传非空地块，也就是障碍物和资源点
- `unitStats`: 单位静态属性表
- `eventsSinceLastCall`: 最近日志切片，不是严格增量流
- `aiFeedbackSinceLastCall`: 最近 AI 错误/命令拒绝反馈切片，不是严格单次消费
- `gameTimeRemaining`: 剩余时间

### 2.2 当前发送给模型的 JSON 大致长什么样

下面这个示例不是伪接口设计，而是当前实现会发出的数据形状。

```json
{
  "tick": 25,
  "my": {
    "resources": {
      "energy": 120,
      "energyPerTick": 10
    },
    "units": [
      {
        "id": "p1_worker_1",
        "x": 2,
        "y": 3,
        "exists": true,
        "type": "worker",
        "hp": 50,
        "maxHp": 50,
        "state": "idle",
        "my": true,
        "playerId": "player_1",
        "attackRange": 0
      },
      {
        "id": "p1_soldier_1",
        "x": 4,
        "y": 5,
        "exists": true,
        "type": "soldier",
        "hp": 100,
        "maxHp": 100,
        "state": "moving",
        "my": true,
        "playerId": "player_1",
        "attackRange": 1
      }
    ],
    "buildings": [
      {
        "id": "p1_hq",
        "x": 1,
        "y": 1,
        "exists": true,
        "type": "hq",
        "hp": 500,
        "maxHp": 500,
        "my": true,
        "playerId": "player_1",
        "productionQueue": []
      }
    ]
  },
  "enemies": [
    {
      "id": "p2_soldier_1",
      "type": "soldier",
      "x": 15,
      "y": 15,
      "hp": 100,
      "maxHp": 100
    }
  ],
  "enemyBuildings": [
    {
      "id": "p2_hq",
      "type": "hq",
      "x": 18,
      "y": 18,
      "hp": 500,
      "maxHp": 500
    }
  ],
  "map": {
    "width": 20,
    "height": 20,
    "tiles": [
      { "x": 5, "y": 5, "type": "resource" },
      { "x": 10, "y": 10, "type": "obstacle" }
    ]
  },
  "unitStats": {
    "worker": { "hp": 50, "speed": 1, "attack": 5, "cost": 50, "attackRange": 0 },
    "soldier": { "hp": 100, "speed": 1, "attack": 15, "cost": 80, "attackRange": 1 },
    "scout": { "hp": 30, "speed": 2, "attack": 5, "cost": 30, "attackRange": 0 }
  },
  "eventsSinceLastCall": [
    {
      "tick": 24,
      "type": "combat",
      "message": "player_1 soldier attacked player_2 soldier"
    }
  ],
  "aiFeedbackSinceLastCall": [
    {
      "tick": 20,
      "phase": "execution",
      "severity": "error",
      "message": "ReferenceError: foo is not defined"
    }
  ],
  "gameTimeRemaining": 587.5
}
```

### 2.3 当前关于信息可见性的真实情况

- `enemies` 当前基本等于敌方单位全量信息
- `enemyBuildings` 当前直接给出敌方建筑信息
- 当前还没有严格战争迷雾
- 字段名虽然已经统一为 `enemies`，但语义仍然更接近“当前直接暴露给 AI 的敌方单位列表”，不是严格视野系统结果

## 3. AI 代码执行时真正能访问什么

模型看到的是 JSON。

沙箱运行代码时能访问的是另一套全局对象，由 [AISandbox.ts](/E:/Projects/llm_craft/packages/server/src/AISandbox.ts#L22) 注入，由 [APIBridge.ts](/E:/Projects/llm_craft/packages/server/src/APIBridge.ts#L16) 构造。

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

## 4. 每个全局对象当前到底是什么

### 4.1 `game`

```js
game = {
  tick: number,
  timeRemaining: number
}
```

当前能做的事：

- 读当前 tick
- 读剩余时间

当前不能做的事：

- 不能直接下命令
- 不能直接查询胜负、对局历史、隐藏状态

### 4.2 `me`

```js
me = {
  units: WrappedUnit[],
  buildings: WrappedBuilding[],
  resources: {
    energy: number,
    energyPerTick: number
  },
  hq: WrappedBuilding | null,
  workers: WrappedUnit[],
  soldiers: WrappedUnit[],
  scouts: WrappedUnit[]
}
```

其中 `WrappedUnit` 在原单位字段基础上，额外提供：

```js
unit.moveTo({ x, y })
unit.attack(targetId)
unit.holdPosition()
```

其中 `WrappedBuilding` 在原建筑字段基础上，额外提供：

```js
building.spawnUnit("worker" | "soldier" | "scout")
```

当前能做的事：

- 遍历我方单位和建筑
- 读取单位位置、血量、状态、攻击范围
- 让单位移动
- 让单位攻击目标
- 让单位原地待命
- 让建筑生产单位

当前不能做的事：

- 不能直接删除、瞬移、治疗单位
- 不能直接建造新建筑
- 不能修改资源数值
- 不能直接设置路径，只能给目标点

### 4.3 `enemies`

```js
enemies = [
  { id, type, x, y, hp, maxHp },
  ...
]
```

注意：

- 这里是“敌方单位 + 敌方建筑”的合并列表
- 也就是说，`enemies` 里可能同时出现 `worker`、`soldier`、`scout`、`hq`、`generator`、`barracks`

当前能做的事：

- 找最近敌人
- 用 `type` 区分单位和建筑
- 直接拿到目标 `id` 用于 `attack`

当前不能做的事：

- 不能从这里读到更详细的建筑状态，比如生产队列
- 不能假设这里只有单位

如果只想要敌方单位，需要自己筛：

```js
const enemyUnits = enemies.filter(
  e => e.type === "worker" || e.type === "soldier" || e.type === "scout"
);
```

### 4.4 `enemyBuildings`

```js
enemyBuildings = [
  { id, type, x, y, hp, maxHp },
  ...
]
```

当前能做的事：

- 快速找敌方 HQ
- 快速筛选兵营、发电站

当前不能做的事：

- 不能对敌方建筑直接调用任何方法

### 4.5 `aiFeedbackSinceLastCall`

```js
aiFeedbackSinceLastCall = [
  {
    tick: number,
    phase: "generation" | "execution" | "command",
    severity: "error" | "warning",
    message: string
  }
]
```

当前能做的事：

- 看上一些回合的报错
- 根据错误修正本轮代码

当前不能做的事：

- 不能把它当成严格的一次性消费队列
- 不能假设这里只有上一轮那一条

### 4.6 `map`

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

当前能做的事：

- 查资源点
- 查障碍物
- 基于坐标写简单战术

当前不能做的事：

- 不能从 `map.tiles` 直接枚举全图所有空地

### 4.7 `unitStats`

```js
unitStats = {
  worker: { hp, speed, attack, cost, attackRange },
  soldier: { hp, speed, attack, cost, attackRange },
  scout: { hp, speed, attack, cost, attackRange }
}
```

当前能做的事：

- 查询造价
- 查询速度
- 查询攻击力和攻击范围

### 4.8 `utils`

```js
utils = {
  getRange(a, b),
  inRange(a, b, range),
  findClosestByRange(from, targets)
}
```

当前能做的事：

- 算两点距离
- 判断是否进入范围
- 在候选目标里找最近一个

当前不能做的事：

- 没有寻路 API
- 没有攻击优先级 API
- 没有按类型分组、排序等高级工具

## 5. AI 当前实际能做到什么

基于现有接口，AI 当前可以稳定做这些事：

- 生产单位
- 控制单位移动到指定目标点
- 让单位攻击目标
- 基于 `enemyBuildings` 直接冲敌方 HQ
- 基于 `enemies` 进行最近目标选择
- 基于 `map.tiles` 找资源点和障碍物
- 基于 `aiFeedbackSinceLastCall` 避免重复同类错误

## 6. AI 当前做不到什么

当前接口和规则下，AI 还做不到这些事：

- 直接读取“严格可见单位”与“严格不可见单位”的差异
- 直接拿到完整全图空地列表
- 直接建造建筑
- 直接控制单位走某条精确路径
- 直接查询命令是否在下发瞬间成功，只能靠后续反馈和日志间接知道
- 依赖跨轮持久记忆

## 7. 当前容易混淆的点

### 7.1 JSON 字段和沙箱全局不是两套名字了，但仍是两层概念

现在两边都统一使用：

- `enemies`
- `enemyBuildings`

但仍然要区分：

- prompt 里给模型看的 JSON
- vm 里执行代码时能访问的全局对象

只是当前这两个层次的名字已经统一，不再有 `visibleEnemies` / `enemies` 的错位。

### 7.2 `enemies` 和 `enemyBuildings` 的关系

- `AIStatePackage.enemies` 只包含敌方单位
- 沙箱里的 `enemies` 是“敌方单位 + 敌方建筑”的合并结果
- 沙箱里的 `enemyBuildings` 只包含敌方建筑

这是当前实现里的一个刻意设计：方便 AI 用一个列表找最近目标，也方便它单独找建筑。

## 8. 当前规则的真实实现

### 8.1 胜负条件

- 一方 HQ 被摧毁，则另一方获胜

### 8.2 移动

- Worker / Soldier: 每 tick 最多移动 1 格
- Scout: 每 tick 最多移动 2 格
- `moveTo` 是给目标点，系统自动寻路
- 障碍物不可通行
- 单位碰撞会阻挡移动
- 非整数坐标会被拒绝

### 8.3 攻击

- Soldier 可以攻击单位和建筑
- Worker / Scout 当前 `attackRange = 0`
- 目标不在攻击范围内，命令失败
- 攻击同队目标会失败

### 8.4 造兵

当前为了验证对战闭环，规则是放宽的：

- 当前任何己方建筑都可以 `spawnUnit(...)`
- 优先在兵营附近产出
- 没有兵营时退化为在 HQ 附近产出

这不是最终设计，只是当前 MVP 简化。

## 9. 后续讨论时的优先级

如果文档和代码不一致，按这个顺序理解：

1. 当前代码真实行为
2. 这份现状文档
3. README / 设计文档 / 计划文档
