# CLI Action Control Plane — Implementation TODO

*Last updated: 2026-05-10 (Phase 7 complete)*

## Legend

- ✅ Done
- 🚧 In progress
- ❌ Not started

---

## Phase 1: 后端控制入口 ✅

- [x] 增加 control session 类型，绑定 `gameId`、`playerId`
- [x] HTTP endpoint: 创建或绑定 session (`POST /api/control/sessions`)
- [x] HTTP endpoint: 调用 tool (`POST /sessions/:id/tools/:toolName`)
- [x] HTTP endpoint: 查询当前 state (`GET /sessions/:id/state`)
- [x] HTTP endpoint: 等待 ticks (`POST /sessions/:id/wait`)
- [x] 将 `GameAgentBridge` 作为 session 级对象维护
- [x] 包装 `executeAgentTool` 结果为统一 control response
- [ ] 基础测试：session 绑定 player
- [ ] 基础测试：`move_unit` 通过 HTTP queue command
- [ ] 基础测试：`get_my_units` 返回当前单位
- [ ] 基础测试：错误 tool name 返回稳定错误

**已创建/修改的文件：**

| 文件 | 行数 | 状态 |
|------|------|------|
| `packages/server/src/ControlHandler.ts` | 123 | ✅ `ControlSessionManager` + `executeControlTool()` + `buildControlResponse()` + `waitTicks()` |
| `packages/server/src/index.ts` | 1003 | ✅ 4 个控制路由已注册（create / state / tool / wait）|
| `packages/shared/src/types.ts` | 527 | ✅ `ControlSession`、`ControlResponse`、`ControlError`、`ControlWarning`、`CreateControlSessionRequest`、`ControlToolCallRequest`、`ControlWaitRequest`

---

## Phase 2: CLI 基础骨架 ✅

- [x] 新增 `packages/cli`
- [x] 支持 `--base-url`、`--session`、`--player`、`--json`
- [x] 实现 `session use/show`
- [x] 统一 stdout JSON、stderr 错误和 exit code
- [x] 实现 stdin JSON 读取工具
- [x] 根 workspace 纳入 build/typecheck（`packages/*` 自动覆盖）

**已创建的文件：**

| 文件 | 行数 | 状态 |
|------|------|------|
| `packages/cli/package.json` | 19 | ✅ 含 scripts: dev / build / typecheck |
| `packages/cli/tsconfig.json` | 9 | ✅ |
| `packages/cli/src/index.ts` | 211 | ✅ 参数解析、help、`session use` + `session show` |
| `packages/cli/src/client.ts` | 61 | ✅ ControlClient HTTP 封装 |
| `packages/cli/src/session.ts` | 51 | ✅ 本地 session 持久化 |
| `packages/cli/src/io/errors.ts` | 12 | ✅ 退出码枚举 |
| `packages/cli/src/io/json.ts` | 7 | ✅ JSON 输出 |
| `packages/cli/src/io/stdin.ts` | 43 | ✅ stdin JSON 解析 |

---

## Phase 3: 读状态和选择器 ✅

- [x] 实现 `state` 命令（支持 `--compact` / `--ascii` / `--cells`）
- [x] 实现 `map` 命令（`state --compact` 的别名）
- [x] 实现 `me` 命令
- [x] 实现 `events` 命令（`--limit n`）
- [x] 实现 `plans` 命令
- [x] 实现 `units` 命令 + `--type` / `--idle` / `--planned` / `--unplanned` / `--near x,y` / `--limit n`
- [x] 实现 `buildings` 命令 + `--ready` + 同上过滤
- [x] 实现 `enemies` 命令 + 同上过滤
- [x] 实现 `resources` 命令 + 同上过滤
- [x] 输出 `kind=selection`

**已创建的文件：**

| 文件 | 行数 | 状态 |
|------|------|------|
| `packages/cli/src/commands/state.ts` | 122 | ✅ state / map / me / events / plans |
| `packages/cli/src/commands/select.ts` | 230 | ✅ units / buildings / enemies / resources 带本地过滤 |

**设计决策：**
- 过滤跑在 CLI 本地（Cebyshev 距离），后端保持简单
- `buildings --ready` 通过 `get_my_state` 的 `productionQueues` 判断
- `enemies` 合并 `get_map_state` 中的敌方单位+建筑为一个列表
| `packages/cli/src/index.ts` | 246 | ✅ 新增 9 个命令路由 + 更新帮助文本 |

