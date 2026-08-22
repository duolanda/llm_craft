# 已知问题

活跃问题按优先级置顶；近期已解决事项和已有明确结论集中归档在文档底部，长期历史仍以 git 记录为准。

## 高优先级

### 大地图与长局性能仍需真实 LLM 对局复测

- **现状**：Agent read path 已减少重复完整状态读取，WebSocket 对慢客户端采用 latest-projection-wins；移动改为静态 A* 与有界局部避障分层，动态拥堵不再触发同 tick 重寻路。一次 717 tick 双 LLM 对局的浏览器堆快照显示，500 条 AI 终端 DOM 产生约 38 万个文本 shaping view 和约 19 万个行盒；实时尾部现限制为 100 条，终端使用动态高度虚拟列表，工具参数和结果仅在展开时挂载。2026-08-06 的 1017-tick 双 `oc-deepseek-v4-flash` 对局中，页面元素在 tick 488–1016 保持 389–399，server working set 从 368.9 MiB 增至 418.9 MiB；共享验收浏览器在连续抓取两组各 100 帧截图后发生 tab crash，尚不能据此判定游戏页面自身内存平台。后续 Chrome 采样确认 OOM 的主要触发器是服务端实时广播每 100ms 为日志扫描完整 `getState()`，并在状态广播中重复读取完整世界，造成高频 clone/序列化分配压力；renderer 的 `partition_alloc` native buffer 是承载和放大该压力的内存层，不是旧 renderer 残留。实时通道已改为瘦投影（`map_init` 静态地图 + `LiveStateSnapshot` 帧），客户端 frame buffer 不再克隆 tile 网格（共享 `map_init` 网格仅在发布给 React 时附加），服务端每 tick 只做一次全量状态读取并复用于帧、map_init 与 delta 基线，日志推送改用廉价 tail 访问器；瘦帧下的内存平台仍需按进程 working set、V8 heap、WebGL、WebSocket 背压和单帧字节数联合复测确认。
- **风险**：144x96 地图、大军团首次 A*、状态序列化、前端 3D 渲染和终局 Match Record JSON 仍可能造成 CPU 或内存峰值。
- **验收**：用真实双 LLM 长局运行至少 1000 tick，记录 tick wall time、RSS、浏览器 working set、终端 DOM 数量和终局保存耗时；终端文本布局对象应在预热后进入平台期。

### ContextWindowLimiter 不是真正的上下文压缩

- **现状**：当前只按消息数量/字节删除旧 user 边界段，并截断超大消息；`ContextWindowLimiter` 不是持久 memory，也不是语义 compactor。
- **风险**：模型仍会失去较早的战略理由和任务上下文，真正的语义压缩还完全没有做；tool-call/result 结构现在按原子批次保留，但长局表现和 token 成本仍同时受历史硬裁剪影响。
- **下一步**：先定义模型可读摘要契约与保留事实，再实现真正 compactor；设计时同时控制总输入体积和缓存前缀稳定性，不假定更高的缓存命中率必然意味着更低成本。

### Match Record 运行中历史仍占内存

- **现状**：完整 delta 分块在 worker thread 完成 JSON + gzip 后以压缩形式留存；Match Record 仍只在终局写一次。
- **风险**：未完成的 delta buffer、turn 和命令结果仍会在极长 evaluation 对局累积，终局组装完整 JSON 也有峰值。
- **下一步**：先以真实长局数据证明问题，再选择有界采样或简单分段文件；不预建恢复/审计平台。

## 中优先级

### `summary` 仍是字符串拼装

- **影响**：能工作，但不利于精确评估模型收到了哪些结构化变化。

### 只读工具仍偏碎

- **现状**：`get_map_state / get_my_state / get_my_units / get_army_summary / get_active_plans / get_recent_events`。
- **方向**：有真实模型调用数据后再判断是否合并，不继续增加新查询工具。

### 3D 战斗表现仍缺正式动画

- **现状**：单位/建筑模型、弹丸和基本碰撞已存在；步兵仍缺完整行走、射击和死亡动画。

### 浏览器控制台仍有非阻塞告警

- **现状**：首次连接或服务端重启时可能短暂记录一次 WebSocket error/disconnect；客户端会在 1 秒后自动重连。Three.js 还会报告 `THREE.Clock` 已弃用。
- **影响**：对局、终局和保存均未受影响，但会给前端诊断增加噪音。


---

## 已解决或已有明确结论

### 已解决：`attack_move_unit.priority` 被误解为排序、实际却充当目标白名单

