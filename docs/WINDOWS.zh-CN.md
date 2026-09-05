# Windows 安装与生命周期

[English](WINDOWS.md) · [简体中文](WINDOWS.zh-CN.md)

## 安装包

Windows 分发物是面向当前用户的单个 ZIP，包含 Agent Host 管理应用、私有 Node.js
运行时、不可变工具与开发者 Kit 软件包、许可证和通知，以及逐文件大小与 SHA-256
清单。使用它不需要源码、Git、npm、管理员权限或系统级服务。

当前工程产物尚未签名。公开下载前仍需确定 Authenticode 签名策略，并在干净设备上
验证 SmartScreen。Apple Developer 身份和 DMG 不影响 Windows 载体。

## 安装

1. 用相邻的 `SHA256SUMS` 核对 ZIP。
2. 完整解压 ZIP。
3. 打开 `Install Agent Host.cmd`。
4. 从“开始”菜单打开 **Agent Host**，选择 ZCode、Codex 或 Claude Code，再选择标准工具、开发者 Kit 或标准工具 + 监控。

安装器会在复制前后验证完整载荷，默认安装到
`%LOCALAPPDATA%\Programs\openAdam\Agent Host`，只把自己的 `bin` 目录加入当前用户
`PATH`，只创建当前用户的 openAdam“开始”菜单快捷方式，并最多保留一个上一应用版本。

无人值守或隔离安装可运行：

```powershell
& '.\Install-AgentHost.ps1' -NoLaunch -NoShortcuts -NoPath
```

## 使用与监控

管理器只绑定 `127.0.0.1`，并用一次性会话地址在默认浏览器中打开。界面首次跟随
Windows 语言，可从侧栏底部的次级“设置”入口切换 English / 简体中文并保存选择。

“使用情况与可靠性”会按 Provider 分开呈现其实际暴露的数据，包括：

- Provider 报告的 Token 总量与 UTC 单日峰值；
- 会话、轮次、活跃天数，以及当前和最长连续活跃天数；
- 有界的最近 30 日活动条；
- 最常用的已映射 Agent Host 工具；
- 完成、错误、取消、耗时和 Direct Runtime 执行计数；
- 采集器健康、新鲜度，以及不完整或缺失的 Provider 覆盖。

Codex Token 是按观测日归组的累计会话汇总，不等于精确的每日增量消耗；观测到的
会话元数据跨度也不等于聊天时长。被动监控不能权威判断 Skill 是否激活、未使用原因、
语义效果、结果采纳、正确性、任务质量或价值。

Direct Runtime 使用每次安装独立的 Windows 命名管道。运行时、Observer 和每周维护
使用当前用户 `\openAdam` 下的任务计划项，不需要管理员权限或机器级服务。

## 更新、恢复与卸载

管理器中的“更新工具”和“恢复上一版工具”改变不可变工具环境。安装新版 ZIP 会更新
Agent Host 应用自身，并保留紧邻的上一应用版本；“开始”菜单中的“Restore previous
Agent Host”可交换两个经过验证的应用版本，而不改动工具或观测数据。Agent 应用绑定
变更后，需要启动新任务才能载入新目录。

如果 Direct Runtime 任务计划替换及其自动回滚都失败，请执行错误中返回的结构化
`agent-host service recover --recovery ID --manifest-sha256 SHA256` 动作。该命令不
接受 bundle 路径，并在 Host 生命周期锁内运行；只有所选私有状态、当前 launcher 和
Task XML 仍与失败记录一致时才会恢复。过期、已变更、被篡改、摘要错误或未知的引用
都不会触碰当前服务，并会保留给所有者处理。

从“开始”菜单运行“Uninstall Agent Host”。默认卸载应用、任务计划项、Agent Host
创建的 Agent 应用绑定、工具软件包、快捷方式和 `PATH` 项，但保留本地历史、设置和
Observer 观测，便于重新安装。若还要移除 Agent Host 私有状态：

```powershell
& "$env:LOCALAPPDATA\Programs\openAdam\Agent Host\Uninstall-AgentHost.ps1" -PurgeData
```

Observer 的独立本地数据库仍会保留；删除它需要 Observer 自己的明确清理操作。

## 维护者构建

构建必须在 Windows 上运行，并提供包含 Windows 标准、监控和开发者 Kit 软件包的已
绑定发布目录：

```powershell
$env:AGENT_HOST_RELEASE_CATALOG = 'C:\absolute\release-catalog'
npm run package:windows
```

该目录必须包含有效的 `build-provenance.json`，且来源策略必须为
`remote-tagged`。每个来源条目都必须对应干净检出、完整提交 SHA，以及当前
仍能从所声明 HTTPS 远端解析到同一提交的不可变标签。最终 payload 与 ZIP
分发清单都会保留来源策略和摘要。仅 CI 固定夹具可显式允许本地来源；这种
构建不构成对外兼容性发布。

产物写入 `.build\windows\distribution`。仓库跟踪的目录有意保持未绑定，因此在真实
Windows Provider 软件包、许可证、SBOM 与摘要就绪前会安全失败。CI 使用的确定性
fixture 只验证打包和脱离源码的生命周期，不是公开兼容性发布。
