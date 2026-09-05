---
name: agent-host-operations
description: Analyze an installed Agent Host environment's health, active tool set, tool usage, storage, routing cost, and local monitoring state through packaged Agent Host commands. Use for system-status, operations, adoption, cost, cleanup, or an explicitly requested tool-set change; never inspect Agent Host source or Observer storage as a substitute.
---

# Agent Host operations

Use the packaged launcher resolved relative to this Skill directory:
`scripts/agent-host` on macOS/Linux and `scripts/agent-host.cmd` on Windows.
Do not locate or invoke an implementation checkout.

For an ordinary request to analyze the installed environment, call exactly:

```text
scripts/agent-host snapshot --json
```

The snapshot is the default low-context route. It includes bounded current
environment, storage, recent lifecycle, catalog, collection, and fresh-session
observations plus the top eight historical tool-call counts. State the snapshot
and observation timestamps before relying on them. When monitoring is enabled,
`observationSource: current-observer-snapshots` means the command read the
current packaged Observer status and report snapshots without triggering a
collection. `cached-agent-host-refresh` is an explicit fallback and may be
stale; report its `currentReadErrorCode` and do not promote cached zeroes to a
current fact. Also report `collector.loaded`, `freshness.status`, and provider
coverage when they are material. Its totals and `toolUsage` are sufficient for
an ordinary broad installed-environment question. For a request specifically
about provider activity, provider-reported Token usage, most-used tools,
observed outcomes, or Direct Runtime reliability, call exactly
`scripts/agent-host usage --json` instead. That formal result is bounded and
privacy-minimized; do not reconstruct it from private Observer storage.
`environment.availableAgentComponents` is installed inventory;
`environment.agentComponents` is the smaller active set currently exposed to
new Agent tasks. Do not describe an inactive installed tool as uninstalled.

After the snapshot, answer and stop unless current executable health is
explicitly material or one specific requested fact is absent. Do not expand a
broad question into an exhaustive audit.

When the user explicitly selects current operations data as input to an
opportunity analysis, use this same bounded snapshot as one
`observer-snapshot` source in the installed Developer Kit material manifest.
Persist the command output only when the user authorized that local working
file, bind its exact bytes with `materials inspect`, and keep collection
freshness and unavailable fields intact. Never substitute Observer SQLite,
provider records, or a recursive Agent-state scan, and never let the snapshot
itself nominate a Skill, Provider, Capability, Procedure, repair, or retirement.

Escalate only for the question being asked:

- Run `scripts/agent-host doctor --json` when current installed health matters.
- Run `scripts/agent-host usage --json` when the user asks for the bounded
  Usage & Reliability view, provider-reported Tokens, provider activity, top
  mapped tools, observed outcomes, or Direct Runtime reliability.
- Add `--deep` only when the user asks about executable tool readiness and the
  extra provider probes are warranted.
- Run `scripts/agent-host observability status --json` only when one named
  per-tool or routing detail is absent from the snapshot. Do not use it merely
  because current-release counts are zero or the user asked broadly about tool
  usage. At most once per task, select only the needed fields in the same
  command, and never return the unfiltered full payload to model context.
- Run `scripts/agent-host activity --json` only when the bounded lifecycle
  timeline is material.
- If an authorized setup, update, or rollback returns
  `SERVICE_INSTALL_ROLLBACK_FAILED`, report its path-free `recovery.action` and
  do not claim automatic rollback succeeded. Only when the user authorizes the
  recovery, pass the returned `service recover --recovery ...
  --manifest-sha256 ...` arguments unchanged to this Skill's packaged launcher.
  Never supply or search for a recovery bundle path. Report the command's
  observed `service.running` and `service.ready`; a failed recovery keeps the
  bundle for owner intervention and must not be retried with guessed values.
- When the user explicitly chooses historical trace metadata for analysis,
  call `scripts/agent-host observability trace-sources --provider PROVIDER
  --json` for one named provider. This is a bounded, path-free listing of
  Observer-retained pseudonymous sessions; it does not trigger collection and
  each session's completeness remains unknown. Export only one session the
  user or their selected Agent has explicitly selected, to a new authorized
  destination, with `scripts/agent-host observability export-trace --provider
  PROVIDER --session HASH --output FILE --json`. Add `--from-ms` and `--to-ms`
  only for an explicitly bounded range. Retained-session export is always
  metadata-only; never request selected content, read the Observer database, or
  infer an opportunity from the listing itself. Inspect bounded summaries first;
  offered-tool catalogs are content-addressed once in the pack and should not be
  expanded into model context unless their exact membership is material.
  A temporary export or analysis request does not authorize creating or updating
  Agent memory, task notes, or any other durable analysis artifact. Do so only
  when the user explicitly requests that persistent output.
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

Use `observability.observationCoverage` to distinguish what the installed
telemetry can actually establish. A provider's available Skill inventory is
not evidence that one Skill was activated. Unless a host emits an authoritative
Skill-activation event, report Skill use as unavailable rather than zero.
Passive telemetry also cannot establish why an Agent did not call a tool, the
semantic effect of a result, or whether the Agent accepted it. For a
consequential question, use a fresh controlled baseline/treatment task with a
task-native outcome check, or obtain a contemporaneous explicit Agent
assessment; otherwise leave the result unknown.

`observability.activity` is a bounded provider summary. Its observed session
counts and UTC active days are useful activity measurements; its longest
observed session span is the elapsed span between recorded events, not chat
duration or active human work time. Token totals are provider-reported usage
measurements and may have partial coverage. Do not compare providers without
preserving those coverage differences.

`freshSession.requiredAfterBindingChange` is an installation policy, not a
measurement that a currently open Agent app is stale. Its companion
`currentSessionUptake: not-observed` must remain unknown unless a fresh real
host session is independently exercised.

Never read `state.json`, Observer SQLite, provider event files, private host
configuration, or Agent Host/Observer source to bypass a missing product
result. Report the product route unavailable or insufficient instead. Use a
targeted controlled evaluation when passive metadata cannot answer a causal or
quality question.