- **根因与处理**：工具参数名和自然语义表达“优先顺序”，但战斗系统在显式传值时只搜索列出的类型。`priority: ["soldier"]` 因而让单位完全无视步枪兵、工人和建筑。索敌现在会先使用调用者给出的顺序，再去重追加该兵种完整默认顺序；严格点杀继续使用 `attack(targetId)`。
- **实战证据**：`match-2026-08-03T11-37-03-459Z-20c70e3e` 中 player_1 连续 98 次传入仅含 `soldier` 的优先级，优势部队抵达敌方 HQ 后始终没有造成建筑伤害，并无视后续出现的步枪兵；`match-2026-08-03T12-04-32-897Z-3a98e16e` 中另一模型也独立传入 `soldier,worker`，说明这是接口契约的系统性误导，而非单模型偶发失误。
- **验证**：战斗回归测试覆盖即时范围攻击和 attack-move 两条路径，确认显式优先项不存在时仍会攻击未列出的建筑。

### 已解决：不可达编队命令阻塞模拟 tick

- **实战证据**：`match-2026-08-06T14-55-08-134Z-9e6493f9` 在 tick 349 后处理 tick 350 用时 3017ms，在 tick 378 后处理 tick 379 用时 2823ms。对应批次分别有 22/9 条 `attack_move`；两辆位于生产建筑夹缝的轻坦持续不可达。旧终点解析会从目标向全图扩圈，并对每个候选点重复执行 A*，因此 UI 实际是在等待权威 tick，而不是视觉插值漏帧。
- **处理与验证**：静态导航拓扑现按移动 footprint 建立 connected domains，同目标请求共享有界 integration field；目标投影限制在 24 格，每个单位只对最终候选执行一次 A*，缓存固定为 64 项并在建筑拓扑变化时失效。由原 Record 还原的 20 个可移动步兵 + 2 辆被困轻坦红测从 1534ms 降至 180ms 内，且连续两 tick 均保持 20 个成功、2 个 `MOVE_BLOCKED`，第二 tick 不重建共享场；40/80/160 单位规模检查完整接单且原阈值不变。

### 已解决：晚到状态帧回跳与 500ms tick 停走

- **根因与处理**：问题先后存在三层。旧客户端会从最新到达帧重新锚定 smoothstep；第一轮 FrameBuffer 修复没有接入 Live，Replay 又固定使用整数 tick 时间；第二轮虽然让 sampler 连续，却仍在 `useFrame` 中 `setDisplayUnits`，把每帧结果交给 React scheduler、重建 `Unit[]/ModelTransform[]`，最终 GPU 实例矩阵并不具备稳定逐帧更新保证。现已删除整条 `useSampledUnits` 和 fallback easing：`VisualWorld` 每帧只采样一次，模型 batch 直接写 `InstancedMesh`，血条、地面环、intent 与战斗提示读取同帧 transform。单位动作的 30fps 限流已删除。Live 使用 2 tick 显示缓冲避免周期性吃完外推后等待；Replay 正常播放不再每 tick clear buffer，整数 frame index 不再驱动模型位置。
- **验证**：服务端孤立单位逐 tick 坐标沿目标单调、横向不漂且步长不超过 speed；500ms 权威帧、60Hz 和 ±200ms 到达抖动测试覆盖 render time/位置单调、停顿长度和速度尖峰。`VisualWorld` 回归测试要求五格路径的 151 个 60Hz render step 每帧前进、每帧只读一次 clock/transform，且不修改权威单位。真实浏览器 Replay 播放/暂停/seek 与 Live 双 LLM 烟测均正常，资源稳定后 Canvas 为 59.9–60fps；截图只用于检查静态模型和附着视觉，没有再用轨迹采样代替玩家对运动观感的判断。

### 已解决：长 turn 中途失败后逐 tick 请求错误风暴

- **实战证据**：历史 731-tick Record 中一方 526 requests、29 tools、509 次连续 `Connection error`；修复前新鲜 1023-tick 双 `oc-deepseek-v4-flash` 对局又复现双方各 138/139 次连续 400，供应商明确报告 assistant `tool_calls` 后缺少匹配 tool message。根因是长 turn 中间传输失败前，已完成的工具结果尚未持久化，warmup assistant tool call 因而在下一 turn 成为孤立消息；orchestrator 又在每个 committed tick 立即重试。
- **处理与验证**：每个完整 tool batch 现在原子持久化 assistant declarations 和匹配 results，并在同 turn 后续请求前限制活动上下文；每方失败独立执行最多 64 tick 的指数退避。回归测试先分别复现缺失 tool result 和 8 tick 内 9 次失败，再验证配对完整、失败调用不超过 4 且另一方 9 次调用/MatchRuntime 8 tick 均不受阻。修复后 608-tick 自然终局与 1017-tick 长局中，每方仅在终局/主动停止时有 1 次 `Request was aborted.`，最长同类错误 streak 均为 1，零输出和 empty-max-token 均为 0。

