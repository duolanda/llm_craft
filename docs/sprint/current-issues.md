# Sprint - 当前问题清单

> 记录当前 MVP 中仍然存在的真实问题和待改进项

## 高优先级

### 1. 实时对局 tick 存在可观察卡顿
- **描述**: OpenRA 迁移后 live match 中出现 tick 26s 到 27s 实际耗时明显超过 1s、单位移动冻结后跳变的现象；诊断确认主要由 agent read path 反复同步 `game.getState()`、重复 deep clone 完整 state/logs，以及 `get_my_state` 建造点推荐每格重复状态读取放大导致。已增加 backend-only `perf_warning`，并将 agent read path 改为同 tick 共享轻量 read state，待 live 复测确认
- **影响**: 直接破坏实时观战和操控反馈；后续地图和机制继续扩展时，AI hot path 必须避免完整 client/replay state clone

### 2. 长局 OOM 的无界历史与重复状态广播已修复，待实战复测
- **描述**: `Game.snapshots`、AI terminal、AI turns 和 replay delta 的无界内存历史已收口：完整快照只保留初始/最新，delta/facts 逐 tick追加到 MatchJournal 后释放 Game 兼容缓存，终局流式压缩为 `.trace.json.gz`；在线窗口有上限，慢 WebSocket 达到 `1 MB` backlog 后采用 latest-projection-wins，不再持续追加过期全量帧
- **影响**: 自动验收中 1001 tick 的 Game delta 缓存保持为 `0`，正式 Trace 仍完整包含 1001 个 replay delta；此前无 3D 的 50,000 tick 压测也已确认 heap 大幅下降。仍需真实双 LLM 长局观察浏览器 working set、服务端 RSS 和压缩保存耗时

### 3. 大地图后的寻路和状态同步需要复测
- **描述**: 回放快照和 WebSocket 重复推送已完成第一轮收敛，但服务端 A* 和每 tick 全量当前 state 仍会随地图与单位规模增长；agent `asciiMap` 已从 `get_map_state` 默认响应中移除
- **影响**: 大军团单位数上来后，寻路重算、ASCII 地图体积和当前 state 序列化仍可能成为瓶颈，需要用 live match / benchmark / 回放复测确认

### 4. 3D 表现仍缺正式战斗动画和建筑级碰撞代理
- **描述**: Phase 17 已修正坦克炮塔原点/前向轴，删除远景兵种图标，并通过重机枪、弹药背包、肩扛火箭筒、备用火箭和工程护甲重做模型本体辨识；兵种主体保留深色、沙色和工程黄色差异，头盔、肩甲、背包外壳、发射器环带和载具装甲使用约 30% 的连续队色区域，使红蓝阵营在无图标远景下仍可辨认。当前单位已从纯格点占位推进到连续坐标和半径分离，坦克同点叠放问题已有基础修复；剩余差距主要是步兵仍使用实例矩阵模拟移动和射击，没有正式骨骼行走/射击/死亡动画；建筑仍主要按格子 footprint 参与寻路/建造，还没有更细的 3D 碰撞代理。
- **影响**: 静态模型和百单位渲染基础已不再是几何占位物，单位互相重叠有所收敛；战斗观感及建筑周边路径仍未达到最终 RTS 品质，下一阶段应补动画/特效并把建筑碰撞代理、出生点和攻击距离进一步统一

### 5. tool-calling runtime 缺少更细的行为指标下发
- **描述**: 服务端内部已记录 `modelRequests / toolCalls / stallDetected`，但 benchmark 对外消息还没有把这些指标完整暴露到前端
- **影响**: 能做离线分析，但前端实时面板还看不到完整的 agent 行为统计

### 6. `summary` 仍然是字符串拼装
- **描述**: 当前 `summary` 已经取代旧 `full/delta` 主输入，但仍是服务端拼接文本
- **影响**: 可工作，但结构化程度不高，不利于后续精细优化

