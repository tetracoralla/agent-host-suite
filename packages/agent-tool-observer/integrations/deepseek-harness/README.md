# DeepSeek Harness Observer bridge

This optional local plugin observes DeepSeek Harness's public durable
`session/event` stream and appends only
`openadam.agent-shell-trace-bridge.v0.1` metadata to one owner-selected local
file. It never writes prompts, message text, reasoning, arguments, results,
commands, headers, credentials, or working paths.

The adapter was checked against DeepSeek Harness session event format `0` at
upstream commit `4e84901e6471b79ec0338099867ebb4606d12bb5`. Runtime capability
negotiation must remain `unconfigured` until the plugin is explicitly added to
the user's composition and the Observer reads a current bridge event.

## Add to a composition

Install or link this package into the DeepSeek Harness composition, then add a
plugin entry whose `name` resolves to
`@openadam/deepseek-harness-observer-bridge` and whose config contains:

```yaml
config:
  output: /absolute/path/to/Agent Tool Observer/bridges/deepseek-harness.jsonl
  providerVersion: your-installed-deepseek-harness-version
```

On Windows, use an absolute drive path. The Manager can report whether the
resulting stream is negotiated and healthy; copying the example by itself does
not prove the plugin is installed. The bridge takes an owner lock and refuses
to let two live processes append to one file. A stale lock is reclaimed only
when its recorded process no longer exists.

The event listener performs no disk I/O. It projects metadata into a bounded
memory queue and appends batches asynchronously. A full queue drops new
metadata and writes a warning to the Harness logger; Observer then reports only
what reached the bridge file. Runtime success still does not establish
correctness, adoption, non-use reason, or product opportunity.
