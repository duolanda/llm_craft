# DeepSeek Prefix Cache 优化分析

> 基于 [Reasonix (esengine/DeepSeek-Reasonix)](https://github.com/esengine/DeepSeek-Reasonix) 的架构研究与逆向分析。
> Reasonix 是一个 DeepSeek-native AI coding agent，围绕 prefix-cache 稳定性设计整个 agent loop。
> 核心数据：单日 435M input tokens，99.82% cache hit rate，~$12 vs ~$61（无缓存基准）。

---

## 1. 背景：LLM API Prefix Cache 机制

### 1.1 工作原理

DeepSeek（以及 Anthropic、OpenAI 等主流 API）都实现了自动 prefix caching。其核心机制是：

> **如果连续两次请求的 token 前缀完全相同，第二次请求命中缓存，只按 ~10% 的价格计费。**

```
请求 1: [system prompt A] + [history B] + [user input C]  → 全价
请求 2: [system prompt A] + [history B] + [user input D]  → 只付 input C 的 full price + A+B 的 cache price
请求 3: [system prompt A] + [history B] + [user input E]  → 同上
```

### 1.2 DeepSeek 的定价差异

| 模型 | 缓存命中 (/1M tokens) | 缓存未命中 (/1M tokens) | 命中/未命中比 |
|------|----------------------|------------------------|-------------|
| deepseek-v4-flash | $0.028 | $0.14 | **2%** |
| deepseek-v4-pro | $0.139 | $1.667 | **~8%** |

缓存命中的 cost 是未命中的 **2%~8%**，这是优化的经济动力。

### 1.3 自动化但脆弱

Prefix caching 是自动的（不需要在请求头里声明），但它极其脆弱：

> **任何字节级别的变化都会导致缓存 miss。**

这意味着：
- 在 system prompt 中写入时间戳 → 每次 miss
- 重新序列化 tool schema 导致 key 顺序变化 → 每次 miss
- 在历史消息中间插入新内容 → 破坏之后所有消息的缓存
- 对旧消息做原地修改（标记为 "expired" 等）→ 破坏前缀稳定

---

## 2. Reasonix 的三区域内存架构

核心 insight：**把上下文分区，让不同区域的更新策略不同，保证缓存前缀稳定。**

```
┌─────────────────────────────────────────────────┐
│ ① IMMUTABLE PREFIX                              │
│ 系统提示 + 工具规格 + 少量示例         ← 固化     │
│ 整个 session 不修改，每轮请求的缓存命中从这里开始   │
├─────────────────────────────────────────────────┤
│ ② APPEND-ONLY LOG                               │
│ [user₁][assistant₁][tool₁][user₂][assistant₂]… │
│ 只追加，不重写，不插入中间                 ← 稳定 │
├─────────────────────────────────────────────────┤
│ ③ VOLATILE SCRATCH                              │
│ R1 thinking、临时计划状态、本轮的瞬态信息           │
│ 从不发往 API                                ← 无害 │
└─────────────────────────────────────────────────┘
```

### 2.1 ImmutablePrefix（不可变前缀）

- System prompt 在 session 开始时被冻结，锁定为相同的字节序列
- Tool 定义（包括 JSON schema）被序列化一次并缓存结果，后续直接用相同的序列化表示
- 少量 few-shot 示例（如果使用）也被包含在这里
- 整块内容在整个 session 中**不做任何修改**

ImmutablePrefix 的实现通过 `registerMemory()` 在会话启动时收集所有固定记忆类型（user / feedback / project / reference），拼接到 system prompt 之后，然后锁定。后续轮次不再重新拼接，而是直接用锁定的字节序列。

### 2.2 AppendOnlyLog（追加日志）

- 每一轮的消息（user input → assistant response → tool results → 下一轮 user input）按顺序追加到日志末尾
- **没有中间插入**——即使有 HQ 被攻击的紧急告警、sub-agent 完成通知，也是追加到末尾而不是插入到历史中间
- **没有原地修改**——即使需要让旧 tool result "过期"，也不改写日志中已有的消息，而是追加一条新消息告知模型
- 日志的大小决定缓存前缀的长度：日志越长，下一次请求可缓存的 token 越多

### 2.3 VolatileScratch（易失暂存区）

- DeepSeek R1 风格的 thinking/reasoning_content 被捕获后放在暂存区
- 临时的 plan 状态、tool call 的中间结果只在本轮可见
- **暂存区的内容永不进入发送给 API 的消息数组**，因此不会影响缓存
- 每轮结束时清空

---

## 3. 四个关键工程决策

### 3.1 冻结工具 schema 序列化

大多数 LLM 客户端（包括 OpenAI SDK 默认行为）每次调用 API 时都会重新序列化工具定义。由于 JavaScript 对象 key 的遍历顺序在某些条件下不确定，或者因为工具注册顺序可能变化，两次序列化的结果可能产生字节级别的差异，直接导致缓存 miss。

Reasonix 的做法：
- 在 session 启动时一次性序列化所有 tool definition
- `ToolRegistry` 中每个 tool 的 `name`、`description`、`parameters` 在注册后以**规范化格式**存储（key 排序）
- 每次 API 调用直接复用预序列化的工具块

### 3.2 禁止历史消息改写

许多 agent 框架在管理上下文时，会对旧消息做以下操作：
- 标记已过时的 tool result 为 "expired"（直接在原消息上修改 content）
- 压缩历史时折叠旧轮次（改写消息数组）
- 删除中间轮次以节省空间（消息数组重新拼接）

所有这些操作都会**改变历史消息数组的字节序列**，从而破坏后续请求的前缀缓存。

Reasonix 的原则：
- 任何需要"修改"旧消息的需求，都改为**追加一条新消息**来实现
- 即使旧 tool result 已经完全过时，也不修改它在 AppendOnlyLog 中的原始内容
- Auto-compaction 的实现是**追加一条压缩摘要到日志末尾**，然后截断早期消息——但因为早期的字节已经不在前缀中，截断不影响后续缓存。具体做法在第 3.4 节详述。

### 3.3 紧急告警的非侵入式注入

游戏场景中常见的需求：当 HQ 被攻击时需要立即插入一条紧急消息通知 AI。在 `LLM Craft` 的 `OpenAICompatibleProvider.ts` 中，`injectUrgentRuntimeAlert()` 的实现是在 `messages` 数组中 `push` 一条新消息——这符合 append-only 原则，不会破坏缓存。

但需要注意的是：**如果告警消息被插入到消息数组的中间位置**（比如在旧 user message 和新的 assistant response 之间），它就会改变所有后续消息的字节偏移，破坏缓存。

Reasonix 的实现确保所有注入消息都走 append 路径，不插入中间。

### 3.4 Auto-compaction 的缓存友好实现

当上下文接近 token 限制时，需要压缩历史。通常的实现方式是：
- 取最近的 N 轮对话，丢弃更早的轮次
- 或者重写一个摘要

这两种做法都会破坏前缀缓存（因为字节序列变了）。

Reasonix 的做法：
- 当上下文接近限制时，从 AppendOnlyLog 的头部取一段历史（最早的部分）
- 将这部分的原始消息用一个模型调用压缩成一个摘要
- **将摘要作为一条新的 system/user 消息追加到 AppendOnlyLog 末尾**
- 再截断头部对应的原始消息

这样做的效果：缓存前缀在压缩前后保持不变——前一请求的后半部分（摘要）和下一请求的前半部分（摘要）是一致的。

```
压缩前: [ImmutablePrefix][A][B][C][D][E]  ← 全部缓存
                压缩 A+B → summary
压缩后: [ImmutablePrefix][C][D][E][summary]  ← [ImmutablePrefix][C][D][E] 缓存命中
                                               [summary] 是新内容，但只占小幅
```

---

## 4. 对比：naive 客户端 vs Reasonix

以 DeepSeek 的 pricing 为基准，分别看四种常见 client 的 cache hit rate 表现：

| 客户端 | 典型 hit rate | 原因 |
|--------|-------------|------|
| **DeepSeek 官网对话** | 60-80% | 同一会话内前缀基本稳定；新会话/刷新后系统提示可能变化，降为 0% |
| **Cherry Studio / Open WebUI** | 30-60% | 工具 schema 每次序列化 key 顺序不固定；加上消息格式可能因版本不同略有变化 |
| **Cline / Continue（XML tool call）** | <30% | Tool result 以 XML 形式嵌入对话，每轮 tool result 的内容和长度不同，导致整个前缀变化的概率极高 |
| **Reasonix** | **99.82%** | 上述四个工程决策组合实现 |

这不是 DeepSeek 的缓存机制有区别——**是 client 端对缓存前缀的保护策略有区别**。

---

## 5. 核心参考数据：真实用户单日缓存效果

来源：`benchmarks/real-world-cache/README.md`（2026-05-01 数据）

### 用量

| 指标 | 数值 |
|------|------|
| Input cache hit tokens | 435,033,856 |
| Input cache miss tokens | 767,616 |
| Output tokens | 179,763 |
| **Cache hit ratio (input)** | **99.82%** |
| 模型 | deepseek-v4-flash |

### 费用

| | 实际（99.82% hit） | 假设 0% cache |
|--|-------------------|---------------|
| Cache-hit input | $12.18 | — |
| Cache-miss input | $0.11 | $60.58 |
| Output | $0.05 | $0.05 |
| **全天总计** | **$12.34** | **$60.63** |

缓存节约了 **~80%** 的 input token 费用。

使用 v4-pro（缓存折扣更大）的情况下：$62.35 vs $727.08，节约 **~91%**。

---

## 6. 与其他缓存机制的对比

### 6.1 Anthropic Prompt Caching

Anthropic 也有相似的缓存机制，但需要显式声明 `cache_control` 断点。Reasonix 的架构设计同样适用于 Anthropic，但目前的实现是 DeepSeek-only。

### 6.2 OpenAI 的 Prompt Caching

OpenAI 的缓存是自动的（类似 DeepSeek），但缓存有效期较短（5-10 分钟无请求后过期），且只对 >= 1024 个 token 的前缀生效。在游戏场景中（tick 间隔可能较长），实际收益会更低。

### 6.3 关键区别

| | DeepSeek | Anthropic | OpenAI |
|--|----------|-----------|--------|
| 声明显式断点 | 不需要 | 需要（cache_control） | 不需要 |
| 缓存粒度 | 整个前缀 | 断点之间 | 整个前缀（>=1024 tokens） |
| 折扣力度 | ~98% off | ~90% off | ~50% off |
| 对字节稳定的要求 | 极高 | 高 | 高 |

---

## 7. 结论

DeepSeek prefix cache 的优化本质上不是一个 API 特性问题，而是一个**客户端架构问题**。

核心原则可以总结为：

> **不让上下文管理代码的便利性，以牺牲字节稳定性为代价。**

具体地：
1. 将上下文分区：不可变部分 → 追加部分 → 暂存部分
2. 禁止任何形式的历史消息改写
3. 紧急注入始终走 append，不插入中间
4. 压缩通过追加摘要 + 截断实现，不重写前缀
5. 工具 schema 序列化锁定字节序列

这些原则适用于任何实现了 prefix caching 的 LLM API，不只是 DeepSeek。
