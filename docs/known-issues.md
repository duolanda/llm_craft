# 已知问题

只记录当前代码仍存在、尚未解决的问题。已修复 / 已完成的历史问题不再在此累积，可在 git 历史中查阅。

## 高优先级

### 1. 大地图与长局性能仍需真实 LLM 对局复测

- **现状**：Agent read path 已减少重复完整状态读取，WebSocket 对慢客户端采用 latest-projection-wins；移动改为静态 A* 与有界局部避障分层，动态拥堵不再触发同 tick 重寻路。一次 717 tick 双 LLM 对局的浏览器堆快照显示，500 条 AI 终端 DOM 产生约 38 万个文本 shaping view 和约 19 万个行盒；实时尾部现限制为 100 条，终端使用动态高度虚拟列表，工具参数和结果仅在展开时挂载。
- **风险**：144x96 地图、大军团首次 A*、状态序列化、前端 3D 渲染和终局 Match Record JSON 仍可能造成 CPU 或内存峰值。
- **验收**：用真实双 LLM 长局运行至少 1000 tick，记录 tick wall time、RSS、浏览器 working set、终端 DOM 数量和终局保存耗时；终端文本布局对象应在预热后进入平台期。

### 2. ContextWindowLimiter 不是真正的上下文压缩

- **现状**：当前只按消息数量/字节删除旧 user 边界段，并截断超大消息；`ContextWindowLimiter` 不是持久 memory，也不是语义 compactor。
- **风险**：模型会失去较早的战略理由、任务上下文和 tool-call/result 配对，真正的上下文压缩还完全没有做；长局表现和 token 成本两块同时被拖。
- **下一步**：先定义模型可读摘要契约与保留事实，再实现真正 compactor；过程中关注与下一条 #3 的联动。

### 3. 缓存命中几乎完全未被优化

- **现状**：`OpenAICompatibleModelTransport` 能读取供应商返回的 `cached_tokens`，但 prompt 从未为缓存命中设计。当前没有稳定的 prompt 前缀、不动的 history 头或显式 cache control 写入点；turn 越往后、被裁掉的边界越多，前缀就越稳不住。
- **风险**：长局里多数 model request 的输入重用率低，命中率可能很低甚至为零。这可能是现在 turn latency / 成本不可控的主要来源之一，且与 #2 裁剪互成负反馈——越裁越稳不住前缀。
- **下一步**：先用真实 Match Record 量化各 request 的 `prompt_tokens / cached_tokens` 估算命中率，再决定是否推入稳定前缀、固定 cache 边界。此前不要盲加 cache control。

### 4. Match Record 运行中历史仍占内存

- **现状**：完整 delta 分块在 worker thread 完成 JSON + gzip 后以压缩形式留存；Match Record 仍只在终局写一次。
- **风险**：未完成的 delta buffer、turn 和命令结果仍会在极长 evaluation 对局累积，终局组装完整 JSON 也有峰值。
- **下一步**：先以真实长局数据证明问题，再选择有界采样或简单分段文件；不预建恢复/审计平台。

## 中优先级

### 已解决：关闭回放的 Benchmark 终局被前端误触发保存

- **根因与处理**：前端在 Benchmark 结果状态清空后仍把最后一轮的 `winner` 当作 live match 终局，发送无 match 身份的 `save_record`；服务端又按当前观察对象直接保存，最终撞上 `MATCH_RECORDING_DISABLED`。`state` 现在显式携带 observed match 的身份、类型和录制能力，自动保存与胜负弹层只对可录制 live match 生效；`save_record` 必须携带稳定 `matchId`，服务端在调用 Recorder 前校验 live 类型与录制策略。

### 5. `summary` 仍是字符串拼装

- **影响**：能工作，但不利于精确评估模型收到了哪些结构化变化。

### 6. 只读工具仍偏碎

- **现状**：`get_map_state / get_my_state / get_my_units / get_army_summary / get_active_plans / get_recent_events`。
- **方向**：有真实模型调用数据后再判断是否合并，不继续增加新查询工具。

### 7. Benchmark 前端缺少完整 Agent 指标

- **现状**：离线 Match Record 可以看到 model request、tool call 和 latency；实时结果面板只显示胜负、时长和少量汇总。

### 8. 3D 战斗表现仍缺正式动画

- **现状**：单位/建筑模型、弹丸和基本碰撞已存在；步兵仍缺完整行走、射击和死亡动画。单位阴影已改为稳定开启，不再按存活单位数跨过 60 的瞬间整体切换；投射物、补画攻击、爆炸和压力测试规模中缺少依据的硬截断也已移除。

### 9. 浏览器控制台仍有非阻塞告警

- **现状**：首次连接时可能短暂记录一次 WebSocket error/disconnect 后自动重连；Three.js 还会报告 `THREE.Clock` 已弃用。
- **影响**：对局、终局和保存均未受影响，但会给前端诊断增加噪音。

### 10. Benchmark 的 Random 策略随机性不足（CPU 调度间隔回归已解决）