### 已解决：战斗渲染按单位数量切换阴影并硬截断特效

- **处理**：单位阴影改为稳定开启，不再按存活单位数跨过 60 的瞬间整体切换；投射物、补画攻击、爆炸和压力测试规模中缺少依据的硬截断也已移除。剩余的正式动画缺失是独立问题，继续保留在中优先级。

### 已解决：OBB 坦克贴近 HQ 时局部移动死锁

- **实战证据与处理**：根据 `match-2026-07-29T15-07-50-390Z-13343a75` 定位到 OBB 坦克贴近 HQ 且无法原地转向的模拟层死锁。坦克现在可沿车身轴脱困，A* 中间格也不再要求精确压中；同处互相阻塞的 worker 可随之继续路径。客户端视觉卡顿和位置回跳后来确认为独立的渲染时钟问题，已在上方归档。

### 已解决：Builtin CPU 决策间隔回归

- **根因**：`bc899cf` 曾误将“LLM 每个 committed tick 都有决策机会”的规则应用到 built-in CPU，导致 Benchmark 和 ControlPlane CPU 接近每 tick 决策。Random 因而拥有远高于设计值的决策频率，即使单次做出有效决策的概率较低，实测强度也会与带正常间隔的 Rush 接近甚至更高；这不是 Random 策略分布本身的独立问题。
- **处理**：恢复 CPU 专属的 `decisionIntervalTicks`，由 shared 统一定义默认值 10 和合法范围 1–60。Benchmark 前端、WebSocket、`BenchmarkOrchestrator`、`GameOrchestrator` 与 `ControlPlaneMatch` 使用同一语义；CLI 不维护独立默认值。LLM 仍保持空闲时每 committed tick 可调度，Mission 也仍逐 committed tick 推进。
- **验证**：Benchmark 和 ControlPlane 测试分别覆盖 CPU 首次派发、未满间隔不派发、达到 10 tick 再次派发，并验证 LLM 同期仍逐 tick 调度。真实短局中，前端 `oc-deepseek-v4-flash` 对 rush CPU 的请求 tick 为 `0/10/20/30`；OpenCode `deepseek-v4-flash` 通过 CLI control session 读状态并提交动作，CLI 启动响应显示服务端采用 `decisionIntervalTicks: 10`，evaluation record 中 CPU 命令 provenance 没有落在 10-tick 网格之外。

### 已确认：通用缓存策略应优先控制历史体积

- **原问题**：曾假设 Agent prompt 缺少稳定前缀、历史裁剪会让缓存命中率过低，因此考虑沿用 Reasonix 的 DeepSeek 优化，让 history 尽可能 append-only，只在上下文压力较高时批量折叠旧观察。
- **实验方案**：正常请求不再即时改写旧读取结果；历史达到 `ContextWindowLimiter` 字节预算 60% 后，才批量折叠 recent tail 之外、至少 1 KiB 且可重新读取的旧观察。对照组保留当前策略：新的同名同参数读取完成后，立即把旧结果替换为小型 tombstone。
- **A/B 结果**：使用相同的 `oc-deepseek-v4-flash` preset 做双模型镜像对局。append-only 方案两局共 23.80 模拟分钟，加权命中率 96.65%，每分钟约 249.36 万 input、8.35 万 fresh input；即时替换方案两局共 16.43 模拟分钟，加权命中率 88.62%，每分钟约 105.32 万 input、11.99 万 fresh input。append-only 虽减少约 30% fresh input，却令总 input 增至约 2.37 倍。
- **成本结论**：按实测 token 量计算，只有“缓存读取价 / 普通输入价”低于约 2.46% 时，append-only 才更便宜。DeepSeek V4 Flash/Pro 约为 2.00%/0.83%，属于特例；OpenAI、Anthropic、Gemini、Mistral、Grok、千问和豆包的代表性公开价格通常约为 10%–25%，部分服务还另收缓存创建费、存储费或长上下文阶梯价。
- **决定**：通用 OpenAI-compatible runtime 保留有界历史和及时替换旧观察的方向；最大化稳定前缀只适合作为显式、可配置的 provider-specific 优化。不得通过 baseURL 或模型名称暗猜计费方式，应由 preset 明确提供缓存策略或价格比例。缓存 usage telemetry 仍有独立价值，不与 history policy 绑定。
- **限制**：四局 LLM 对局不是确定性 paired benchmark，局长也不完全一致；2.46% 是当前工具返回体和模型行为下按模拟分钟归一化得到的工程分界，不是跨模型常数。它已足够否定“更高命中率必然更便宜”，后续具体供应商仍应以真实账单复核。

