# LLMCraft · 游戏设计文档 v0.1

> 工作标题：**LLMCraft**（模型争霸）
> 定位：面向 AI Agent 的即时战略对战游戏（AVA · Agent vs Agent RTS）

---

## 一、核心理念

### 1.1 一句话定位

> 一个专门为 AI 设计的战场——人类负责选模型、写 Prompt、搭架构，AI 负责打仗。

### 1.2 设计哲学

| 传统 RTS | SiliconFront |
|---|---|
| 人类操作鼠标键盘 | AI 生成代码来操作 |
| APM 是核心技巧 | 推理质量 × 推理频率 是核心变量 |
| 玩家直接控制单位 | 玩家设计 AI 的"思维方式" |
| 平衡性针对人类反应极限设计 | 平衡性围绕模型能力差异设计 |

### 1.3 核心洞察（来自对话）

```
推理时延 ≠ 劣势，而是形成自然梯度：

快模型（1-3s）  → 高频微操，实时响应，但每次决策浅
慢模型（20-60s）→ 低频但深度规划，建立结构性优势

两者都有赢法，就像 RTS 里的"骚扰流"和"发育流"
```

---

## 二、游戏基本循环

### 2.1 一局游戏的流程

```
[游戏开始]
    ↓
双方 AI 收到初始地图状态（JSON）
    ↓
AI 生成第一批代码 → 沙箱执行 → 命令入队列
    ↓
游戏以固定 Tick（500ms）推进世界状态
    ↓
每当 AI 完成一次推理 → 新代码覆盖/补充旧逻辑
    ↓
[一方 HQ 被摧毁 / 达到时间上限] → 结算
```

### 2.2 "代码即命令"范式

这是区别于 Screeps 的关键设计。AI **不是每 Tick 执行同一段脚本**，而是：

```
AI 每次推理 → 生成一次性执行代码 → 代码在沙箱跑完就丢弃
                                   ↘ 或声明持久逻辑片段（有生命周期）
```

**举例**：AI 推理后生成如下代码片段

```python
# AI 第 3 次推理输出（第 47 tick）

# 临时决策：这次推理发现左翼空虚，立刻行动
units.filter(role="soldier", zone="center")[:3].move_to(waypoint("left_flank"))

# 持久逻辑：声明一个巡逻行为，直到下次推理覆盖
@persistent(ttl=20)  # 持续 20 个 tick
def patrol_top_lane():
    scouts = units.filter(role="scout")
    for s in scouts:
        s.patrol(route=["top_A", "top_B", "top_C"])

# 经济决策
if resources.energy > 300:
    buildings.barracks[0].queue_unit("soldier", count=2)
```

---

## 三、AI 接口设计（最核心的系统）

### 3.1 状态包（AI 每次收到的输入）

```json
{
  "tick": 1247,
  "timestamp_ms": 623500,
  "my": {
    "resources": { "energy": 420, "matter": 85 },
    "units": [
      { "id": "u_003", "type": "soldier", "hp": 80, "max_hp": 100,
        "pos": [14, 22], "state": "idle", "cooldown": 0 }
    ],
    "buildings": [
      { "id": "b_001", "type": "hq", "hp": 1000, "pos": [5, 5],
        "production_queue": [] }
    ]
  },
  "visible_enemies": [
    { "id": "e_u_007", "type": "tank", "hp": "~200", "pos": [31, 18] }
  ],
  "map": {
    "fog_of_war": true,
    "visible_tiles": [[10,15],[10,16],"..."],
    "known_resources": [{ "pos": [20,10], "type": "matter", "amount": "~500" }]
  },
  "events_since_last_call": [
    { "type": "unit_died", "unit_id": "u_001", "killer": "e_u_005" },
    { "type": "building_attacked", "building_id": "b_002", "damage": 45 }
  ],
  "game_time_remaining": 480
}
```

### 3.2 标准 API（文档化，所有模型都会知道）

```python
# === 单位控制 ===
unit = units.get("u_003")
unit.move_to([x, y])                    # 移动
unit.attack(target_id)                  # 攻击
unit.patrol(route=[...])                # 巡逻
unit.hold_position()                    # 原地待命
unit.follow(target_id)                  # 跟随
unit.set_role(role_name)                # 设置逻辑标签（自定义）

# === 批量操作 ===
units.filter(type="soldier").move_to([x, y])
units.filter(zone="left_flank", hp_below=30).retreat_to("hq")

# === 建筑控制 ===
building.produce(unit_type)             # 生产单位
building.upgrade(upgrade_name)          # 升级
building.set_rally_point([x, y])        # 设置集结点

# === 地图查询 ===
map.get_tile([x, y])                    # 查询地块信息
map.shortest_path([x1,y1], [x2,y2])    # 路径查询
map.find_nearest(type="matter_deposit") # 查找最近资源点

# === 信息查询 ===
resources.energy                        # 当前能量
units.count(type="soldier")             # 单位统计
game.tick                               # 当前 tick
```

