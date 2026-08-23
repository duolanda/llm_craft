# LLMCraft 当前实现现状

日期：2026-08-23

## 1. 运行边界

- `MatchRuntime` 拥有单局时钟、500ms tick、`CommandGateway` 和结束通知。
- `SimulationCore` 同步编排 movement → projectiles → economy → harvest → combat → construction → production → victory。
- `Game` 负责解释命令、持有 `WorldState`、执行规则并生成 UI/AI feedback log。
- SimulationCore 异常会停止该局；不会克隆世界、回滚 tick 或继续运行半失败对局。
- 命令在下一 tick 边界释放。每条命令独立执行，一条失败不会撤销同批次的其他成功命令。
- 没有每 actor 每 tick 命令上限或全局路径命令额度。普通动态冲突只走有界局部避障；连续 8 tick 无路线进展后才使用瞬时拥堵代价重规划，每 tick 最多 4 个单位，避免拥堵时集中重跑 A*。

移动采用两层模型：A* 主要根据地形和建筑规划全局路线；单位之间的动态冲突由确定性优先级、空间索引和有限角度/距离候选做局部避障。每种移动 footprint 会为当前静态拓扑建立 passability 与 connected-domain 层；同类单位前往同一目标时共享一个有界的 reverse integration field，先以连通域排除不可达请求，再只在目标附近 24 格内分配可达落点，最后每个单位最多执行一次初始 A*。integration field 使用 64 项 LRU；建筑增删会使静态拓扑缓存失效，移动单位不会进入该缓存。只有单位在已分配路线上长期无进展时，才构造一次性 congestion overlay：静止/hold 单位代价高于正在移动的单位，近期失败路段也被加权，但两者都是有限软代价，不会把瞬时人群误判成永久不可达。这一分层对应 OpenRA 的阻塞等级与重规划、0 A.D. 的长/短路径升级，以及 Game AI Pro 的 cost/island/integration field 思路。

局部候选按前向进度、移动距离、转向幅度和确定性避让侧评分；无前向进度的横移不会清除拥堵计数，也不允许立即返回上一位置。持续拥堵后开放扩展侧移；OBB 车辆还能保持车体朝向沿车身轴前进或倒车，先腾出转向扫掠空间。A* 中间格只作为路线引导，单位进入半格范围即可继续下一个节点，最终目的地仍需精确抵达，避免大型车体因无法压准狭窄处格心而永久微调。阻塞时间最长的单位优先脱困。单位终点预约只用于避免多个命令选择重叠终点，不会作为整条全局路线的硬障碍。权威碰撞在 XY 平面计算：worker/步兵使用按人体投影标定的圆，三种车辆按各自尺寸使用 OBB，建筑和障碍格组成静态 AABB。A* 不搜索朝向，因而以 OBB 包围圆提供保守静态净空；终点、出生、移动扫掠、单位避障和拥堵解叠使用精确 Circle/OBB + SAT。单位朝向由模拟层持有，写入实时状态和录像 delta，前端只做位置与最短角度插值。车体尺寸来自 shared `entity-geometry.json`；simulation movement profile 只补充避让优先级、locomotion layer 和可碾压类型。移动中的轻坦、火焰坦克和重坦按实际提交的扫掠轨迹瞬杀敌方 `worker`、`rifleman` 和 `rocket_soldier`，并产生普通 `unit_destroyed` 事件；`commando` 免疫三种坦克的碾压，友军、车辆、建筑、静止重叠以及已退役的 `soldier` 也仍按普通碰撞处理。后续让行或不同尺寸单位应继续扩展 profile 间交互策略，而不是向 A* 或前端塞单位特例。

拥堵恢复另行跟踪整条路线剩余距离的历史最佳值，因此在同一小区域前后挪动不会伪装成有效进展。一次拥堵重规划后必须再经历完整的无进展窗口才能再试；全局移动循环优先处理拥堵时间最长的单位，从而在每 tick 4 次的重规划预算下保持确定性和公平轮转。

实时 WebSocket 使用独立的 `LiveStateProjectionFrame` 作为动态状态投影；完整 `GameState` 只属于服务端模拟、Match Record 和 Replay。live frame 不携带历史日志、静态地图、寻路缓存、生产队列或 AI 输出：地图通过一次性的 `map_init`，日志通过有界 `state_events`，最新 AI 输出通过可替换的 `ai_output` 消息传递。Live 与 Replay 都通过 `SimulationVisualTimeline` 消费同一个 frame sampler：Live clock 使用单调服务器时间和 2 tick 固定显示缓冲，Replay clock 用 `requestAnimationFrame` 连续推进可暂停、变速和 seek 的 playhead；React 的 replay frame index 只用于界面、tick 级元数据和滚动缓冲窗口，不充当模型渲染时钟，正常播放也不再每 tick 清空 frame buffer。客户端按 frame sequence 丢弃晚到旧帧，采样位置与最短角度 heading；超过 10 格的状态跳变立即 snap。

