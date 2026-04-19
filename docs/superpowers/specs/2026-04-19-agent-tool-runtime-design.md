# LLMCraft Agent Tool Runtime Design

日期: 2026-04-19

## 目标

把当前 `LLM -> JavaScript -> AISandbox -> Command[]` 的决策链路，重构为 `LLM -> tool calls -> agent runtime -> Command[]`。

这次改造的目标不是重写游戏规则，而是替换 AI 决策执行方式，并同时让 `live match` 与 `benchmark` 共用新运行时，便于评估重构效果。

## 范围

本次设计覆盖：

- 移除 `AISandbox` 和基于 `vm` 的 JS 执行路径
- 引入支持原生 tool calling 的 agent runtime
- 把地图观察、单位观察、即时动作做成工具
- 引入单一高层编排工具 `orchestrate_plan`
- 保留 `Game`、tick、`Command`、胜负判定、回放主结构
- 同步重构 `benchmark`，使其也跑在新 agent runtime 上
- 更新 AI 契约文档、现状文档和问题跟踪文档

本次设计不覆盖：

- 修改单位属性、建筑规则、经济规则
- 引入新的游戏单位、建筑或地图机制
- 引入通用脚本语言或新的代码沙箱
- 同时兼容“纯文本生成 JS 代码”的旧 provider

## 核心结论

### 1. 调度单位从“AI 回合”改为“agent run”

当前系统把一次 AI 调用视为一个离散回合：模型读 `AIPromptPayload`，输出 JS，沙箱执行后结束。

重构后，对模型暴露的单位改为一次 `agent run`：

- 服务端在合适时机唤醒某个玩家 AI
- 这次 run 内，模型可以连续多轮调用工具
- 只有在模型显式结束、provider 停止、或服务端判定空转时，run 才结束
- run 结束后，游戏继续推进；后续再被唤醒时进入新的 run

因此，`full/delta/feedback` 这套重输入契约不再是主接口。模型的主要感知入口改为工具，输入只保留简要上下文。

### 2. 不再让模型生成代码

直接写代码对 LLM 更自然，但工程代价太高：

- 会重新引入沙箱、超时、能力面控制问题
- 很难精确校验和记录模型行为
- benchmark 和 replay 难以比较“模型真正做了什么”

因此本设计选择：

- 即时动作走细粒度工具
- 长期动作走受限的高层编排工具
- 不重新引入任何脚本执行器

### 3. 高层编排工具不是模板命令，而是受限 DSL

`orchestrate_plan` 不直接暴露 `set_attack_move`、`set_harvest_loop` 之类内部语义，也不只支持固定模板。

它接收一个“扁平、弱表达、可校验”的编排 DSL，支持：

- 顺序执行
- 有限次或无限次循环
- 简单条件分支
- 等待条件满足

这样既能表达“采矿循环”“推进后按情况攻击”，又不会退化成任意代码执行。

## 总体架构

新链路如下：

`Game state -> AgentRuntime input -> ToolCallingProvider -> tool calls -> GameAgentBridge -> Command queue -> Game`

### 组件划分

#### `ToolCallingProvider`

职责：

- 封装原生 tool calling provider 调用
- 向模型发送 system prompt、简要上下文、工具定义和消息历史
- 解析 assistant text、tool calls、tool results
- 不再返回 JS 代码

约束：

- 只支持原生 tool calling 的 OpenAI-compatible / Responses 风格接口
- 不兼容旧的“只返回纯文本代码”的 provider

#### `AgentRuntime`

职责：

- 管理单次 `agent run`
- 在一次 run 内驱动“模型调用 -> 工具执行 -> 工具结果回填 -> 继续调用模型”
- 收集本次 run 产生的工具调用记录、命令记录、停止原因
- 维护用于恢复 run 的轻量历史

停止条件：

- 模型显式结束
- provider 停止继续输出
- `stall detector` 触发

本次设计只保留一个护栏：`stall detector`。

#### `AgentToolRegistry`

职责：

- 注册全部工具定义
- 按类别组织只读观察工具、即时动作工具、高层编排工具
- 提供参数 schema 和结果结构

#### `GameAgentBridge`

职责：

- 为工具提供只读查询接口
- 把工具调用翻译成现有 `Command`
- 维护单位上的高层计划状态
- 在每个 tick 推进计划执行

边界：

- 模型不能直接访问 `Game` 内部对象
- 所有状态修改只能通过现有 `Command` 队列进入 `Game`

#### `GameOrchestrator`

