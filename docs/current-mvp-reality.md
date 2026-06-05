# LLMCraft 当前 MVP 现状说明

日期: 2026-06-05

这份文档只描述当前代码真实行为，不描述理想设计。

## 1. 当前系统边界

- 前端: React + Vite + Canvas
- 后端: Node.js + TypeScript
- 游戏 Tick: `500ms`
- AI 唤醒频率: 默认每 `5 tick` 触发一次
- AI 决策方式: OpenAI-compatible tool calling agent runtime
- 旧的 `AISandbox + Node vm + 生成 JavaScript` 链路已移除
- 模型配置来源: 服务端预设库（磁盘加密存储）
- live match 与 benchmark 现在共用同一套 runtime 外壳

## 2. 当前可见信息与工具结构

当前 AI 已不再使用也不再保留 `AIPromptPayload(full/delta)` 旧链路。

每次被唤醒时，模型只会收到：

- 固定 `system prompt`
- 持续对话历史
- 当前 `AgentRunInput`

当我方 HQ 已处于敌方攻击范围内时，`summary` 会额外插入固定警告：

- `Alert: our HQ is under attack.`

模型通过工具读取局面：

- `get_map_state`: 全图可见战场信息；默认返回无坐标轴 ASCII 小地图、单位列表和建筑列表，需要逐格地形时才请求 `cells`
- `get_my_state`: 我方经济、HQ、建筑、生产能力
- `get_my_units`: 我方可直接控制单位
- `get_active_plans`: 当前高层计划
- `get_recent_events`: 近期 AI-facing 反馈

只读工具结果都会带当前 `tick`。其中 `get_my_units` 返回 `{ tick, units }`，`get_active_plans` 返回 `{ tick, plans }`，`get_recent_events` 返回 `{ tick, events }`。

同一个长 run 中，新的同名同参数读取会把旧读取结果折叠为 `expired: true` tombstone；assistant 思考文本和动作工具结果保留。这个机制用于避免旧地图、旧单位表和旧 recent events 在上下文中长期污染后续判断。

模型通过工具改变局面：

- `move_unit`
- `attack`
- `attack_move_unit`
- `spawn_unit`
- `build_structure`
- `start_harvest_loop`
- `hold_unit`
- `orchestrate_plan`

动作/计划工具会先做明显无效请求的即时校验；单位、建筑或敌方目标不存在时通常返回 `ok: false` 和 `hint`，不会入队。`attack` 是例外：如果目标曾被看见但当前已不存在，会自动降级为移动到目标最后已知位置。所有动作/计划结果都会带当前 `tick`，如果本轮没有读取过局势或最后一次读取已超过 10 ticks，会额外返回 stale warning，但 warning 本身不阻止命令入队。

`start_harvest_loop` 是暴露给 agent 的内建 worker 采矿循环；常规采矿不需要再用 `orchestrate_plan` 手写资源点和 HQ 之间的往返路线。

`attack` 是暴露给 agent 的标准 RTS 点目标攻击命令，也是存在明确敌方目标 ID 时的默认战斗命令：agent 只传己方单位 ID 和敌方目标 ID。目标仍存在时，系统会移动到射程内并持续攻击；目标已死亡但曾被看见过时，系统会移动到目标最后已知位置，避免失败后反复重读局势。攻击敌方 HQ、barracks、war_factory 或关键敌军时，应优先使用 `attack`，不要用坐标移动命令代替。

`attack_move_unit` 是暴露给 agent 的无目标区域推进命令：有攻击能力的单位会向目标点移动并在到达前自动攻击路上的角色匹配目标。默认目标优先级按单位类型分流：`rifleman` 优先清步兵，`rocket_soldier` 优先打 `light_tank` / `war_factory`，`light_tank` 优先打 `hq` / `war_factory` / `barracks`。到达目标点后该命令结束，不会持续自动攻击后续靠近或新生产的敌方单位。它只用于没有明确 `targetId` 时穿越危险区域或试探接敌；拆 HQ、拆 barracks、拆 war_factory、点杀敌军应使用 `attack`。

单位有一层自卫保底：当有攻击力的单位被敌方单位攻击后，如果它仍然存活、处于 idle/hold、没有正在执行的移动路径，且攻击者在自身射程内，会自动还击攻击者。这个机制只处理单位自身被打后的反击；HQ / barracks / war_factory 不会触发周围单位自动护卫，也不会替代 `attack` / `attack_move_unit` 的主动作战决策。

