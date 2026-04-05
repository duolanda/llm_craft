# LLMCraft MVP 设计文档

日期: 2026-04-01

## 概述

LLMCraft 的最小可行产品 - 一个 Agent vs Agent 的即时战略游戏，人类编写 Prompt，AI 生成代码来对战。

## 项目结构

```
llm_craft/
├── packages/
│   ├── server/          # Node.js 游戏服务器
│   ├── client/          # React 前端 (Vite)
│   └── shared/          # 共享 TypeScript 类型定义
├── logs/                # 游戏回放日志 (JSON)
└── package.json
```

## 技术栈

| 层级 | 技术 |
|-----|------|
| 前端 | React + TypeScript + Vite + Canvas |
| 后端 | Node.js + TypeScript |
| 沙箱 | isolated-vm（执行 AI 生成的 TS/JS）|
| 模型 | OpenAI API (gpt-4o-mini) |
| 存储 | JSON 日志文件 |

## MVP 范围（第一阶段）

| 系统 | 内容 |
|-----|------|
| **地图** | 20×20 格子、障碍物、对称布局 |
| **单位** | Worker（采集）、Soldier（战斗）、Scout（侦察）|
| **建筑** | HQ（核心）、Generator（产能）、Barracks（兵营）|
| **资源** | 只有 Energy（Generator 生产，生产单位消耗）|
| **标准 API** | 单位移动/攻击/待命、建筑生产、地图查询 |
| **AI 模式** | 单 Agent，无 Sub-agent |
| **胜负条件** | 一方 HQ 被摧毁 |

## 数据流转

```
┌─────────────┐    500ms Tick    ┌─────────────┐
│  游戏循环   │ ────────────────→ │   状态      │
└─────────────┘                    └──────┬──────┘
       ↑                                   │
       │ 3. 执行命令                       │ 1. 序列化
       │                                   │
┌──────┴──────┐                    ┌──────▼──────┐
│   命令队列   │                    │  AI 状态包  │
└──────┬──────┘                    └──────┬──────┘
       ↑                                   │
       │ 4. 命令入队                       │ 2. 发送给 AI
       │                                   │
┌──────┴──────┐                    ┌──────▼──────┐
│   沙箱      │ ←────────────────  │  OpenAI     │
│  (隔离执行)  │   5. AI 生成代码   │   API       │
└─────────────┘                    └─────────────┘
```

## API 设计（参考 Screeps）

### 全局对象

```typescript
game: Game;
me: Player;
enemies: Enemy[];
map: GameMap;
utils: Utils;
```

### 基础类型

```typescript
interface Position {
  x: number;
  y: number;
}

interface GameObject {
  id: string;
  x: number;
  y: number;
  exists: boolean;
}

type ResultCode = 0 | -1 | -2 | -3 | -4 | -5;
// 0 = 成功, -1 = 不是所有者, -2 = 不在范围内, -3 = 无效目标
// -4 = 能量不足, -5 = 忙

type TileType = "empty" | "obstacle" | "resource";
```

### 单位

```typescript
type UnitType = "worker" | "soldier" | "scout";
type UnitState = "idle" | "moving" | "attacking" | "gathering";

interface Unit extends GameObject {
  type: UnitType;
  hp: number;
  maxHp: number;
  state: UnitState;
  my: boolean;
  attackRange: number;  // worker=0, soldier=1, scout=0

  moveTo(target: Position | GameObject): ResultCode;
  attack(target: Unit | Building): ResultCode;  // 检查 attackRange
  holdPosition(): ResultCode;
}
```

**单位属性表**:

| 类型 | HP | 速度 | 攻击 | 造价 | 攻击范围 |
|-----|----|------|-----|------|---------|
| worker | 50 | 1 | 5 | 50 | 0 (不能攻击，只能采集) |
| soldier | 100 | 1 | 15 | 80 | 1 (近战) |
| scout | 30 | 2 | 5 | 30 | 0 (不能攻击) |

### 建筑

```typescript
type BuildingType = "hq" | "generator" | "barracks";

interface Building extends GameObject {
  type: BuildingType;
  hp: number;
  maxHp: number;
  my: boolean;

  spawnUnit(type: UnitType): ResultCode;
}
```

### 玩家（我方）

```typescript
interface Player {
  units: Unit[];
  buildings: Building[];
  resources: Resources;

  hq: Building | null;
  workers: Unit[];
  soldiers: Unit[];
  scouts: Unit[];

  getUnitsByType(type: UnitType): Unit[];
  getUnitsInRange(pos: Position, range: number): Unit[];
  getIdleUnits(): Unit[];
}

interface Resources {
  energy: number;
  energyPerTick: number;
}
```

### 地图和工具

```typescript
interface GameMap {
  width: number;
  height: number;
  getTile(x: number, y: number): TileType;
}

interface Utils {
  findPath(from: Position, to: Position): Position[];
  findClosestByPath(from: Position, targets: Position[]): Position | null;
  findClosestByRange(from: Position, targets: Position[]): Position | null;
  getRange(a: Position, b: Position): number;
  inRange(a: Position, b: Position, range: number): boolean;
}
```

## 前端布局

```
┌─────────────────────────────────────────────────┐
│  LLMCraft MVP               [实时/回放] 切换     │
├──────────────────────┬──────────────────────────┤
│                      │  AI 1 (红方)             │
│      地图 Canvas      │  └─ 最新代码输出        │
│      (20×20 格子)     │                          │
│                      │  AI 2 (蓝方)             │
│                      │  └─ 最新代码输出        │
├──────────────────────┴──────────────────────────┤
│  日志: [单位移动] [单位攻击] ...                │
└─────────────────────────────────────────────────┘
```

回放模式增加：进度条、暂停/播放、速度控制。

## AI 沙箱设计

- AI 在 System Prompt 中收到 TypeScript 类型定义
- AI 生成 TypeScript/JavaScript 代码片段
- 代码在 `isolated-vm` 中执行，超时限制 50ms
- 无网络/文件系统访问权限
- 只能访问注入的 API 对象

## AI 代码示例

```typescript
// 移动所有士兵到中间
me.soldiers.forEach(s => s.moveTo({x: 10, y: 10}));

// 有能量就生产士兵
if (me.resources.energy > 150) {
  const barracks = me.buildings.find(b => b.type === "barracks");
  if (barracks) barracks.spawnUnit("soldier");
}

// 空闲士兵攻击最近敌人
const idleSoldiers = me.soldiers.filter(s => s.state === "idle");
idleSoldiers.forEach(s => {
  const nearestEnemy = utils.findClosestByRange(s, enemies);
  if (nearestEnemy && utils.inRange(s, nearestEnemy, 3)) {
    s.attack(nearestEnemy);
  } else if (nearestEnemy) {
    s.moveTo(nearestEnemy);
  }
});
```
# 文档状态说明

> 这是历史方案文档，不代表当前已实现规则。
> 当前有效规则与接口以 [current-mvp-reality.md](/E:/Projects/llm_craft/docs/current-mvp-reality.md) 和 [ai-api-contract.md](/E:/Projects/llm_craft/docs/ai-api-contract.md) 为准。
