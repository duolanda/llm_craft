# 红蓝双方独立模型预设设计

## 背景

当前实时对局的模型配置完全依赖服务端 `.env`：

- 全局只有一套 `OPENAI_API_KEY`
- 全局只有一个 `OPENAI_BASE_URL`
- 全局只有一个 `OPENAI_MODEL`
- `GameOrchestrator` 启动时为红蓝双方复制同一套 provider 配置

这带来三个问题：

1. 红蓝双方不能使用不同模型或不同供应商端点
2. 模型配置属于运行期业务设置，却被绑死在部署环境变量里
3. token 会以明文形式存在 `.env` 文件中

## 目标

本次改造目标如下：

1. 支持红方和蓝方分别选择不同的模型预设进行对战
2. 不再依赖 `.env` 保存业务模型配置
3. 预设由后端持久化管理
4. API token 不以明文形式落盘
5. 当前版本先只支持 OpenAI-compatible 接口
6. 架构上为未来扩展其他 provider 类型保留入口

## 非目标

本次不做以下内容：

1. 不实现账号体系或多用户隔离
2. 不追求强安全模型，不引入主密码或硬件级密钥管理
3. 不实现前端防篡改
4. 不接入除 OpenAI-compatible 之外的新 provider
5. 不重做整个应用导航，仅增加必要的设置入口和选择控件

## 方案概览

采用“后端托管预设库 + 启动对局时按玩家选择实例化 provider”的方案。

- 服务端新增预设存储层，负责读写预设和加解密 token
- 前端新增设置页，用于增删改查预设
- 实时对局界面新增红蓝双方预设选择器
- WebSocket `start` 消息携带 `player1PresetId` 和 `player2PresetId`
- 服务端按两个 preset 分别创建 `llm1` / `llm2`
- provider 工厂按 `providerType` 分发，当前仅实现 `openai-compatible`

## 数据模型

### 存储模型

服务端新增 `LLMPresetRecord` 持久化结构：

```ts
type ProviderType = "openai-compatible";

interface LLMPresetRecord {
  id: string;
  name: string;
  providerType: ProviderType;
  baseURL: string;
  model: string;
  apiKeyEncrypted: string;
  createdAt: string;
  updatedAt: string;
}
```

说明：

- `providerType` 保留为判别字段，避免未来扩展时破坏现有结构
- `apiKeyEncrypted` 为密文，不保存明文 token
- `baseURL` 与 `model` 先按 OpenAI-compatible 语义处理

### API 响应模型

前端不应获取明文 token。列表和详情接口返回脱敏视图：

```ts
interface LLMPresetSummary {
  id: string;
  name: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}
```

编辑时允许前端留空 `apiKey` 表示“不修改现有 token”。

## 存储与加密

### 持久化位置

新增服务端数据目录：

- `packages/server/data/llm-presets.json`

该文件保存预设数组，供服务端启动和运行期读写。

### 加密方式

token 使用主流对称加密 `AES-256-GCM` 后再写入 `llm-presets.json`。

约束：

- 目标只是避免磁盘明文保存 token
- 不引入用户主密码流程
- 不提供抵抗本机管理员或运行时代码注入的安全承诺

实现要求：

- 加解密逻辑集中在服务端存储层或加密工具模块
- 上层业务代码只接触“创建/更新预设时的明文输入”和“实例化 provider 时的解密结果”
- 列表与详情接口不返回明文 token

## 服务端架构变更

### 1. 预设仓储层

新增服务端模块，职责包括：

- 从 `llm-presets.json` 读取预设
- 创建、更新、删除预设
- 对 `apiKey` 做加密存储
- 根据 `presetId` 读取并解密出运行期 provider 配置

建议拆分为：

- `PresetStore`：负责文件存储、序列化和 CRUD
- `crypto` 工具：负责 `AES-256-GCM` 加解密

### 2. provider 配置工厂

当前 `createLLMProvider` 直接接受一套 `LLMProviderConfig`。改造后：

- 定义带 `providerType` 的运行时配置结构
- 工厂按 `providerType` 创建 provider
- 当前仅分支到 `OpenAICompatibleProvider`

建议新增：

```ts
interface OpenAICompatibleRuntimeConfig {
  providerType: "openai-compatible";
  apiKey: string;
  baseURL: string;
  model: string;
}
```

后续若接入其他 provider，只需：

1. 添加新的 runtime config 类型
2. 扩展工厂分支
3. 新增对应 provider 实现

无需修改 `GameOrchestrator` 的对局调度逻辑。

### 3. GameOrchestrator

当前构造函数只接收单套配置，并复制给双方。

改造后改为接收玩家级配置：

```ts
interface MatchLLMConfig {
  player1: OpenAICompatibleRuntimeConfig;
  player2: OpenAICompatibleRuntimeConfig;
}
```

行为变化：

- `llm1` 使用 `player1` 配置
- `llm2` 使用 `player2` 配置
- 回放记录仍分别保存双方 `model` 和 `baseURL`

不变项：

- AI 调度频率
- 状态打包策略
- 回放记录格式中已有的 player-level model/baseURL 信息

### 4. server 入口层

服务端启动时不再根据 `.env` 预创建单例 orchestrator。

改为：

- 启动 HTTP + WebSocket 服务
- 初始化 preset store
- 当收到 `start` 消息时，校验 `player1PresetId` / `player2PresetId`
- 从 store 解析两套运行时配置
- 按这两套配置创建新的 `GameOrchestrator`
- 后续 `stop` / `save_record` 操作针对当前这局 orchestrator 生效