验收命令：
```bash
llmcraft units --type worker --idle
llmcraft enemies --type hq
llmcraft resources --near 5,5 --limit 2
```

---

## Phase 4: 原子动作命令 ✅

- [x] 实现 `move`
- [x] 实现 `attack`
- [x] 实现 `attack-move`
- [x] 实现 `gather`
- [x] 实现 `build barracks`
- [x] 实现 `train worker/soldier`
- [x] 实现 `hold`
- [x] 每个动作支持参数输入和 stdin selection 输入
- [x] 每个动作透传后端 `warning` 和 `hint`

验收命令：
```bash
llmcraft units --idle --type worker | llmcraft gather
llmcraft move --unit worker_1 --to 5,8
llmcraft train worker --building hq_1
```

**已创建/修改的文件：**

| 文件 | 行数 | 状态 |
|------|------|------|
| `packages/cli/src/commands/actions.ts` | 305 | ✅ move / attack / attack-move / gather / build / train / hold |
| `packages/cli/src/index.ts` | 319 | ✅ 新增 7 个动作命令路由 + 帮助更新 |

---

## Phase 5: 管道转换器 ✅

- [x] 实现 `nearest resource`
- [x] 实现 `nearest enemy`
- [x] 实现 `target enemy-hq`
- [x] 实现 `target weakest`
- [x] transformation schema（selection → pairing）

验收命令：
```bash
llmcraft units --idle --type worker | llmcraft nearest resource | llmcraft gather
llmcraft units --type soldier | llmcraft target enemy-hq | llmcraft attack
```

**已创建/修改的文件：**

| 文件 | 行数 | 状态 |
|------|------|------|
| `packages/cli/src/commands/transform.ts` | 184 | ✅ nearest resource/enemy + target enemy-hq/weakest |
| `packages/cli/src/index.ts` | 326 | ✅ 新增 2 个转换器命令路由 + 帮助更新 |

---

## Phase 6: Plan 和 Orchestrate ✅

- [x] 实现 `plan economy`
- [x] 实现 `plan defend`
- [x] 实现 `plan attack-hq`
- [x] 实现 `plan custom --file`
- [x] 实现 `orchestrate` 消费 plan
- [x] 实现 `orchestrate` 消费 actions batch
- [x] 支持 `--dry-run`
- [x] 支持 `--max-actions`

---

**已创建/修改的文件：**

| 文件 | 行数 | 状态 |
|------|------|------|
| `packages/cli/src/commands/plan.ts` | 193 | ✅ plan (economy/defend/attack-hq/custom) + orchestrate |
| `packages/cli/src/index.ts` | 335 | ✅ 新增 2 个 plan/orchestrate 命令路由 + 帮助更新 |

---

## Phase 7: 等待、脚本化和文档 ✅

- [x] 实现 `wait --ticks n`
- [x] 增加 `examples/cli-bots/basic-economy.sh`
- [x] 增加 `examples/cli-bots/rush.sh`
- [x] 编写 CLI 使用文档 (内嵌在 help text 中)
- [x] 更新 `docs/current-mvp-reality.md`
- [x] 按需更新 `docs/ai-api-contract.md`

验收：完整脚本可以靠 CLI 玩完整局：
```bash
while true; do
  llmcraft units --idle --type worker | llmcraft gather
  llmcraft buildings --type barracks --ready | llmcraft train soldier
  llmcraft units --type soldier --unplanned | llmcraft target enemy-hq | llmcraft attack
  llmcraft wait --ticks 5
done
```

**已创建/修改的文件：**

| 文件 | 行数 | 状态 |
|------|------|------|
| `packages/cli/src/commands/wait.ts` | 23 | ✅ wait --ticks n |
| `examples/cli-bots/basic-economy.sh` | 56 | ✅ 经济自动化 shell 脚本 |
| `examples/cli-bots/rush.sh` | 70 | ✅ 激进 rush shell 脚本 |
| `packages/cli/src/index.ts` | 341 | ✅ 新增 wait 路由 + 帮助更新 |
| `docs/current-mvp-reality.md` | — | ✅ 新增 CLI 控制面章节 |
| `docs/ai-api-contract.md` | — | ✅ 新增 Control Plane HTTP API 章节 |
