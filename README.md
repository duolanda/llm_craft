# LLMCraft

> Agent vs Agent 实时战略游戏：LLM 通过工具调用或 CLI 控制面指挥单位对战。

LLMCraft 是一个服务端权威的 RTS 原型。两个 Agent 在同一个确定性模拟中采矿、建造、生产和作战，Web 客户端通过 WebSocket 实时观察对局，也可以加载保存的 Match Record 回放。

## 技术栈

- Node.js 22+、TypeScript 5.9 strict、pnpm workspace
- React、Vite、React Three Fiber
- WebSocket 实时投影与 HTTP control API
- OpenAI-compatible tool-calling Agent Runtime
- shell 可调用的 `llmcraft` CLI
- `@llmcraft/record` Match Record 校验、旧 JSON 导入与 replay 投影

## 快速开始

```bash
pnpm install
pnpm dev
```

默认地址：

- Web UI：`http://localhost:3100`
- 服务端：`http://localhost:3101`

### 模型与 API Key 配置

**模型和 API Key 在 Web UI 里配置，不放在 `.env`。** 进入 `http://localhost:3100`，打开设置面板，新建 OpenAI-compatible 模型 preset（填入 name、base URL、model、API key 等），服务端会用内置密钥加密落盘。对局时双方各选一个 preset 即可。

`packages/server/.env` 不再用于模型配置，只有少数可选服务端环境变量（例如 `PORT=3101`）。不要提交 `.env`，也不要把 API key 写进 `.env`。

### 分别启动

```bash
pnpm dev:shared
pnpm dev:record
pnpm dev:server
pnpm dev:client
```

### 验证与构建

```bash
pnpm test
pnpm typecheck
pnpm verify
pnpm build
```

运行单个服务端测试：

```bash
pnpm --filter @llmcraft/server test -- src/__tests__/Game.test.ts
```

## 当前架构

```text
WebSocket / HTTP / CLI
          │
    MatchRegistry ── 选择、查询、停止和保存对局
          │
    MatchRuntime ─── 单局时钟、tick 和结束通知
          │
    CommandGateway ─ 身份、tick、幂等和稳定排序
          │
        Game ─────── 权威 WorldState 和命令解释
          │
   SimulationCore ── 固定顺序执行模拟系统
```

生命周期控制和玩法控制是两个边界：

- `MatchRegistry + MatchRuntime` 创建、预热、开始、停止、查询和选择观察对象。
- `GameplayController` 为 LLM、CLI 和 built-in CPU 提供相同的观察与动作语义。
- `DecisionController` 是由 committed tick 驱动的决策来源；某方仍在运行时只跳过该方，不阻塞另一方。
- 当前没有固定 5 tick 宏观间隔、双方配对轮次、命令预算分配器或 batch 事务回滚。

更完整的现状说明见 [当前实现现状](./docs/current-implementation.md)。

## Monorepo

```text
llmcraft/
├── packages/
│   ├── shared/   # 共享类型、协议、规则与地图常量
│   ├── record/   # Match Record validator/importer/projector
│   ├── server/   # 模拟、Agent、HTTP/WebSocket、benchmark
│   ├── client/   # 实时 3D 战场、回放和诊断
│   └── cli/      # action control plane CLI
├── docs/
└── package.json
```

依赖与构建顺序为 `shared → record → server/client`；CLI 依赖 shared。

## 对局和 Agent

每局默认每 500ms 推进一个 tick。命令在 tick 边界经 `CommandGateway` 进入模拟，每条命令独立执行；同一个 batch 中一条动作失败不会撤销其他成功动作。

当前标准地图为 144×96。standard 规则包含 Worker、Rifleman、Rocket Soldier、Scout Car、Light Tank、Heavy Tank 和 Artillery；建筑包含 HQ、Barracks、War Factory、Refinery、Machine Gun Turret、Anti-Tank Turret 和 Tech Center。`soldier` 仅保留旧录像兼容，新对局不可生产。胜利条件由 `MatchDefinition` 冻结；默认规则要求摧毁敌方全部建筑，单独摧毁 HQ 不会立即结束对局。

