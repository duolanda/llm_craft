# LLMCraft 当前 MVP 现状说明

日期: 2026-07-16

这份文档只描述当前代码真实行为，不描述理想设计。

## 1. 当前系统边界

- 前端: React + Vite + React Three Fiber / Three.js 3D 战场
- 后端: Node.js + TypeScript
- 游戏 Tick: `500ms`
- live 与 CLI/control-plane 的模拟墙钟由 `MatchRuntime` 持有；`Game.start()` 只切换规则生命周期状态，不再创建 `setInterval`。Agent/plan 调度循环仍在现有 orchestrator/control-plane 中，后续阶段再迁入统一 runtime scheduler
- 实际 live tick 由 `MatchRuntime` 触发一个同步事务：先在 tick 边界应用现有命令队列，再调用 `SimulationCore.step(WorldState)`。Core 直接编排 movement → projectiles → economy → harvest orders → combat → construction → production → victory，不再反向调用 `Game.processXPhase()`，也不读取墙钟、不做 I/O、不调用模型
- 对局事务在推进前建立轻量 checkpoint；命令或任一模拟系统抛错都会恢复完整 tick 前状态、记录 `tick_error` 并 fail-stop 外部 clock，不会把部分成功的世界作为正常快照继续推进
- Movement、Projectile、Economy、HarvestOrder、Combat、Construction、Production 和 Victory 已从 Game 的内联规则中提取为只操作 WorldState 的独立 simulation systems，并由 SimulationCore 直接组合。经济、施工、生产和胜负返回可序列化 outcome；Game 保留旧命令解释和实时 UI/AI feedback 日志 adapter，权威命令事实由 CommandGateway / DomainEvent 承载
- Phase 2 的命令边界已接入真实运行路径：LLM live 动作、Mission/plan 推进和 CLI/control-plane 动作都通过 MatchRuntime 专属 `CommandGateway` 提交 v1 `CommandEnvelope`。Gateway 整批校验、按 `clientRequestId` 幂等去重，并在 `applyAtTick` 按 actor/sequence/request ID 稳定排序；Game 会在 tick 内为每个 envelope 建 checkpoint，任一命令失败就恢复该 envelope 前的世界/controller 状态，其他 envelope 可继续。单个 envelope 超过本 tick 剩余路径预算时整批拒绝，不再跨 tick 部分延期。直接 `Game.queueCommand()` 只保留给旧测试入口
- `MatchDefinition v2.rules.commandBudget` 显式保存每 actor 每 tick `100` 条总命令和全局每 tick `4` 条路径命令；Gateway、Game 和 Trace manifest 使用同一份值。旧 v1 definition 固定按历史默认值读取。总命令预算按 actor/apply tick跨 envelope 累计；路径需求先等额保底，未使用额度按 simulation tick 轮换借出。旧 `Game.queueCommand()` 兼容队列不属于正式多 controller 公平入口
- MatchRuntime 已将 Gateway 接纳/拒绝/回滚、每个已执行命令的结构化结果，以及 SimulationCore 原生 outcome 追加为同一条 `DomainEvent` v1 流。对局专属 MatchJournal 分配单调 `eventSequence` 并写入 NDJSON，实时内存只保留最近 `500` 条；完整 command submission 另以单调 submission sequence 保存，因此连被拒绝的输入也不必从日志文案反推
- `MatchTraceRecordV3` 共享类型与服务端运行时 validator 已落地。活跃 journal 具有含完整 MatchDefinition/seed/capabilities/status 的 manifest，并从 tick 0 开始为每个已提交 tick 写 state hash v2；hash 纳入 RNG 游标但排除 UI/AI log。AI turn 和 terminal event 仍在同一对局 journal 目录内
- SimulationCore 抛错会 rollback 并产生 `simulation_tick_failed`；如果世界状态已经提交、随后 journal 写入失败，则 MatchRuntime 以 `committed: true` fail-stop，且不会把它误报为模拟回滚
- `saveRecord()` 已输出正式 `.trace.json.gz`：它固定 journal/Game cut，以 64 KiB gzip chunk 流式组装事实流与派生 replay projection，`fsync` 后原子 rename；失败临时文件会清理，相同 cut 的并发保存会去重。远程 Replay、本地上传、Diagnostics、Analyzer 和 compact 工具同时兼容旧 JSON 与新 gzip Trace
- `MatchRecorder` 已把 Trace v3 保存从 `GameOrchestrator` 提取为任意 MatchRuntime 可复用的边界；live 与 CLI/control-plane 现在使用同一套一致 cut、并发去重和原子 finalizer。`MatchRegistry` 统一保存 live、control 和 benchmark round 的稳定身份，服务端不再用 `state.orchestrator/state.controlMatch` 表示唯一对局；多个 match 可以并存，WebSocket 只展示当前 observed match，切换观察不会停止其他 match
- control session 绑定具体 `matchId`，而不是隐式全局对局。HTTP/CLI 可以列出注册对局、切换 Web UI 观察对象、停止指定对局和保存指定对局/session 的 Trace v3；benchmark round 在结束后仍保留为可独立查询和保存的 registry entry。主 Web UI 的“对局观察”面板也可以列出 registry entry 并切换 observed match；它只改变 WebSocket 投影，不会停止、暂停或重定向其他对局，也不提供 CPU-vs-CPU 产品入口
- 活跃 journal 使用进程 owner / 单局 workspace 两级目录，并带 owner PID、主机、matchId 和状态元数据；相同 matchId 不再覆盖旧证据。终局保存前先停止并等待 controller/CPU/transcript 写入安静，正式 Trace 原子落盘后删除 workspace；删除后 terminal history 的显式分页会从正式 Trace 读取，不要求把完整历史重新常驻内存。registry 每秒收尾自然结束的 match，优雅关闭会 stop+save 全部需要保留的对局；benchmark `recordReplay=false` 会 quiesce 后直接 discard journal
- 启动扫描会跳过仍存活的 owner，将失活 owner 和超过五分钟宽限期的旧版无 owner journal 隔离到 `logs/orphan-journals` 并写 recovery provenance。统一 retention 服务按组限制最大年龄、条目数和容量；正式 artifact 默认只预览，`storage cleanup --apply` 才删除，orphan 恢复区自动治理。版本化 `data/retention-pins.json`、文件 `.keep` 和目录 `.llmcraft-keep` 都可保护固定样本
- Game 内仍生成实时 UI/AI feedback 兼容日志，但正式 replay projection 的 `commandResults` 已由 DomainEvent projector 派生。Analyzer 对 Trace 直接统计命令事件；Transcript Viewer 可打开服务端/本地 Trace 并关联 AI turn、tools、commands 和 DomainEvents，旧文本只作兼容导入。model/tool span 仍为 partial，Viewer 会明确显示能力缺口
- 首版 `WorldState` 已聚合 tick、单位/建筑 registry、资源、玩家经济、弹丸和胜负状态。`Player.units/buildings` 改为从 registry 即时组成的投影，不再由 `Game.refreshPlayerCollections()` 维护第二份实体集合；资源余量、权威 tile 和 tile projection 通过同一更新方法同步。日志、snapshot、controller 和墙钟仍明确留在 WorldState 外。统一实体 registry、移除权威实体中的表现字段以及版本化 observation/client projection 仍待后续 Phase 1/2 完成
- `Unit` / `Building` 已移除 `my` 字段；阵营关系统一由实体 `playerId` 与当前观察者在 Agent/client projection 中派生，回放和开发展示状态也不再伪造该布尔值。WorldState 内部单位现在保存权威 `order`，Player/GameState 投影才生成客户端与 AI 兼容的 `intent`；投影还复制 path、production/construction progress 等嵌套值，观察者不再持有可修改世界的实体引用
- WorldState 维护单调 `revision`；同 tick 的命令处理也会增加 revision。GameAgentBridge 的轻量观察缓存按 revision 而不是仅按 tick 失效，修复了过去依赖可变引用而掩盖的 same-tick stale read；计划推进和 target action 还会主动刷新观察
- Unit 与 Building 仍各自保留适合领域系统的数据结构，并共同实现轻量 `GameObject` 位置/存在性接口；没有引入传统深继承。`WorldState.entities` 统一负责跨类型 ID 解析、所有权校验、创建/销毁、存活过滤和每 tick 不变量；Manager 只保留内部存储 hook，正式运行路径不再直接创建或删除实体
- 对局开局输入已收敛到不可变 `MatchDefinition v2`：显式包含 ruleset/scenario、seed、tick 间隔、地图、玩家、胜利条件和命令/路径预算。seed 初始化 WorldState 专属 `mulberry32-v1` 随机流，RNG 状态可序列化、回滚并纳入权威 hash；当前仍只允许 `default-v1` / `default-144x96-v1` 场景几何
- 两个正式 LLM Controller 默认按模拟时间每 `5 tick` 获得一轮配对宏观决策机会；上一轮任一方仍在运行时不会只给快模型开启下一轮。非 LLM test controller 或显式不同 interval 的 benchmark 继续使用独立调度。该策略限制快模型获得额外 turn 的数量优势，但同一轮内先返回的命令仍会先进入后续 tick，尚未实现同步结果屏障
- AI 决策方式: OpenAI-compatible tool calling agent runtime
- Phase 3A 已完成 Controller 与模型会话边界：`GameOrchestrator` 只调度 `Controller`，LLM、CLI、human 和确定性 test driver 分别使用独立 adapter。内建 CPU 不再实现 `LLMProvider / AgentSession / testConnection / subagent`；OpenAI SDK、base URL、供应商参数和响应归一化位于无状态 `OpenAICompatibleModelTransport`，RPM 限流按每次内部 completion 生效
- `GameAgentBridge` 已拆出 revision-aware `ObservationProjection`、`MissionRuntime` 和 `AgentPolicy`，所有写入仍经过对局专属 `CommandGateway`。Mission 可在没有后续模型请求时跨 tick 执行；直接工具、Mission、持续攻击的 tactical 命令、外部控制和子 Agent 都带结构化 provenance
- 主 Agent 内部模型请求会写入 `metrics.modelRequestRecords`：包含成功/失败、显式重试链、实际 messages v1 快照及 SHA-256、finish reason、latency 和 token 分类。工具 span 记录 turn/controller/model-request、起止时间、observation/result tick、结果字节和 command IDs；运行失败也会写 AI turn，不再只留文本错误
- 子 Agent 默认每玩家最多同时 2 个，活跃任务的 unit/building lease 不可重叠；worker 的每次工具调用都会校验 lease，并使用 `subagent:<taskId>` controller 身份保留 parent controller/turn 归属
- AgentSession 已启用确定性 `MemoryPolicy v1`：持久会话历史默认最多 `80` 条消息 / `1 MiB`，单条最多 `32 KiB`。旧历史按完整 user 对话段移除，不会制造孤立 tool result；过大的旧观察替换为带原大小和 observed tick 的 tombstone。每轮 `metrics.memory` 记录压缩前后消息数、字节数、删除数和截断数。该边界只治理模型上下文，不修改 WorldState 或删除 Trace 事实
- 旧的 `AISandbox + Node vm + 生成 JavaScript` 链路已移除
- 模型配置来源: 服务端预设库（磁盘加密存储）
- live match 与 benchmark 现在共用同一套 runtime 外壳