## 3. 当前高层计划能力

`orchestrate_plan` 采用扁平 steps 列表，且只支持 `{ call, args, scope, when, until, retry }` 形态：把已有动作工具调用注册成后续 tick 自动推进的持续计划。

当前支持：

- 顺序执行
- `loop = -1` 无限循环
- call steps: `move_unit`、`attack_move_unit`、`attack`、`spawn_unit`、`build_structure`、`start_harvest_loop`、`hold_unit`
- step / plan `scope`: `per_unit` 对 `unitIds` 中每个单位展开，`global` 只执行一次
- call step 的 `when` / `until`: `arrived`、`enemy_in_range`、`hq_in_range`、`near_position`、`target_in_range`、`target_destroyed`、`credits_at_least`、`building_exists`、`enemy_building_exists`、`unit_count_at_least`、`enemy_unit_count_at_least`、`production_queue_empty`
- `spawn_unit` 在 plan 中可用 `buildingId: "$hq"`、`"$barracks"` 或 `"$war_factory"` 延迟解析当前友方建筑
- plan 中的 `spawn_unit` / `build_structure` 会在当前 credits 不足时等待，不再每 tick 入队必然失败的生产/建造命令
- 同一 tick 内多个 active plan 共享预算；较早推进出的付费生产/建造命令会预留 credits，后续 plan 余额不足时等待，避免多个 plan 同时花掉同一笔钱
- `get_active_plans` 会返回 `currentStep`、`waitingReason` 和 `lastAttempt`，用于区分计划是在等条件、等预算、刚刚生成命令、已推进 step，还是失败

即时动作会打断同一单位的当前计划。

## 4. 当前记录机制

回放与 transcript 现在记录的是 agent 行为，不是 JavaScript 代码。

当前 `aiTurns` 会保存：

- `runInput.summary`
- assistant 文本
- tool calls
- 注册的 plans
- 本轮入队的 commands
- stop reason
- metrics

当前 transcript 会保存：

- summary
- assistant text
- tool calls
- commands
- plans
- metrics

服务端提供 `pnpm --filter @llmcraft/server analyze:record <record.json> [--debug <llm-debug.log>]`，用于离线统计回放里的囤钱、worker 过量、生产瓶颈、战斗命令噪声和 HQ 受击时机；传入 debug log 时还会补充工具调用分布和粗略 token 体量。

Benchmark 支持配置并发数，服务端会同时运行最多 `concurrency` 局 LLM vs CPU 对局；默认并发为 `1`，前端限制为 `1-10`。主画面会自动观战一局活跃 benchmark round，并在该 round 结束后切到剩余活跃 round 中编号最小的一局；前端状态条会显示当前画面对应的 round 和活跃 round 列表。最终结果按 round 编号排序，进度消息按实际完成顺序更新。

## 5. 当前 MVP 规则

