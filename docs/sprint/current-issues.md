# Sprint - 当前问题清单

> 只记录当前代码仍存在或本轮刚关闭的问题；历史设计不继续作为现状累积。

## 高优先级

### 1. 大地图与长局性能仍需真实 LLM 对局复测

- **现状**：Agent read path 已减少重复完整状态读取，WebSocket 对慢客户端采用 latest-projection-wins；移动改为静态 A* 与有界局部避障分层，动态拥堵不再触发同 tick 重寻路。
- **风险**：144x96 地图、大军团首次 A*、状态序列化和终局 Match Record JSON 仍可能造成 CPU 或内存峰值。
- **验收**：用真实双 LLM 长局记录 tick wall time、RSS、浏览器 working set 和终局保存耗时。

### 2. ContextWindowLimiter 不是真正的 compactor

- **现状**：当前只按消息数量/字节删除旧 user 边界段，并截断超大消息。
- **风险**：模型会失去较早的战略理由和任务上下文；它不能替代持久 memory 或 Codex/pi 风格语义压缩。
- **下一步**：先定义模型可读摘要契约与保留事实，再实现真正 compactor。

### 3. Match Record 运行中历史仍占内存

- **现状**：完整 delta 分块在 worker thread 完成 JSON + gzip 后以压缩形式留存；Match Record 仍只在终局写一次。
- **风险**：当前未完成的 delta buffer、turn 和命令结果仍会在极长 evaluation 对局累积，终局组装完整 JSON 也有峰值。
- **下一步**：先以真实长局数据证明问题，再选择有界采样或简单分段文件；不预建恢复/审计平台。

## 中优先级

### 4. `summary` 仍是字符串拼装

- **影响**：能工作，但不利于精确评估模型收到了哪些结构化变化。

### 5. 只读工具仍偏碎

- **现状**：`get_map_state / get_my_state / get_my_units / get_army_summary / get_active_plans / get_recent_events`。
- **方向**：有真实模型调用数据后再判断是否合并，不继续增加新查询工具。

### 6. Benchmark 前端缺少完整 Agent 指标

- **现状**：离线 Match Record 可以看到 model request、tool call 和 latency；实时结果面板只显示胜负、时长和少量汇总。

### 7. 3D 战斗表现仍缺正式动画

- **现状**：单位/建筑模型、弹丸和基本碰撞已存在；步兵仍缺完整行走、射击和死亡动画。

### 8. 浏览器控制台仍有非阻塞告警

- **现状**：首次连接时可能短暂记录一次 WebSocket error/disconnect 后自动重连；Three.js 还会报告 `THREE.Clock` 已弃用。
- **影响**：本轮真实对局、终局和保存均未受影响，但会给前端诊断增加噪音。

## 本轮已完成

- [x] 删除 system prompt 和状态工具中的固定开局、六步枪兵阈值、编队、反制与 HQ 强攻脚本；状态改为客观事实和合法建造选项。
- [x] `move_unit` / `attack_move_unit` / `attack` 改为框选式 `unitIds` 批量命令，删除独立 `attack_move_group` 及 formation 参数。
- [x] `build_structure` 支持自动合法工地、自动走位施工和完工后恢复原采矿循环。
- [x] 撤除固定 tick-0 初始决策屏障；`start` 立即启动时钟并派发双方决策，让首次与后续模型响应延迟采用同一实时规则，保留显式可选 warmup。
- [x] 动作失败直接返回紧凑恢复候选，批量命令将共享候选提升到顶层，避免 hint 诱导额外状态读取和候选列表重复膨胀。
- [x] plan 等待状态增加结构化 `waiting.code/message/details`，区分余额不足、单位移动中、同一命令已生效、装填、工人未到位、生产队列忙、前置科技缺失和目标不存在等原因。
- [x] 将 `feat/3d` 之后的历史提交压成一个 commit，保留本轮未提交修改。
- [x] 普通 live 拒绝重复 start；重复 `llmcraft play` 只报告 active match；前端可切换观察 registry 中的对局。
- [x] 将 HQ 和初始单位位置纳入 `MapDefinition.playerStarts`。
- [x] 删除每 actor 100 条命令、每 tick 4 条路径命令和阻塞重寻路额度。
- [x] 删除 envelope/tick checkpoint 与回滚；CLI batch 改为逐 action 部分成功。
- [x] 删除 state hash、RNG checkpoint、持久 DomainEvent、事实工作区和自动 artifact retention。
- [x] 删除 100ms poll，改为 committed tick / match ended 通知。
- [x] group attack move 一次提交全部编队命令，删除跨 tick pending release。

## 本轮已修复

### [x] 长局实时帧重复完整状态，造成浏览器高负载

- **证据**：`match-2026-07-25T16-25-51-522Z-b3af6e97.match.json` 的单次 state broadcast 从开局约 1.30 MB 增长到 T831 约 2.25 MB；按 837 ticks 重建各帧估算，每个 WebSocket 连接累计处理约 631 MB 状态副本。
- **原因**：每 tick 都附带完整 `latestSnapshot`，keyframe 又在顶层 `state` 和 `frame.state` 重复同一份完整状态。
- **修复**：实时协议只以 `frame` 传输 keyframe/delta；保留兼容字段外形，但 `state` 固定为 `null`、`snapshots` 固定为空数组。

### [x] 局部避障把横向位移当成有效进度，导致 worker 振荡和坦克拥堵