## 2. 当前可见信息与工具结构

当前 AI 已不再使用也不再保留 `AIPromptPayload(full/delta)` 旧链路。

每次被唤醒时，模型只会收到：

- 从当前 `MatchDefinition` 与 `playerId` 生成的阵营相对 `system prompt`；双方分别看到镜像的我方/敌方 HQ 和敌方推进目标。建筑工地与 worker 站位不再写死在 prompt，必须采用当前 `get_my_state` 返回的成对 `suggestedSites`
- 持续对话历史
- 当前 `AgentRunInput`

当我方 HQ 已处于敌方攻击范围内时，`summary` 会额外插入固定警告：

- `Alert: our HQ is under attack.`

模型通过工具读取局面：

- `get_map_state`: 全图战场信息；默认返回结构化单位、建筑和资源列表，不再返回 ASCII 小地图或迷雾兼容字段，需要逐格地形时才请求 `cells`
- `get_my_state`: 我方经济、HQ、建筑、生产能力
- `get_my_units`: 我方可直接控制单位，并按 `role + intent` 返回 `groups` 聚合，帮助直接看见 hold/idle 的战斗部队
- `get_army_summary`: 我方/敌方兵种比例、ready/reloading 战斗单位数量、局部集结规模与 assembly point，以及非强制的混编/阵型建议
- `get_active_plans`: 当前高层计划
- `get_recent_events`: 近期 AI-facing 反馈

