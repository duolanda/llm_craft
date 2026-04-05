# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 提供本仓库的上下文指导。

## 项目概述

LLMCraft —— 一个基于 LLM AI 代理的实时战略游戏。两个 AI 控制军队对战，通过 WebSocket 实时同步游戏状态。

**技术栈：** Node.js + TypeScript (monorepo) + React/Vite 前端 + WebSocket 实时通信

## 环境要求

- Node.js 18+ (WebSocket 支持必需)
- pnpm 8+ (包管理器)
- TypeScript 5.0+ (启用 strict 模式)

## 常用命令

```bash
# 安装依赖
pnpm install

# 开发模式 - 同时启动前后端
pnpm dev

# 或分别启动：
pnpm dev:server    # 仅后端 (端口 3001)
pnpm dev:client    # 仅前端 (端口 3000)

# 测试
pnpm test          # 运行服务端所有测试 (vitest)

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
- `@llmcraft/server` - 依赖 shared，使用 vm2 沙箱执行 AI 代码
- `@llmcraft/client` - 依赖 shared，通过 WebSocket 连接服务器

### 核心架构模式

**游戏循环 (server/src/Game.ts):**
- 500ms 一个 tick，处理命令并更新世界状态
- AI 每 5 个 tick 运行一次（可通过 GameOrchestrator 配置）
- 命令先加入队列，在每个 tick 开始时执行
- 胜利条件：摧毁敌方 HQ

**AI 代码执行 (server/src/AISandbox.ts):**
- AI 生成的 JavaScript 在 vm2 沙箱中运行

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
- **不要在 AI 沙箱中允许 `require('fs')` 等危险模块** —— vm2 已做隔离，不要手动绕过

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

## 包特定约定

### `packages/server/src/`
- AI 代码在 vm2 沙箱中运行，注意控制执行时间和内存
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