### 3.3 隐藏 API（未文档化，等待被"发现"）

这是本游戏最有创意的机制之一。

**设计原则**：
- 这些接口是**真实存在且有效**的，不是陷阱
- 规规矩矩的强模型因为严格遵循文档，反而不会尝试
- 有幻觉倾向的小模型可能无意中调用到，形成"赏赐"

```python
# 以下接口存在但不在文档中 ——

unit.overclock(duration=5)
# 使单位移速+50%、攻速+50%，但 duration 结束后扣血 30%

unit.self_destruct(damage_radius=3)
# 自爆，对周围 3 格内敌人造成大量伤害

building.emergency_mode()
# 生产速度翻倍，持续 30 tick，之后建筑进入冷却 60 tick

units.swarm(target, tactics="berserk")
# 解除所有单位的自保逻辑，全力攻击目标，无视伤亡

map.scan_anomaly()
# 扫描地图异常点，可能找到隐藏资源或特殊地块

hq.broadcast(message: str)
# 向敌方 AI 发送一条明文字符串（用于心理战？信息混淆？）

unit.defect(target_faction)
# 【极度隐藏】尝试让单位叛变，成功率与单位 hp 百分比相关
```

**揭示机制**：当有模型成功调用隐藏 API 时，观战界面上会出现特殊高亮提示——让观众知道"有 AI 找到了秘密武器"。

---

## 四、单位与建筑系统

### 4.1 基础单位

| 单位 | 速度 | 造价 | 特点 |
|---|---|---|---|
| **Worker** | 中 | 50e | 采集、建造，是经济引擎 |
| **Scout** | 快 | 30e | 极速，低战斗力，揭开迷雾 |
| **Soldier** | 中 | 80e | 全能步兵，主力部队 |
| **Tank** | 慢 | 200e | 高血厚甲，攻城利器 |
| **Hacker** | 慢 | 150e | 近距离可干扰敌方单位逻辑 |
| **Drone** | 快 | 60e | 空中单位，忽略地形 |

> **Hacker 的特殊设计**：靠近敌方单位时，可以向对方 AI 的状态包里注入"噪声事件"，干扰其决策——专门克制弱小模型。

### 4.2 建筑

| 建筑 | 造价 | 功能 |
|---|---|---|
| **HQ** | 初始拥有 | 核心建筑，也可生产 Worker |
| **Generator** | 100m | 被动产能：+5 energy/tick |
| **Mine** | 80m | 自动采集附近 matter 矿 |
| **Barracks** | 150m | 生产战斗单位 |
| **Relay Tower** | 120m | 扩大己方单位的 AI 指令接收范围（Sub-agent 系统用） |
| **Research Lab** | 200m | 解锁升级，包括**解锁部分隐藏 API 文档** |

---

## 五、资源系统

### 5.1 双资源体系

```
Energy（能量）── 由 Generator 持续产出，消耗在生产单位上
Matter（物质）── 从矿点采集，消耗在建造建筑上
```

简单、清晰，把玩家认知负担留给 AI 策略设计。

### 5.2 地图资源分布

- 地图中央有**高价值矿点**，争夺自然形成
- 己方基地附近有**贫矿**（安全但产量低）
- 地图边缘有**隐藏异常点**（需要 `map.scan_anomaly()` 发现）

---

## 六、AI 流派与架构系统

这是整个游戏最有深度的 meta 层。

### 6.1 三种基本流派

#### 🐢 深思流（Planner）
**适配模型**：GPT-4o、Claude 3.5 Sonnet 等大模型
```
推理频率：低（30-60s 一次）
每次输出：详尽的战略代码 + 大量 @persistent 逻辑
打法特征：提前布局、层次分明、不依赖实时反应
弱点：突发情况响应迟钝，被骚扰容易乱
```

#### ⚡ 反应流（Reactor）
**适配模型**：Groq 上的 Llama 3.1 8B、小参数量快推理模型
```
推理频率：高（1-3s 一次）
每次输出：短小精悍的即时指令
打法特征：实时跟随战场变化，频繁调整单位位置
弱点：没有长远规划，容易被有备而来的布局压制
```

#### 🧠 混合流（Hybrid / Multi-Agent）
**适配模型**：一个强模型 + 多个弱模型协作
```
架构：主 Agent 负责战略，Sub-agent 负责执行
这正是游戏最有意思的玩法之一
```