逐帧视觉状态由 `VisualWorld` 持有。每个 R3F render frame 只读取一次 timeline 和每个实体的 transform，再由稳定的实例 batch 直接调用 Three.js `setMatrixAt` / `instanceMatrix.needsUpdate`；单位坐标不进入 React state，不克隆逐帧 `Unit[]`，也没有 30fps 动作限流。模型、车体/炮塔朝向、血条、地面环、intent 和战斗提示在同一 render frame 读取同一份 mutable transform。React 只负责 Canvas/批次结构、HUD 和 tick 级属性；视觉层只读权威状态，不反向修改模拟。WebSocket 断开后每秒重连，换局或重连时清空旧 live frame buffer。

车辆和建筑 GLB 在 Blender 导出前按同一份 shared 几何规格归一化，导出根变换为 1；前端不再用按类型的视觉补偿系数，只用统一 `CELL_SIZE` 把“模拟格”换算为 Three.js 世界单位。车辆碰撞只覆盖履带/底盘/车体，炮管、天线和排气附件作为装饰悬垂；生成器会验证主体没有越出 canonical footprint，服务端测试同时验证建筑规则 footprint 与模型规格一致。

持续攻击和 attack-move 追逐移动目标时，目标的连续坐标会先转换为边界内整数网格，再交由寻路层选择可达终点。指定目标攻击建筑时不再把被占据的建筑中心交给通用移动终点投影，而是按攻击者射程、来向和车辆碰撞半径预约互不重叠的近侧射击位；移动途中每个 committed tick 都会先重算是否已进入射程，满足后立即停止追击并开火。对相同目标重复调用 `attack` 会复用正在执行的追击路径，不会重新分配终点。attack-move 的可选 `priority` 只把指定目标类型提前，未列出的类型继续按兵种默认相对顺序参与兜底索敌，不再充当严格目标白名单。指定目标攻击无论是在首次调用实时校验时，还是在后续持续攻击过程中发现目标已消失，都会只在攻击者自身视野内确定性地重选附近敌人；没有候选时后续持续攻击转为 hold 并清掉旧追击路径，首次调用则返回目标已消失。大部分无明确点杀目标的推进仍应直接使用 attack-move。

采矿循环会向最近的已完成 HQ 或 refinery 交付。省略矿点时，自动选择以反复交付路程为主、worker 初始路程和当前分配为辅；单格矿点最多保留 2 个 worker，超额分配会自动改派，矿点耗尽后也会自动切换路线。worker 在矿格边缘的交互范围内即可采集，不再要求共享同一个格心；因此第二个 worker 的落点被终点预约投影到相邻格时仍能完成采集。满载 worker 进入交付建筑范围即可卸货。Refinery 只缩短交付路线，不增加采集速度；省略建造坐标时会按预计路线节省选址。自动建造任务以 worker 与建筑完整 footprint 实际相邻为移动步骤的完成条件。

## 2. 对局与玩家控制

生命周期控制和玩法控制是两个边界：

- 生命周期：`MatchRegistry + MatchRuntime`，由 WebSocket、HTTP 或 CLI 触发创建、预热、开始、停止、查询和观察。
- 玩法：`GameplayController`，供 AgentRuntime、CLI adapter 和 built-in CPU 使用同一套观察/动作工具。
- `DecisionController` 是可由 harness 调度的决策来源；当前实现为 LLM 和 built-in CPU。
- `GameOrchestrator` 订阅 committed tick。LLM 空闲且遇到新 tick 时可开始下一次决策；慢方仍运行时只跳过慢方，不阻塞快方。连续模型请求失败时按玩家独立执行 2/4/8/...、最多 64 tick 的有界退避；任一成功请求会重置该玩家的退避，不阻塞另一方或 MatchRuntime。
- 不存在 100ms AI poll 或 LLM 固定宏观决策间隔。built-in CPU 使用统一的 `decisionIntervalTicks`，默认 10 tick；Benchmark WebSocket/UI 可覆盖该值，ControlPlane/CLI 省略时使用同一服务端默认值。
- `warmup` 只提前执行选中模型的首个真实请求并保留会话结果，不启动游戏时间。`start` 不等待首次决策：时钟立即启动并同时派发双方控制器，因此首次和后续响应耗时都属于实时对局成本。
- 即时动作失败会在服务端已知时直接返回紧凑恢复候选；计划等待状态同时提供兼容摘要 `waitingReason` 和结构化 `waiting.code/message/details`，避免用额外全图读取猜测失败原因。

