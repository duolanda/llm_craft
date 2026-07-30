# ADR 0002：所有控制者通过统一命令入口工作

- 状态：Superseded in part by ADR 0005
- 日期：2026-07-16
- 关联：[Roadmap](../roadmap.md)

## 背景

Web、CLI、LLM 和旧的内建脚本驱动当前通过不同调用路径提交动作，部分 CLI 批量操作会跨 tick，命令归属、幂等和公平顺序不完整。`GameLog` 同时承担 UI 文案、AI 反馈、命令结果和历史事实，导致消费者重复解释。

## 当前保留的决策

- `GameplayController` 是 LLM、CLI 和 CPU 的统一玩法入口。
- 所有状态修改都转换为 `Command`，交给当前 `MatchRuntime` 的 `CommandGateway`，并只在 tick 边界执行。
- `CommandGateway` 校验 match、actor、tick、命令 ID、幂等键并提供稳定排序。
- envelope 的结构接纳是整体的；进入游戏后每条命令独立成功或失败，不做世界快照或整批回滚。
- CLI batch 逐 action 执行并返回 `partialSuccess`；相同 `clientRequestId` 的相同请求可安全重试。

## 被 ADR 0005 删除的部分

版本号、每 actor 命令额度、全局路径额度、持久事件流、state hash、checkpoint 和事件溯源脚手架均无已证明的消费者，不再属于命令契约。