只读工具结果都会带当前 `tick`。其中 `get_my_units` 返回 `{ tick, groups, units }`，`get_army_summary` 返回 `{ tick, myCounts, enemyCounts, combatUnits, readyCombatUnits, reloadingCombatUnits, recommendedFormation, recommendations }`，`get_active_plans` 返回 `{ tick, plans }`，`get_recent_events` 返回 `{ tick, events }`。

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

`attack` 是暴露给 agent 的标准 RTS 点目标攻击命令，也是存在明确敌方目标 ID 时的默认战斗命令：agent 只传己方单位 ID 和敌方目标 ID。目标仍存在时，系统会移动到射程内并持续攻击；目标已死亡但曾被看见过时，系统会移动到目标最后已知位置，避免失败后反复重读局势。攻击敌方 HQ、barracks、war_factory、refinery 或关键敌军时，应优先使用 `attack`，不要用坐标移动命令代替。

`attack_move_unit` 是暴露给 agent 的无目标区域推进命令：有攻击能力的单位会向目标点移动并在到达前自动攻击路上的角色匹配目标。默认目标优先级按单位类型分流：`rifleman` 优先清火箭/步兵，`rocket_soldier` 优先打 `light_tank`，`light_tank` 优先打敌方装甲和反装甲支援，其后才拆生产建筑/HQ/精炼厂。到达目标点后该命令结束，不会持续自动攻击后续靠近或新生产的敌方单位。它只用于没有明确 `targetId` 时穿越危险区域或试探接敌；点杀关键敌军或拆建筑应使用 `attack`。

