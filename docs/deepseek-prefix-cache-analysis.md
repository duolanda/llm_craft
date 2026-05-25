# Reasonix Prefix Cache 调研与 LLMCraft 可借鉴点

> 调研目标：看看 [esengine/deepseek-reasonix](https://github.com/esengine/deepseek-reasonix) 的 DeepSeek prefix cache 设计里，有哪些原则适合迁移到 LLMCraft。
>
> 结论先行：可借鉴的是上下文稳定性原则，不是照搬 Reasonix 的产品形态。LLMCraft 是双 AI 实时对战，胜负质量比纯成本更重要；但当前 agent loop 里确实有几个会破坏 prefix cache 的点，值得修。

---

## 1. DeepSeek prefix cache 的真实约束

DeepSeek 的 Context Caching 默认开启，不需要额外 API 参数。官方文档描述的关键规则是：

- 后续请求如果复用了已经持久化的相同前缀，可以命中 cache。
- 匹配从第 0 个 token 开始，要求完整复用某个 cache prefix unit。
- cache 是 best-effort，不保证 100% 命中。
- response usage 中有 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens` 可观测。

官方当前价格（截至 2026-05-26，价格可能变动）：

| 模型 | Cache hit input / 1M | Cache miss input / 1M | Output / 1M |
|---|---:|---:|---:|
| `deepseek-v4-flash` | `$0.0028` | `$0.14` | `$0.28` |
| `deepseek-v4-pro` | `$0.003625` | `$0.435` | `$0.87` |

这意味着在 v4-flash 上，cached input 约为 uncached input 的 2%；在 v4-pro 当前价格上，cached input 约为 0.83%。工程收益足够大，但前提是客户端不要频繁改变请求前缀。

参考：

- DeepSeek pricing: https://api-docs.deepseek.com/quick_start/pricing
- DeepSeek context caching: https://api-docs.deepseek.com/guides/kv_cache

---

## 2. Reasonix 值得看的不是数字，而是不变量

Reasonix README 和 benchmark 给出的单日案例是：

| 指标 | 数值 |
|---|---:|
| Input cache hit tokens | 435,033,856 |
| Input cache miss tokens | 767,616 |
| Output tokens | 179,763 |
| Input cache hit ratio | 99.82% |

按 Reasonix benchmark README 中的当前 v4-flash 价格表计算，该 workload 约为 `$1.38`，如果完全没有 input cache 约为 `$61.06`。

这个数据只能说明：在某个真实用户的一天里，Reasonix 的 prompt 组织方式非常 cache-friendly。它不能直接推出 LLMCraft 也能达到 99%+，因为 LLMCraft 每个 game turn 都会注入变化的战场状态，天然比代码助手更动态。

Reasonix 真正值得借鉴的是这些不变量：

1. **固定前缀只计算一次**
   system prompt、tool specs、few-shot 示例等尽量固定，不在每次请求时重新拼接随机内容、时间戳或顺序不稳定的数据。

2. **历史消息只追加，不原地改写**
   如果旧观察过期，追加一条新消息说明它过期，而不是修改旧 tool result 的 `content`。

3. **临时状态不要进入下一轮 prompt**
   本轮 scratch、内部计划、reasoning 摘要等如果只是执行时辅助，不要写回长期对话历史。

4. **压缩是成本/质量权衡，不是免费 cache 魔法**
   一旦删除历史头部或替换早期消息，下一个请求的前缀就会改变。可以做 compaction，但要把它当作必要时的上下文治理，而不是声称不破坏 cache。

参考：

- Reasonix README: https://github.com/esengine/deepseek-reasonix
- Reasonix architecture: https://github.com/esengine/deepseek-reasonix/blob/main/docs/ARCHITECTURE.md
- Reasonix real-world cache case: https://github.com/esengine/deepseek-reasonix/blob/main/benchmarks/real-world-cache/README.md

---

## 3. LLMCraft 当前已经做对的地方

当前 `OpenAICompatibleProvider` 里有几个设计天然有利于 prefix cache：

- `SYSTEM_PROMPT` 是常量，不含时间戳或随机字段。
- 每个 provider 实例持有自己的 `history`，每轮从 `system + history + current user input` 继续。
- assistant message 和 tool result 正常追加到 `messages` 和 `persistentHistory`。
- `injectUrgentRuntimeAlert()` 用 `messages.push(...)` 注入 HQ 告警，没有插入到历史中间。
- `injectSubAgentNotifications()` 也是 append 模式，并且同步写入 `persistentHistory`。

这些都符合 Reasonix 的 append-only 基本方向。

---

## 4. 当前最值得修的 cache 破坏点

### 4.1 会原地改写旧 tool result

`OpenAICompatibleProvider.expireSupersededReadToolResults()` 会遍历历史消息，并把旧的同名同参数读取结果改成：

```json
{
  "expired": true,
  "reason": "superseded_by_new_read",
  "message": "This older read result was replaced..."
}
```

这对模型行为有帮助，但对 prefix cache 不友好：旧消息一旦参与过上一轮请求，下一轮再修改它的 `content`，前缀就变了。

更 cache-friendly 的替代方案：

- 不改写旧 tool message。
- 新读取完成后，追加一条短消息，例如：

```json
{
  "role": "tool",
  "tool_call_id": "<current-call-id>",
  "name": "get_map_state",
  "content": "{\"supersedes\":[\"old-call-id\"],\"result\":...}"
}
```

或者追加一条 user/system 风格的 runtime note，告诉模型哪些旧 call id 已被替代。关键是：旧消息字节不要变。

### 4.2 tools 每次请求都会重新映射

`createAgentCompletion()` 每次都从 `options.tools.map(...)` 构造 OpenAI tool definitions。当前 tool 列表来自静态代码，实际风险不算最高，但如果后续增加动态工具、MCP 工具、按玩家状态启停工具，序列化稳定性会变差。

可借鉴 Reasonix 的做法：

- provider 初始化时冻结 tool specs，或在 `AgentRuntime` 创建时冻结。
- 对 schema key 做稳定排序。
- 请求时复用同一份 tool definitions，而不是每次重新生成。

### 4.3 没有记录 DeepSeek cache telemetry

DeepSeek 会返回 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。LLMCraft 现在只记录 `modelRequests`、`toolCalls`、`stallDetected` 等指标，没有把 cache hit/miss 写入 `AgentRunMetrics` 或 transcript。

这会导致后续优化没有反馈闭环。建议先加观测，再讨论重构：

- 每次 model response 后读取 usage。
- 聚合到单次 run 的 metrics。
- transcript 中记录 hit/miss tokens、finish_reason、latencyMs。
- client UI 可以先不展示，日志里有就够。

### 4.4 战场状态是动态输入，不能盲目追求 99%+

LLMCraft 每个 turn 的 `AgentRunInput` 会包含 tick、summary、delta 或 full state。游戏状态本来就该变化，不能为了 cache 命中牺牲 AI 的战场感知。

合理目标不是“让所有输入都稳定”，而是：

- 稳定 system prompt 和 tools。
- 稳定历史消息字节。
- 把变化集中放在当前 user input 的尾部。
- 控制不必要的重复读取和重复大块状态。

---

## 5. 不建议照搬的点

### 5.1 不要把 compaction 写成“不破坏 cache”

如果从：

```text
[system][A][B][C][D][E]
```

变成：

```text
[system][C][D][E][summary]
```

那么请求从 `A` 位置开始就不再匹配旧前缀。DeepSeek cache 不是“任意中间片段匹配”；它要求复用已持久化的 prefix unit。

可以做 compaction，但文档和实现都应该承认代价：

- 压缩发生的那一轮或下一轮可能 cache miss 增加。
- 换来的是避免超过上下文、降低长期 prompt 体积、减少模型被过期信息干扰。
- 如果要减少损失，可以在阈值很高时才做，或把摘要先 append 并在后续稳定后再截断。

### 5.2 不要直接引入 Reasonix 的产品级功能

Reasonix 有 MCP、filesystem、shell、skills、semantic search、dashboard、session persistence 等能力。这些不是 LLMCraft 当前问题的解法。

LLMCraft 的核心场景是实时游戏 AI 对战，优先级应该是：

1. 让 AI 决策更稳。
2. 让 turn latency 可解释。
3. 降低无意义 token 消耗。
4. 最后才是扩展通用 agent 能力。

---

## 6. 建议的实施顺序

### P0：先加观测

- 在 `OpenAICompatibleProvider` 捕获 response usage。
- 记录：
  - `prompt_cache_hit_tokens`
  - `prompt_cache_miss_tokens`
  - visible output tokens
  - finish_reason
  - request latency
- 写入 `AgentRunMetrics` 和 transcript。

没有这些数据，任何 cache 优化都只能靠猜。

### P1：停止原地改写历史消息

把 `expireSupersededReadToolResults()` 改成 append-only supersede note。这个改动最直接，且不改变游戏规则。

验收方式：

- 同一 provider 连续两轮后，上一轮已经发送过的 message object 不再被修改。
- 模型仍能看到“旧读取已过期”的提示。
- 现有 stall / repeated read 行为测试继续通过。

### P2：冻结 tools 序列化

把 tool definitions 规范化为稳定结构：

- tool 顺序固定。
- schema key 稳定排序。
- provider 请求复用冻结后的 tools。

这一步为后续动态工具、MCP 或子 Agent 工具裁剪留空间。

### P3：评估上下文压缩

只有在 transcript 显示 prompt 体积或延迟成为瓶颈后，再做 compaction。不要为了“像 Reasonix”而提前引入。

如果要做，建议先明确策略：

- 压缩对象：旧 tool result、旧 delta、还是完整历史轮次。
- 压缩触发：token 阈值、turn 数、还是 latency 阈值。
- 压缩结果的可信度：摘要是否可用于战术决策，是否必须允许重新读取。
- cache 影响：压缩后 hit/miss 是否恶化。

---

## 7. 对 PR 的最终结论

这个 PR 应该保留为一份调研文档，而不是一份实现计划。

Reasonix 对 LLMCraft 的核心启发是：

> 把 prompt 当成一段需要长期保持字节稳定的协议，而不是每轮随手重组的临时 JSON。

落到 LLMCraft，最小可行动作是：

1. 加 cache telemetry。
2. 禁止原地改写历史 tool result。
3. 冻结 tool specs。
4. 等有数据后再讨论 compaction。

这些改动比照搬 Reasonix 的三层命名、成本宣传数字或通用 coding-agent 功能更实际。
