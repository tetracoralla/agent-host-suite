# Agent Host

[English](README.md) · [简体中文](README.zh-CN.md)

Agent Host 为受支持的 Agent 应用安装并管理一套兼容的本地工具环境。它只使用公开扩展
入口连接工具，并在本机运行已选择的结构化任务，不修改 Agent 应用自身。

本仓库是 **Agent Host Suite** 的分发单元；npm 包、CLI、schema 等稳定技术标识继续使用
这个名称。

## 范围与事实来源

- Capability contract 定义稳定的类型化操作语义；Procedure contract 定义已经稳定的多阶段
  方法。
- 独立 Provider 负责自己的领域行为和发布；Agent Host 负责校验、安装、连接、运行与本机
  生命周期。
- Agent Host 不内嵌外部 Provider 源码，也不向模型暴露通用 Provider 调用工具。

本文只描述长期边界，不代表某台机器的安装状态，也不是发布 manifest。

- `catalog/profiles/*.json` 是 profile 成员关系的事实来源。
- 绑定后的 release catalog 定义一个兼容版本：manifest 决定准确软件包、版本与哈希，
  独立校验的相邻 `build-provenance.json` 记录决定构建来源。
- `status`、`snapshot`、`usage` 和 `doctor` 只描述命令运行当时的本机状态。
- 源码回归、已安装 Agent 流程、直接运行时、管理界面、二进制分发和所有者体验必须分别
  判断，不能互相替代。

仓库内置的发布目录故意保持未绑定，因此源码仓库不会假装已经提供可公开安装的版本。

## Profile

- `standard`：小型默认 Agent 工具集。
- `observability`：经用户明确同意后增加本机监测，但不把监测组件加入普通 Agent 工具目录。
- `local-dogfood`：增加开发期工具库存，同时保留较小的默认启用集合。
- `developer`：以 Skill-only 后台组件安装 Agent Tool Development Kit；该 profile 不提供
  Agent MCP 工具，只投影 Developer Kit Skill 与 launcher。

评估辅助工具只属于开发与 CI，不是可安装的 profile，也不进入普通 Agent 工具目录。

准确成员必须从 profile 文件与所选 release manifest 读取，不应从文档中的数量或列表推断。
已安装库存与 Agent 当前可见工具是两回事；修改连接后，需要新建 Agent 任务再判断工具发现
与自然采用。

## 常用流程

```text
agent-host setup --profile standard --host zcode --release-manifest /absolute/current.json
agent-host snapshot --json
agent-host usage --json
agent-host doctor --deep --skip-agent-apps --json
agent-host tools status
agent-host manager
agent-host update --release-manifest /absolute/new-current.json
agent-host rollback
agent-host uninstall
agent-host uninstall --purge-data
```

只有在需要核对 Agent 应用当前连接时，才运行 Full Check 或不带
`--skip-agent-apps` 的 `doctor --deep`。如果服务替换失败并返回结构化恢复动作，应在同一个
Agent Host 私有状态上使用其中的不透明恢复标识和 manifest 摘要；不要自行拼接或传入恢复
目录路径。

Agent Host 默认保留用户拥有的应用配置与数据。本机监测需要主动开启，被动采集只保存元数据。
`uninstall --purge-data` 会删除 Suite 拥有的快照与历史，但 Observer 共享数据库有独立的数据
生命周期，因此会被保留。观测到工具调用或工具曾被提供，不能证明 Skill 已激活、结果被采用、
结果正确、任务质量或价值。完整边界见
[`docs/TRACE_PLANE.zh-CN.md`](docs/TRACE_PLANE.zh-CN.md)。

`update` 上明确给出的 manifest 用于选择新的 release catalog；不带该参数的 `update` 只适用于
内置 catalog 已绑定的打包载体。

## 分发边界

本仓库是 Apache-2.0 开发者预览。每个候选版本必须独立判断公共二进制是否可发布：

- Windows 打包与干净设备要求见 [`docs/WINDOWS.zh-CN.md`](docs/WINDOWS.zh-CN.md)。
- macOS 公共二进制需要 Developer ID 签名、Apple 公证、stapling、Gatekeeper 检查与干净
  设备验收。
- 本机或内部使用的 ad-hoc 签名构建只是验证产物，不是公共下载。

完整产品模型、架构、集成 schema、发布流程与复核契约以英文文档为准。这些维护者文档不随
npm 包分发；请从源码仓库阅读
[`PRODUCT_MODEL.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/PRODUCT_MODEL.md)、
[`ARCHITECTURE.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/ARCHITECTURE.md)、
[`TOOL_INTEGRATION.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/TOOL_INTEGRATION.md)、
[`RELEASE.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/RELEASE.md) 与
[`REVIEW_CONTRACT.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/REVIEW_CONTRACT.md)。
