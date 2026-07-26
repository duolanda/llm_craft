# ADR 0004：统一 Match Trace Journal 是记录与分析的事实源

- 状态：Superseded by ADR 0005
- 日期：2026-07-16
- 关联：[Roadmap](../roadmap.md)

## 废弃说明

本 ADR 提议的 journal、状态 hash、版本迁移、capability、恢复和 artifact retention 平台没有真实消费者，实施成本也显著高于当前问题规模，因此整体废弃。

当前唯一用户产物是 ADR 0005 定义的 Match Record：

- `off / replay / evaluation` 三个档位；
- transcript 由 `includeTranscript` 单独控制；
- 终局写一个 `.match.json`，运行中不重写大文件；
- `@llmcraft/record` 只做校验、历史普通 JSON 导入和回放投影；
- `analyze-record.mjs` 独立读取 Match Record，不属于记录生命周期平台。

未来只有在出现具体丢失样本、明确消费者和可验证恢复目标后，才重新讨论增量日志或崩溃恢复。