`attack_move_group` 支持 `line`、`column`、`wedge`、`dispersed`、`battle_line`。`battle_line` 是角色化编队：light_tank 前排，soldier/rifleman 居中掩护，rocket_soldier 后排输出。它只是目的地分配和默认 target priority，不会强制 AI 攒兵或固定战术。

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

当旧 record 缺少 `aiTurns` 但 metadata 显示双方是模型玩家时，`analyze-record` 会明确标记 `agent: unavailable (record has no aiTurns...)`，不再把缺失日志误读成模型请求数为 `0` 或 CPU 对局。新对局中，agent run 只要已经返回结果，会先写入 AI turn journal，再处理胜负后的 early return，避免最后一轮打出胜负时丢失模型/tool 调用记录。

Benchmark 支持配置并发数，服务端会同时运行最多 `concurrency` 局 LLM vs CPU 对局；默认并发为 `1`，前端限制为 `1-10`。主画面会自动观战一局活跃 benchmark round，并在该 round 结束后切到剩余活跃 round 中编号最小的一局；前端状态条会显示当前画面对应的 round 和活跃 round 列表。最终结果按 round 编号排序，进度消息按实际完成顺序更新。

## 5. 当前 MVP 规则

- 当前规则已集中在 shared 默认 ruleset（`DEFAULT_RULESET`）中；`UNIT_STATS` / `BUILDING_STATS` 仍保留为兼容导出，但服务端核心创建、成本、生产关系和攻击能力判断开始通过 ruleset helper 读取。
- 建筑包含 `hq`、`barracks`、`war_factory`、`refinery`
- 单位包含 `worker`、`soldier`、`rifleman`、`rocket_soldier`、`light_tank`
- `hq` 生产 `worker`
- `barracks` 生产 `soldier`、`rifleman`、`rocket_soldier`
- `war_factory` 生产 `light_tank`
- `worker` 可建造 `barracks`、`war_factory`、`refinery`；`war_factory` 需要己方已有一个已完成 `barracks`
- 建造不是瞬间完成：开始施工时扣除 credits 并创建占地建筑，施工中建筑可被攻击、会阻挡寻路，但不能生产、不能作为科技前置，也不会满足 plan 的 `building_exists`
- 建造要求 worker 位于目标建筑完整 footprint 的相邻 1 格内；施工期间该 worker 进入 `building` 状态并被占用，不能移动、采矿或接收其他命令
- 默认施工时间：`barracks` 12 ticks、`war_factory` 18 ticks、`refinery` 16 ticks
- 当前 OpenRA-lite 武器模型：攻击不再是命令执行即扣血，而是开火生成 projectile；projectile 按飞行时间抵达后由 warhead 结算伤害。单位有 reload：`soldier` 3 ticks、`rifleman` 2 ticks、`rocket_soldier` 8 ticks、`light_tank` 6 ticks。
- 当前移动/碰撞模型：地图、建筑、资源和寻路仍使用格子坐标；单位权威坐标允许为连续数值。A* 仍以最近格作为路径节点，但移动沿路径按速度推进，并在 tick 后做单位半径分离；轻坦半径大于步兵，避免多个坦克视觉上叠在同一点。到达、采矿和 plan `arrived` 判断使用近似位置/最近格，不再依赖 `x === tile.x`。
- 当前单位数值：`soldier` 115 HP / 10 damage / range 1 / cost 55；`rifleman` 95 HP / 9 damage / range 6 / cost 70；`rocket_soldier` 80 HP / 34 damage / range 6 / cost 110；`light_tank` 420 HP / 42 damage / range 5 / cost 240。
- 当前 armor / 伤害倍率：单位 armor 为 `infantry` 或 `vehicle`，建筑 armor 为 `structure`。`soldier` 对 infantry 1x、vehicle 0.25x、structure 0.35x；`rifleman` 对 infantry 1.45x、vehicle 0.25x、structure 0.35x；`rocket_soldier` 对 infantry 0.35x、vehicle 2.25x、structure 0.9x；`light_tank` 对 infantry 0.8x、vehicle 1x、structure 0.9x。伤害结算四舍五入为整数。
- `rocket_soldier` 和 `light_tank` 的 projectile 有 1 格 splash，默认 falloff 分别为 35% / 50%。这让单位扎堆会吃亏，坦克前排、步兵掩护、火箭后排的阵型更有实际收益。
- 内置 CPU benchmark 策略会先把 builder 移动到建筑 footprint 邻格，再依次建立 barracks、refinery 和 war_factory；施工中的建筑不会被当作已完成产能。rush 策略会为下一座科技建筑预留 credits，再用剩余资源生产部队；有敌方 vehicle 时优先从 barracks 生产 `rocket_soldier`，否则优先 `rifleman`，有 war_factory 时生产 `light_tank`。前线矿工根据己方 refinery 附近仍有储量的资源点动态分配，不再依赖固定数组索引。
- Phase 3 增强 agent 决策脚手架：`get_my_state.techStatus` 汇总己方 worker / rifleman / rocket_soldier / light_tank / barracks / war_factory 数量、敌方 `war_factory` / `light_tank` 迹象，并给出推荐建造和生产项；`orchestrate_plan` 可用 `enemy_building_exists` / `enemy_unit_count_at_least` 表达看到敌方科技后触发反制生产。
- Phase 4 增强角色化目标选择：默认 `attack_move_unit` 和无显式 priority 的 `attack_in_range` 会按攻击者类型选择目标；当前优先级更偏向部队交火：`rocket_soldier` 点敌方 `light_tank`，`light_tank` 优先打装甲/反装甲支援，然后再拆建筑。
- Phase 5 降低计划噪声：计划内生产/建造会先检查 credits，余额不足时等待收入，不再刷 `spawn_insufficient_credits` / `build_insufficient_credits` 日志。
- Phase 6 增强计划预算协调：同 tick 多个 active plan 推进时会按顺序预留生产/建造成本，避免不同计划基于同一份 credits 同时下达超额付费命令。
- Phase 7 增强 active plan 可解释性：计划记录会暴露当前 step、等待原因和最近一次推进尝试，帮助 agent 判断计划是在等钱/等条件还是已经生成命令。
- Phase 7 后续补强计划闭环：命令 provenance 会完整穿过 SimulationCore；确定性的引擎拒绝会把对应 Mission 标记为 failed，`retry` 不再对非法建造无限重发。计划内 `spawn_unit` 只在生产队列为空时发下一单，避免 `until` 尚未满足时提前塞满队列。
- Phase 8 建立 OpenRA 迁移地图基线：默认地图从旧 `21 x 21` 扩大到 `37 x 25`。后续进一步扩大到 `144 x 96`，双方 HQ 固定在 `(14,48)` / `(129,48)`，资源点和中心障碍改为适合长距离推进、侧翼机动和大军团观战的布局。
- Phase 9 增强资源分配：省略坐标调用 `start_harvest_loop` 时会倾向选择较近且较少 worker 占用的资源点；`get_my_state.economyStatus` 会暴露 worker / activeHarvester / idleWorker 数量、携带中的 credits、资源点分配和经济建议。
- Phase 10 增强移动目标预约：寻路会把其他单位的当前格和已预约 `pathTarget` 都视为占用；多个单位同 tick 移动或 attack-move 到同一目标时，后续单位会自动解析到附近可达格，降低大地图集群推进时的同格拥堵。
- Phase 19 重做单位战斗交互：引入 weapon/projectile/reload/splash，`GameState.projectiles` 向前端同步实时弹丸；客户端优先渲染 active projectiles，旧录像没有该字段时仍可回放。新增 `get_army_summary` 和 `attack_move_group` 的 `battle_line` 编队，给 AI 表达步坦协同的工具，但不强制 AI 攒兵或按脚本行动。
- Phase 4 首轮观赏性实验曾加入固定阶段和自动主力/侧翼分组，但该方案会把引擎的局势摘要越界为策略决策，已撤销。当前运行时不再提供 `operationPlan`、固定分兵阈值或预选侧翼目标；后续应先建立中性战场事实与由 LLM 自主声明的开放战略意图。
- Phase 20 收敛 AI 读工具和表现层：`get_map_state` 移除 `fogOfWar`、`visibleTileCount`、`asciiMap`，默认只返回结构化单位/建筑/资源；`get_my_state` 的推荐项携带可直接调用工具的 `workerId` / `buildingId`；`get_my_units` 增加 `groups` 聚合。客户端对单位位置按服务器 tick 周期做时间插值；服务端单位坐标改为连续坐标 + 半径分离，降低大军团推进时的顿挫和坦克叠放感。
- Phase 21 调整 3D 资源、默认地图和动作表现：资源 tile 在客户端渲染为更大的多晶簇矿脉；默认地图暂不生成任何 obstacle 岩石，只保留 `obstacle` 语义和渲染能力供后续地图设计使用。资源点移出 HQ / 生产建筑夹缝和中央主攻路线，改为基地外侧矿场与上下侧翼矿场。新增 `/?showcase=animation-lab` 本地动画调试入口，用固定 worker / 步兵 / 坦克样例单独观察采矿、交付、行走和攻击动作；worker 工作状态不再做高频上下跳动，单位移动插值增加缓入缓出和静止 deadzone。
- Phase 22 建立 Animation Lab 预览架构和开发入口：`/?showcase=animation-lab` 是单一固定调试场景，包含原有 worker / infantry / tank 动作样例，并追加 rifleman / rocket soldier / tank 三组固定面对面靶场。左下角 `implemented` / `preview` tab 只切换同一批元素的表现层：前者展示当前已实装 projectile / combat feedback，后者用于单独验证尚未接入正式战场的候选弹药美术表现；普通命中不再做独立爆炸圆环、烟尘或火花碎片，避免喧宾夺主。开发环境右上角新增下移后的折叠式 `DEV` 快捷导航，保留 Live、Mass Battle、Animation Lab、FX Preview、Diagnostics 和 Transcript；Mass Battle 页面左下角提供 High Detail / Mass LOD 切换面板。
- Phase 23 将 Animation Lab 验证后的弹药表现接入正式战场：`CombatEffects` 对服务器同步的 `ActiveProjectile` 使用连续本地时间分数插值，避免弹丸按服务器 tick 一格一格跳动；正式弹药表现改为飞行体 + 曳光/烟尾 + 枪口闪，并删除旧的命中大圈 / impact mesh。`/?showcase=animation-lab` 的 implemented tab 继续展示正式渲染路径，preview tab 仍作为下一轮未确认美术表现的隔离验证入口。
- Phase 13 启用 3D 战场表现层：前端主战术视口从 2D Canvas 网格切换为 React Three Fiber / Three.js；HQ、兵营、工厂、工人、步兵、火箭兵、轻坦、资源和障碍加载 `packages/client/public/assets/models/battlefield/*.glb`。这些 GLB 由本机 Blender 后台脚本生成，运行时通过 `team_primary` / `team_accent` 材质名替换红蓝队色。底层仍保留离散战术坐标供 AI、寻路、攻击范围、回放和控制面使用，但前端默认不显示格线或坐标轴。
- Phase 14 将首版几何占位资产替换为可复现的生产资产管线：步兵以 Quaternius CC0 `Animated Men` 人体网格为基础追加原创军装、护甲、武器和工程装备，轻坦基于 Quaternius CC0 `Animated Tanks` 重制材质和附加装甲；HQ 扩大为约 `7.2 x 6.5` 世界单位的指挥中心，并重制兵营和战车工厂。Blender 导出模型嵌入程序生成的 Albedo / Normal / Roughness 贴图，地面和道路也使用重复 PBR 纹理。
- Phase 14 同时加入军团 LOD 和实例运动：单位总数达到 `100` 时自动切换为单网格、单材质的 mass-battle GLB；高细节版本仍用于小规模/近景。单位、矿石和岩石均通过 `InstancedMesh` 合批，移动步兵以 30 Hz 更新实例矩阵形成错相步态起伏。开发地址 `/?showcase=mass-battle` 可在没有服务端对局状态时独立生成 `80 vs 80` 压力场景，`&units=<每方数量>` 可用于资产审查。
- Phase 15 增加客户端战斗表现层：轻坦由 Blender 分别导出车体和炮塔的详细版/LOD GLB，运行时车体保持移动朝向、炮塔独立追踪 `targetId`；`lastAttackTick` 驱动实例化后坐、弹丸、枪口焰和命中闪光，单位或建筑从状态中消失时生成短生命周期的实例化爆炸与碎片。该层只消费权威游戏状态，不修改服务器战斗规则。默认 `80 vs 80` 展示场景实测约 `24.3` 万三角形、`144` 次 draw call，应用内诊断为 `60 FPS`。
- Phase 16 将视觉验收顺序改为画质优先：`/?showcase=mass-battle` 默认使用 `20 vs 20` 高细节 GLB、完整 PBR 材质和单位阴影，单材质 mass-battle LOD 仅在显式传入 `&lod=mass` 时启用。地表替换为 Poly Haven CC0 `Aerial Grass Rock` 2K PBR，临时十字道路和默认意图线已移除，展示模式使用全屏战场、紧凑交战编队和较低战术镜头；`&units=<每方数量>` 仍可用于逐级扩军验收。
- Phase 17 修正坦克坐标契约并重做模型本体辨识：Blender 导出将 Tank 4 全部零件重定位到炮塔座圈中心，运行时按源模型 `-X` 前向轴增加 `90°` 校准，因此车体与炮塔可分别正确朝向移动/攻击目标。远景兵种图标已完全删除；普通步兵保持轻型突击步枪轮廓，`rifleman` 视觉改为配备长重机枪、弹药箱、两脚架和大型弹药背包的机枪兵，火箭筒兵改为肩扛大型发射管并携带两枚备用火箭，工人使用黄色工程护甲。服装与兵种主护甲保留中性、深色、沙色和工程黄色差异，同时约 30% 的头盔、肩甲、背包外壳、发射器环带和载具装甲使用连续队色区域；低透明度地环仅作选中反馈，不承担阵营识别。`/?showcase=mass-battle&view=far` 用于无图标远景辨识验收。
- Phase 18 重建四类生产建筑的一级轮廓：HQ 使用分层指挥要塞、雷达阵列和双侧防御塔；兵营使用 U 形双营房、开放集结院、武器架和训练靶；战车工厂使用无外墙双装配工位、车体轨道、吊装炮塔和出车坡道；精炼厂使用发光晶矿卸料坑、斜向输送带、棱角破碎塔和方形储矿仓，并移除油罐、火炬塔等油气设施语汇。建筑继续共享工业 PBR 与阵营材质，但不再依赖屋顶颜色区分功能。
- 开局每方 `1 HQ + 4 Worker + 800 credits`
- 胜负条件是摧毁敌方所有建筑；HQ 被摧毁但仍有 barracks / war_factory / refinery 时不会立刻失败
- 当前地图 `144 x 96`
- 当前没有战争迷雾读取层：`get_map_state`、`get_my_state.techStatus.enemy` 和 active plan 的 enemy 条件使用全图真实状态，且不再返回 ASCII 小地图。单位自动索敌仍受各自 `visionRange` 限制；等侦察兵、雷达和 last-seen 系统完整后再重新评估迷雾。
- `worker` 自动采矿，回最近已完成 HQ 或 refinery 交付；资源点有有限储量
- `barracks`、`war_factory` 和 `refinery` 不能紧贴己方 `HQ`
- idle/hold 的有攻击力单位被敌方单位攻击时，会在射程内自动还击攻击者

