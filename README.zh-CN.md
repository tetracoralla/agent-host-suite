# Agent Host

[English](README.md) · [简体中文](README.zh-CN.md)

Agent Host 为受支持的 Agent 应用安装并管理一套兼容的本地工具环境。它只使用公开扩展
入口连接工具，并在本机运行已选择的结构化任务，不修改 Agent 应用自身。

本仓库是 **Agent Host Suite** 的分发单元；npm 包、CLI、schema 等稳定技术标识继续使用
这个名称。

当前源码树是开发者预览：**无公证**、无 Developer ID 签名、也不是 App Store 或插件
市场。陌生人应从 GitHub Release 或已配置的 HTTPS 地址下载 macOS DMG / Windows
安装包（所有者发布资产之后）；在此之前 Host 会明确说「尚未配置公开下载」。macOS
需按住 Control 点击 → 打开。设置 `AGENT_HOST_FEATURED_CATALOG_URL` 后，Host 可拉取
绑定 catalog 并安装工具。见
[未公证预览下载](docs/UNSIGNED_PREVIEW.md)。Host 工作集里的「已选中」不能证明正在
打开的 Agent 会话已经载入这些工具。

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

## 读者对象

- **外部用户**：安装一份**已绑定**的兼容版本（打包载体，或
  `setup --release-manifest` 指向该 catalog）。工具来自该版本中所选 profile 的成员，
  并需要新建 Agent 任务。本仓库跟踪的 catalog 是 `draft-unbound`，没有绑定 manifest
  时公开 setup 会失败。
- **tools-dev dogfood**：有授权源码仓库的开发者遵循
  [Local dogfood](docs/LOCAL_DOGFOOD.md)。兄弟仓库只是构建输入，不是运行时路径；
  `local-dogfood` 是本机反馈 profile，不是商店。

[精选目录 v1](docs/FEATURED_CATALOG.md) 是名为 `featured` 的 profile：通过上述同一套
安装 API 选出的独立发布工具子集。浏览器与原生 Manager 可在设置时选择精选，或在标准
安装后“获取精选工具”（含 Armorial）。`tools set --profile` 只启用已安装工具的工作集，
不会安装尚未入库的工具。它不是市场。Codex 投影与会话 Skill/MCP 路径见
[发现与投影](docs/DISCOVERY_PROJECTION.md)。

## Profile

- `standard`：小型默认 Agent 工具集。
- `featured`：面向外部用户的准入列表，在 `standard` 上增加 Armorial。用
  `agent-host profiles list` 查看；它不是 `local-dogfood`。
- `observability`：经用户明确同意后增加本机监测，但不把监测组件加入普通 Agent 工具目录。
- `local-dogfood`：增加开发期工具库存，同时保留较小的默认启用集合。
- `developer`：以 Skill-only 后台组件安装 Agent Tool Development Kit；该 profile 不提供
  Agent MCP 工具，只投影 Developer Kit Skill 与 launcher。

评估辅助工具只属于开发与 CI，不是可安装的 profile，也不进入普通 Agent 工具目录。

准确成员必须从 profile 文件与所选 release manifest 读取，不应从文档中的数量或列表推断。
已安装库存与 Agent 当前可见工具是两回事；修改连接后，需要新建 Agent 任务再判断工具发现
与自然采用。

## 外部精选路径

本 checkout 没有 GitHub Release 资产。所有者发布 Release 或 HTTPS 清单之后（见
[未公证预览下载](docs/UNSIGNED_PREVIEW.md)）：

```text
export AGENT_HOST_FEATURED_CATALOG_URL=https://github.com/tetracoralla/agent-host-suite/releases/latest/download/preview-distribution.json
agent-host profiles list --json
agent-host profiles fetch --json
agent-host setup --profile featured --host zcode
agent-host tools set --profile featured
agent-host doctor --deep --json
```

也可继续用 `--release-manifest /absolute/current.json` 指向本地绑定 catalog。

跟踪的 `draft-unbound` catalog 上 setup 会失败。`--development-root` 是
tools-dev 路径，不是 featured。详见
[精选目录 v1](docs/FEATURED_CATALOG.md)。

## 不点名采用验收

本 checkout **没有**记录一次已完成的真人采用。没有 Host GUI / 完整 Agent 会话的
Linux 施工环境也不能替它打分。在已经装好 Agent Host 并连接 Agent 应用的机器上，按
[不点名采用验收](docs/ADOPTION_ACCEPTANCE.md) 把页面夹具拷出仓库、开**新会话**、
看图标是否进入作品，且提示里不出现 Armorial。

```text
agent-host doctor --featured-readiness --json
```

该命令只检查 featured 工作集已选、以及已连接应用的投影 receipt 是否健康，并且
`adoptionEvidence` 恒为 `false`。Host status 与调用次数不能当采用证据。

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

本仓库是 Apache-2.0 开发者预览。**无公证。** 公开预览安装包保持未签名，打算放在
[GitHub Releases](https://github.com/tetracoralla/agent-host-suite/releases)
或自建 HTTPS 站点。本 checkout 不声称那些资产已经存在。

- 不存在公开的 Agent Host 市场或第三方插件商店。
- macOS 预览 DMG 未经 Developer ID 签名、未经 Apple 公证。Gatekeeper 需要按住
  Control 点击 → 打开。这就是受支持的预览路径，不是「等以后上架」的权宜之计。
- Windows 预览 ZIP 未做 Authenticode 签名。SmartScreen 可能警告；先核对 SHA-256。
  详见 [`docs/WINDOWS.zh-CN.md`](docs/WINDOWS.zh-CN.md)。
- 设置 `AGENT_HOST_FEATURED_CATALOG_URL` 后，Host 可下载绑定 catalog 并安装精选
  工具。见 [未公证预览下载](docs/UNSIGNED_PREVIEW.md)。

完整产品模型、架构、集成 schema、发布流程与复核契约以英文文档为准。这些维护者文档不随
npm 包分发；请从源码仓库阅读
[`PRODUCT_MODEL.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/PRODUCT_MODEL.md)、
[`ARCHITECTURE.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/ARCHITECTURE.md)、
[`TOOL_INTEGRATION.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/TOOL_INTEGRATION.md)、
[`RELEASE.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/RELEASE.md)、
[`REVIEW_CONTRACT.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/REVIEW_CONTRACT.md)、
[`DISCOVERY_PROJECTION.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/DISCOVERY_PROJECTION.md)、
[`FEATURED_CATALOG.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/FEATURED_CATALOG.md)、
[`UNSIGNED_PREVIEW.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/UNSIGNED_PREVIEW.md) 与
[`ADOPTION_ACCEPTANCE.md`](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/ADOPTION_ACCEPTANCE.md)。