- **现状**：Random 的行为分布仍不够随机，实测强度与 Rush 相近。`bc899cf` 曾误将“LLM 每个 committed tick 都有决策机会”的规则应用到 built-in CPU，导致 Benchmark 和 ControlPlane CPU 接近每 tick 决策；该调度回归现已修复。
- **处理**：恢复 CPU 专属的 `decisionIntervalTicks`，由 shared 统一定义默认值 10 和合法范围 1–60。Benchmark 前端、WebSocket、`BenchmarkOrchestrator`、`GameOrchestrator` 与 `ControlPlaneMatch` 使用同一语义；CLI 不维护独立默认值。LLM 仍保持空闲时每 committed tick 可调度，Mission 也仍逐 committed tick 推进。
- **验证**：Benchmark 和 ControlPlane 测试分别覆盖 CPU 首次派发、未满间隔不派发、达到 10 tick 再次派发，并验证 LLM 同期仍逐 tick 调度。真实短局中，前端 `oc-deepseek-v4-flash` 对 rush CPU 的请求 tick 为 `0/10/20/30`；OpenCode `deepseek-v4-flash` 通过 CLI control session 读状态并提交动作，CLI 启动响应显示服务端采用 `decisionIntervalTicks: 10`，evaluation record 中 CPU 命令 provenance 没有落在 10-tick 网格之外。Random 是否还存在独立的策略分布问题，需要在统一间隔后继续用相同 seed 对比动作类型、参战单位比例、目标选择和胜率。

### 11. 已解决：无限生产 plan 难以撤销，且不能表达真实生产队列

- **根因**：把 `spawn_unit` 放进无限循环的 `orchestrate_plan`，既让取消生产必须先理解 mission，又把“计划意图”和“建筑生产队列”混成两套状态；旧实现还在入队时一次性扣全款，无法暂停、退款或表达混合兵种顺序。
- **处理**：生产已从 plan call 集合移除。`spawn_unit` 改为给单座建筑追加有限且严格有序的 `{ unitType, count }[]`；新增 `get_production_queue` 和 `cancel_production`。生产逐 tick 扣款，缺钱暂停并自动恢复；取消订单或建筑被摧毁会退还当前未完成单位已支付的 credits；每建筑每兵种最多保留 100 个待生产单位。自动建造仍由 `orchestrate_plan` 负责，并保留动态占位立即换址与完成边界去重。
- **验证**：覆盖混合批次顺序、逐 tick 付款、缺钱暂停/恢复、显式取消退款、建筑摧毁退款、每兵种 100 上限，以及 LLM 工具的追加、查询和取消链路；`orchestrate_plan` schema 和运行时均拒绝 `spawn_unit`。

### 12. 单位移动观感卡顿并伴随位置抖动

- **现状**：单位移动给人的观感仍是一卡一卡的，部分单位在移动过程中还会出现位置抖动。已根据 `match-2026-07-29T15-07-50-390Z-13343a75` 修复一条确定的模拟层死锁：OBB 坦克贴近 HQ 且无法原地转向时可沿车身轴脱困，A* 中间格也不再要求精确压中；同处互相阻塞的 worker 可随之继续路径。其余视觉卡顿仍未定位。
- **风险**：移动推进不连续和局部抖动会明显影响战场可读性；两种现象可能分别来自服务端 tick 状态更新、客户端插值、路径修正或实例矩阵更新，暂不能假定为同一根因。
- **验收**：分别采集服务端位置序列和客户端逐帧渲染位置，确认卡顿与抖动各自发生在哪一层；修复后单位在正常网络和帧率下应连续移动，且路径修正时不出现可见的往返抖动。

### 13. 已解决：`attack_move` 集结点在 tick 边界退化为普通移动

- **根因与处理**：玩法工具正确生成了 `rallyMode: "attack_move"`，但 `Game.normalizeCommand` 的字段白名单遗漏该字段，导致真正执行时按默认 `move` 落盘。命令规范化现在显式保留合法 `rallyMode`，并同时保留同类嵌套字段 `resumeWorkerOrder`；回归测试穿过 GameplayController、Game 命令队列和 tick 执行边界验证建筑最终模式，而不只检查工具的即时返回。

### 14. 已解决：建造者死亡后 plan 永久残留且没有直接取消入口

- **根因与处理**：global 建造 step 的默认 retry 把“显式绑定单位已经死亡”也当成临时等待，且 LLM 只能查 `get_active_plans`，没有与之对称的取消工具。MissionRuntime 现在会让这种 plan 立即失败；新增 `cancel_plan({ planIds })`，与生产队列的 `cancel_production({ orderIds | buildingIds })` 明确分域。
- **实战证据**：`match-2026-07-29T16-16-36-665Z-da5edda4` 中 `plan_3` 的 worker 死亡后仍出现在 active 列表，DeepSeek 因没有计划取消入口而误把 `plan_3` 传给 `cancel_production`。回归测试覆盖主动取消和绑定单位死亡两条路径。

### 15. 已解决：Builtin CPU 因读取旧单位字段而整局不采矿

- **根因与处理**：`get_my_units` 已将瞬时状态从 `state` 改名为 `phase`，但 `BuiltinCPUStrategy.issueWorkerEconomy` 仍判断 `worker.state === "idle"`，导致 random/rush CPU 永远不会给普通空闲工人调用 `start_harvest_loop`。CPU 现改为读取 `worker.phase`，现有测试 fixture 同步到真实工具结果结构。
- **实战证据**：`match-2026-07-29T16-16-36-665Z-da5edda4` 中 CPU 的 4 个工人没有一次采矿调用；初始资金在完成 6 个机枪兵后降至 5，余下 8 个订单从 tick 65 起永久停在 `waiting_for_credits`。
