# Agent shell integrations

Observer has two connection classes:

- Codex persisted sessions, Claude project records, and ZCode usage/model-I/O
  records are discovered read-only. No Agent-shell configuration is changed.
- DeepSeek Harness public events, Gemini CLI local telemetry, Claude Code
  hooks, and GitHub Copilot CLI hooks require an explicit user-owned change.

After Observer is installed, inspect the available adapters and generate one
non-mutating plan:

```sh
agent-tool-observer adapters --json
agent-tool-observer adapter-plan --adapter openadam.gemini-cli-otel --json
```

The plan contains exact paths because it is requested for one adapter; the
catalog and normal reports remain path-free. Every plan says
`appliesChanges: false`. Review and merge it into the Agent shell's current
configuration instead of replacing the whole settings file. Preserve a copy
of the prior user-owned settings and follow the plan's `removal` field before
purging Observer runtime data.

## Routes

- **DeepSeek Harness:** load the packaged `deepseek-harness` module in the
  owning application, subscribe it to public durable `session/event` events,
  and drain it during shutdown. It never decodes private compressed sessions.
- **Gemini CLI:** enable official local telemetry with the returned output
  file and `logPrompts: false`. Observer directly reads concatenated JSON
  objects incrementally; it starts no collector or listener.
- **Claude Code:** merge only the returned OpenAdam hook items. Every command
  hook is asynchronous, returns no output, and exits zero, so it cannot block
  or steer the Agent.
- **GitHub Copilot CLI:** write the returned owned hook document. Post-tool
  events emit call and result metadata together, limiting synchronous bridge
  launches to one per tool result; the two-second hook timeout is a safety
  bound.

All bridges hash identifiers before storage and omit prompts, messages,
reasoning, tool arguments/results, commands, paths, provider errors, and
credentials. They observe transport/runtime facts only. Missing data is
unknown, and completion is not correctness, adoption, usefulness, or value.