- 当前规则已集中在 shared 默认 ruleset（`DEFAULT_RULESET`）中；`UNIT_STATS` / `BUILDING_STATS` 仍保留为兼容导出，但服务端核心创建、成本、生产关系和攻击能力判断开始通过 ruleset helper 读取。
- 建筑包含 `hq`、`barracks`、`war_factory`
- 单位包含 `worker`、`soldier`、`rifleman`、`rocket_soldier`、`light_tank`
- `hq` 生产 `worker`
- `barracks` 生产 `soldier`、`rifleman`、`rocket_soldier`
- `war_factory` 生产 `light_tank`
- 当前 OpenRA-lite 战斗数值（Phase 11 大地图尺度）：`soldier` 100 HP / 12 attack / range 1 / cost 80；`rifleman` 90 HP / 14 attack / range 3 / cost 90；`rocket_soldier` 80 HP / 24 attack / range 4 / cost 140；`light_tank` 300 HP / 30 attack / range 3 / cost 300。
- Phase 2 引入轻量 armor / 伤害倍率，Phase 11 按 37x25 地图重调：单位 armor 为 `infantry` 或 `vehicle`，建筑 armor 为 `structure`。`rifleman` 对 infantry 1.2x、vehicle 0.4x、structure 0.55x；`rocket_soldier` 对 infantry 0.45x、vehicle 2x、structure 1x；`light_tank` 对 infantry 0.7x、vehicle 1x、structure 1.2x。伤害结算四舍五入为整数。
- Phase 11 同步提高建筑耐久：`hq` 1400 HP、`barracks` 420 HP、`war_factory` 650 HP；单个 `light_tank` 拆 HQ 约需 39 tick，四个 `rocket_soldier` 拆 HQ 约需 15 tick，给 37x25 地图上的侦察、回防和反制留下反应窗口。
- 内置 CPU benchmark 策略已开始使用新角色：有敌方 vehicle 时优先从 barracks 生产 `rocket_soldier`，否则优先 `rifleman`；有 war_factory 时生产 `light_tank`；rush 策略会在有 barracks 和足够 credits 后尝试建 `war_factory`。
- Phase 3 增强 agent 决策脚手架：`get_my_state.techStatus` 汇总己方 worker / rifleman / rocket_soldier / light_tank / barracks / war_factory 数量、敌方 `war_factory` / `light_tank` 迹象，并给出推荐建造和生产项；`orchestrate_plan` 可用 `enemy_building_exists` / `enemy_unit_count_at_least` 表达看到敌方科技后触发反制生产。
- Phase 4 增强角色化目标选择：默认 `attack_move_unit` 和无显式 priority 的 `attack_in_range` 会按攻击者类型选择目标；内置 CPU rush 会让 `rocket_soldier` 点敌方 `light_tank`，让 `light_tank` 点敌方 HQ / 生产建筑。
- Phase 5 降低计划噪声：计划内生产/建造会先检查 credits，余额不足时等待收入，不再刷 `spawn_insufficient_credits` / `build_insufficient_credits` 日志。
- Phase 6 增强计划预算协调：同 tick 多个 active plan 推进时会按顺序预留生产/建造成本，避免不同计划基于同一份 credits 同时下达超额付费命令。
- Phase 7 增强 active plan 可解释性：计划记录会暴露当前 step、等待原因和最近一次推进尝试，帮助 agent 判断计划是在等钱/等条件还是已经生成命令。
- Phase 8 建立 OpenRA 迁移地图基线：默认地图从旧 `21 x 21` 扩大到 `37 x 25`，双方 HQ 固定在 `(4,12)` / `(32,12)`，资源点和中心障碍改为更长推进距离下的测试布局。
- Phase 9 增强资源分配：省略坐标调用 `start_harvest_loop` 时会倾向选择较近且较少 worker 占用的资源点；`get_my_state.economyStatus` 会暴露 worker / activeHarvester / idleWorker 数量、携带中的 credits、资源点分配和经济建议。
- Phase 10 增强移动目标预约：寻路会把其他单位的当前格和已预约 `pathTarget` 都视为占用；多个单位同 tick 移动或 attack-move 到同一目标时，后续单位会自动解析到附近可达格，降低大地图集群推进时的同格拥堵。
- Phase 11 重调战斗尺度：射程层级调整为 `soldier` 1、`rifleman` 3、`rocket_soldier` 4、`light_tank` 3；rocket 更专注反装甲，light_tank 保持主力攻坚定位，建筑 HP 提高以避免大地图上少量单位过快结束对局。
- 开局每方 `1 HQ + 2 Worker + 400 credits`
- 胜负条件是摧毁敌方 `HQ`
- 当前地图 `37 x 25`
- 当前没有战争迷雾
- `worker` 自动采矿，回 HQ 周围 1 格自动交付；当前没有资源枯竭、矿量储备或精炼厂链路
- `barracks` 和 `war_factory` 不能紧贴己方 `HQ`
- idle/hold 的有攻击力单位被敌方单位攻击时，会在射程内自动还击攻击者

## 6. CLI 控制面

新增 `@llmcraft/cli` 包，提供 shell 可调用的游戏动作控制面。外部调用者（脚本、LLM agent、benchmark harness）可以通过 HTTP 控制玩家行动，无需理解项目内部 TypeScript API。agent-facing 命令是构建后的 `llmcraft`；`pnpm cli -- ...` 仅作为开发调试入口。

### 架构

```
外部调用者 (shell/script/agent)
  |  llmcraft <command> [flags]
  v
@llmcraft/cli (参数解析、stdin 管道、JSON 输出)
  |  HTTP control API
  v
server ControlSessionManager → ControlPlaneMatch(player bridge) → Game
```