### 5. 计划推进与 tick 执行之间仍有轻微延迟
- **描述**: 当前计划推进由 orchestrator 轮询观察 tick 后再入队
- **影响**: 相比直接嵌入 tick 前阶段，存在轻微的一 tick 级延迟风险

## 中优先级

### 5. 预设仍缺少 temperature
- **描述**: 当前预设只有 baseURL、model、rpm，没有 temperature
- **影响**: 无法用预设层面调整模型稳定性/随机性

### 6. 查询类工具仍然偏碎，后续需要收敛
- **描述**: 当前只读工具拆成了 `get_map_state / get_my_state / get_my_units / get_army_summary / get_active_plans / get_recent_events`
- **影响**: 对 agent 来说查询入口偏多，后续需要收敛到 `3` 个（查地图、查自己、recent）或 `2` 个（查所有、recent）工具，并主要通过简单参数完成过滤，而不是继续增加新读工具

### 7. 高级编排层仍需验证 LLM 实际使用效果
- **描述**: 两局真实双 LLM Trace 已确认模型会主动使用 `orchestrate_plan`；已修复 global unit step 无法命中 `near_position`、带 retry 的移动重复发路径，以及建造建议缺少 `workerPosition` 的问题。现在需要用修复后的真实对局验证计划能否稳定完成“builder 移动 -> 兵营 -> 第一波进攻”
- **影响**: 表达力与已知执行阻塞都已处理，剩余风险是不同模型是否会稳定采纳结构化建议，以及第一波进攻节奏在镜像实战中的方差

### 8. Benchmark 面板还没消费新 runtime 细节
- **描述**: 服务端内部已有 tool calls / plans / stopReason 等 runtime 细节，但 benchmark 结果面板还未充分展示
- **影响**: 回放已经能看到 tool-driven agent 行为，但 benchmark 视角仍不够完整

### 9. 日志文件名时间戳仍使用 UTC 时间
- **描述**: 当前对局日志/回放等文件名里的时间戳使用 UTC 时间，与本地开发和排查时常用的北京时间不一致
- **影响**: 按文件名定位具体对局时需要额外换算时区，容易和控制台、本地观察时间产生偏差；后续可评估改为北京时间或在文件名中显式标注时区

### 10. 战略表达仍缺少开放且持久的意图层
- **描述**: 首轮观赏性实验中的固定阶段、`7+3/10` 分兵阈值、自动 `mainForce / raidForce` 和预选侧翼目标会把运行时局势摘要越界为隐藏脚本策略，现已撤销。当前 Mission 能执行多步命令，但模型还没有独立于聊天历史、可版本化并可关联多个 Mission 的自由战略意图
- **影响**: 不应继续扩充 rush/raid/multi-front 等策略枚举；下一步需要让系统只提供中性事实，由 LLM 自由声明目标、理由、约束和复审条件，并在 Trace 中记录意图变化

## 已完成 ✅

