# LLMCraft MVP 实施计划 (修正版)

> **P9 指令**: 使用 superpowers:subagent-driven-development 模式执行，Task 1-2 可并行，Task 3-7 必须串行，每步代码审查通过后再推进。

**目标**: 构建可运行的 LLMCraft MVP - Agent vs Agent 即时战略游戏

**架构**: Monorepo + TypeScript + Node.js + React + isolated-vm + OpenAI

---

## 修正记录

| 问题 | 原方案 | 修正方案 |
|-----|-------|---------|
| 战斗无范围限制 | `attack()` 无范围检查 | 添加 `attackRange` 属性，超范围返回 `ERR_NOT_IN_RANGE` |
| 沙箱不安全 | 使用 `new Function()` | 使用 `isolated-vm` 进行真正的代码隔离 |
| 依赖顺序风险 | `AIStatePackage` 在共享类型 | 移到 server 内部，由 `AIStatePackageBuilder` 构建 |
| 无测试 | 无任何测试计划 | 每个 Task 包含对应测试 |

---

## Task 1: 项目初始化

**交付物**:
- `package.json` (root)
- `packages/shared/package.json`
- `packages/server/package.json`
- `packages/client/package.json`
- `tsconfig.json`
- `.gitignore`

**验收标准**:
- [ ] `npm install` 成功
- [ ] `mkdir -p packages/shared/src packages/server/src packages/client/src logs`

---

## Task 2: 共享类型定义

**交付物**:
- `packages/shared/tsconfig.json`
- `packages/shared/src/constants.ts`
- `packages/shared/src/types.ts`
- `packages/shared/src/index.ts`

**关键类型**:
```typescript
// 基础
interface Position { x: number; y: number; }
interface GameObject { id: string; x: number; y: number; exists: boolean; }

// 单位 - 添加 attackRange
type UnitType = "worker" | "soldier" | "scout";
interface Unit extends GameObject {
  type: UnitType;
  hp: number; maxHp: number;
  state: "idle" | "moving" | "attacking" | "gathering";
  playerId: string;
  attackRange: number; // 新增: worker=0, soldier=1, scout=0
}

// 建筑
interface Building extends GameObject {
  type: "hq" | "generator" | "barracks";
  hp: number; maxHp: number;
  playerId: string;
  productionQueue: UnitType[];
}

// 游戏状态
interface GameState {
  tick: number;
  players: Player[];
  tiles: Tile[][];
  winner: string | null;
  logs: GameLog[];
}
```

**常量定义**:
- `TICK_INTERVAL_MS = 500`
- `MAP_WIDTH = 20`, `MAP_HEIGHT = 20`
- 单位属性: worker {hp:50, speed:1, attack:5, cost:50, attackRange:0}, soldier {hp:100, speed:1, attack:15, cost:80, attackRange:1}, scout {hp:30, speed:2, attack:5, cost:30, attackRange:0}

**验收标准**:
- [ ] `cd packages/shared && npm run build` 成功
- [ ] 类型导出正确

---

## Task 3: 游戏核心逻辑

**交付物**:
- `packages/server/tsconfig.json`
- `packages/server/src/MapGenerator.ts`
- `packages/server/src/UnitManager.ts`
- `packages/server/src/BuildingManager.ts`
- `packages/server/src/Game.ts`
- `packages/server/src/__tests__/Game.test.ts`

**关键实现**:

### MapGenerator
- 生成 20x20 地图
- 对称障碍物布局 (四角 + 中央)
- 资源点分布在地图边缘

### UnitManager
- `createUnit(type, x, y, playerId)` - 设置正确的 attackRange
- `moveUnit(unit, targetX, targetY)` - 检查移动范围
- `attackUnit(attacker, target)` - **检查 attackRange，超范围返回 ERR_NOT_IN_RANGE**
- `holdPosition(unit)`

### BuildingManager
- `createBuilding(type, x, y, playerId)`
- `spawnUnit(building, unitType)` - 检查建筑类型和成本
- `getEnergyProduction(playerId)`

### Game 类
- 初始化: 2 玩家，各 1 HQ + 2 Worker + 1 Soldier
- 500ms tick 循环
- 命令队列处理 (move, attack, hold, spawn)
- 胜负判断 (HQ 被摧毁)
- 状态快照保存

**攻击范围检查代码**:
```typescript
attackUnit(attacker: Unit, target: Unit): ResultCode {
  if (!attacker.exists || !target.exists) return RESULT_CODES.ERR_INVALID_TARGET;
  if (attacker.playerId === target.playerId) return RESULT_CODES.ERR_INVALID_TARGET;
  
  // 新增: 范围检查
  const distance = Math.sqrt(Math.pow(attacker.x - target.x, 2) + Math.pow(attacker.y - target.y, 2));
  if (distance > attacker.attackRange) return RESULT_CODES.ERR_NOT_IN_RANGE;
  
  target.hp -= UNIT_STATS[attacker.type].attack;
  attacker.state = UNIT_STATES.ATTACKING;
  if (target.hp <= 0) { target.hp = 0; target.exists = false; }
  return RESULT_CODES.OK;
}
```

**单元测试**:
```typescript
// Game.test.ts 必须覆盖:
- 单位创建和属性 (特别是 attackRange)
- 移动命令执行
- 攻击命令执行 (包括范围限制)
- 资源生产和消耗
- 建筑建造和单位生成
- 胜利条件检测
```

**验收标准**:
- [ ] 所有单元测试通过
- [ ] `npm run dev` 服务器启动，游戏初始化无错误

---

## Task 4: AI 沙箱与 OpenAI 集成