## 6. CLI 控制面

新增 `@llmcraft/cli` 包，提供 shell 可调用的游戏动作控制面。外部调用者（脚本、LLM agent、benchmark harness）可以通过 HTTP 控制玩家行动，无需理解项目内部 TypeScript API。agent-facing 命令是构建后的 `llmcraft`；`pnpm cli -- ...` 仅作为开发调试入口。shared 包现在按 Node ESM 运行时规则声明 `"type": "module"`，内部导入导出使用 `.js` 后缀，确保 CLI 通过 workspace 包加载 `@llmcraft/shared` 时能正常取得 ruleset helper 和常量导出。

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

服务端可以同时保留多个 live/control/benchmark match。session 的 `gameId` 就是稳定 `matchId`；不传 `--game` 时绑定当前 observed 或最近的 control match，但需要精确控制时应显式传入。选择 Web UI 观察对象只是改变网络投影目标，不会暂停或终止其他对局。

### 会话管理

- `llmcraft play --vs random|rush` — 创建 `player_1 vs CPU player_2` 对局，并自动加入 `player_1`
- `llmcraft play --mode pvp` — 创建等待两个 control session 加入的 PVP 对局
- `llmcraft session use --player player_1` — 创建或绑定控制会话
- `llmcraft session show` — 查看当前会话信息
- `llmcraft matches list` — 列出 live/control/benchmark match 及状态、tick、赢家和 observed 标记
- `llmcraft matches observe --game <matchId>` — 切换 Web UI 当前观察的 match
- `llmcraft matches stop --game <matchId>` — quiesce、停止并保存指定 match，不影响其他 match
- `llmcraft record save [--game <matchId>]` — 保存指定 match；省略 `--game` 时使用本地 session 绑定的 match