科技层级不使用单独研究按钮：完成 War Factory 即进入 T2，解锁三种 T2 车辆与反坦克塔；完成 Tech Center 进入 T3，解锁重坦和火炮。科技中心被毁时，正在生产的 T3 单位会完成，后续受锁订单暂停并在重建后恢复。

Agent 可使用的工具包括：

- 观察：`get_map_state`、`get_my_state`、`get_my_units`、`get_army_summary`、`get_active_plans`、`get_recent_events`
- 动作：移动、攻击、采矿、建造、生产、驻守和多 tick plan

权威工具契约见 [AI API Contract](./docs/ai-api-contract.md)。

## CLI 控制面

外部 agent 通过 `llmcraft` CLI 控制单位，不要让模型直接写 WebSocket 或裸 HTTP 客户端。最常见的 host 流程：

1. 启动服务端，然后开一个 PVP 房间：

   ```bash
   pnpm dev:server
   pnpm build:cli
   ./node_modules/.bin/llmcraft play --mode pvp
   ```

2. 给双方 agent 各发一条指令，只把 `player_1` 换成 `player_2`：

   ```text
   You are player_1 in a LLMCraft CLI match.
   First read docs/cli-agent-guide.md.
   Join with: llmcraft session use --player player_1 --base-url http://localhost:3101
   After joining, copy your sessionId and pass --session <sessionId> on every command.
   Use only llmcraft. Do not write WebSocket or raw HTTP clients.
   ```

CLI session 绑定的 match 与 Web UI 当前观察的 match 相互独立。完整命令、selector、transformer 和 plan 说明见 [CLI Agent Guide](./docs/cli-agent-guide.md)。

## Match Record 与回放

正式对局产物统一称为 Match Record：

- 格式身份：`match-record`
- 文件名：`match-<ISO timestamp>-<short match id>.match.json`
- `replay`：定义、元数据、初末状态和 tick delta
- `evaluation`：在 replay 上增加命令结果、Agent turn、工具和模型请求指标
- `includeTranscript`：仅在 evaluation 中可选保留完整 messages 和 assistant 输出

运行中 delta 在共享 worker thread 中按块压缩留存；终局或显式保存时写一次 JSON。当前没有独立 Trace v3、MatchJournal、DomainEvent 事实流、state hash、journal workspace 或自动 retention 平台。

记录目录：

- Live/control：`packages/server/logs/records/*.match.json`
- Benchmark：`packages/server/logs/benchmark-records/*.match.json`

分析保存的对局：

```bash
pnpm --filter @llmcraft/server analyze:record packages/server/logs/records/<record>.match.json
pnpm --filter @llmcraft/server analyze:record packages/server/logs/records/<record>.match.json --timeline
```

调试页面：

- `http://localhost:3100/diagnostics.html`
- `http://localhost:3100/transcript.html`

transcript 是 evaluation Match Record 的可选内容，不是独立的正式文件格式。

## 文档

当前文档（仓库内）：

- [AGENTS.md](./AGENTS.md)：编码 Agent 的工作上下文与架构概览
- [当前实现现状](./docs/current-implementation.md)：玩法与运行时真实行为
- [AI API Contract](./docs/ai-api-contract.md)：Agent 输入和工具契约
- [CLI Agent Guide](./docs/cli-agent-guide.md)：外部 Agent 的稳定 shell 接口
- [已知问题](./docs/known-issues.md)：仍待处理的问题
- [想法与方向](./docs/ideas.md)：早期对话和后续想法记录

历史资料在 [`docs/archive/`](./docs/archive/)：早期设计稿、重构期 roadmap、ADR、baseline 等，只作历史参考，不代表当前实现。

## License

MIT