普通 live 流程只允许一个 active match。重复 start 返回提示。`llmcraft play` 重复调用只返回已有 active control match 的信息，不创建新对局或 session。benchmark round 仍可并行注册；前端的对局面板可以切换观察任一 registry entry。

## 3. MatchDefinition

当前定义由以下内容组成：

- `map`：地图 ID、144x96 尺寸、矿脉、障碍物、双方 HQ 和初始单位位置；
- `players`：两个玩家槽位和初始 credits；
- `rulesetId`、`tickIntervalMs` 和胜利条件。

当前只接受内置 `standard` ruleset 和 `standard` map 的完整布局。命令限制、模型调度和记录配置不属于 MatchDefinition。

shared constants 是内置 `standard` 规则和地图模板的定义处；`createDefaultMatchDefinition()` 会把地图布局复制进单局定义。运行中的地图尺寸、矿脉、障碍物、开局实体和 tick 时长读取该局 MatchDefinition；单位数值、造价和生产关系通过其 `rulesetId` 对应的 shared ruleset helper 读取。前者是“这一局采用什么”，后者是“内置 standard 具体是什么”，不是两套相互竞争的配置。

`soldier` 已从 standard 的当前生产关系中退役，兵营基础生产 `rifleman` 和 `rocket_soldier`，基础步兵定位由 rifleman 承担；T3 后会额外解锁 `commando`。为保证历史 Match Record、旧状态投影和战斗目标兼容，`soldier` 的类型、数值、渲染与战斗行为继续保留；ruleset helper、Game 命令、GameplayController、CLI 和 built-in CPU 都不会在新对局中生产它。前端实时统计默认隐藏该行，但回放中实际存在 soldier 时会重新显示。

standard 的科技层级由已完成建筑实时推导，没有额外研究队列：

- T1：兵营生产 `rifleman` / `rocket_soldier`；已完成兵营可作为机枪塔的前置。
- T2：已完成兵营后可建重工；重工完成即解锁 `light_tank` / `flame_tank`，同时允许建反坦克塔。
- T3：已完成重工后可建科技中心；科技中心完成后，重工解锁 `heavy_tank`，兵营解锁玩家级限造 1 名的 `commando`。

机枪塔和反坦克塔都是服务端权威战斗单位：完工后按自身视野、目标优先级和冷却自动索敌，并通过与移动单位相同的 projectile/warhead 管线造成伤害。火箭兵的最小射程由战斗系统强制执行；指定目标或 attack-move 发现目标位于最小射程内时，会先退到合法射界再开火。火焰坦克为 T2 近程反步兵/攻坚车辆：560 HP 高于轻坦的 420，射程 3，攻击前有 1 tick 权威前摇，完成后建立持续喷火状态并每 tick 生成一次伤害脉冲；目标失效、离开射程、切换目标或收到移动/hold 命令会立即中断，重新接敌必须再次前摇。每次脉冲基础伤害为 6，infantry / vehicle / structure 系数为 4 / 0.2 / 4（直击分别为 24 / 1 / 24），因此持续贴住步兵和建筑时伤害很高，却不会替代轻坦参与载具对拼；单辆持续喷火约 30 秒摧毁满血 HQ、9 秒摧毁兵营，机枪塔几乎无法阻挡它，反坦克塔则是硬克制。客户端根据权威 `attackStream` 绘制双喷口连续火焰，不显示用于逐 tick 结算的火焰 projectile。

特种兵为 T3 唯一单位：160 HP、1.2 格/tick、600 credits、24 tick 生产时间。步枪射程 7，命中任意 infantry 即秒杀；对建筑会自动切换为射程 1 的 C4，命中即摧毁目标；对 vehicle 的伤害固定为 0，自身属于 infantry，但免疫轻坦、火焰坦克和重坦的移动碾压，仍会受到常规武器伤害。玩家的存活特种兵与所有兵营已排队数量合计不得超过 1，死亡后名额释放。GameplayController 在入队前返回结构化 `unit_limit_reached`，Simulation 层仍会让兼容导入的超额订单以 `waiting_for_unit_limit` 暂停，避免绕过权威限制。

重坦当前为 850 HP、0.6 格/tick，保留 90 基础伤害、520 credits 和 26 tick 生产时间；相较轻坦，它以显著更慢的机动换取 T3 正面反装甲能力。侦察车、自行火炮和迫击炮车已从当前类型、生产关系和资产中移除，不保留 Match Record 兼容分支。