stdin selection/pairing 展开的多动作以及 `orchestrate` 的 `kind=actions` 输入通过一个 HTTP batch 请求和一个 CommandEnvelope 提交。可用 `--request-id <id>` 提供稳定幂等键；相同 ID 与相同动作重试不会再次执行，同一 ID 改变动作会明确拒绝。

### 读状态命令

- `state [--compact] [--cells]` — 全图 + 玩家状态
- `map [--ascii]` — ASCII 战场地图
- `me` — 经济、HQ、建筑、产能
- `events [--limit n]` — 近期事件
- `plans` — 活跃计划

`state --compact` 会返回 `winner`，方便 agent 快速判断对局是否结束。PVP lobby 在双方都创建 control session 前不会 tick；等待期间读命令仍可用，但 selector、transformer、action、plan、orchestrate 会返回 `game_not_started`，避免先加入的一方提前排队动作。对局结束后，`state` / `map` / `me` / `events` / `plans` 仍可读取；selector、transformer、action、plan、orchestrate 会直接返回 `game_over` 和赢家，不再继续执行无意义管道。

### 选择器命令

- `units [--type w|s] [--idle] [--planned|--unplanned] [--near x,y] [--limit n]`
- `buildings [--type hq|barracks|war_factory|refinery] [--ready] [--near x,y] [--limit n]`
- `enemies [--type w|s|rifleman|rocket_soldier|light_tank|hq|barracks|war_factory|refinery] [--near x,y] [--limit n]`
- `resources [--near x,y] [--limit n]`

