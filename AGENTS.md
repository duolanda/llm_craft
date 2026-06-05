# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 提供本仓库的上下文指导。

## 项目概述

LLMCraft —— 一个基于 LLM AI 代理的实时战略游戏。两个 AI 控制军队对战，通过 WebSocket 实时同步游戏状态。

**技术栈：** Node.js + TypeScript (monorepo) + React/Vite 前端 + WebSocket 实时通信

## 环境要求

- Node.js 22+
- pnpm 8+ (包管理器)
- TypeScript 5.9+ (启用 strict 模式)

## 常用命令

```bash
# 安装依赖
pnpm install

# 开发模式 - 同时启动 shared watch + 前后端
pnpm dev

# 或分别启动：
pnpm dev:shared    # shared 包增量构建
pnpm dev:server    # 仅后端 (端口 3001)
pnpm dev:client    # 仅前端 (端口 3000)

# 测试
pnpm test          # 运行服务端所有测试 (vitest)
pnpm typecheck     # 全仓类型检查
pnpm verify        # typecheck + server test + server build + client build

# 构建
pnpm build         # 按依赖顺序构建所有包
pnpm build:shared  # 仅构建 shared 包
```

### 运行单个测试

```bash
# 运行指定测试文件
pnpm --filter @llmcraft/server test -- src/__tests__/Game.test.ts

# 按名称模式运行
pnpm --filter @llmcraft/server test -- --grep "Game"
```

### 分析保存的对局录像

排查 `packages/server/logs/records/*.json` 时，优先使用内置分析脚本，不要先临时手写解析器：

```bash
# 总览：经济、命令、结果、胜负
pnpm --filter @llmcraft/server analyze:record packages/server/logs/records/<record>.json

# 关键时间线：总部压力、掉血、技能、关键命令
pnpm --filter @llmcraft/server analyze:record packages/server/logs/records/<record>.json --timeline

# 指定 tick 快照，适合复盘某次交战
pnpm --filter @llmcraft/server analyze:record packages/server/logs/records/<record>.json --snapshots "54,59,62,82" --focus player_1

# 分析一次性命令/技能释放时机
pnpm --filter @llmcraft/server analyze:record packages/server/logs/records/<record>.json --skill <command_type> --focus player_1
```

当怀疑模型“反应慢”时，先对齐：敌军进入 HQ 5/3/2 格的 tick、HQ 首次掉血 tick、关键技能成功 tick、HQ 死亡 tick。`aiTurns` 为空的旧记录只能反推行为，不能还原模型原文和工具调用链。

## 架构概览

###  monorepo 结构

```
llmcraft/
├── packages/
│   ├── shared/          # 共享类型和常量（需最先构建）
│   ├── server/          # Node.js WebSocket 游戏服务器
│   └── client/          # React + Vite 前端
├── logs/                # 对局记录和调试日志
└── docs/                # 设计文档（ai-api-contract.md 为权威参考）
```

### 包依赖关系

构建顺序：`shared` → (`server`, `client`)

- `@llmcraft/shared` - 无依赖，输出 dist/index.js 和类型定义
- `@llmcraft/server` - 依赖 shared，使用子进程 + Node `vm` 执行 AI 代码
- `@llmcraft/client` - 依赖 shared，通过 WebSocket 连接服务器

### 核心架构模式

**游戏循环 (server/src/Game.ts):**
- 500ms 一个 tick，处理命令并更新世界状态
- AI 每 5 个 tick 运行一次（可通过 GameOrchestrator 配置）
- 命令先加入队列，在每个 tick 开始时执行
- 胜利条件：摧毁敌方 HQ

**AI 代码执行 (server/src/AISandbox.ts):**
- AI 生成的 JavaScript 在独立子进程中的 Node `vm` 上下文运行

**LLM 调用层 (server/src/createLLMProvider.ts):**
- GameOrchestrator 通过 `LLMProvider` 接口请求代码生成
- 当前默认实现是 `OpenAICompatibleProvider`
- 兼容 OpenAI 风格端点的模型接入应优先走 provider 层，而不是直接写进 orchestrator

**Agent turn 与工具调用性能判断:**
- 一个用户/游戏 turn 内连续执行多轮工具调用是标准 agent loop，本身不是问题：模型可一次返回多个 tool calls，本地执行 tool results，再继续下一次模型请求直到收敛。
- 不要仅因为单个 turn 很长或工具调用次数多就判定设计有问题；性能分析应落到 turn 内每一次模型请求的 latency、finish_reason、visible output tokens、reasoning tokens、cache hit tokens，以及是否反复读取同类状态工具导致循环。
- 慢 turn 的重点风险是某些内部模型请求异常变慢、hidden reasoning 膨胀、可见输出为空却打到 max_tokens，或工具选择陷入重复，而不是“一个 turn 里跑了工具”这个事实。

