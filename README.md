# LLMCraft

> Agent vs Agent 即时战略游戏 - 人类编写 Prompt，AI 生成代码来对战

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## 简介

LLMCraft 是一个供 LLM 游玩的即时战略游戏。双方 AI 生成代码来指挥单位移动、攻击、建造和生产，并决出胜负。

目前还处于原型验证阶段，游戏设计也完全没有定型。

## 技术栈

- **前端**: React + TypeScript + Vite + Canvas
- **后端**: Node.js + TypeScript + WebSocket
- **沙箱**: 子进程 + Node `vm`（AI 代码隔离执行）
- **AI**: OpenAI API 兼容接口
- **包管理**: pnpm workspace

## 快速开始

### 环境要求

- Node.js 18+
- pnpm

### 安装

```bash
# 克隆仓库
git clone <repository-url>
cd llmcraft

# 安装依赖
pnpm install

# 配置环境变量
cp packages/server/.env.example packages/server/.env
# 编辑 .env 填入你的 API Key
```

### 配置说明

编辑 `packages/server/.env`:

```env
# 必填: API 密钥
OPENAI_API_KEY=your-api-key

# 可选: 模型名称 (默认: gpt-4o-mini)
OPENAI_MODEL=gpt-4o-mini

# 可选: 自定义 API 地址 (兼容 OpenAI API 格式的服务)
# OPENAI_BASE_URL=https://api.yourservice.com/v1

# 服务器端口 (默认: 3001)
PORT=3001
```

支持任意兼容 OpenAI API 格式的服务（Azure、本地模型、第三方代理等）。

如果不配置 `OPENAI_API_KEY`，则只能查看历史对局回放
此时后端会以“回放模式”启动：

- 实时对局功能不可用
- 仍可读取 `logs/records/` 下的历史记录
- 前端仍可进入“对局回放”并加载服务端记录或本地 JSON

### 运行

```bash
# 同时启动前后端
pnpm dev

# 访问 http://localhost:3000
# 点击"开始"按钮观看 AI 对战
```

或分开启动：

```bash
# 终端 1 - 后端
pnpm dev:server

# 终端 2 - 前端
pnpm dev:client
```

### 测试

```bash
# 运行单元测试
pnpm test
```

### 构建

```bash
# 构建所有包
pnpm build

# 单独构建
pnpm build:shared
pnpm --filter @llmcraft/server build
pnpm --filter @llmcraft/client build
```

## 对局回放

前端已支持基于保存记录的回放。

使用方式：

1. 启动前后端
2. 打开前端页面，切换到“对局回放”
3. 从服务端记录列表选择一份 `match-*.json`，或直接导入本地 JSON
4. 使用播放 / 暂停 / 进度条 / 倍速控制查看过程

当前回放会尽量还原：

- 每个 tick 的单位、建筑、资源和日志变化
- 当时的 AI 输出
- 单位的移动目标点
- 单位的攻击目标或攻击落点

服务端提供的回放接口：

- `GET /api/replay/records`：列出 `logs/records/` 中的记录
- `GET /api/replay/records/:fileName`：读取单个记录 JSON

说明：

- 回放是基于 `initialState + tickDeltas + commandResults + aiTurns` 的重建，不是重新跑一遍引擎
- 视觉过程和战局分析是可靠的，但极少数瞬时内部状态不保证 100% 还原

## 游戏机制

### 地图

- 20×20 格子
- 对称布局的障碍物和资源点

### 单位

| 类型 | HP | 速度 | 攻击 | 造价 | 攻击范围 |
|-----|----|------|-----|------|---------|
| Worker | 50 | 1 | 0 | 50 | 0 (不能攻击) |
| Soldier | 100 | 1 | 15 | 80 | 1 (近战) |

### 建筑

| 类型 | HP | 造价 | 功能 |
|-----|----|------|-----|
| HQ | 1000 | - | 核心建筑，被摧毁则失败 |
| Barracks | 300 | 120 | 生产士兵 |

### 游戏流程

1. 双方各有一个 HQ、2 个 Worker、200 credits
2. 每 500ms 执行一个游戏 tick
3. AI 每 5 ticks 思考一次，生成代码
4. AI 代码在沙箱中执行，产生命令
5. 命令加入队列，在下一 tick 执行
6. Worker 可以建造 Barracks，Barracks 建好后才能生产 Soldier
7. Barracks 不能紧贴己方 HQ 建造，至少要留出 1 格缓冲
8. 一方 HQ 被摧毁则游戏结束

### AI API

AI 可以通过全局对象控制游戏：

```javascript
// 移动单位
me.soldiers.forEach(s => s.moveTo({ x: 17, y: 10 }));

// 建造兵营
if (!me.buildings.find(b => b.type === "barracks") && me.workers[0] && me.resources.credits >= 120) {
  me.workers[0].build("barracks", { x: me.hq.x + 2, y: me.hq.y });
}

// 生产士兵
const barracks = me.buildings.find(b => b.type === "barracks");
if (barracks && me.resources.credits >= 80) {
  barracks.spawnUnit("soldier");
}

// 攻击敌人
const nearestEnemy = utils.findClosestByRange(soldier, enemies);
if (nearestEnemy && utils.inRange(soldier, nearestEnemy, 1)) {
  soldier.attack(nearestEnemy.id);
}

// 或在执行时按优先级自动选择当前射程内目标
soldier.attackInRange(["hq", "soldier", "worker", "barracks"]);
```

补充说明：

- `moveTo({ x, y })` 是意图型移动。如果目标格不可站，系统会自动改到附近最近的可达格
- `attackRange` 当前按 8 邻域计算；`Soldier` 的 `attackRange = 1` 覆盖上下左右和四个斜角相邻格
- `attackInRange([...])` 会在命令真正执行时重新扫描射程内目标，适合减少 AI 回包延迟带来的目标过期
- 最近一轮命令修正或失败原因会通过 `aiFeedbackSinceLastCall` 返回，包含精简的 `code + meta + hint`
- 更完整的 AI 接口契约见 [docs/ai-api-contract.md](./docs/ai-api-contract.md)

## 项目结构

```
llmcraft/
├── packages/
│   ├── shared/          # 共享类型和常量
│   ├── server/          # Node.js 游戏服务器
│   └── client/          # React 前端
├── logs/                # 对局记录与调试日志
├── docs/                # 设计文档
├── package.json         # pnpm workspace 配置
├── pnpm-workspace.yaml  # pnpm workspace 定义
└── README.md            # 本文件
```

## 贡献

欢迎提交 Issue 和 PR！

## 文档说明

- 当前有效的 AI 接口契约见 [docs/ai-api-contract.md](./docs/ai-api-contract.md)
- 当前真实 MVP 行为见 [docs/current-mvp-reality.md](./docs/current-mvp-reality.md)
- 当前保存的对局记录格式为 `initialState / finalState / tickDeltas / commandResults / aiTurns`
- 当前前端已支持读取保存记录并做逐 tick 回放
- `docs/plans/` 和较早的设计稿包含历史方案，不一定代表当前实现

## License

MIT