实时对战启用条件从“存在 `.env` token”变为“服务端至少存在一个预设”，但真正启动对局时仍要求红蓝双方都已选定预设。

## API 设计

### HTTP API

新增设置相关接口：

1. `GET /api/settings/presets`
   - 返回 `LLMPresetSummary[]`

2. `POST /api/settings/presets`
   - 请求体：

```ts
{
  name: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey: string;
}
```

3. `PUT /api/settings/presets/:id`
   - 请求体：

```ts
{
  name: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey?: string;
}
```

   - `apiKey` 缺省或空串时表示保留原 token

4. `DELETE /api/settings/presets/:id`
   - 删除指定预设

错误处理要求：

- 预设不存在返回 404
- 请求字段非法返回 400
- 存储读写失败返回 500
- 错误消息使用可读中文，便于前端直接展示

### WebSocket 消息

当前 `start` 消息无配置体。改造后：

```ts
{
  type: "start";
  player1PresetId: string;
  player2PresetId: string;
}
```

服务端校验：

- 两个 id 都必须存在
- 对应 preset 必须存在且可解密

失败时通过现有 `error` 消息返回原因。

### 初始状态消息

当前 `state` 消息中仅包含 `liveEnabled`。改造后保持兼容，同时新增设置页所需的更明确信号是可选项，不强制塞进 WebSocket。

设置页优先走 HTTP API 获取预设列表，不依赖 WebSocket 推送。

## 前端交互设计

### 1. 设置入口

前端新增设置页面或设置面板，提供：

- 预设列表查看
- 新增预设
- 编辑预设
- 删除预设

字段：

- 名称
- Base URL
- Model
- API Key

约束：

- provider 类型当前固定为 `OpenAI-compatible`
- 编辑已有预设时不回填明文 API Key
- 若用户不填写新 API Key，则保留原值

### 2. 实时对局配置

在实时对局区域新增：

- 红方预设选择器
- 蓝方预设选择器

允许：

- 双方选择同一个预设
- 双方选择不同预设

### 3. 启动按钮状态

启动按钮禁用条件：

1. WebSocket 未连接
2. 预设列表为空
3. 红方未选择预设
4. 蓝方未选择预设

### 4. 错误反馈

以下错误直接展示在现有状态条：

- 预设加载失败
- 创建/更新/删除预设失败
- 启动对局时 preset 无效
- token 解密失败

## 状态流

### 设置页流转

1. 页面加载时请求 `GET /api/settings/presets`
2. 用户新增或编辑预设时调用对应 HTTP API
3. 成功后重新拉取列表或局部更新本地状态
4. 列表数据同时驱动设置页和实时对局选择器

### 对局启动流转

1. 用户在实时对局区选择红蓝预设
2. 点击“启动模拟”
3. 前端发送带双方 preset id 的 `start`
4. 服务端读取并解密两份配置
5. 服务端实例化 `GameOrchestrator`
6. `GameOrchestrator` 分别创建 `llm1` 和 `llm2`
7. 对局开始，后续状态同步保持原有机制

## 测试策略

遵循 TDD，先补测试再改实现。

### 服务端测试

至少覆盖：

1. `PresetStore` 创建后，JSON 文件中不出现明文 token
2. `PresetStore` 能正确读取、更新、删除预设
3. 更新预设且未传新 `apiKey` 时，旧 token 被保留
4. `start` 使用不同 preset 时，`GameOrchestrator` 使用不同模型配置
5. 无效 preset id 会返回可读错误消息

### 前端测试

至少覆盖：

1. 设置表单能创建预设
2. 编辑预设时留空 token 不会清空已有 token
3. 启动消息会携带 `player1PresetId` 和 `player2PresetId`
4. 红蓝任一未选中时启动按钮禁用

## 迁移策略

由于当前 `.env` 模式被移除，迁移策略为一次性切换：

1. 保留 `PORT` 等非业务运行参数
2. 移除 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 作为实时对战依赖
3. 首次升级后，用户需在前端设置页中创建至少一个预设

若服务端没有任何预设：

- 回放功能仍可正常使用
- 实时对战按钮不可用，前端提示先创建预设

## 文档更新

实现完成后必须同步更新：

1. `docs/ai-api-contract.md`
2. `docs/current-mvp-reality.md`
3. `docs/sprint/current-issues.md`

重点更新内容：

- 启动对局消息协议
- 预设管理接口
- 实时对战配置来源
- 新的运行前置条件

## 风险与取舍

### 风险

1. 服务端运行期需要能解密 token，因此这不是强安全方案
2. 新增设置页后，前端状态和实时对局状态会比当前更复杂
3. 当前服务端从“固定单例 orchestrator”切到“按启动动态创建 orchestrator”，需要仔细处理 stop/save_record 空状态

### 取舍

1. 优先满足“磁盘不明文”而不是“高强度密钥管理”
2. 优先保持当前对局与回放架构不变，只替换配置来源
3. 优先为未来 provider 扩展预留结构，但当前实现只交付 OpenAI-compatible

## 实施边界

本次实现应限制在以下范围：

- server：存储层、加密、设置 API、动态 orchestrator 创建
- client：设置页、预设 CRUD、红蓝选择、启动协议改造
- shared：补充前后端共享类型
- docs：更新 API 契约与当前现状文档

不进入以下范围：

- 用户登录
- 云端同步
- 多人共享预设权限
- 非 OpenAI-compatible provider 接入