## 4. Agent runtime

- 模型通过 OpenAI-compatible tool calling 观察和控制游戏，不生成可执行 JavaScript。
- 只读工具：`get_map_state`、`get_my_state`、`get_my_units`、`get_army_summary`、`get_production_queue`、`get_active_plans`、`get_recent_events`。
- 动作工具：移动、attack move、指定目标攻击、有限批次生产、取消生产、集结点、建造、持续采矿和 hold。即时移动、attack move、attack 与 hold 可在精确 `unitIds` 和执行时动态 `selection` 之间二选一；动态选择支持 `all_combat`、`idle_combat` 或具体单位类型，并在执行 tick 解析当前存活单位，避免查询与并行动作之间的 ID 过期。`all_combat` 严格包含所有存活战斗单位，不会暗中排除已有 plan 的分队；后下发的即时命令会中断被选中单位的 plan。保留独立分队时由调用者显式传入主力 `unitIds` 并排除该分队。子 Agent 为保持 unit lease 边界仍只允许显式 `unitIds`；集结点和整队列取消接受 `buildingIds` 数组。
- `spawn_unit` 给一座建筑追加严格有序的 `{ unitType, count }[]`。生产按 tick 扣款，余额不够时保留进度暂停，有收入后自动继续；取消订单或生产建筑被摧毁时，当前未完成单位已经支付的 credits 全额退回。T3 单位一旦开始会在科技中心被毁后完成，队列中后续受锁单位进入 `waiting_for_prerequisite`，重建科技中心后自动恢复。每座建筑每种单位最多有 100 个待生产单位；`commando` 另受玩家级 1 名限造约束。
- LLM、HTTP control 与 CLI 共用 `orchestrate_plan`；step 的 `call` 和 `args` 复用其支持的即时动作工具名与动作参数，但 per-unit 持久计划仍在注册时用顶层 `unitIds` 固定所有权，不接受只适合单次即时解析的动态 `selection`。`cancel_plan` 可按 ID 立即终止 active plan，显式绑定的单位死亡时计划自动失败。新 plan 的首个移动或追击 step 会接管注册前遗留的单位命令，但已由当前 step 下发的移动不会每 tick 重发。绕后、分兵多线、夹击或避开正面交战等对路线敏感的分队行动由独立 `unitIds` plan 和连续移动 step 表达：先到己方一侧的路线入口点，再沿所选路线通过战场；单个远端点不约束实际行进路线。生产不再进入 plan，改由 `spawn_unit` / `get_production_queue` / `cancel_production` 管理有限队列；global 建造计划可省略 `unitIds`，内部 `MissionRuntime` 在每个 committed tick 推进。
- plan 建造步骤可省略坐标自动选址，并负责 worker 走位；行军期间 footprint 被临时占据时立即重选。同批未落地工地会预留 footprint 外一格，普通生产建筑沿 HQ 朝战场方向横向展开，避免相邻计划贴边形成采矿封锁。
- HQ、兵营和重工持久保存带模式的可选 rally point。默认 `move`；兵营和重工可设 `attack_move`，该模式会穿过命令规范化与 tick 队列原样保留，新战斗单位会边推进边索敌；HQ worker 集结只支持 `move`。目标格被占时寻路层为每个单位选择附近可达落点；清除 rally point 不影响已经出发的单位。
- 开局 worker、无 rally point 的新 worker，以及完工后没有原任务可恢复的建造 worker 会自动选择高效矿路并进入 `harvest_loop`。显式集结点、hold、移动和手动改派仍覆盖自动任务。
- group attack move 会一次提交所有编队命令，不做跨 tick pending group release。
- 指定目标 `attack` 采用传统 RTS 追击语义：目标在射程外时先寻路进入合法射界再持续攻击；若已观察目标在批量工具执行前死亡，则从当前全图目标中选出一个替代目标供整批攻击者统一追击，不再按每个单位当时的自动索敌视野分别决定是否停下。持续攻击中的目标消失后，各单位也会从当前战场目标继续重选；只有不存在任何合法目标时才清理追击并 hold。
- `get_map_state` 和 `get_my_units` 用 `phase` 表示瞬时模拟阶段，保留 `intent` 表示持续任务，避免把 `phase: idle` 误解为没有采矿任务。`get_my_units` 不再返回完整逐格路径，只返回终点与剩余步数；`get_my_state` 区分 assigned/active/stalled harvesters 并报告矿点余量，harvest loop 连续 12 tick 没有位移或 credits 变化时报告 `path_blocked`。LLM 的 `start_harvest_loop` 接受 `unitIds` 数组，相同有效任务返回 `already_active` 而不重启。
- `no_recent_read` 只提示本轮从未读取过状态；一旦读取，模型推理跨过若干 tick 不再产生纯时间阈值的过期噪音。所有动作仍在调用时使用实时状态校验。
- Agent session 会把 building complete、unit ready、unit lost 和任一己方建筑遭攻击四类关键 EVA 消息插入模型上下文并去重。
- 同 tick 多个付费建造 plan 会按当前可用 credits 预留成本；生产费用由 ProductionSystem 在每个 tick 确定性结算。
- `ContextWindowLimiter` 暂时按消息数和字节裁剪 provider history。每批 assistant tool declarations 与匹配的 tool results 会先作为原子 checkpoint 持久化，并在同一长 turn 的每次后续模型请求前重新限制活动上下文，避免中途传输错误留下孤立 tool call。它不是持久 memory，也不是真正的语义 compactor。