### 已解决：关闭回放的 Benchmark 终局被前端误触发保存

- **根因与处理**：前端在 Benchmark 结果状态清空后仍把最后一轮的 `winner` 当作 live match 终局，发送无 match 身份的 `save_record`；服务端又按当前观察对象直接保存，最终撞上 `MATCH_RECORDING_DISABLED`。`state` 现在显式携带 observed match 的身份、类型和录制能力，自动保存与胜负弹层只对可录制 live match 生效；`save_record` 必须携带稳定 `matchId`，服务端在调用 Recorder 前校验 live 类型与录制策略。

### 已解决：无限生产 plan 难以撤销，且不能表达真实生产队列

- **根因**：把 `spawn_unit` 放进无限循环的 `orchestrate_plan`，既让取消生产必须先理解 mission，又把“计划意图”和“建筑生产队列”混成两套状态；旧实现还在入队时一次性扣全款，无法暂停、退款或表达混合兵种顺序。
- **处理**：生产已从 plan call 集合移除。`spawn_unit` 改为给单座建筑追加有限且严格有序的 `{ unitType, count }[]`；新增 `get_production_queue` 和 `cancel_production`。生产逐 tick 扣款，缺钱暂停并自动恢复；取消订单或建筑被摧毁会退还当前未完成单位已支付的 credits；每建筑每兵种最多保留 100 个待生产单位。自动建造仍由 `orchestrate_plan` 负责，并保留动态占位立即换址与完成边界去重。
- **验证**：覆盖混合批次顺序、逐 tick 付款、缺钱暂停/恢复、显式取消退款、建筑摧毁退款、每兵种 100 上限，以及 LLM 工具的追加、查询和取消链路；`orchestrate_plan` schema 和运行时均拒绝 `spawn_unit`。

### 已解决：`attack_move` 集结点在 tick 边界退化为普通移动

- **根因与处理**：玩法工具正确生成了 `rallyMode: "attack_move"`，但 `Game.normalizeCommand` 的字段白名单遗漏该字段，导致真正执行时按默认 `move` 落盘。命令规范化现在显式保留合法 `rallyMode`，并同时保留同类嵌套字段 `resumeWorkerOrder`；回归测试穿过 GameplayController、Game 命令队列和 tick 执行边界验证建筑最终模式，而不只检查工具的即时返回。

### 已解决：建造者死亡后 plan 永久残留且没有直接取消入口

- **根因与处理**：global 建造 step 的默认 retry 把“显式绑定单位已经死亡”也当成临时等待，且 LLM 只能查 `get_active_plans`，没有与之对称的取消工具。MissionRuntime 现在会让这种 plan 立即失败；新增 `cancel_plan({ planIds })`，与生产队列的 `cancel_production({ orderIds | buildingIds })` 明确分域。
- **实战证据**：`match-2026-07-29T16-16-36-665Z-da5edda4` 中 `plan_3` 的 worker 死亡后仍出现在 active 列表，DeepSeek 因没有计划取消入口而误把 `plan_3` 传给 `cancel_production`。回归测试覆盖主动取消和绑定单位死亡两条路径。

### 已解决：Builtin CPU 因读取旧单位字段而整局不采矿

- **根因与处理**：`get_my_units` 已将瞬时状态从 `state` 改名为 `phase`，但 `BuiltinCPUStrategy.issueWorkerEconomy` 仍判断 `worker.state === "idle"`，导致 random/rush CPU 永远不会给普通空闲工人调用 `start_harvest_loop`。CPU 现改为读取 `worker.phase`，现有测试 fixture 同步到真实工具结果结构。
- **实战证据**：`match-2026-07-29T16-16-36-665Z-da5edda4` 中 CPU 的 4 个工人没有一次采矿调用；初始资金在完成 6 个机枪兵后降至 5，余下 8 个订单从 tick 65 起永久停在 `waiting_for_credits`。
