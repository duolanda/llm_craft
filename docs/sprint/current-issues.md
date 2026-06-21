# Sprint - 当前问题清单

> 记录当前 MVP 中仍然存在的真实问题和待改进项

## 高优先级

### 1. 实时对局 tick 存在可观察卡顿
- **描述**: OpenRA 迁移后 live match 中出现 tick 26s 到 27s 实际耗时明显超过 1s、单位移动冻结后跳变的现象；诊断确认主要由 agent read path 反复同步 `game.getState()`、重复 deep clone 完整 state/logs，以及 `get_my_state` 建造点推荐每格重复状态读取放大导致。已增加 backend-only `perf_warning`，并将 agent read path 改为同 tick 共享轻量 read state，待 live 复测确认
- **影响**: 直接破坏实时观战和操控反馈；后续地图和机制继续扩展时，AI hot path 必须避免完整 client/replay state clone

### 2. WebSocket 状态同步仍是定时推送
- **描述**: 当前 `state` 仍然是每连接 `100ms` 固定推送一次，不是严格事件驱动
- **影响**: 有额外序列化和无效推送开销，后续做更细粒度同步会受限

### 3. 96x64 大地图后的寻路和状态同步需要复测
- **描述**: 默认地图已扩大到 `96 x 64`，前端主视口切到 Three.js 3D 战场，但服务端 A*、agent `asciiMap`、回放快照和 WebSocket 全量 state 推送仍沿用原有结构
- **影响**: 大军团单位数上来后，寻路重算、快照 clone、ASCII 地图体积和前端渲染对象数量都可能成为新瓶颈，需要用 live match / benchmark / 回放复测确认

### 4. 3D 表现仍缺正式战斗动画和逻辑占地
- **描述**: Phase 17 已修正坦克炮塔原点/前向轴，删除远景兵种图标，并通过重机枪、弹药背包、肩扛火箭筒、备用火箭和工程护甲重做模型本体辨识；兵种主体保留深色、沙色和工程黄色差异，头盔、肩甲、背包外壳、发射器环带和载具装甲使用约 30% 的连续队色区域，使红蓝阵营在无图标远景下仍可辨认。当前剩余差距主要是步兵仍使用实例矩阵模拟移动和射击，没有正式骨骼行走/射击/死亡动画；大型建筑在服务端仍只占一个离散坐标点，视觉占地与寻路碰撞不一致。后续性能优化必须以浏览器截图保持视觉等价为前提
- **影响**: 静态模型和百单位渲染基础已不再是几何占位物，但战斗观感及建筑周边路径仍未达到最终 RTS 品质；下一阶段必须补动画/特效并把建筑占地纳入建造校验、寻路、攻击距离和单位出生点

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
- **描述**: 当前只读工具拆成了 `get_map_state / get_my_state / get_my_units / get_active_plans / get_recent_events`
- **影响**: 对 agent 来说查询入口偏多，后续需要收敛到 `3` 个（查地图、查自己、recent）或 `2` 个（查所有、recent）工具，并主要通过简单参数完成过滤，而不是继续增加新读工具

### 7. 高级编排层仍需验证 LLM 实际使用效果
- **描述**: `orchestrate_plan` 已支持基于现有动作工具的 call steps，但还缺少 benchmark/transcript 数据验证模型是否会稳定使用
- **影响**: 表达力已比旧 DSL 更贴近工具调用心智模型，但是否能显著减少微操和提高胜率仍需实测

### 8. Benchmark 面板还没消费新 runtime 细节
- **描述**: 服务端内部已有 tool calls / plans / stopReason 等 runtime 细节，但 benchmark 结果面板还未充分展示
- **影响**: 回放已经能看到 tool-driven agent 行为，但 benchmark 视角仍不够完整

### 9. 日志文件名时间戳仍使用 UTC 时间
- **描述**: 当前对局日志/回放等文件名里的时间戳使用 UTC 时间，与本地开发和排查时常用的北京时间不一致
- **影响**: 按文件名定位具体对局时需要额外换算时区，容易和控制台、本地观察时间产生偏差；后续可评估改为北京时间或在文件名中显式标注时区

### 10. CLI/control-plane 对局不会保存 record 文件
- **描述**: CLI PVP / CLI vs CPU 走 `ControlPlaneMatch`，目前没有接入 `GameOrchestrator.saveRecord()` 的落盘路径，也没有 control API 暴露保存回放入口
- **影响**: CLI agent 对打可在内存中推进并通过 `state/events` 观察，但结束后不会留下 `logs/records/*.json`，不利于复盘、离线分析和 benchmark 横向比较；后续应抽出通用 record builder，或为 control-plane 增加 `saveRecord()` / `POST /api/control/save-record`

## 已完成 ✅

- [x] 暂时移除缺少侦察兵、雷达和 last-seen 配套的战争迷雾读取层，恢复双方全图情报，同时保留单位局部自动索敌范围
- [x] 重建 HQ、兵营、战车工厂和精炼厂的功能轮廓，解决四类建筑都像通用工业盒体的问题
- [x] 移除 `AISandbox` 与 `Node vm` 主链路
- [x] live match 切到 tool-calling agent runtime
- [x] benchmark 切到同一套 tool-calling runtime
- [x] 只读工具统一为 `get_map_state / get_my_state / get_my_units / get_active_plans / get_recent_events`
- [x] 引入 `orchestrate_plan` 扁平 call-step 计划
- [x] 回放与 transcript 改为记录 tool calls / plans / commands / stop reason
- [x] 修复 action tool 命令要等整轮 agent run 结束后才入队，导致长链 tool-calling 期间单位表面“无动作”的时序问题
- [x] 为 tool-calling runtime 增加工具结果 tick、动作预校验和 stale-read warning，减少长 run 使用过期单位/建筑 ID 的无效命令
- [x] 为 OpenAI-compatible provider 增加同名同参数 read tool result 折叠，保留 assistant 文本但淘汰旧观察大 JSON
- [x] 清理 `AIStatePackageBuilder` 与 `AIPromptPayload(full/delta)` 兼容残留
- [x] 修复单位走到目标后仍保留 `moving` 状态与一次性 `move` intent，导致 agent 误判单位还在移动
- [x] 将 `get_map_state` 默认响应压缩为 ASCII 小地图 + 实体列表，并把逐格 `cells` 改为显式请求
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

---

*最后更新: 2026-06-17*