### 动作命令

- `move --unit <id> --to x,y`
- `attack --unit <id> --target <id>`
- `attack-move --unit <id> --to x,y [--priority soldier,rifleman,rocket_soldier,light_tank,worker,hq,barracks,war_factory,refinery]`
- `gather --unit <id> [--resource x,y]`
- `build barracks|war_factory|refinery --unit <id> --at x,y`
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

- WebSocket 每 `100ms` 检查一次状态，但只在对局实例、tick 或 `liveEnabled` 变化时发送。正式投影为 v1 keyframe/delta，带 frame sequence、simulation tick/time、tick interval 和 server time；单连接 backlog 达 `1 MB` 时暂停追加，排空后从上一已发帧合并到最新 delta
- Live 与 Replay 共用 `@llmcraft/trace` exact state projector 和有界 `SimulationFrameBuffer`。R3F 单位位置按 simulation time 插值并直接写 instance matrix；旧 `useFrame -> setDisplayUnits(全量数组)` 路径已删除。record 保存 tick interval，Replay 播放与统计时间不再写死 500ms
- `@llmcraft/trace` 内置 Analysis v1 metric registry 与独立 Detector registry；经济、动态兵种/建筑数量与资源价值、Agent latency/token/tool/command/Mission 指标从 record 的 tick interval、ruleset 和结构化 facts 生成。每个结果带 metric version 与原始 `sourcePaths`，Detector 只在声明的 ruleset 上运行。`analyze:record` 的 human/JSON/CSV 共用该解释，保留 timeline/snapshot，并支持目录批处理与 `--compare <baseline>`
- 原 Transcript Viewer 已收敛为 Match Explorer：直接展示 Trace 中的真实 messages v1、每次内部模型请求的成功/错误/重试、latency、finish reason、token/cache、tools、commands、DomainEvents 和 Diagnostics，且可跳转主 Replay 的对应 tick；compact-v2 历史记录仍能结构化读取已有 `aiTurns`，旧文本 transcript 只保留兼容导入
- 2026-07-16 浏览器基线（1280×720、DPR 2、每方 200 单位）：Mass LOD 约 `120 FPS / 39 draw calls / 732,436 triangles`，同规模 High Detail 约 `118 FPS / 137 draw calls / 2,720,504 triangles`；LOD 将 draw calls 和 triangles 各降低约 72% / 73%。该浏览器运行时不暴露 JS heap 指标，长时内存增长仍需在带 memory instrumentation 的性能环境中单独验收
- Benchmark 现由通用 `ExperimentRunner` 调度 seed 和换边配对、重复、并发与失败恢复。指定 experimentId 时每局结果与完整 round payload 原子持久，后续运行校验 Manifest、跳过已完成 trial 并重建完整汇总；结果显示胜率 Wilson 95% CI、方位偏差和中位/P90 时长，通用 summary 还聚合 model latency/token/cost
- replay delta 在 tick 当场写入 MatchJournal NDJSON，随后释放 Game 内兼容历史缓存；完整快照只保留初始和最新两个。最终 `saveRecord()` 把固定 cut 以 64 KiB gzip chunk 流式 finalize 为 `.trace.json.gz`，长局不需要把完整 delta/fact 历史常驻堆内存
- 当前 `summary` 仍是服务端拼装的轻量文本，不是严格结构化状态摘要
- 当前 tool-calling provider 基于 OpenAI-compatible chat completions 工具调用
- 当前 plan 推进是 orchestrator 轮询驱动，实际执行相对 tick 有一个轻微的观察/入队延迟
