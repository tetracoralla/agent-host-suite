# Agent Host 轨迹平面

## 用途

轨迹平面让 Agent Host 以同一套隐私最小化语义观察不同 Agent Shell，
但不会假装它们的数据文件和事件系统完全相同。每个适配器只声明当前
确实能够提供的事实；统一结果始终保留适配器、Provider、源格式、版本、
新鲜度、截断和不可观测字段。

采集优先级依次是：公开类型化事件或遥测接口、官方 OpenTelemetry、
官方 Hook、稳定的本机只读记录，最后才是聚合用量。Agent Host 不修改
Shell、不截取屏幕或键盘，也不会用一个 Shell 的丰富数据去猜另一个
Shell 缺失的事实。

## 两层隐私边界

### 被动采集

定时采集永远只保存元数据：经过哈希的事件、会话、轮次、请求和调用
标识；Provider 与适配器标识；模型名和工具名；时间、运行状态、数量、
耗时、字节数和 Provider 报告的 Token 数。提示词、消息正文、推理内容、
工具参数与结果、Header、Provider 选项、凭据、命令、错误正文和路径
绝不进入 Observer 数据库。

### 显式轨迹分析包

显式导出分为两条路线。用户可以选择一份明确的 ZCode model-I/O 文件和
输出位置；这个 v0.1 分析包默认仍为纯元数据。
只有同时指定 `--include-selected-content` 与
`--confirm-sensitive-content`，才会把所选会话内容写入分析包；即使如此，
已知传输 Header、Provider 选项、凭据字段和源路径仍会被排除。用户编写的
自由文本本身也可能含秘密，导出器无法识别并删除所有此类内容，因此分析包会
明确标记这一风险。导出器会限制输入、
事件数、单段内容、JSON 深度和最终输出大小，记录所有截断，以仅用户可读
权限排他写入一个新文件，并且不会把分析包写回 Observer 状态库。

如果 Provider 原始文件已经轮换消失，用户还可以先按 Provider 列出
Observer 当前保留的会话，再用一个明确的会话哈希和可选毫秒时间范围导出。
这个 v0.2 分析包只使用 Observer 已保存的元数据，绝不支持加入会话正文。
会话目录与分析包均不包含 Provider 路径或原始源标识，并会限制返回量、
公开当前保留期限，同时把会话完整性标为未知。重复出现的“已提供工具”目录
只按内容寻址保存一份，由模型步骤引用，不会在分析包里反复展开。列出和导出
不会触发采集。

分析包只是交给用户所选 Agent 的材料，不是 Observer 的推荐、评估、
批准，也不能证明正确性或采纳。

启用本机监测后，可通过 Agent Host 的公开命令使用：

```sh
agent-host observability adapters --json
agent-host observability adapter-plan --adapter openadam.gemini-cli-otel --json
agent-host observability trace-sources --provider zcode --limit 25 --json
agent-host observability export-trace --provider zcode \
  --session 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --output /新建的/retained-trace-pack.json --json
agent-host observability export-trace --provider zcode \
  --file /明确选择的/model-io-file.jsonl --output /新建的/trace-pack.json --json
```

`adapters` 返回不含路径的能力目录；`trace-sources` 返回一个 Provider
当前保留的、带数量上限且不含路径的匿名会话目录。Manager 的“使用情况与
可靠性”页面也提供同样的会话列表与纯元数据下载流程。浏览器放弃下载时，
Manager 会取消已安装 Observer 的子进程并清除私有临时输出；只有完整结果
才会以新文件发布，因此中断不会暴露半成品。`adapter-plan` 返回一个适配器当前所需
的用户级配置片段与撤回方法，但始终标记 `appliesChanges: false`，Agent Host
不会修改其他 Agent Shell 的设置。只读记录适配器无需更改 Shell；事件、
遥测与 Hook 适配器只有在用户或其 Agent 审阅并应用方案后才会生效。

## 适配器能力协商

每个适配器通过 `openadam.agent-shell-adapter.v0.1` 描述：传输方式、
被动采集或显式导出能力、模型步骤／工具暴露／工具调用与结果／用量／
轮次结束／自述理由存在性等信号、内容边界，以及操作系统和源格式版本。

每项信号只能是 `available`、`partial` 或 `unavailable`；不可用不等于零。
运行时探测可以因源缺失或版本不支持而降低覆盖，但不能从未读取的记录
中抬高覆盖结论。

## 统一语义

- “工具已暴露”只表示某次已记录请求的工具目录里出现了该名称；
- “工具调用”只表示 Shell 记录了模型发出或运行时派发的调用；
- “工具结果”只表示 Shell 记录了对应调用的运行时结果；
- `completed` 是传输／运行状态，不代表语义正确；
- “存在模型自述理由”只记录是否存在，不在被动状态中保存正文，也不能
  独立解释为什么使用或未使用某个工具；
- “结果已交付”不代表模型、用户或下游成果采纳了结果。

## 当前路线

- Codex：本机会话事件；
- Claude Code：本机项目事件，可选官方 Hook 桥；
- ZCode：只读用量数据库、增量 model-I/O 轨迹和显式单源导出；
- DeepSeek Harness：公开的持久 `session/event` 桥，不私自猜解压缩会话；
- Gemini CLI：直接增量读取用户明确配置的官方本机 OpenTelemetry 文件，
  要求 `telemetry.logPrompts=false`，并过滤含正文的记录；不会运行收集器或
  OTLP 监听器；
- GitHub Copilot CLI：官方 Hook 经 Agent Host 元数据桥，安装 Hook 必须由
  用户明确选择；一次工具后置 Hook 同时生成调用与结果元数据，避免每次
  调用启动两次 Node 进程。

Claude 命令 Hook 方案固定使用 `async=true`、空输出和退出码 0，使 Observer
不能阻塞或引导 Agent。Copilot CLI 的公开 Hook 契约目前为同步执行，因此
方案只使用工具后置、失败、停止和会话结束事件，并设置两秒超时。桥仍然
只写元数据；Shell 报告的完成状态不是质量判断。

任何被动适配器都不能证明 Skill 激活、语义效果、结果采纳、未使用原因、
任务质量、机会或产品价值。用户或其 Agent 可以分析显式选择的材料并另行
撰写提案，但该提案必须保留自己的来源与不确定性。
