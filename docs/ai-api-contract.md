# LLMCraft AI API Contract

日期: 2026-04-05

这份文档只描述当前 AI 可依赖的接口契约。

它回答两个问题：

- 每轮模型会收到什么 JSON
- 生成的 JavaScript 在沙箱里能访问什么全局对象和方法

不包含战术建议，不包含设计愿景，不包含未来计划。

## 1. 输入结构

每轮模型收到：

- `system prompt`
- `JSON.stringify(AIStatePackage, null, 2)`

当前 `AIStatePackage` 结构：

```ts
interface AIStatePackage {
  tick: number;
  my: {
    resources: {
      energy: number;
      energyPerTick: number;
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
    scout: UnitStats;
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
- `eventsSinceLastCall` 和 `aiFeedbackSinceLastCall` 当前是最近切片，不是严格增量流

## 2. 沙箱全局对象

AI 代码在 `vm2` 中运行。

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

## 3. 全局对象定义

### 3.1 `game`

```ts
const game: {
  tick: number;
  timeRemaining: number;
};
```

### 3.2 `me`

```ts
const me: {
  units: WrappedUnit[];
  buildings: WrappedBuilding[];
  resources: {
    energy: number;
    energyPerTick: number;
  };
  hq: WrappedBuilding | null;
  workers: WrappedUnit[];
  soldiers: WrappedUnit[];
  scouts: WrappedUnit[];
};
```

`WrappedUnit` 在普通单位字段基础上，额外提供：

```ts
unit.moveTo(pos: { x: number; y: number }): void;
unit.attack(targetId: string): void;
unit.holdPosition(): void;
```

`WrappedBuilding` 在普通建筑字段基础上，额外提供：

```ts
building.spawnUnit(unitType: "worker" | "soldier" | "scout"): void;
```

### 3.3 `enemies`

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
- 也就是说，沙箱 `enemies` 和输入 JSON `enemies` 不是同一个语义层次
- 如果只要敌方单位，需要按 `type` 自己筛选

### 3.4 `enemyBuildings`

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

### 3.5 `aiFeedbackSinceLastCall`

```ts
const aiFeedbackSinceLastCall: Array<{
  tick: number;
  phase: "generation" | "execution" | "command";
  severity: "error" | "warning";
  message: string;
}>;
```

### 3.6 `map`

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

### 3.7 `unitStats`

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
  scout: {
    hp: number;
    speed: number;
    attack: number;
    cost: number;
    attackRange: number;
  };
};
```

### 3.8 `utils`

```ts
const utils: {
  getRange(a: { x: number; y: number }, b: { x: number; y: number }): number;
  inRange(a: { x: number; y: number }, b: { x: number; y: number }, range: number): boolean;
  findClosestByRange(from: { x: number; y: number }, targets: Array<{ x: number; y: number }>): any;
};
```

## 4. 当前保证的行为

- `unit.moveTo(...)` 会下发移动命令，实际移动由游戏系统逐 tick 执行
- `unit.attack(...)` 会下发攻击命令，目标需要在攻击范围内
- `unit.holdPosition()` 会下发待命命令
- `building.spawnUnit(...)` 会下发产兵命令
- 沙箱运行时错误会被捕获并作为该轮 AI 失败返回，不应导致服务端进程退出

## 5. 当前不保证的行为

- 不保证严格战争迷雾
- 不保证 `eventsSinceLastCall` / `aiFeedbackSinceLastCall` 是严格单次消费
- 不保证输入 JSON 和沙箱全局对象完全同构
- 不保证存在未在本文列出的兼容变量名

## 6. 最小示例

```js
const enemyHQ = enemyBuildings.find(b => b.type === "hq");

if (enemyHQ) {
  me.soldiers.forEach(s => {
    const target = utils.findClosestByRange(s, enemies);
    if (target && utils.inRange(s, target, s.attackRange)) {
      s.attack(target.id);
    } else {
      s.moveTo({ x: enemyHQ.x - 1, y: enemyHQ.y });
    }
  });
}
```