**状态同步 (server/src/GameOrchestrator.ts):**
- 维护 AI 对话窗口（最近 20 条消息）
- 窗口重置时发送 "full" 完整状态，否则发送 "delta" 增量
- 记录所有游戏状态用于保存回放

## 关键文件

| 文件 | 用途 |
|------|------|
| `packages/server/src/index.ts` | WebSocket 服务器入口 |
| `packages/server/src/Game.ts` | 核心游戏逻辑，命令处理 |
| `packages/server/src/GameOrchestrator.ts` | AI 调度和状态打包 |
| `packages/server/src/AISandbox.ts` | AI 代码沙箱执行 |
| `packages/server/src/LLMProvider.ts` | LLM provider 抽象接口 |
| `packages/server/src/OpenAICompatibleProvider.ts` | 当前 OpenAI 兼容实现 |
| `packages/shared/src/types.ts` | 共享 TypeScript 接口 |
| `packages/shared/src/constants.ts` | 游戏常量（HP、造价、地图大小等） |
| `docs/ai-api-contract.md` | AI API 权威文档 |

## 环境配置

服务端需要：

```bash
cp packages/server/.env.example packages/server/.env
# 编辑 .env：
# OPENAI_API_KEY=your-key
# OPENAI_MODEL=gpt-4o-mini (可选)
# OPENAI_BASE_URL=... (可选，用于自定义端点)
```

## 绝对不能做的事 🚫

- **不要将 `.env` 文件提交到 git** —— 已配置 `.gitignore`，但务必确认
- **不要在客户端暴露 OPENAI_API_KEY** —— 只能在 server 包中使用
- **不要直接修改 `shared/src/constants.ts` 中的常量** —— 会影响整个 monorepo，牵一发而动全身
- **不要在 AI 沙箱中开放文件系统、网络或任意模块访问** —— 当前隔离依赖子进程边界和受限 API，禁止手动扩大能力面

## 测试方法

使用 Vitest。关键模式：

```typescript
// Game.test.ts - 游戏逻辑集成测试
const game = new Game();
game.start();
// ... 队列命令，推进 tick，断言状态
```

## 代码风格约定

- 启用 TypeScript strict 模式
- 优先使用显式类型而非 `any`
- 使用 `@llmcraft/shared` 中的常量（UNIT_TYPES, BUILDING_TYPES 等）
- 结果码：OK = 0，错误为负数（定义在 shared/src/constants.ts）
- 只是调整代码时，用 `rg` 搜索应排除历史日志目录：`packages/server/logs/`，例如加 `-g '!packages/server/logs/**'`，避免对局记录污染搜索结果

## 包特定约定

### `packages/server/src/`
- AI 代码在子进程中的 Node `vm` 上下文运行，注意控制执行时间、消息体大小和进程生命周期
- 新增模型接入优先扩展 `LLMProvider`，不要把供应商 SDK 直接耦合进 `GameOrchestrator`
- 游戏状态修改必须在 Game tick 周期内完成，禁止异步修改
- WebSocket 消息按类型路由，新消息类型需在 `types.ts` 中定义

### `packages/client/src/`
- 使用 `useWebSocket` 钩子进行通信，禁止直接调用 fetch
- 游戏渲染使用 Canvas API，避免频繁 React 重渲染
- 状态更新通过 `GameState` 类型约束，不要扩展未定义字段

### `packages/shared/src/`
- **只放类型定义和常量**，禁止放业务逻辑
- 修改后必须重新构建 (`pnpm build:shared`)，否则其他包不会生效

## 文档一致性约定 📋

修改代码后，按需同步更新文档。区分**必须更新**和**可选更新**：

### 🔴 必须更新（核心文档）

| 当你修改了... | 必须同步更新... |
|-------------|---------------|
| `shared/src/types.ts` 或 `shared/src/constants.ts` | `docs/ai-api-contract.md` —— AI API 契约是权威参考 |
| 游戏机制、单位属性、建筑逻辑 | `docs/current-mvp-reality.md` —— 让开发者能够掌握最新现状 |
| 修复 bug 或发现新问题 | `docs/sprint/current-issues.md` —— 问题追踪闭环 |

### ⚪ 无需更新（宏观/临时计划文档）

| 文件 | 说明 |
|-----|------|
| `docs/plans/*.md` | 开发中的临时计划文件 |
| `docs/LLMCraft · 游戏设计文档 v0.1.md` | 早期设计文档，只负责概念设计，与实现不强相关 |
