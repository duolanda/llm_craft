# 复盘指令的固定上下文评估

修改复盘指令前，先固定一局真实对战产生的复盘请求。同一份输入反复调用同一模型，每轮只替换末尾的复盘指令，再根据实际输出修订提示词。不要用文案字符串测试代替模型行为评估。

一次完整执行记录见 [2026-09-06 固定上下文实验](reflection-evaluation-2026-09-06.md)，包括未通过的候选、角色对照、重复采样和采用范围。

## 样本与验收

样本必须来自正常终局，并在 `GameOrchestrator.reflectPrompt` 等待最后一轮决策收尾后，由原 `OpenAIAgentSession` 的 `onRequest` 回调采集。保存当时的 system prompt、实际保留历史（包括工具结果、供应商 replay 数据）、工具定义、终局身份和生成参数。已经丢失的早期历史不会补造；无 transcript 的旧 Match Record 不能完整还原这份输入。

人工审阅每次完整输出，重点检查：

- 是否保留有对局证据的核心打法和有用调整，能指导下一局做决策。
- 是否将经验概括成有适用条件的原则，避免从单局推导固定工人数、距离、资源线、时点或必造阵容。
- 是否合并重复经验，省去战报、旧单位 ID、坐标和事故时间线。
- 是否区分实际观察、原策略里的旧断言和推测，不继承与规则或工具反馈冲突的结论。
- 是否简洁且可读，既不扩写为完整操作手册，也不退化为空泛口号。

字符数和段数用于比较，不单独决定通过。候选达到要求后仍在同一输入上重复采样，检查模型随机性；单样本结果只说明该复盘场景的输出质量，不证明新策略能提升胜率。

每轮记下指令版本、完整输出、未通过的具体句子和修改理由。修改的是通用的筛选与表达要求，不能把这局预期的战术答案直接塞进指令。若基线未复现问题，应如实保留结果，不能仅凭输出变短宣布修复。

## 使用

以下路径均相对仓库根目录。脚本通过 `PresetStore` 在进程内读取所选 preset，保持与生产环境相同的 ModelTransport；不把 API key 写进 fixture 或命令行。

```bash
# 只采一局，默认对手为 rush CPU；需要双 LLM 时传 --opponent-preset。
# 为复现已有策略的继承问题，可传 --prompt 和不可变的 --version。
pnpm --filter @llmcraft/server eval:reflection capture \
  --fixture packages/server/data/reflection-eval/example/context.json \
  --preset <preset-id> --opponent-preset <preset-id> \
  --prompt <prompt-id> --version <version-id>

# 基线：原封不动重放采集时的复盘请求。
pnpm --filter @llmcraft/server eval:reflection run \
  --fixture packages/server/data/reflection-eval/example/context.json \
  --label baseline --runs 2

# 候选：使用当前源码生成末尾的复盘指令，或 --instruction <完整指令文本文件>。
pnpm --filter @llmcraft/server eval:reflection run \
  --fixture packages/server/data/reflection-eval/example/context.json \
  --instruction current --label candidate-1 --runs 3
```

`capture` 使用独立的标准对局和正常 500ms tick，不改变 Web UI 的观战对象。默认最多运行 30 分钟；超时或中止只保存未完成录像，不生成虚假的终局复盘样本。正常结束后先保存含 transcript 的 Match Record，再在原 session 发出复盘请求前保存 fixture，并将这次原指令的输出保存为 `context.json.capture-output.md`。

fixture 的请求哈希用于检测意外改动。每轮还校验包含所有历史、工具和生成参数的前缀哈希，以及 preset 的模型、端点和附加参数哈希；只有末尾指令允许变化。模型认证信息可以轮换，模型与请求设置发生变化则应另建实验。

默认保留 fixture 中末尾消息的角色。如果要单独验证指令优先级，可用 `--instruction-role user|system` 做角色对照；需保持文字相同并单独记录，不能把这组结果当作仅改变措辞的实验。线上是否改变角色应以实际输出为依据。

每个 `--label` 目录保存完整指令、各次原始响应/usage/哈希和可阅读的 Markdown 输出，不复用之前的复盘答案作为历史。已有 fixture 和结果目录不覆盖。所有实验数据默认放在已忽略的 `packages/server/data/`，人工结论可保存在文档中。线上复盘仍继续原会话并按原有流程保存策略，评估脚本不读写策略的 active 版本。
