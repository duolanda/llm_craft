# LLMCraft

> Agent vs Agent 即时战略游戏 - LLM 通过工具调用或 CLI 控制面指挥单位对战

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## 简介

LLMCraft 是一个供 LLM 游玩的即时战略游戏。双方 agent 通过工具调用指挥单位移动、攻击、建造和生产，并决出胜负。

目前还处于原型验证阶段，游戏设计也完全没有定型。

## 技术栈

- **前端**: React + TypeScript + Vite + Canvas
- **后端**: Node.js + TypeScript + WebSocket + HTTP control API
- **Agent Runtime**: OpenAI-compatible tool calling
- **CLI**: shell 可调用的 action control plane
- **AI**: OpenAI API 兼容接口
- **Record/Trace**: `@llmcraft/trace` 统一校验、迁移与 Replay 投影
- **包管理**: pnpm workspace

## 快速开始

### 环境要求

- Node.js 22+
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

# 服务器端口 (默认: 3101)
PORT=3101
```

支持任意兼容 OpenAI API 格式的服务（Azure、本地模型、第三方代理等）。

如果不配置 `OPENAI_API_KEY`，则只能查看历史对局回放
此时后端会以“回放模式”启动：

- 实时对局功能不可用
- 仍可读取 `logs/records/` 下的历史记录
- 前端仍可进入“对局回放”并加载服务端记录或本地 JSON

### 运行

```bash
# 同时启动 shared/trace watch + 前后端
pnpm dev

# 访问 http://localhost:3100
# 点击"开始"按钮观看 AI 对战
```

或分开启动：

```bash
# 终端 1 - shared 包增量构建
pnpm dev:shared

# 终端 2 - trace 包增量构建
pnpm dev:trace

# 终端 3 - 后端
pnpm dev:server

# 终端 4 - 前端
pnpm dev:client
```

## CLI 控制面对战

CLI 控制面允许外部 shell agent、脚本或 benchmark harness 直接操控 LLMCraft 对局。它封装了 HTTP control API、session 管理、stdin 管道和 JSON 输出；agent 应优先调用 `llmcraft` 命令，不要自己写 WebSocket 或 raw HTTP 客户端。

### 构建 CLI

```bash
pnpm install
pnpm build:cli

# 查看帮助
./node_modules/.bin/llmcraft --help
```

构建后 agent-facing 命令是 `llmcraft`。`pnpm cli -- ...` 只作为开发期调试入口；需要管道 JSON 时不要用 pnpm script 包装。

```bash
./node_modules/.bin/llmcraft --help
```

### Agent vs CPU

先启动后端：

```bash
pnpm dev:server
```

再创建一局 `player_1` 对 CPU `player_2`：

```bash
llmcraft play --vs random
# 或
llmcraft play --vs rush
```

`play --vs` 会自动创建对局、加入 `player_1`，并把 session 保存到 `~/.llmcraft/session.json`。之后可以直接运行：

```bash
llmcraft state --compact
llmcraft units --idle --type worker | llmcraft gather
llmcraft buildings --type hq --ready | llmcraft train worker
llmcraft units --type soldier | llmcraft target enemy-hq | llmcraft attack
```

### 两个 CLI Agent 对战

启动一个等待双方加入的 PVP 对局：

```bash
llmcraft play --mode pvp
```

分别让两个 agent 加入不同阵营：

```bash
# Agent 1
llmcraft session use --player player_1

# Agent 2
llmcraft session use --player player_2
```

两个 agent 都加入后，游戏 tick 才会开始。

在双方都加入之前，`state` / `map` / `me` / `events` / `plans` 可读，但 selector、transformer、action、plan、orchestrate 会返回 `game_not_started`，避免先加入的一方提前排队动作。

如果你是人类主持人，想让任意两个外部 coding agent 对战，可以按这个流程操作：

1. 你先运行 `pnpm dev:server` 和 `llmcraft play --mode pvp`。
2. 给第一个 agent 说明：先读 `docs/cli-agent-guide.md`，作为 `player_1` 运行 `llmcraft session use --player player_1 --base-url http://localhost:3101`，之后每条命令都显式带自己的 `--session <id>`。
3. 给第二个 agent 同样说明，但使用 `player_2`。
4. 两边都创建 control session 后，对局会自动开始 tick。

如果两个 agent 在同一台机器、同一个用户下运行，不要共享默认 `~/.llmcraft/session.json`。请从 `session use` 的 JSON 输出中取出各自的 `sessionId`，后续命令显式传入：

```bash
# Agent 1 后续每条命令
llmcraft state --session cs_player1
llmcraft units --idle --type worker --session cs_player1 | llmcraft gather --session cs_player1

# Agent 2 后续每条命令
llmcraft state --session cs_player2
llmcraft units --idle --type worker --session cs_player2 | llmcraft gather --session cs_player2
```

或者让两个 agent 分别设置环境变量：