**交付物**:
- `packages/server/src/SystemPrompt.ts`
- `packages/server/src/APIBridge.ts`
- `packages/server/src/AISandbox.ts` (使用 isolated-vm)
- `packages/server/src/AIStatePackageBuilder.ts`
- `packages/server/src/OpenAIClient.ts`
- `packages/server/.env.example`

**关键实现**:

### SystemPrompt.ts
- 完整的 TypeScript 类型定义
- 可用 API 列表
- 代码示例
- 明确的指令: "只回复可执行的 JavaScript 代码，不要解释"

### AISandbox (使用 isolated-vm)
```typescript
import ivm from "isolated-vm";

export class AISandbox {
  private isolate: ivm.Isolate;
  private context: ivm.Context;
  
  constructor() {
    this.isolate = new ivm.Isolate({ memoryLimit: 8 });
    this.context = this.isolate.createContextSync();
  }
  
  async executeCode(code: string, api: any): Promise<Command[]> {
    // 使用 isolated-vm 执行，超时 50ms
    // 注入 game, me, enemies, map, utils 到 context
    // 捕获所有命令调用
  }
}
```

### AIStatePackageBuilder
- 从 GameState 构建 AI 可见状态
- 过滤敌方单位 (只返回在视野内的)
- 构建 me/units/buildings 数组

### OpenAIClient
- 封装 OpenAI SDK
- 超时处理
- 代码清洗 (移除 markdown 代码块)

**验收标准**:
- [ ] isolated-vm 正确安装和配置
- [ ] AI 沙箱执行测试通过 (代码隔离，无全局访问)
- [ ] OpenAI API 调用成功 (需配置 API key)

---

## Task 5: WebSocket 服务器

**交付物**:
- `packages/server/src/GameOrchestrator.ts`
- `packages/server/src/index.ts`
- `packages/server/src/__tests__/WebSocket.test.ts`

**关键实现**:

### GameOrchestrator
- 组合 Game + AISandbox + OpenAIClient
- AI 思考间隔: 每 5 ticks 调用一次
- 轮询检查游戏状态

### WebSocket 服务器
- 端口: 3001
- 消息协议:
  - 客户端 -> 服务器: `{ type: "start" }`, `{ type: "stop" }`
  - 服务器 -> 客户端: `{ type: "state", state: GameState, snapshots: GameSnapshot[] }`
- 状态广播: 100ms 间隔

**验收标准**:
- [ ] WebSocket 连接测试通过
- [ ] 状态广播正常
- [ ] 开始/停止命令响应正确

---

## Task 6: React 前端

**交付物**:
- `packages/client/vite.config.ts`
- `packages/client/tsconfig.json`
- `packages/client/index.html`
- `packages/client/src/main.tsx`
- `packages/client/src/App.tsx`
- `packages/client/src/hooks/useWebSocket.ts`
- `packages/client/src/components/GameCanvas.tsx`
- `packages/client/src/components/AIOutputPanel.tsx`
- `packages/client/src/components/GameLog.tsx`

**关键实现**:

### GameCanvas
- Canvas 尺寸: 640x640 (20x20 * 32px)
- 渲染顺序: 地图 -> 建筑 -> 单位
- 颜色: Player1 红色, Player2 蓝色
- 显示血条

### AIOutputPanel
- 显示双方 AI 最新代码输出
- 语法高亮 (可选)

### GameLog
- 显示最近 20 条日志
- 带 tick 编号

**验收标准**:
- [ ] `npm run dev` 客户端启动
- [ ] WebSocket 连接成功
- [ ] 地图渲染正确

---

## Task 7: 集成与测试

**步骤**:
1. 根目录创建 `.env`，填入 OpenAI API key
2. 构建 shared: `npm run build -w @llmcraft/shared`
3. 启动服务器: `cd packages/server && npm run dev`
4. 启动客户端: `cd packages/client && npm run dev`
5. 访问 http://localhost:3000
6. 点击"开始"，观察 AI 对战

**验收标准**:
- [ ] 完整游戏流程可运行
- [ ] 双方 AI 正常生成代码
- [ ] 单位移动/攻击正常
- [ ] 胜负判断正确
- [ ] 回放日志保存到 `logs/` 目录

---

## 依赖关系图

```
Task 1 (初始化)
    │
    ▼
Task 2 (共享类型) ───────────────────┐
    │                                 │
    ▼                                 │
Task 3 (游戏逻辑)                     │
    │                                 │
    ▼                                 │
Task 4 (AI沙箱) ──→ Task 5 (WebSocket) │
                        │             │
                        ▼             │
                   Task 6 (前端) ◄────┘
                        │
                        ▼
                   Task 7 (集成)
```

---

## 执行指令

1. **并行启动**: Task 1 + Task 2
2. **串行执行**: Task 3 → Task 4 → Task 5 → Task 6 → Task 7
3. **每步审查**: P9 审查代码通过后才进入下一步
4. **测试要求**: 每个 Task 的验收标准必须全部打勾

---

## 风险预案

| 风险 | 应对 |
|-----|-----|
| isolated-vm 在 Windows 编译失败 | 降级到 `vm2` 或直接使用 `new Function` + 严格白名单 |
| OpenAI API 延迟高 | 增加超时到 100ms，添加重试逻辑 |
| 前端 Canvas 性能差 | 降级到 DOM 渲染或优化绘制逻辑 |
# 文档状态说明

> 这是历史实现计划文档，不代表当前已实现规则。
> 当前有效规则与接口以 [current-mvp-reality.md](/E:/Projects/llm_craft/docs/current-mvp-reality.md) 和 [ai-api-contract.md](/E:/Projects/llm_craft/docs/ai-api-contract.md) 为准。