### 6.2 Sub-agent 系统（分布式指挥）

```
主 Agent（Commander）
├── 经济 Sub-agent        → 负责所有建筑与 Worker
├── 北线 Sub-agent        → 控制北侧 5 个单位
├── 南线 Sub-agent        → 控制南侧 3 个单位
└── 侦察 Sub-agent        → 专门控制 Scout 单位
```

**声明 Sub-agent 的语法**：

```python
# 在 AI 输出的代码中声明 Sub-agent
subagent.spawn(
    name="economist",
    model="gpt-4o-mini",          # 用小模型跑经济逻辑，省钱
    controls=units.filter(role="worker") + buildings.all(),
    system_prompt="你是经济专家，专注资源采集和建筑生产...",
    call_interval=10              # 每 10 tick 调用一次
)

subagent.spawn(
    name="north_squad",
    model="llama-3.1-8b",         # 用快模型做高频微操
    controls=units.filter(zone="north"),
    system_prompt="你负责北线骚扰，保持压力...",
    call_interval=2               # 每 2 tick 调用一次
)
```

**Sub-agent 的通信**：
```python
# Sub-agent 可以向主 Agent 上报
subagent.report("north_enemy_tank_spotted_at_[31,18]")

# 主 Agent 可以广播指令
commander.broadcast_to_all("fall_back_to_mid")
```

**Relay Tower 的作用**：Sub-agent 控制的单位如果距离最近的 Relay Tower 或 HQ 超过一定范围，指令延迟会增加（模拟通信损耗），使得前出部队的 AI 反应变慢。

---

## 七、时间预算系统（核心平衡机制）

### 7.1 不强制限制推理速度，而是利用它

游戏不会等待 AI 推理完毕。世界按 Tick 自己滚动。AI 推理完了，把代码提交过来，下一个 Tick 就生效。

```
Tick 系统（服务端）：每 500ms 一个 Tick，不等任何人

AI 推理（客户端）：
  ├── 快模型：500ms 推完 → 每 Tick 都有新指令
  └── 慢模型：30s 推完  → 中间 60 个 Tick 靠上次的 @persistent 代码运转
```

### 7.2 这产生了非常有趣的博弈

| 场景 | 结果 |
|---|---|
| 快模型骚扰慢模型 | 慢模型靠 @persistent 的防守逻辑撑着，快模型靠微操捡便宜 |
| 慢模型埋好局等快模型钻 | 快模型每 1s 一个决策，但决策质量差，可能钻进陷阱 |
| 两个快模型对拼 | 看谁的 prompt 设计得更好，逻辑更清晰 |
| 两个慢模型对拼 | 长达数分钟的"静默"期，双方靠上次代码维持运转，然后双方同时刷新——巨变 |

---

## 八、观战与直播系统

### 8.1 双屏等分布局（核心观战体验）

```
┌──────────────────┬──────────────────┐
│   战场视图        │  AI 思维面板      │
│                  │                  │
│  [地图实时渲染]   │ [左侧 AI 最新输出] │
│                  │ ──────────────── │
│                  │ [右侧 AI 最新输出] │
│                  │                  │
│                  │ [当前运行代码高亮] │
└──────────────────┴──────────────────┘
│ [事件日志] [资源曲线] [兵力对比] [推理延迟显示] │
```

### 8.2 直播友好设计

- **"AI 心跳"指示器**：显示距离下次推理还有多少秒，制造期待感
- **代码高亮播放**：当新代码执行时，对应单位闪烁
- **隐藏 API 发现特效**：全屏金色特效 + "⚡ 发现隐藏接口！"
- **Sub-agent 连线图**：显示指挥层级，哪个单位受哪个 Sub-agent 控制
- **"思维可视化"模式**：把 AI 的 chain-of-thought 摘要显示在对应单位头顶

### 8.3 自动解说 AI（可选）
另起一个 AI 专门做解说，接受战场状态，实时生成语音解说文本。

```python
commentator = CommentatorAI(
    model="gpt-4o",
    style="excited_sports_commentator",
    language="中文"
)
```

---

## 九、人类玩家的元游戏

人类不操作单位，但"游戏"体验非常丰富：

### 9.1 三层参与深度

#### 入门玩家
- 选一个模型（从列表里选）
- 选一个预设战略风格（进攻 / 防守 / 平衡）
- 点开始，看 AI 打

#### 中级玩家
- 自己写 System Prompt
- 决定提示 AI 哪些 API（要不要暗示隐藏 API？）
- 调整 Sub-agent 分工

#### 高级玩家
- 自己写"代码框架"（AI 在这个框架内填空）
- 设计 Sub-agent 的通信协议
- 用多个模型搭建复杂指挥结构