- [x] 完成 Phase 4 首轮观赏性实战诊断：首局基线在 tick 64–196 对非法兵营位置重试 133 次，随后因未闭合 multi-tool history 持续 provider 400；修复后连续三局浏览器镜像赛均完整自然终局，provider 400 为 0。第二局生产从旧基线的 tick 61–80 集中排 20+ rifleman，收敛为按生产完成逐单补充，并出现 refinery、war_factory、rocket_soldier、light_tank 混合路线。实验中加入的固定 `operationPlan` 虽曾被模型用于终局拆分，但因过度干预战略已撤销，不作为当前能力
- [x] 修复 plan → SimulationCore → command result 的因果链：`Command.provenance` 不再在 normalize 时丢失；确定性 `build_invalid_position` 等失败会终止对应 Mission，而不是被 `retry` 永久重发
- [x] 修复 provider 在多工具调用中途触发 read-only stall 时留下缺失 tool response 的非法历史；未执行的剩余 tool call 现在写入显式 `stall_detected` 结果，下一轮请求仍满足 OpenAI 消息序列约束
- [x] 计划内 `spawn_unit` 增加生产队列空闲门槛，避免 `until=unit_count_at_least` 等待成品期间每 tick 继续预排同质单位
- [x] 基于两局真实双 LLM Trace 完成首轮策略诊断：快节奏一方在 tick 49 完成兵营、持续生产步枪兵并于 tick 227 开始攻击 HQ；慢节奏一方因首个 global builder plan 卡死在 tick 46。由此将策略契约调整为“3 采矿 + 1 builder、约 6 个步枪兵立即施压 HQ、战车工厂放到第一波之后或敌方装甲反制时”，同时明确 HQ 是首要目标、摧毁后仍需清理其余生产建筑
- [x] 完成优化后的第三局真实浏览器镜像复赛：双方都正确采用 3 采矿 + 1 builder、读取 `workerPosition` 并完成兵营与第一波 6 人进攻；红方在 tick 838 开始反攻 HQ、tick 879 摧毁 HQ、tick 957 清完其余建筑获胜。Trace 暴露的下一层策略问题是蓝方首波受挫后把新步兵/坦克逐个送进约 10 个火箭兵集群，因此 attackWindow 改按 12 格内最大局部集群判断，未满 6 人时给出 assemblyPoint 和 regroup 提示；敌方 3+ 火箭兵且步兵掩护不足时停止推荐 light_tank
- [x] 完成最终策略反馈的第四局真实浏览器镜像复赛：双方兵营分别在 tick 49/51 完成；`attack_move_group` 返回 2 个立即下发、4 个跨 tick scheduled 后，模型明确识别 scheduled 并未再逐个覆盖。蓝方形成 2 兵营 + 1 战车工厂的混合产能，tick 625 首次攻击敌方 HQ、tick 712 摧毁并在 tick 713 清完建筑获胜；整局只有 3 次 `command_invalid`，明显低于首场旧实现的 487 次与第二场的 12 次
- [x] 为 `attack_move_group` 的跨 tick 调度补强工具反馈：动作结果解释 `queuedNow / scheduled`，`get_my_units` 暴露 `pendingGroupMoves` 与单位级 `hasPendingGroupMove`；模型不再把路径预算导致的短暂 idle 误判为编队漏下命令
- [x] 修复 MissionRuntime global unit step 不解析具体单位的问题；`near_position / arrived / hq_in_range` 现在可推进显式 unitId 的 global 步骤，retry 移动在已有同类持续命令时不再每 tick 重发
- [x] 将 `get_my_state.techStatus.recommendedStructures[].suggestedSites` 和建造失败反馈升级为建筑中心与 `workerPosition` 成对建议；模型可直接先移动 worker 再建造，不再需要猜测多格 footprint 的相邻站位
- [x] 完成真实入口验收：Web UI 使用 deepseek-v4-flash 镜像分别自然打到 tick 483（红方胜）和 tick 329（蓝方胜）终局；CLI PVP 通过两个显式 control session 从建局、经济、施工、生产、进攻打到 tick 780 终局，并分别由统一 MatchRecorder 保存 Trace v3
- [x] 删除 LLM 对局的 paired outer-turn barrier；每个 controller 现在按自己的 simulation-tick interval 和 in-flight guard 独立调度，短 turn 不再因对手长 tool loop 而整局失去后续决策机会；浏览器实机复测到 tick 133 时双方已分别进入 Request #2，蓝方继续到 Request #4，保存 Trace 含 6 个 turn
- [x] 将 `attack_move_group` 超出单 actor 公平寻路份额的成员保留为显式 pending group commands，并由 plan advancement 跨 tick 下发；大编队不再以单个超额 envelope 整批回滚
- [x] 修复终局 quiesce 先使 run session 失效、导致已 abort 的真实 agent turn 未写入 Trace 的问题；AI turn 现在先持久化，再屏蔽旧 session 的 UI/runtime 副作用
- [x] 修复刷新 Web UI 后本地 `isPlaying` 与服务端真实 match 状态脱节的问题；state projection 增加 `matchStatus`，运行中重连会恢复“暂停模拟”状态
- [x] 修复持续攻击在 Bridge 与 SimulationCore 两层重复推进的问题：模拟层持有攻击/冷却意图，Bridge 不再每 tick 重发并触发 `ERR_BUSY` 原子回滚；移动中的追击也不再反复替换路径
- [x] 让 MissionRuntime 按 MatchDefinition 路径预算为双方保留公平计划份额；4 worker 采矿等批量计划会跨 tick 显式推进，不再以超额 envelope 整批回滚
- [x] 修复 CLI `plan economy/tech/attack-hq` 的旧地图假设：建筑计划使用服务端推荐点或 HQ/footprint 相对位置并先移动 builder；HQ 进攻使用 `hq_in_range` 和大地图超时，实测双方 economy plan 均能自动完成兵营施工
- [x] 提取通用 `MatchRecorder`，让 live 与 CLI/control-plane 通过相同的一致 cut 和 Trace v3 finalizer 保存；新增按 match/session 保存的 control API 与 `llmcraft record save`
- [x] 引入 `MatchRegistry` 统一 live/control/benchmark round 的稳定 `matchId`；多个 match 可并存、查询、停止和保存，WebSocket 只投影显式选择的 observed match，不再以单一 orchestrator/controlMatch 充当全局对局
- [x] 在主 Web UI 增加“对局观察”选择器，列出 MatchRegistry 中的 live/control/benchmark match 并只切换 observed projection；窄屏无横向溢出，关闭面板后 3D Canvas 保持挂载
- [x] 将 Gateway 接纳/拒绝/回滚、结构化 command result 与 SimulationCore outcome 统一为 DomainEvent v1；MatchRuntime 负责关联 ID，MatchJournal 负责单调 eventSequence 和 NDJSON 流式追加，实时窗口上限 `500`
- [x] 定义 `MatchTraceRecordV3`、显式 capability 和运行时 validator；活跃 journal 已保存 manifest、完整 command submission 与逐提交 tick 的 state hash v2
- [x] 区分模拟 rollback 与提交后的 journal 故障；两者都 fail-stop，但只有前者产生 `simulation_tick_failed`，后者保留 `committed: true` 证据
- [x] 将活跃 journal 的一致 cut 流式原子 finalize 为正式 Trace v3，并建立独立 `@llmcraft/trace` validator/migrator/projector；`saveRecord()`、Replay、本地 JSON、Diagnostics 和 Analyzer 已接入
- [x] 为 journal 补进程 owner、终局 quiesce+seal 清理、启动时失活 owner/legacy 孤儿恢复，以及 record/transcript/orphan 的年龄/数量/容量策略；CLI/HTTP 默认 dry-run，显式 apply 才清理正式产物，固定样本由版本化 pins 或 keep marker 保护
- [x] 为每个真正进入 Game 的命令强制产生且只产生一个结构化结果；旧的静默丢弃分支改为 `command_invalid`，commandId 在整局内不允许被不同 envelope 重用
- [x] 引入 shared CommandEnvelope v1 与 MatchRuntime 专属 CommandGateway；LLM live、计划推进和 CLI/control-plane 真实动作路径已统一经过整批授权校验、clientRequestId 幂等、applyAtTick 边界和确定性排序
- [x] 将 CLI selection/pairing 与 orchestrate action batch 从逐条 HTTP/tool 提交改为单请求、单 CommandEnvelope；controller 预校验失败恢复内部计划/攻击状态，Game 按 envelope checkpoint，任一命令失败或路径预算不足时整批回滚并产生结构化证据
- [x] 为正式 envelope 增加每 actor/apply tick累计 `100` 条的 Gateway 接纳预算和公平共享的全局 `4` 条路径执行预算；双方先等额保底、空余额按 tick 轮换借出，多 envelope 不能绕过，超额分别结构化拒绝或整批回滚
- [x] 升级到 MatchDefinition v2，将命令/路径预算写入版本化 rules；旧 v1 Trace 固定使用历史默认语义，Gateway、Game 与 manifest 不再读取彼此独立常量
- [x] 将 replay delta 逐 tick流式写入 journal 并释放 Game 兼容缓存；正式 Trace 采用 64 KiB chunk 的 `.trace.json.gz` 原子文件，旧 JSON、新 gzip、Replay、Analyzer 和 compact 工具统一兼容
- [x] 让正式 commandResults、Analyzer 和 Transcript Viewer 原生消费 DomainEvent/AI turn facts；慢 WebSocket 在 1 MB backlog 时采用 latest-projection-wins；Live/CLI/LLM-vs-CPU Benchmark 已通过同一参数化契约测试
- [x] 将 control-plane 集成测试从直接 `Game.tickUpdate()` 迁到 `MatchRuntime.advanceOneTick()`，确保无墙钟测试也经过同一 Gateway/runtime 边界
- [x] 让 MatchDefinition.seed 实际初始化 WorldState 专属的可序列化 `mulberry32-v1` RNG；随机流状态已纳入 tick checkpoint 与确定性 hash，为后续随机规则禁止 `Math.random()` 建立边界
- [x] 将正式实体创建/销毁收口到 EntityRegistry / WorldState；创建前先校验 player 所有权，UnitManager/BuildingManager 的对应方法降为内部存储 hook
- [x] 将移动、弹丸结算、资源经济、持续采矿、攻击/追击/反击、施工、生产和胜负判定从 Game 内联代码提取为只操作 WorldState 的独立 simulation systems；SimulationCore 直接组合这些系统并返回结构化 outcome，Game 只保留旧命令与日志 adapter
- [x] 将权威单位持续命令从共享投影字段 `intent` 拆成 WorldUnit.order；Player/GameState 读取时才生成兼容 intent，并深复制可变嵌套字段，Agent/client 不再拿到权威实体引用
- [x] 为 WorldState 增加 revision，并将 GameAgentBridge 观察缓存从 tick-only 改为 revision-aware；同 tick processCommands、计划推进和 target action 不再读取陈旧的实体投影
- [x] 增加 WorldState EntityRegistry：统一跨 Unit/Building 的 ID 解析、存活语义与每 tick 不变量检查，并把 attack/projectile 的泛型目标查找迁到该入口；保持组合式数据结构，不引入深继承对象树
- [x] 从共享 Unit/Building 权威类型、服务端创建、客户端回放和开发展示状态中删除恒真/恒假的 `my` 字段；self/enemy 关系只在观察投影中由 playerId 派生
- [x] 引入首版 WorldState 聚合权威模拟状态：UnitManager/BuildingManager 成为实体集合唯一来源，Player 的 units/buildings 只在读取时投影；资源余量与 tile/tileView 更新收口到同一边界
- [x] 将 SimulationCore step 改为原子事务：任一规则阶段异常都会恢复 tick、实体、经济、资源、命令队列、弹丸、日志和胜负状态，并 fail-stop 外部 clock，不再保存可继续推进的半成品世界
- [x] 提取首版同步 SimulationCore.step，并让 MatchRuntime 的 live/control-plane tick 直接经过该 core；固定规则阶段顺序已有独立表征测试，性能计时和墙钟留在 runtime 边界，Game.tickUpdate 仅作为兼容入口
- [x] 引入首版不可变 MatchDefinition，并让 Game 初始化与 MatchRuntime tick 间隔实际消费该定义；现阶段主动拒绝非默认 ruleset/scenario/地图几何，待 Phase 3 将 agent prompt 改为由 MatchDefinition 生成后再开放可变场景
- [x] 完成 MatchRuntime 第一阶段迁移：把 500ms 模拟 timer 从 `Game` 移到 runtime，live 与 control-plane 通过同一 ClockDriver 推进；Game 保留同步 tickUpdate，规则结束时 runtime 会同步停止外部 clock
- [x] 修复 strategic smoke 中内置 CPU 直接远程建造、经济命令覆盖 builder 移动、施工中建筑被当作完成产能和生产持续花光科技建筑预算的问题；双边 rush 基线现可在 360 tick 内完成 barracks / refinery / war_factory、生产 40+ 战斗单位并下达多战线推进命令
- [x] 收紧建造规则：`war_factory` 需要已完成 `barracks`，worker 必须贴近建筑 footprint 才能施工，建造改为多 tick 施工并占用 worker；`refinery` 明确作为可建矿场/交付点
- [x] 暂时移除缺少侦察兵、雷达和 last-seen 配套的战争迷雾读取层，恢复双方全图情报，同时保留单位局部自动索敌范围
- [x] 重建 HQ、兵营、战车工厂和精炼厂的功能轮廓，解决四类建筑都像通用工业盒体的问题
- [x] 移除 `AISandbox` 与 `Node vm` 主链路
- [x] live match 切到 tool-calling agent runtime
- [x] benchmark 切到同一套 tool-calling runtime
- [x] 只读工具统一为 `get_map_state / get_my_state / get_my_units / get_army_summary / get_active_plans / get_recent_events`
- [x] 引入 `orchestrate_plan` 扁平 call-step 计划
- [x] 回放与 transcript 改为记录 tool calls / plans / commands / stop reason
- [x] 修复 action tool 命令要等整轮 agent run 结束后才入队，导致长链 tool-calling 期间单位表面“无动作”的时序问题
- [x] 为 tool-calling runtime 增加工具结果 tick、动作预校验和 stale-read warning，减少长 run 使用过期单位/建筑 ID 的无效命令
- [x] 为 OpenAI-compatible provider 增加同名同参数 read tool result 折叠，保留 assistant 文本但淘汰旧观察大 JSON
- [x] 清理 `AIStatePackageBuilder` 与 `AIPromptPayload(full/delta)` 兼容残留
- [x] 修复单位走到目标后仍保留 `moving` 状态与一次性 `move` intent，导致 agent 误判单位还在移动
- [x] 将 `get_map_state` 默认响应收敛为结构化单位、建筑和资源列表，并把逐格 `cells` 改为显式请求；已移除 ASCII 小地图和迷雾兼容字段
- [x] 暴露内建 `start_harvest_loop` 工具，避免 agent 用 `orchestrate_plan` 手写采矿往返
- [x] 增加 `analyze:record` 离线回放分析脚本，用于统计囤钱、worker 过量、生产瓶颈、战斗命令噪声和 HQ 受击时机
- [x] 暴露默认只自动攻击单位的 `attack_move_unit`，让士兵前压时不会无视路上敌军，同时保留攻击 HQ / barracks 必须显式下令的战略约束
- [x] 用高层 `attack(unitId, targetId)` 替代 LLM 暴露面的 `attack_unit` / `attack_in_range`，由 bridge 负责追击、持续攻击和目标死亡后的最后位置移动
- [x] 限制 `attack_move_unit` 到达目标点后结束，避免士兵在敌方基地永久自动清理后续新单位
- [x] 明确 `attack` 是有目标 ID 时的默认战斗命令，避免 LLM 把 `attack_move_unit` 当成拆 HQ / barracks 的替代品
- [x] 为 `orchestrate_plan` 增加 `{ call, args, scope, when, until, retry }` steps，让计划能复用现有动作工具表达开局、生产和连续作战意图
- [x] 修复 CLI control plane 每次工具调用重置 read tracking，导致 `units | build` 等先读后写管道误报 `no_recent_read`
- [x] 收敛 CLI control-plane CPU 对手到 benchmark 共享的内建 CPU 策略，避免 `random/rush` 行为复制漂移
- [x] 将 CLI control-plane 对局从 `state.orchestrator` 假适配对象拆出为独立 `ControlPlaneMatch`，避免普通 LLM 对局被 control session 误绑定
- [x] 清理旧的 CLI 临时 smoke 脚本，避免继续暗示 fake orchestrator 或过期双 agent 接入方式
- [x] 将 CLI control session 改为共享 `ControlPlaneMatch` 的 player 级 bridge，并由 match loop 推进 `orchestrate_plan`
- [x] 为 active plans 暴露 `currentStep`、`waitingReason` 和 `lastAttempt`，避免 agent 只靠单位 idle 状态判断计划是否卡住
- [x] 将 `spawn_agent` 子 Agent 执行纳入 `LLMProvider` / rate-limit wrapper，避免 `GameOrchestrator` 直接耦合 OpenAI client
- [x] 拆出 control HTTP 路由模块，并把 control read/provider-only 工具分类收敛到 shared 元数据
- [x] 增加单位被攻击后的自卫反击保底，让 idle/hold 的有攻击力单位在射程内自动还击攻击者，而不是由 HQ/barracks 触发周围单位护卫
- [x] Benchmark 支持并发运行多局 LLM vs CPU，对外保留按 round 编号排序的完整结果
- [x] 默认地图从 `37 x 25` 扩大到 `96 x 64`，并调整 HQ、worker、资源点和中心障碍布局
- [x] 前端主战术视口从 2D Canvas 网格切换到 React Three Fiber / Three.js 3D 战场
- [x] 用 CC0 源网格、Blender 定制装备和 PBR 贴图替换首版单位占位模型，并重制大型 HQ / 兵营 / 战车工厂
- [x] 为 `100+` 单位场景增加单材质 mass-battle LOD，合批单位、矿石和障碍，并提供独立 `80 vs 80` 压力展示页
- [x] 拆分轻坦车体/炮塔 LOD，加入实例化后坐、弹道、枪口焰、命中闪光、爆炸和碎片
- [x] 建立 `20 vs 20` 高细节画质基线，换用 CC0 实拍 PBR 地表，移除默认意图线和单材质 LOD
- [x] 校准坦克炮塔座圈和 `-X` 前向轴，删除远景图标并以武器、背包、护甲和材质重做兵种轮廓
- [x] 增加 Blender 后台 GLB 资产生成脚本，单位、建筑、资源和障碍改为加载 `public/assets/models/battlefield/*.glb`
- [x] 修复 shared 包 Node ESM 运行时导出，CLI 可通过 workspace 包正常加载 ruleset helper 并启动 CPU 对局
- [x] 将单位移动基础从纯整数格点推进为连续坐标 + 单位半径分离，并把到达/采矿/计划条件改为近似位置判断，减少坦克叠放和连续坐标误判
- [x] 将客户端单位插值改为按服务器 tick 周期的时间插值，替代指数追目标造成的顿挫/追逐感
- [x] 修复 agent run 产生胜负时 AI turn 可能在 early return 前未写入的问题，并让 `analyze-record` 对缺失 `aiTurns` 的旧模型对局明确显示日志不可用
- [x] 调整 3D 资源、默认地图和动画调试：资源矿脉改为更大的多晶簇；默认地图暂不放置 obstacle 岩石；资源点移出 HQ / 生产建筑夹缝和中央主攻路线；新增 `/?showcase=animation-lab` 本地动画调试入口，并降低 worker 工作、交付和士兵移动的高频抖动
- [x] 建立 Animation Lab projectile preview 架构：`/?showcase=animation-lab` 保持单一调试场景，在原有动作样例基础上追加三组固定面对面靶场，左下角 tab 只切换同一批元素的 implemented / preview 表现，便于观察 bullet / rocket / shell 的飞行、枪口闪和受击 recoil；dev-only 导航下移并精简入口，Mass Battle 默认 200v200，LOD 切换移动到 Mass Battle 页面左下角面板
- [x] 将 Animation Lab preview 验证后的弹药表现接入正式战场：正式 `CombatEffects` 现在基于 `ActiveProjectile` 的 launched/impact tick 做本地连续插值，渲染飞行体、曳光/烟尾和枪口闪，并删除旧的命中大圈 / impact mesh

---

*最后更新: 2026-07-17*