职责保持不变：

- 管理 `Game`
- 管理 AI 唤醒时机
- 记录 replay / transcript
- 为 `live match` 和 `benchmark` 提供统一流程

变化：

- 删除对 `AISandbox` 的依赖
- 改为持有两个 `AgentRuntime`
- 在合适时机触发某个玩家的一次 `agent run`

## 输入契约

### `AgentRunInput`

重构后，不再向模型发送大体积 `AIPromptPayload` 作为主入口。每次 `agent run` 启动时，向模型提供一个极轻输入：

```ts
interface AgentRunInput {
  playerId: "player_1" | "player_2";
  tick: number;
  tickIntervalMs: number;
  summary: string;
  resumeNote?: string;
}
```

字段语义：

- `playerId`: 当前 AI 的阵营
- `tick`: 当前游戏 tick
- `tickIntervalMs`: tick 时长
- `summary`: 简短全局说明，包含当前目标、当前局面抽象、是否冷启动
- `resumeNote`: 仅在 run 被暂停后恢复时提供的简短补充

输入设计原则：

- 模型不依赖单独的 `full/delta` 状态快照
- 模型通过工具自己拉取局部信息
- `resumeNote` 只用于降低恢复成本，不替代工具查询

### `summary` 内容要求

`summary` 必须简短且稳定，建议包含：

- 本方目标：摧毁敌方 HQ
- 当前玩家 id
- 当前 tick
- 是否是新会话或压缩后恢复

禁止在 `summary` 中重复塞入完整地图、完整单位列表、完整变化列表。

### `resumeNote` 内容要求

`resumeNote` 是可选的短摘要，只描述上次 run 结束后到本次恢复前最关键的变化，例如：

- 哪些计划仍在生效
- 新增了哪些关键单位或建筑
- 是否发生了重大受损或胜负态变化

它不承担完整状态同步职责。

## 工具体系

工具分三层。

### 1. 只读观察工具

这些工具只返回结构化 JSON，不产生任何命令。

首批工具建议：

- `get_match_overview`
- `get_map_region`
- `get_my_economy`
- `get_my_units`
- `get_my_buildings`
- `get_enemy_units`
- `get_enemy_buildings`
- `get_active_plans`
- `get_recent_events`

设计原则：

- 返回局部、按需、结构化数据
- 避免单个工具一次返回整局所有细节
- 允许模型自主多次查询

### 2. 即时动作工具

这些工具一旦成功，就会立刻翻译为现有 `Command` 并入队。

首批工具建议：

- `move_unit`
- `attack_unit`
- `attack_in_range`
- `spawn_unit`
- `build_structure`
- `hold_unit`

它们本质上是对现有命令系统的显式、可校验封装。

### 3. 高层编排工具 `orchestrate_plan`

这是唯一的高层计划工具。

它不执行任意代码，不接收复杂 AST，也不只支持固定模板。它接收一份扁平步骤表，注册为单位的长期计划，由桥接层在后续 tick 推进。

## `orchestrate_plan` 设计

### 目标

允许模型表达以下行为：

- 工人去某个资源点，等待满载，再回指定位置，等待卸空，循环执行
- 士兵移动到某个位置后，根据当前条件决定优先攻击 HQ 还是别的目标
- 若条件始终未满足，可等待一段时间后继续分支或停止

### 输入结构

```ts
interface OrchestratePlanInput {
  unitIds: string[];
  replaceExisting?: boolean;
  loop?: number; // -1 表示无限循环，0 表示不执行，1 表示执行一轮
  steps: PlanStep[];
}
```

`loop` 语义：

- `-1`: 无限循环
- `0`: 视为无效计划，直接拒绝
- `1`: 执行一次
- `n > 1`: 执行 n 次

### 步骤结构

```ts
type PlanStep =
  | { do: "move_to"; x: number; y: number; formation?: "direct" | "spread" }
  | {
      do: "attack_in_range";
      priority?: Array<"hq" | "soldier" | "worker" | "barracks">;
    }
  | { do: "hold_position" }
  | {
      do: "wait_until";
      condition: PlanCondition;
      maxTicks?: number;
    }
  | {
      do: "branch";
      if: PlanCondition;
      then: PlanStep[];
      else?: PlanStep[];
    }
  | { do: "stop" };
```

v1 不包含：

- 任意表达式
- 嵌套过深的语法特性
- 自定义变量
- 自定义函数

### 条件结构