```bash
export LLMCRAFT_SESSION=cs_player1
export LLMCRAFT_SERVER=http://localhost:3101
```

Windows PowerShell：

```powershell
$env:LLMCRAFT_SESSION = "cs_player1"
$env:LLMCRAFT_SERVER = "http://localhost:3101"
```

PowerShell 中坐标参数要加引号，例如 `--at '5,10'`、`--to '18,10'`，避免逗号被 shell 拆成多个参数。

### Agent 最小回合循环

每个 agent 每轮应先读状态，再行动。如果动作结果返回 `warning.type = "state_stale"` 或 `"no_recent_read"`，下一步先重新读取 `state` / `me` / `units`。

```bash
llmcraft state --compact
llmcraft units --idle --type worker | llmcraft gather
llmcraft buildings --type hq --ready | llmcraft train worker
llmcraft units --idle --type worker --limit 1 | llmcraft build barracks --at 5,10
llmcraft buildings --type barracks --ready | llmcraft train soldier
llmcraft units --type soldier | llmcraft target enemy-hq | llmcraft attack
```

CLI 本身不会强制等待或插入 `sleep`；外部 agent 或 benchmark harness 拥有调度循环，下一轮何时读取由调用方决定。

`state --compact` 会返回 `winner`，可用于快速判断对局是否结束；需要完整经济、HQ 和生产信息时使用不带 `--compact` 的 `state`。

服务端可以同时保留多个 live、control 和 benchmark 对局。可按稳定 `matchId` 管理和保存：

```bash
llmcraft matches list
llmcraft matches observe --game match_abc123
llmcraft record save --game match_abc123
llmcraft matches stop --game match_abc123
```

`matches observe` 只切换 Web UI 当前展示的对局，不会停止其他对局，也不会改变既有 CLI session 绑定的 `gameId`。`matches stop` 会等待 controller 安静、停止并保存这一局；`record save` 省略 `--game` 时会使用本地已保存 session 对应的 match。

浏览器顶部的“对局”按钮提供同一个 MatchRegistry 的只读观察选择器；它只切换主战场投影，不负责创建 CPU 对局或改变其他 match 的生命周期。

选择器/配对管道展开出的多动作会通过单个 HTTP batch 和单个 `CommandEnvelope` 提交，在同一 tick 全部应用或整批回滚。自动化重试可传 `--request-id <id>`；相同 ID+动作不会重复执行，同一 ID 改变动作会拒绝。

日志与录像治理默认先预览：`llmcraft storage journals` / `storage recover` 检查异常 journal，`storage inspect` / `storage cleanup` 查看逐 artifact retention 决策；只有追加 `--apply` 才执行恢复或正式文件清理。版本化 pins 和 keep marker 不会被删除。

对局结束后，除 `state` / `map` / `me` / `events` / `plans` 这类读取命令外，selector、transformer、action、plan 和 orchestrate 命令会直接返回 `game_over` 与赢家，避免 agent 继续执行无意义管道。

注意：`attack-move` 是向坐标推进并处理路上敌军的命令，不是拆 HQ 的替代品。攻击 HQ 或 barracks 时使用 `target enemy-hq | attack` 或 `attack --target <buildingId>`。

完整 agent 操作手册见 [docs/cli-agent-guide.md](./docs/cli-agent-guide.md)。

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

### 调试页面入口

启动前后端后，除了主页面外，还有两个独立调试页面：

- `http://localhost:3100/diagnostics.html`：对局诊断页。直接从服务端记录列表选择 `match-*.json`，查看 HQ 压力时间线、防守响应延迟、受压后工具调用、失效单位、出生点陷阱等结构化指标。
- `http://localhost:3100/transcript.html`：模型日志查看页。用于查看 `packages/server/logs/llm-debug/*.log`，拆解每次 LLM 请求看到的上下文、响应、工具调用和执行结果。

这两个页面目前是调试入口，没有放进主界面导航；需要直接访问 URL。

说明：

- 回放是基于 `initialState + tickDeltas + commandResults + aiTurns` 的重建，不是重新跑一遍引擎
- 视觉过程和战局分析是可靠的，但极少数瞬时内部状态不保证 100% 还原

## 记录与调试日志

当前有两种不同的文件输出，职责不同：

- `logs/records/*.trace.json.gz`：当前压缩 Trace v3 对局记录；读取链路仍兼容历史 `*.json`
- `packages/server/logs/llm-debug/*.log`：单局 LLM debug transcript，用于人工排查 prompt / response / 执行结果

benchmark 另有两类独立输出：

- `packages/server/logs/benchmark-records/*.trace.json.gz`：benchmark 每个已完成 round 的压缩回放
- `packages/server/logs/benchmark-llm-debug/*.log`：benchmark 每个已完成 round 的 LLM transcript

### `save_record` 会保存什么

