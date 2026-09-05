# Agent Shell 接入

Observer 有两类接入方式：

- Codex 持久会话、Claude 项目记录与 ZCode 用量／model-I/O 记录由 Observer
  只读发现，不改变 Agent Shell 配置；
- DeepSeek Harness 公开事件、Gemini CLI 本机遥测、Claude Code Hook 与
  GitHub Copilot CLI Hook 需要用户明确应用配置。

安装 Observer 后，先查看目录，再为一个适配器生成不执行变更的方案：

```sh
agent-tool-observer adapters --json
agent-tool-observer adapter-plan --adapter openadam.gemini-cli-otel --json
```

单个方案因用户明确请求而包含准确路径；目录和普通报告仍不含路径。所有
方案都标记 `appliesChanges: false`。应把方案合并到当前 Shell 配置，而不是
覆盖整个设置文件；保留用户原配置，并在清除 Observer 运行数据前先按
`removal` 字段断开外部接入。

## 各 Shell 路线

- **DeepSeek Harness：**由所属应用加载随包提供的 `deepseek-harness` 模块，
  订阅公开的持久 `session/event`，并在退出时排空队列；不解码私有压缩会话。
- **Gemini CLI：**按方案启用官方本机遥测文件并保持 `logPrompts: false`。
  Observer 直接增量读取连续 JSON 对象，不启动收集器或监听端口。
- **Claude Code：**只合并方案中的 OpenAdam Hook 项。所有命令 Hook 均异步、
  无输出、退出码为 0，因此不能阻塞或引导 Agent。
- **GitHub Copilot CLI：**写入方案中的独立 Hook 文件。工具后置事件一次
  同时产生调用和结果元数据，把同步桥进程限制为每个工具结果一次；两秒
  超时是安全上限。

所有桥在落盘前哈希标识，不保存提示词、消息、推理、工具参数／结果、命令、
路径、Provider 错误或凭据。它们只观察传输／运行事实；缺失数据仍是未知，
完成也不等于正确、采纳、有用或有价值。