- **证据**：同一录像中 `unit_2` 在 `(34,58)` / `(33,58)` 之间逐 tick 往返，`unit_24`、`unit_34`、`unit_45` 有同类轨迹；蓝方多数轻坦在 T700–750 位置完全不变，但仍持有 `attack_move` 路径。
- **原因**：局部避障按固定顺序返回第一个可行候选；任意位移都清除 blocked 计数，没有前向进度、两点振荡或长时间拥堵逃生判定。
- **修复**：评估全部有界候选并优先前向进度；无进度侧移保留 blocked 压力，禁止立即返回上一位置；持续拥堵后开放扩展侧移和保持 OBB 朝向的倒车逃生候选。同时将单格矿点的并发分配上限收敛为 2，超出后自动改派，避免 worker 在矿点终点形成物理上无法解开的包围。

### [x] 持续攻击追逐移动目标时会生成非法浮点移动坐标

- **证据**：`match-2026-07-25T15-22-26-781Z-2fa7478d.match.json` 中 player_1 出现 1037 次、player_2 出现 33 次 `move_blocked`，全部细分为 `move_bad_target`；示例目标为 `(68.98768721173717, 44.836268045551485)`，反馈为 `Use integer map coordinates.`。
- **原因**：有目标攻击在目标未进入射程时，直接把移动中目标的连续坐标写入 `move` 命令；宏观调用首次生成错误命令后，tactical 持续攻击循环会逐 tick 重发同类非法坐标。
- **影响**：单位可能长期无法追击移动目标，制造大量失败日志和命令，严重扭曲交战结果；该录像中 player_1 的 1037 次失败里 904 次来自 tactical 重试。
- **修复**：持续 `attack` 和 attack-move 的追击分支统一把目标连续坐标四舍五入并限制到地图内，再提交给移动系统；已增加两条浮点移动目标回归测试。

### [x] 自动建造计划可能在尚未贴近建筑占地时提前结束移动步骤

- **证据**：同一录像中 player_2 的 refinery 自动计划选择建筑中心 `(122,48)`、施工位 `(121,45)`；工人停在 `(122,44)` 后，移动 step 因 `near_position distance=1` 被判完成，但建造 step 在 T47、T64 持续返回结构化 `worker_not_adjacent`，最终模型另行选址才于 T106 开工。
- **原因**：推荐的 `workerPosition` 已经是精确合法施工格，但内部移动 step 仍允许距离 1 的宽松完成条件；这个容差不能保证工人实际与多格建筑 footprint 相邻。
- **影响**：自动 `build_structure` 虽然不再诱导模型反复重写计划，却仍可能永久停在建造 step，延误科技建筑。
- **修复**：新增 `worker_adjacent_to_build_footprint` 计划条件，内部自动建造只在 worker 实际位于完整 footprint 外侧一格时进入建造步骤；已增加多格建筑计划回归断言。
- [x] `AgentMemoryPolicy` 改为 `ContextWindowLimiter`，并明确其临时性质。
- [x] `GameAgentBridge` 改为统一 `GameplayController`；调度来源改称 `DecisionController`。
- [x] `BuiltinTestController` 改为 `BuiltinCPUController`，CPU 定位为模型 benchmark baseline。
- [x] `ExperimentRunner` 收回为 `BenchmarkRunner`；`analyze-record.mjs` 保持独立。
- [x] 统一为 Match Record，提供 off/replay/evaluation 与可选 transcript；删除详细记录格式、状态 hash 和独立人类日志。
- [x] 用真实 CLI-vs-rush 对局验证 Registry、GameplayController、WebSocket 3D 投影、自然终局、自动保存和离线分析链路。
- [x] 修复真实终局中 control state 已有 winner、lobby status 仍显示 `running` 的不一致，并增加回归测试。
- [x] 修复实时 3D 帧插值在状态投递抖动时造成全地图单位同步停顿；实时对局恢复 `feat/3d` 的本地 smoothstep 补间，确定性帧缓冲仅用于回放。
- [x] 恢复实时对局的暂停/继续语义；暂停不再隐式保存，暂停后可手动保存并继续同一对局。
- [x] Match Record 文件名恢复以可排序的 ISO 时间戳开头，并保留短 match id 防碰撞。
- [x] 从 `get_my_state.buildOptions` 删除候选工地预计算；选址只在 `build_structure` 省略坐标时执行，显式坐标非法时才返回 `suggestedPlacements`。
- [x] 查明 tick 314 卡死根因：圆形碰撞拒绝 A* 首步后，同一 tick 不断取得同一路径且没有进度/退出条件；将移动改为静态 A*、空间索引和固定候选数的局部避障，动态单位不进入同 tick 重寻路，并增加相邻坦克与拥堵长跑回归测试。
- [x] 恢复每 100 tick 的 gzip delta 分块；每 tick 只向 worker 投递一个小 delta，worker 内封块，JSON 序列化、压缩和保存前解压均不占模拟线程，worker 失败时保留 raw fallback。
- [x] 修复新局部避障后单位更容易视觉穿模：原轻坦 0.56 格圆形碰撞远小于渲染车体。步兵改用圆、轻坦改用约 `2.96 × 1.96` 格 OBB，建筑/障碍使用静态 AABB；权威 heading 贯通模拟、录像与前端插值，精确 Circle/OBB SAT 统一覆盖终点、出生、扫掠、局部避障和有界拥堵解叠，A* 使用 OBB 包围圆保守净空。
