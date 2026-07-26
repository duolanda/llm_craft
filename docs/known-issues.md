# 已知问题

只记录当前代码仍存在、尚未解决的问题。已修复 / 已完成的历史问题不再在此累积，可在 git 历史中查阅。

## 高优先级

### 1. 大地图与长局性能仍需真实 LLM 对局复测

- **现状**：Agent read path 已减少重复完整状态读取，WebSocket 对慢客户端采用 latest-projection-wins；移动改为静态 A* 与有界局部避障分层，动态拥堵不再触发同 tick 重寻路。
- **风险**：144x96 地图、大军团首次 A*、状态序列化和终局 Match Record JSON 仍可能造成 CPU 或内存峰值。
- **验收**：用真实双 LLM 长局记录 tick wall time、RSS、浏览器 working set 和终局保存耗时。

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

### 5. `summary` 仍是字符串拼装

- **影响**：能工作，但不利于精确评估模型收到了哪些结构化变化。

### 6. 只读工具仍偏碎

- **现状**：`get_map_state / get_my_state / get_my_units / get_army_summary / get_active_plans / get_recent_events`。
- **方向**：有真实模型调用数据后再判断是否合并，不继续增加新查询工具。

### 7. Benchmark 前端缺少完整 Agent 指标

- **现状**：离线 Match Record 可以看到 model request、tool call 和 latency；实时结果面板只显示胜负、时长和少量汇总。

### 8. 3D 战斗表现仍缺正式动画

- **现状**：单位/建筑模型、弹丸和基本碰撞已存在；步兵仍缺完整行走、射击和死亡动画。

### 9. 浏览器控制台仍有非阻塞告警

- **现状**：首次连接时可能短暂记录一次 WebSocket error/disconnect 后自动重连；Three.js 还会报告 `THREE.Clock` 已弃用。
- **影响**：对局、终局和保存均未受影响，但会给前端诊断增加噪音。