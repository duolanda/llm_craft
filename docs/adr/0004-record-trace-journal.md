# ADR 0004：统一 Match Trace Journal 是记录与分析的事实源

- 状态：Accepted
- 日期：2026-07-16
- 关联：[Roadmap](../roadmap.md)

## 背景

当前 record、纯文本 transcript、GameHistory、diagnostics、compact script 和 analyzer 各自保存或解释部分事实，格式与代码演进不同步。旧记录缺字段时，工具可能把“没有记录”误判成“没有发生”；长局历史和临时 journal 也缺少统一生命周期。

## 决策

- Phase 2 建立版本化 Match Trace Journal，使用结构化追加格式，而不是把纯文本 transcript 当作事实源。
- Journal 记录 manifest、MatchDefinition 摘要、命令、命令结果、DomainEvent、Agent/model/tool span、keyframe 和 state hash。
- 全链路使用 `matchId / actorId / turnId / modelRequestId / toolCallId / commandId / eventSequence` 关联。
- Replay、Transcript Explorer、Diagnostics、Analyzer 和 Experiment Runner 只通过统一 projector 读取 journal；纯文本 transcript 是可重新生成的导出物。
- schema 带明确版本、运行时校验和 capability 标记；旧数据缺失能力时显式报告，不静默补零。
- 活跃 journal 流式追加、分块并压缩，不要求整局历史常驻内存。对局完成后原子 finalize；异常遗留可在启动时识别和回收。
- record、benchmark record、导出 transcript 和临时 journal 使用配置化保留策略，并支持固定基准样本免清理。

## 事实与派生数据

- 命令、事件、模型请求和工具调用是原始事实。
- replay frame、经济曲线、反应时间、诊断标签和 transcript 文本是可重建的派生数据。
- 启发式诊断必须携带规则版本，不能覆盖或伪装成原始事实。

## 迁移顺序

1. Phase 0 只审计现有工具、保存基准样本，不在旧 GameOrchestrator 上建设最终 schema。
2. MatchRuntime、CommandEnvelope 和 DomainEvent 边界稳定后定义 schema v3。
3. 先写 validator/projector/migrator，再迁移 live record。
4. 依次迁移 CLI、benchmark、replay、transcript 和 analyzer，最后删除重复 diff/apply 与 compact 解释。

## 明确不做

- 不让每个 viewer 自己猜测 record 版本。
- 不通过扩展 `compact-v2` 临时字段继续累积隐式 schema。
- 不把 UI 文案、最终 WorldState 或单个 analyzer 的诊断结果当作完整对局事实。
- 不在 Phase 0 提前重写 Transcript Viewer。

## 影响

正式 journal 会增加 schema 与迁移维护成本，但能够把回放、模型行为、命令效果和批量实验放进同一证据链，并为容量治理提供统一入口。

## 实施进度

- 2026-07-16：`MatchTraceRecordV3`、显式 capability 与运行时 validator 已建立。MatchRuntime 的活跃 journal 已写 manifest、完整 command submission、DomainEvent、AI turn、terminal event 和逐提交 tick 的 state hash v2；manifest 含完整 MatchDefinition/seed 和生命周期状态。
- 2026-07-16：正式 `saveRecord()` 已切换为 Trace v3 finalizer；它对 journal/Game 历史捕获一致 cut，流式写临时文件、`fsync` 后原子 rename，并处理失败清理与同 cut 并发去重。Trace 内含事实流及显式派生的 replay projection。
- 2026-07-16：独立 `@llmcraft/trace` 包成为 server/client 共用的 validator、capability gate、migrator 和 projector。compact-v2 迁移把缺失事实标为 `absent`；Replay、Diagnostics 和 Analyzer 不再各自判断 v3 格式。
- 2026-07-16：`MatchRecorder` 已从 live orchestrator 提取，live 与 CLI/control-plane 共享同一个稳定 cut、写入串行化和 Trace v3 finalizer；MatchRegistry 的任意可保存 match 均可由 HTTP/CLI 按 `matchId` 落盘。
- 2026-07-16：临时 journal 已采用 owner/workspace 生命周期；终局 controller quiesce 后原子 finalize 并 seal 清理，优雅退出会保存全部应保留 match。失活 owner 与 legacy journal 可启动恢复，正式 artifact 与 orphan 恢复区有 dry-run-first retention、容量/年龄/数量限制和 pinned baseline 保护。
- 正式 Trace 文件压缩/分块和原生 Trace Transcript/Analyzer 仍是后续工作；当前已完成生命周期治理，但不能把单个未压缩 JSON 当成最终长局容器。