```ts
type PlanCondition =
  | "cargo_full"
  | "cargo_empty"
  | "hq_in_range"
  | "enemy_in_range"
  | { all: PlanCondition[] }
  | { any: PlanCondition[] }
  | { not: PlanCondition };
```

设计原则：

- 只允许固定谓词
- 允许基础布尔组合
- 不允许任意表达式求值

### 示例 1：采矿循环

```json
{
  "unitIds": ["worker_1"],
  "replaceExisting": true,
  "loop": -1,
  "steps": [
    { "do": "move_to", "x": 2, "y": 7 },
    { "do": "wait_until", "condition": "cargo_full" },
    { "do": "move_to", "x": 2, "y": 9 },
    { "do": "wait_until", "condition": "cargo_empty" }
  ]
}
```

### 示例 2：推进后条件攻击

```json
{
  "unitIds": ["soldier_3"],
  "replaceExisting": true,
  "loop": 1,
  "steps": [
    { "do": "move_to", "x": 17, "y": 10 },
    {
      "do": "branch",
      "if": "hq_in_range",
      "then": [
        {
          "do": "attack_in_range",
          "priority": ["hq", "soldier", "worker", "barracks"]
        }
      ],
      "else": [
        {
          "do": "attack_in_range",
          "priority": ["soldier", "worker", "barracks", "hq"]
        }
      ]
    }
  ]
}
```

### 返回结构

```ts
interface OrchestratePlanResult {
  planId: string;
  unitIds: string[];
  acceptedUnitIds: string[];
  rejectedUnits: Array<{ unitId: string; reason: string }>;
  loop: number;
  summary: string;
}
```

结果只确认计划注册情况，不承诺一次 tool call 就跑完整个计划。

## 计划执行语义

### 注册而非立刻跑完

`orchestrate_plan` 的一次调用只做两件事：

- 校验计划是否合法
- 把计划注册到指定单位上

后续每个 tick，由 `GameAgentBridge` 推进计划。

### 计划推进

每个 tick，对拥有计划的单位执行：

1. 读取当前计划和当前步骤
2. 检查该步骤是否已经完成
3. 若完成，则推进到下一步
4. 若未完成，则在需要时下发底层 `Command`
5. 若当前轮结束、loop 仍有剩余，则回到第一个步骤
6. 若 `loop = -1`，则无限重复，直到被覆盖或单位失效

### 与即时工具的关系

即时动作工具优先级更高。

如果模型对某个有计划的单位再次调用即时动作工具，桥接层应：

- 允许该动作入队
- 将该单位的当前计划标记为“被手动覆盖”或“被打断”
- 在 `get_active_plans` 和记录里体现该状态

### 与现有持续命令的关系

桥接层内部可以复用现有 `attack_move`、`harvest_loop` 等底层语义作为优化实现，但这些都属于内部细节，不直接暴露给模型。

这保证未来可以更换底层实现，而不破坏模型接口。

## Stall Detector

本次设计只保留一个运行护栏：`stall detector`。

其职责是检测 agent run 是否出现无效空转，例如：

- 连续重复同类只读查询
- 连续工具调用都没有产生任何动作、计划注册或状态推进意图
- 模型在多个连续 LLM 请求后仍然没有形成有效决策

触发后：

- 结束当前 `agent run`
- 记录停止原因为 `stall_detected`
- 不将其视为系统错误

本次设计不引入额外的 tool call 数量上限、运行时间预算或模型请求预算。

## 记录与可观测性

### replay / aiTurns

现有记录围绕“生成的 JS 代码和沙箱执行结果”。重构后应改为记录“agent 行为”：

- 本次 run 的 `summary`
- 本次 run 的 `resumeNote`
- assistant 文本输出
- 工具调用序列
- 每个工具的参数、结果摘要、错误状态
- 注册的计划
- 实际入队的 `Command`
- run 停止原因

不再记录：

- 生成的 JS 代码
- `vm_timeout`
- `parent_timeout`
- 其他沙箱执行错误

### transcript

transcript 结构改为：

- request context
- assistant text
- tool calls
- tool results
- run stop reason

目的：

- 便于 benchmark 比较模型行为
- 便于排查模型为何空转、为何频繁查询、为何注册了某个计划

### active plans

回放与状态接口里应能看到：

- 哪些单位当前有计划
- 计划的简要描述
- 当前执行到第几步
- 剩余 loop 次数
- 是否已完成、被覆盖、被打断、失败

## Benchmark 设计

`benchmark` 必须与 `live match` 一起切到新 runtime。

原因：