## 5. CLI / HTTP control

- `POST /api/control/start-game` 创建 control match；已有 active control match 时返回该 `matchId` 和 `reused: true`。
- control session 固定绑定 `matchId + playerId`，观察对象变化不会迁移 session。
- 单 tool 请求直接进入绑定玩家的 `GameplayController`。
- `/sessions/:id/actions` 接受带 `clientRequestId` 的 action 数组并提供请求级幂等；每个 action 独立执行和返回。部分失败时保留成功动作并返回 `partialSuccess: true`。
- CLI 的 move、attack、attack-move、gather 和 hold 支持 `--units`，stdin 选择会合并为 `unitIds` 数组；`train --count` 追加有限生产批次，`production-queue` 查询队列，`cancel-production` 按订单或建筑取消；rally 支持 `move` / `attack-move` 两种模式；`orchestrate` 以正式工具名接收 `{ actions: [...] }`，只为旧脚本保留短别名归一化。
- MatchRegistry HTTP API 支持列表、切换观察、停止和保存指定对局。

## 6. Match Record

正式产物是单个 `match-<ISO timestamp>-<short match id>.match.json`：

- `off`：不保存；
- `replay`：定义、元数据、初末状态和 tick delta；
- `evaluation`：增加命令结果、Agent turn、工具和模型请求指标；
- `includeTranscript`：可选增加完整模型 messages 与 assistant 输出。

Control-plane match 默认使用 `evaluation` 且关闭 transcript，因此 CLI/HTTP 命令及 controller provenance 默认可复盘。

终局只写一次文件，不重写大 JSON。运行中每个 tick 只向 worker thread 投递一个小 delta，由 worker 每 100 条封块并执行 JSON + gzip，压缩后留存；保存前也由 worker 解压解析。分块边界不再从模拟线程搬运整个大数组；worker 失败则保留 raw chunk，不影响对局。不生成单独 transcript、详细因果记录、临时事实工作区、状态 hash 或自动 retention 产物。

`@llmcraft/record` 是 server/client 共用的 Match Record 读取与状态投影包。它能导入项目已有的普通旧 JSON；不实现已删除的详细记录格式兼容。

`analyze-record.mjs` 是供开发者或 Agent 离线分析已有 Match Record 的工具。它报告逐玩家 request status/finish reason、错误总量与最长同类 streak、零输出、latency p50/p90/max、input/output/reasoning/cache tokens、context drop/truncate，以及工具和命令推进；`--timeline` 会列出请求错误段。它与 benchmark runner 相互独立。

## 7. Benchmark

- 当前 benchmark 是 LLM preset 对 `random` 或 `rush` built-in CPU。
- CPU 是模型/提示词的最低能力 baseline，不是性能规模测试，也不是平衡样本。
- `random` / `rush` 在敌方 HQ 摧毁后会继续显式攻击剩余建筑；HQ 不再被当作唯一终局目标。
- `BenchmarkRunner` 直接处理轮次、换边、并发和汇总；没有通用 ExperimentRunner。
- `recordReplay=false` 时 round 不生成 Match Record；开启时使用 evaluation 档位，可另行选择 transcript。
- 每个 round 都作为独立 match 注册；benchmark 只报告进度，不自动切换主画面的观察对象。

## 8. 当前明确限制

- `summary` 仍是服务端拼装字符串。
- `ContextWindowLimiter` 只会丢弃/截断上下文，没有语义摘要。
- Match Record 的压缩 tick delta 和未压缩 evaluation 数据在终局前留在内存，长局内存与终局 JSON 峰值仍需实测。
- 当前地图定义虽然完整，但 SimulationCore 仍只接受内置 standard 布局。
- 人类手操 adapter 尚未实现；当前没有占位的 HumanControllerAdapter。