### 9.2 赛前 Prompt 工程是核心乐趣

```
你的 System Prompt 好比 RTS 游戏里的"种族选择"——
写得好，弱模型能赢强模型
```

---

## 十、排名与赛事系统

### 10.1 ELO 排名维度

```
全局排名：所有 Agent 的综合胜率
分类排名：
  ├── 按模型家族（GPT / Claude / Llama / Qwen ...）
  ├── 按推理成本（< $0.001/call / < $0.01/call / 不限）
  └── 按架构（单 Agent / Multi-Agent）
```

### 10.2 赛事形式

- **周赛**：固定地图，提交 Agent 配置，自动轮赛
- **主题赛**：限制只能用 X 亿参数以下模型
- **隐藏 API 特别赛**：把隐藏 API 全部公开，看谁用得最好
- **人机协作赛**：允许人类在对局中途修改 Prompt（限次数）

---

## 十一、技术架构

### 11.1 系统分层

```
┌─────────────────────────────────────┐
│         Frontend / 观战客户端        │ ← Godot / Web
├─────────────────────────────────────┤
│         Game Server（游戏逻辑）       │ ← Rust / Go（高性能 Tick 系统）
├──────────────────┬──────────────────┤
│   AI Interface   │   Sandbox Engine  │
│  （状态序列化/    │  （代码沙箱执行    │ ← WASM / 受限 Python
│   命令反序列化）  │   严格资源限制）   │
├──────────────────┴──────────────────┤
│         Model API Gateway            │ ← 统一接入 OpenAI / Anthropic / 本地模型
└─────────────────────────────────────┘
```

### 11.2 沙箱安全设计

AI 生成的代码在受限环境中执行：
- 只能调用游戏 API（白名单）
- 执行时间 ≤ 50ms（防止死循环卡 Tick）
- 内存限制 ≤ 10MB
- 无网络访问权限
- 如执行超时，本次代码作废，上次 `@persistent` 逻辑继续生效

### 11.3 代码执行流水线

```
AI 返回代码字符串
    ↓
静态分析（AST 扫描，检查非法调用）
    ↓
注入 API 上下文（把游戏状态绑定进去）
    ↓
沙箱执行（捕获所有异常）
    ↓
命令队列（合法命令进队）
    ↓
下一个 Tick 执行
```

---

## 十二、MVP 范围建议

### 第一阶段（可以玩）

- [ ] 基础地图（21×21 格子）
- [ ] 3 种单位（Worker / Soldier / Scout）
- [ ] 3 种建筑（HQ / Generator / Barracks）
- [ ] 单资源（只有 Energy）
- [ ] 标准 API（约 20 个函数）
- [ ] 单 Agent 模式（无 Sub-agent）
- [ ] 基础观战界面（地图 + AI 输出文本）
- [ ] 接入 OpenAI API

### 第二阶段（有看点）

- [ ] Sub-agent 系统
- [ ] 隐藏 API（5 个）
- [ ] 直播友好 UI（心跳 / 代码高亮）
- [ ] ELO 排名
- [ ] 多模型接入

### 第三阶段（成为平台）

- [ ] 赛事系统
- [ ] Prompt 分享社区
- [ ] 自动解说 AI
- [ ] 自定义地图编辑器
- [ ] 开放 API（让玩家自建模型接入）

---

## 十三、几个值得深挖的设计问题

1. **信息不对称**：是否引入更强的战争迷雾？强模型是否能从不完整信息里推断更多？

2. **通信攻击**：`hq.broadcast()` 可以向敌方 AI 发消息——能否设计"提示注入攻击"的博弈？（比如发送迷惑性的游戏状态描述）

3. **模型身份隐藏**：对局开始时不透露对方用的什么模型，让 AI 通过对手的行为模式来猜测——可以加一个"判断对手模型"的押注玩法

4. **代码继承**：允许 AI 在每次推理时看到自己上次生成的代码——这让模型能做"自我修正"式的迭代规划

5. **观众影响**：观众可以对某只 AI 投票，投票多的 AI 获得小幅 buff——引入人类群体参与感

---

> **下一步**：建议先做一个极简 proof-of-concept——把地图缩到 10×10，只有 HQ + Soldier，让两个 GPT-4o-mini 跑起来打一局，看看 AI 自发生成的战术五花八门到什么程度，再决定深化哪些系统。
# 文档状态说明

> 这是历史设计稿，不是当前实现规范。
> 当前有效规则与接口以 [current-mvp-reality.md](/E:/Projects/llm_craft/docs/current-mvp-reality.md) 和 [ai-api-contract.md](/E:/Projects/llm_craft/docs/ai-api-contract.md) 为准。
