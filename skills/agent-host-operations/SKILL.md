---
name: agent-host-operations
description: Analyze an installed Agent Host environment's health, active tool set, tool usage, storage, routing cost, and local monitoring state through packaged Agent Host commands. Use for system-status, operations, adoption, cost, cleanup, or an explicitly requested tool-set change; never inspect Agent Host source or Observer storage as a substitute.
---

# Agent Host operations

Use the packaged launcher at `scripts/agent-host`, resolved relative to this
Skill directory. Do not locate or invoke an implementation checkout.

For an ordinary request to analyze the installed environment, call exactly:

```text
scripts/agent-host snapshot --json
```

The snapshot is the default low-context route. It includes bounded current
environment, storage, recent lifecycle, catalog, collection, and fresh-session
observations plus the top eight historical tool-call counts. State the snapshot
and observation timestamps before relying on them. Its totals and `toolUsage`
are sufficient for an ordinary broad status, cost, or tool-usage question.
`environment.availableAgentComponents` is installed inventory;
`environment.agentComponents` is the smaller active set currently exposed to
new Agent tasks. Do not describe an inactive installed tool as uninstalled.

After the snapshot, answer and stop unless current executable health is
explicitly material or one specific requested fact is absent. Do not expand a
broad question into an exhaustive audit.

Escalate only for the question being asked:

- Run `scripts/agent-host doctor --json` when current installed health matters.
- Add `--deep` only when the user asks about executable tool readiness and the
  extra provider probes are warranted.
- Run `scripts/agent-host observability status --json` only when one named
  per-tool or routing detail is absent from the snapshot. Do not use it merely
  because current-release counts are zero or the user asked broadly about tool
  usage. At most once per task, select only the needed fields in the same
  command, and never return the unfiltered full payload to model context.
- Run `scripts/agent-host activity --json` only when the bounded lifecycle
  timeline is material.
- Run `scripts/agent-host tools status --json` when the user asks which
  installed tools are active. Change the active set only when the user
  explicitly asks: call one `tools set --tool COMPONENT ... --json` with the
  complete desired set, or `tools reset --json` to restore the profile default.
  Preserve at least one active Agent tool. A successful change requires a fresh
  Agent task and does not establish that an already-open task reloaded schemas.
- Do not run `observability refresh`, cleanup, update, rollback, host changes,
  tool-set changes, or uninstall unless the user requested that state change.

Treat Agent Host and Observer output as observations or measurements. Preserve
provider coverage, freshness, truncation, unknown values, and the distinction
between a completed call and a correct or useful task result. Observer has no
model and does not establish causation, opportunity, natural adoption, routing
quality, task quality, or retirement decisions. Make those assessments
outside the product from current task context, and label the inference.

`freshSession.requiredAfterBindingChange` is an installation policy, not a
measurement that a currently open Agent app is stale. Its companion
`currentSessionUptake: not-observed` must remain unknown unless a fresh real
host session is independently exercised.

Never read `state.json`, Observer SQLite, provider event files, private host
configuration, or Agent Host/Observer source to bypass a missing product
result. Report the product route unavailable or insufficient instead. Use a
targeted controlled evaluation when passive metadata cannot answer a causal or
quality question.