Control session 只是访问令牌；同一 player 的多个 session 共享 match 里的 `GameAgentBridge`，因此 active plans、target memory 和持续 attack orders 不会因重连或多 session 被拆散。`orchestrate_plan` 注册后由 `ControlPlaneMatch` 按 tick 推进并排入游戏命令队列。

### 会话管理

- `llmcraft play --vs random|rush` — 创建 `player_1 vs CPU player_2` 对局，并自动加入 `player_1`
- `llmcraft play --mode pvp` — 创建等待两个 control session 加入的 PVP 对局
- `llmcraft session use --player player_1` — 创建或绑定控制会话
- `llmcraft session show` — 查看当前会话信息

### 读状态命令

- `state [--compact] [--cells]` — 全图 + 玩家状态
- `map [--ascii]` — ASCII 战场地图
- `me` — 经济、HQ、建筑、产能
- `events [--limit n]` — 近期事件
- `plans` — 活跃计划

`state --compact` 会返回 `winner`，方便 agent 快速判断对局是否结束。PVP lobby 在双方都创建 control session 前不会 tick；等待期间读命令仍可用，但 selector、transformer、action、plan、orchestrate 会返回 `game_not_started`，避免先加入的一方提前排队动作。对局结束后，`state` / `map` / `me` / `events` / `plans` 仍可读取；selector、transformer、action、plan、orchestrate 会直接返回 `game_over` 和赢家，不再继续执行无意义管道。

### 选择器命令

- `units [--type w|s] [--idle] [--planned|--unplanned] [--near x,y] [--limit n]`
- `buildings [--type hq|barracks|war_factory] [--ready] [--near x,y] [--limit n]`
- `enemies [--type w|s|rifleman|rocket_soldier|light_tank|hq|barracks|war_factory] [--near x,y] [--limit n]`
- `resources [--near x,y] [--limit n]`

### 动作命令

- `move --unit <id> --to x,y`
- `attack --unit <id> --target <id>`
- `attack-move --unit <id> --to x,y [--priority soldier,rifleman,rocket_soldier,light_tank,worker,hq,barracks,war_factory]`
- `gather --unit <id> [--resource x,y]`
- `build barracks|war_factory --unit <id> --at x,y`
- `train worker|soldier|rifleman|rocket_soldier|light_tank --building <id>`
- `hold --unit <id>`

所有动作命令支持参数输入和 stdin selection 输入（从选择器管道传入）。

### 管道转换器

- `nearest resource` — 为每个单位选择最近资源
- `nearest enemy` — 为每个单位选择最近敌人
- `target enemy-hq` — 配对敌方 HQ
- `target weakest` — 配对最弱敌人

### 计划与编排

- `plan economy|tech|defend|attack-hq|custom --file <path>` — 生成计划 JSON
- `orchestrate [--dry-run] [--max-actions n]` — 执行计划或批量动作

### 示例管道

```bash
llmcraft units --idle --type worker | llmcraft gather
llmcraft buildings --type barracks --ready | llmcraft train soldier
llmcraft units --type soldier | llmcraft target enemy-hq | llmcraft attack
llmcraft plan economy | llmcraft orchestrate
llmcraft plan tech | llmcraft orchestrate
```

完整的 agent 操作手册见 `docs/cli-agent-guide.md`。双 CLI agent 同机对战时必须显式隔离 session：后续命令使用 `--session <id>`，或分别设置 `LLMCRAFT_SESSION`，避免两个 agent 共享并覆盖 `~/.llmcraft/session.json`。

CLI 本身只执行单次读/动作命令，不内置 turn loop，也不要求两轮之间 `sleep`。外部 agent、benchmark harness 或脚本如果需要持续运行，应自行决定下一次读取和行动的调度节奏。

## 7. 当前限制

- 当前仍然是服务端每连接 `100ms` 推一次 `state`
- 当前 `summary` 仍是服务端拼装的轻量文本，不是严格结构化状态摘要
- 当前 tool-calling provider 基于 OpenAI-compatible chat completions 工具调用
- 当前 plan 推进是 orchestrator 轮询驱动，实际执行相对 tick 有一个轻微的观察/入队延迟
