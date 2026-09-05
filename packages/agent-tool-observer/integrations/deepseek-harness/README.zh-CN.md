# DeepSeek Harness Observer 桥

这个可选本机插件通过 DeepSeek Harness 公开、持久的 `session/event` 事件
流观察运行情况，只把 `openadam.agent-shell-trace-bridge.v0.1` 元数据追加到
用户指定的本机文件。它不会写入提示词、消息正文、推理、参数、结果、命令、
Header、凭据或工作路径。

当前适配针对 DeepSeek Harness 会话格式 `0`，核对的上游提交为
`4e84901e6471b79ec0338099867ebb4606d12bb5`。只有用户把插件明确加入组合，
且 Observer 实际读到当前桥事件后，运行时能力状态才能从 `unconfigured`
改变。

安装或链接本包后，在组合中加入名称可解析为
`@openadam/deepseek-harness-observer-bridge` 的插件，并配置绝对输出路径：

```yaml
config:
  output: /absolute/path/to/Agent Tool Observer/bridges/deepseek-harness.jsonl
  providerVersion: 当前安装的 DeepSeek Harness 版本
```

Windows 使用带盘符的绝对路径。Manager 可以报告生成的数据流是否已经协商并处于健康状态；仅复制示例不能证明插件已经安装。桥会获取仅属当前进程的锁，拒绝两个存活进程写入同一个文件；只有锁中记录的进程已不存在时才会回收陈旧锁。
事件监听器本身不执行磁盘 I/O，而是写入有界内存队列，再异步批量追加。
队列满时会丢弃新的元数据并在 Harness 日志中告警；Observer 只报告真正
写进桥文件的事实。运行成功仍不能证明正确性、采纳、未使用原因或产品机会。