- 点击前端“保存记录”、对局结束后前端自动触发 `save_record`，或运行 `llmcraft record save [--game <matchId>]`
- 服务端会通过统一 `MatchRecorder` 把指定对局的一致 cut 流式写成 gzip Trace v3；live、CLI/control-plane 与 benchmark 不使用不同 record builder
- Trace v3 的 manifest、command submissions、DomainEvents、state hashes 和 AI/terminal 流是事实层；兼容回放所需的 `initialState / finalState / tickDeltas / commandResults / aiTurns` 位于显式派生的 replay projection

### Benchmark 会保存什么

- benchmark round 会注册为独立 match；启动 benchmark 不会自动停止已有 live/control match
- `recordReplay = true` 时，每个已完成 round 会自动写出 1 份回放到 `packages/server/logs/benchmark-records/`
- `recordReplay = false` 时，round 会在 controller quiesce 后丢弃临时 journal，不会被后台生命周期任务偷偷保存
- `debug.recordLLMTranscript = true` 时，每个已完成 round 会额外写出 1 份 transcript 到 `packages/server/logs/benchmark-llm-debug/`
- benchmark 的 `decisionIntervalTicks` 只影响 CPU 一侧；LLM 一侧保持默认 5 tick 调度
- 同一 cut 如果被重复保存，服务端会复用已有文件路径；同一时刻并发保存也会合并为一次写入
- benchmark 文件当前按时间戳命名；在串行执行模型下通常不会冲突，但命名不是强唯一

### `LLM Debug` 会保存什么

- 前端勾选 `LLM Debug` 后，再执行 `start` 或 `reset`
- 该开关只对当前这一局生效
- 服务端会为这局分配一个独立 transcript 路径：`packages/server/logs/llm-debug/match-<timestamp>.log`

当前实现里，debug transcript 不是在点击 `start/reset` 时立刻创建空文件，而是在该局第一次真正写入 transcript 时才创建目录和文件。

### transcript 何时真正落盘

服务端会在以下场景向当前对局的 `.log` 追加一段纯文本：

- 一轮 LLM 请求正常返回，且随后完成工具调用循环
- LLM 已返回，但这时对局已经停止，于是记录“对局已停止，未继续执行”
- `runAI()` 流程抛异常，于是记录调度失败

每一段 transcript 当前会包含：

- 时间、玩家、`mode`、`requestTick`、`executeTick`、模型名
- 完整 request messages
- 原始 response
- assistant messages / tool calls / commands / plans
- provider 错误
- 命令结果
- runtime 错误

### 暂停、重置与文件边界

- `暂停` 不会主动新建文件，也不会强制写一个结束块
- 如果暂停前已经有请求在飞，等它返回后，仍可能向当前 transcript 追加最后一段“对局已停止，未继续执行”
- `重置` 会创建新的 `GameOrchestrator`，因此按当前实现视为新对局，并使用新的 transcript 文件
- 如果某一局在被暂停或重置前从未发生过任何 transcript 写入，那么这局可能不会留下 `.log` 文件

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
3. 双 LLM 默认每 5 ticks 获得一次配对宏观决策机会；通过工具调用或 CLI 控制面产生命令
4. 命令加入队列，在后续 tick 执行
5. Worker 可以建造 Barracks，Barracks 建好后才能生产 Soldier
6. Barracks 不能紧贴己方 HQ 建造，至少要留出 1 格缓冲
7. 一方 HQ 被摧毁则游戏结束

### Agent API

当前主链路是 OpenAI-compatible tool calling runtime。服务端向模型暴露只读工具和动作工具，例如：

- `get_map_state`、`get_my_state`、`get_my_units`、`get_recent_events`
- `move_unit`、`start_harvest_loop`、`build_structure`、`spawn_unit`
- `attack`、`attack_move_unit`、`hold_unit`、`orchestrate_plan`

CLI 控制面复用同一套动作语义，并提供更适合 shell agent 的命令、过滤器和管道。更完整的接口契约见 [docs/ai-api-contract.md](./docs/ai-api-contract.md)，CLI agent 操作手册见 [docs/cli-agent-guide.md](./docs/cli-agent-guide.md)。

## 项目结构

```
llmcraft/
├── packages/
│   ├── shared/          # 共享类型和常量
│   ├── server/          # Node.js 游戏服务器
│   ├── client/          # React 前端
│   └── cli/             # shell action control plane
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
- CLI agent 操作手册见 [docs/cli-agent-guide.md](./docs/cli-agent-guide.md)
- 当前真实 MVP 行为见 [docs/current-mvp-reality.md](./docs/current-mvp-reality.md)
- 当前保存格式为 `.trace.json.gz`：Trace facts 是权威层，`initialState / finalState / tickDeltas / commandResults / aiTurns` 是版本化 replay projection
- 当前前端已支持读取保存记录并做逐 tick 回放
- `docs/plans/` 和较早的设计稿包含历史方案，不一定代表当前实现

## License

MIT
