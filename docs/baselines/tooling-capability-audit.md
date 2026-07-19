# Record、Transcript 与分析工具能力审计

- 日期：2026-07-16
- 状态：Phase 0 事实清单
- 原则：这里只记录当前能力边界，不在旧 GameOrchestrator 上建设最终观测平台

## Record / Replay

当前 live `saveRecord()` 输出 Trace v3：manifest、initial/final keyframe、command submissions、DomainEvents、state hashes、AI/terminal 流是事实/证据层；`replayProjection` 是显式派生缓存，包含兼容 GameRecord 所需 metadata、tickDeltas 和 commandResults。保存对一致 cut 使用临时文件、流式写出、`fsync` 和原子 rename。

已知缺口：

- 正式 Trace v3 仍是未压缩的单 JSON 文件，尚未成为分块容器。
- model request / tool call span capability 仍可能是 partial，不能从现有事实流补造隐藏请求细节。
- aiTurns 在旧记录中可能为空、仅覆盖一方或只覆盖部分回合，不能据此把模型请求和工具调用计为零。
- Replay、Diagnostics 和 Analyzer 虽已统一通过 projector 兼容读取，仍不是原生 DomainEvent/span explorer。

2026-07-16 后，record、benchmark record、两类 transcript 和 orphan journal 已有最大年龄、数量、容量和固定样本保护；正式 artifact 默认 dry-run、显式 apply，异常恢复区自动治理。该能力不改变旧 record 的事实缺失。

可信用途：当前代码产生的新 record 可用于个案回放和命令结果检查。

不可信用途：没有版本/capability 证明的旧 record 不能直接用于当前平衡比较，也不能证明“模型没有调用工具”。

## Transcript

服务端当前按 `transcript=tx_*` 写入 request、assistant、tool_call 和 result 块，能够区分 player、requestTick 和同局内的 run。

已知缺口：

- `packages/client/src/transcriptViewer.tsx` 仍要求旧 header：`mode=full|delta requestTick executeTick model`。
- Viewer 仍解析旧的 `response / parsed_code / provider_error / commands / sandbox` section；当前服务端已经是 tool-calling transcript，两者不兼容。
- 纯文本块不是经过 schema 校验的事实源，跨双方 turn 的关联、模型内部 request span、重试和 token/cache 细节不完整。
- transcript 是按局 append 的可选 debug 文件，尚不是 Trace 原生 explorer 输入；但文件本身已进入统一的年龄/数量/容量 retention，并受 dry-run/apply 与 pin 保护。

可信用途：直接阅读当前 `.log`，核对某个 `tx_*` 的 summary、assistant、tool call 和最终 result。

不可信用途：当前 Transcript Viewer 的解析结果；在 Trace schema 稳定前不应继续修补旧 parser 作为长期方案。

## `analyze-record.mjs`

当前 analyzer 能汇总胜负、经济、命令结果、工具调用，并输出 HQ 压力/掉血/死亡时间线。它会在整份 record 没有 aiTurns 时提示 agent 信息不可用。

已知缺口：

- 时长固定按 `tick × 500ms` 计算，没有读取版本化 MatchDefinition。
- 核心汇总和快照仍硬编码 `soldier`、`barracks`，不能完整代表 rifleman、rocket_soldier、light_tank、war_factory 和 refinery。
- `floating_credits`、`production_bottleneck_possible` 等阈值没有 ruleset/诊断规则版本。
- aiTurns 部分缺失时，按玩家显示的 `modelRequests=0/toolCalls=0` 仍可能被误读为真实零值。
- 没有 schema validator；旧记录字段存在但语义已变化时可能静默继续分析。

可信用途：针对已知 record 版本做个案时间线定位，并结合人工核对。

不可信用途：跨规则版本的模型排名、平衡结论或仅凭单个 flag 自动调数值。

## Client Diagnostics

当前 diagnostics 可以从 record 重建单位/建筑生命周期、经济和命令/turn 时间线，并在浏览器中选择已有 record。

已知缺口：

- duration 同样硬编码 500ms。
- 多处统计只识别 `soldier`；新兵种会漏计或被错误归类。
- tool/turn 事件通常归到 `turn.requestTick`，不能表示同一 turn 内每次模型请求、工具开始/结束和命令实际应用 tick。
- 部分历史命令分类使用 `finalWorld`，可能用最终状态解释早期行为。
- 它与 server analyzer 拥有独立启发式和 delta 解释，没有共享规则版本。

可信用途：当前已知格式的人工复盘辅助。

不可信用途：精确模型反应延迟、跨版本指标对比或无人复核的自动诊断。

## Benchmark

当前 benchmark 能批量运行 LLM vs CPU、并发多局、保存每轮 record，并汇总胜负和时长。

已知缺口：

- 对外结果仍以胜率、局长等粗指标为主，Agent runtime 的内部 request latency、reasoning/cache tokens、重复读取和 mission/战术分类没有形成统一实验数据集。
- CPU 仍通过 `LLMProvider` 外形接入，Controller 与 ModelTransport 尚未拆分。
- 没有 experiment manifest 来固定代码、规则、Prompt、模型参数、seed、重复次数和统计口径。

## Phase 2 之前的处理规则

2026-07-16 进度：DomainEvent v1 已能从 `envelope -> command_result -> simulation outcome` 生成单调序列；正式 Trace v3 finalizer 与独立 `@llmcraft/trace` validator/migrator/projector 已落地，Replay、本地 JSON、Diagnostics、Analyzer 和 compact 导出工具均可读取 v3。通用 `MatchRecorder` 已让 live 与 CLI/control-plane 进入同一保存路径，benchmark round 也进入统一 MatchRegistry。Transcript Viewer 仍是文本解析器，Analyzer 目前也主要消费兼容 replay projection，并非原生事件/span 分析器，因此下列保守使用规则对深层模型诊断仍然有效。

- 保留现有工具用于人工排查，不扩展旧格式为最终平台。
- 修复会阻塞架构迁移的明显错误可以进入，但不重写 Transcript Viewer 或新增另一套 schema。
- 所有分析结论必须同时标注 record 版本、缺失能力和人工复核范围。
- 最终替代路径由 [ADR 0004](../adr/0004-record-trace-journal.md) 约束。