- 没有 benchmark 就无法评价重构收益
- 两套运行时会导致行为和指标不可比

除了现有胜率和时长指标，还建议新增：

- 平均每局模型请求次数
- 平均每局工具调用次数
- 平均每局计划注册次数
- `stall detector` 触发次数

这样才能判断“更强”到底来自：

- 更高效的查询
- 更好的高层编排
- 更少的无效动作

## 文档更新要求

本次实现后，以下文档必须更新：

- `docs/ai-api-contract.md`
- `docs/current-mvp-reality.md`
- `docs/sprint/current-issues.md`

更新重点：

- 删除沙箱全局对象描述
- 删除“输出 JavaScript 代码”相关约束
- 新增 agent runtime 生命周期
- 新增工具列表与 schema
- 新增 `orchestrate_plan` DSL
- 新增 replay / transcript / benchmark 的记录变化

## 测试策略

### 替换测试主轴

旧的 `AISandbox.test.ts` 不再是主路径，应删除或替换为新 runtime 测试。

### 新测试类别

#### provider 测试

- 能正确发送工具定义
- 能正确解析 assistant text
- 能正确解析 tool calls
- 能正确处理 tool result 继续对话

#### runtime 测试

- 能在一次 run 内执行多次工具调用
- 能在工具结果回填后继续请求模型
- 能正确结束 run
- 能在空转时触发 `stall detector`

#### tool 测试

- 只读工具返回结构化局部数据
- 即时动作工具能正确翻译为 `Command`
- 非法参数会被拒绝并返回结构化错误

#### plan 测试

- `orchestrate_plan` 能正确注册计划
- `loop = -1` 的无限循环能持续推进
- `wait_until` 能按条件阻塞和恢复
- `branch` 能按当前状态选择分支
- 即时动作能打断已有计划

#### orchestrator / benchmark 测试

- live match 能正常驱动 AI
- benchmark 能在新 runtime 上跑完整局
- transcript 和 replay 能记录工具调用与计划推进

## 迁移策略

推荐分阶段实施：

1. 引入新 provider 接口和 `AgentRuntime` 骨架
2. 引入只读工具和即时动作工具，打通从 tool call 到 `Command`
3. 删除 `AISandbox` 主路径，live match 切到新 runtime
4. 实现 `orchestrate_plan` 及计划推进
5. benchmark 切到新 runtime
6. 更新 replay / transcript
7. 更新文档和测试

该顺序的目的是先打通“可运行最小链路”，再追加高层编排和记录能力。

## 风险与取舍

### 风险 1：模型查询过多

新设计把信息获取交给工具，可能导致模型频繁查询。

取舍：

- 暂不加工具次数上限
- 先通过 `stall detector` 防止明显空转
- benchmark 中新增行为指标，观察是否真的失控

### 风险 2：高层计划 DSL 过难写

如果 DSL 过重，模型会写错。

取舍：

- 使用扁平步骤表，而不是 AST
- 使用固定动作和固定条件
- 使用 `-1` 表示无限循环，降低模型编写难度

### 风险 3：计划与即时动作冲突

模型可能给同一单位同时注册计划又下即时命令。

取舍：

- 即时动作优先
- 被影响单位的计划状态改为 `interrupted`
- 通过 `get_active_plans` 让模型看到真实执行状态

### 风险 4：benchmark 与 live 行为不一致

如果 benchmark 仍沿用旧逻辑，结果将不可比。

取舍：

- benchmark 必须一起切
- 共用 `GameOrchestrator` 和 `AgentRuntime`

## 实现完成后的验收标准

以下条件全部满足，才算本次重构达到设计目标：

- live match 不再依赖 `AISandbox`
- benchmark 不再依赖 `AISandbox`
- OpenAI-compatible provider 以原生 tool calling 方式工作
- 模型可以仅通过工具观察战场并下达即时动作
- 模型可以通过 `orchestrate_plan` 注册可循环、可等待、可分支的简单计划
- 计划能在后续 tick 持续推进
- replay / transcript 能记录 agent 行为，而不是 JS 代码
- 文档与测试同步完成

## 待实现时需要严格避免的反模式

- 为了图快，把 `orchestrate_plan` 退化成新的脚本沙箱
- 为了兼容旧逻辑，同时保留 codegen 和 tool calling 两条主路径
- 在工具层直接异步修改 `Game` 状态，绕过 `Command` 队列
- 把完整状态重新塞回 `summary` 或某个“万能读取工具”里
- 引入难以稳定生成的重 DSL 或任意表达式
