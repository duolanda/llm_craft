# ADR 0002：所有控制者通过版本化命令与事件契约工作

- 状态：Accepted
- 日期：2026-07-16
- 关联：[Roadmap](../roadmap.md)

## 背景

Web、CLI、LLM 和旧的内建脚本驱动当前通过不同调用路径提交动作，部分 CLI 批量操作会跨 tick，命令归属、幂等和公平顺序不完整。`GameLog` 同时承担 UI 文案、AI 反馈、命令结果和历史事实，导致消费者重复解释。

## 决策

- `CommandGateway` 是唯一命令入口，所有 Controller 和外部控制面都必须经过它。
- 使用版本化 `CommandEnvelope` 表达 `matchId`、`actorId`、`baseTick`、`applyAtTick`、`sequence`、`clientRequestId` 和一组 `GameCommand`。
- 一个 envelope 原子接受或原子拒绝，并在 tick 内整体提交或整体回滚；相同 `clientRequestId` 重试不得重复执行。
- 命令只在 tick 边界生效，并按公开、确定性的顺序排序；墙钟到达先后不参与游戏内公平性。
- 命令和寻路预算按 actor、simulation tick 显式分配；固定 actor 排序不能永久抢占共享预算，拆分 envelope 也不能绕过上限。
- `SimulationCore.step` 输出结构化 `DomainEvent`。事件包含稳定类型、event sequence、发生 tick、actor/entity/command 关联和结构化 payload。
- 命令结果是 DomainEvent 的一种；UI log、AI recent events 和统计指标从事件投影产生，不再反向解析展示文案。

## 契约边界

- Command 表达意图，不能假定成功。
- CommandResult/Event 表达已经发生的事实，不能再次修改状态。
- WorldState 仍是当前权威状态；本阶段不要求只靠事件从零重建所有内部缓存，因此不是纯 event sourcing。
- keyframe、命令、事件和 state hash 共同支持校验与回放。

## 迁移顺序

1. 在现有命令队列外建立兼容 CommandGateway。
2. 先覆盖 build、spawn、move、attack 等核心命令及结果。
3. 迁移 Web、LLM 和 CLI；确定性测试驱动通过 test adapter 接入；删除各路径的私有批处理语义。
4. 将现有 GameLog 降级为事件投影，最后删除消费者中的文案解析。

## 明确不做

- 不把 CLI HTTP 请求到达时间当作命令执行时间。
- 不允许 Controller 绕过 Gateway 直接调用 Manager。
- 不在 DomainEvent payload 中塞入完整 WorldState 或仅供某个页面使用的格式化文本。

## 影响

命令会增加关联字段和校验成本，但能够实现公平调度、原子批处理、幂等重试和跨工具的统一结果解释。

## 实施进度

- 2026-07-16：shared 已定义 `CommandEnvelopeV1`、接收结果/拒绝码和 `DomainEvent` v1 基础外层。
- 2026-07-16：MatchRuntime 现持有对局专属 CommandGateway；Gateway 实现整批接受/拒绝、精确重试去重、ID 冲突拒绝、actor 所有权、未来 tick 窗口和 `actorId -> sequence -> clientRequestId` 确定性排序。
- 2026-07-16：LLM live、plan/Mission 推进与 CLI/control-plane 动作已迁入 Gateway；Game 仅保留兼容命令执行队列。
- 2026-07-16：MatchRuntime 已将 envelope 接纳/拒绝/释放/回滚、每个 command result 和 SimulationCore outcome 写入同一条 DomainEvent v1 流；MatchJournal 分配单调 eventSequence 并流式追加 NDJSON。命令结果可从 `actor/clientRequest/command/entity` 直接关联，无需解析文案。GameLog projector 和 Trace schema v3 仍待后续迁移。
- 2026-07-16：CLI selection/pairing 与 action orchestration 已使用单 HTTP batch 和单 envelope；controller 预校验与 Game 世界状态各有事务快照。任一批内命令失败或预算不足会回滚整批，幂等重试返回原结果。
- 2026-07-16：首版公平预算为 Gateway 按 actor/apply tick累计接纳 100 条总命令、执行阶段全局每 tick 4 条路径命令；活跃 actor 先等额保底，空余额按 tick 轮换借出，拆 envelope 不能绕过。
