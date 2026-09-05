# Agent Host Trace Plane

## Purpose

The Trace Plane gives Agent Host one privacy-minimized way to observe supported
Agent shells without pretending their data stores or event systems are the
same. Each adapter negotiates the facts it can currently supply; the normalized
result keeps the adapter, provider, source format, version, freshness,
truncation, and unavailable fields attached.

The collection priority is:

1. a provider's public typed event or telemetry extension;
2. an official OpenTelemetry surface;
3. an official hook surface;
4. a stable owner-local record opened read-only;
5. aggregate usage only.

Agent Host does not patch a shell, intercept keystrokes or screens, or infer
missing facts from another shell's richer format.

## Two privacy tiers

### Passive collection

Scheduled collection is always metadata-only. It may retain hashed event,
session, turn, request, and call identities; provider and adapter identity;
model and tool names; timestamps and runtime states; counts, durations, byte
sizes, and provider-reported token values. It never persists prompt or message
text, reasoning, tool arguments or results, headers, provider options,
credentials, commands, error messages, or paths.

### Explicit Trace Analysis Pack

There are two explicit export routes. The user can select one exact supported
ZCode model-I/O file and destination. That v0.1 pack is metadata-only by
default. Including selected conversation content requires a separate
`--include-selected-content` choice and
`--confirm-sensitive-content` confirmation. Even then, known transport headers,
provider options, credential fields, and source paths are excluded. Arbitrary
user-authored text can itself contain secrets; selected-content export cannot
identify or remove every such value and reports that risk in the pack. The exporter
applies input, event, per-content, JSON-depth, and complete-output limits;
records every truncation; writes a new exclusive owner-only file; and does not
insert the pack into Observer state.

When an original provider file has rotated away, the user may instead list
Observer-retained sessions for one provider and export one explicit session
hash with an optional millisecond time range. That v0.2 pack uses only the
metadata already retained by Observer and can never include selected content.
The source catalog and pack contain no provider path or raw source identity,
remain bounded, report the active retention cutoff, and label session
completeness as unknown. Repeated offered-tool inventories are content-addressed
once and referenced by model-step events instead of being repeated throughout
the pack. Listing and exporting do not trigger collection.

The pack is material for the user's selected Agent. It is not an Observer
recommendation, evaluation, approval, or proof of correctness or adoption.

With monitoring enabled, the public Agent Host commands are:

```sh
agent-host observability adapters --json
agent-host observability adapter-plan --adapter openadam.gemini-cli-otel --json
agent-host observability trace-sources --provider zcode --limit 25 --json
agent-host observability export-trace --provider zcode \
  --session 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --output /new/retained-trace-pack.json --json
agent-host observability export-trace --provider zcode \
  --file /exact/model-io-file.jsonl --output /new/trace-pack.json --json
```

`adapters` is a path-free capability catalog. `trace-sources` is a path-free,
bounded catalog of retained pseudonymous sessions for one provider. The
Manager exposes the same listing and metadata-only download flow under Usage &
Reliability. If a browser download is abandoned, Manager cancels the installed
Observer process and removes its private temporary output. Completed exports
are published only as new files, so interruption cannot expose a partial pack.
`adapter-plan` returns the exact
current-user configuration fragment and removal action for one adapter, but
always reports `appliesChanges: false`: Agent Host never edits another Agent
shell's settings. Automatic record adapters need no shell change. Explicit
event, telemetry, and hook adapters become active only after the user or their
Agent reviews and applies the returned plan.

## Adapter capability negotiation

Every adapter publishes a descriptor using
`openadam.agent-shell-adapter.v0.1`. The descriptor separates:

- `transport`: public events, OTel, hooks, stable local records, or aggregates;
- `collection`: passive metadata and/or explicit export;
- `signals`: model steps, tool offers, tool calls/results, usage, turn ends,
  and self-reported rationale presence;
- `content`: whether an explicit pack can include selected content;
- `runtime`: operating systems and supported source-format versions.

A signal is `available`, `partial`, or `unavailable`; unavailable never means
zero. Runtime probing may lower declared coverage when a source or version is
missing or unsupported, but never raises it from records that were not read.

## Normalized semantics

- `tool offered` means a named tool appeared in one recorded request catalog.
- `tool call` means the shell recorded a model-emitted or dispatched call.
- `tool result` means the shell recorded a runtime result for a call.
- `completed` is a transport/runtime state, not semantic correctness.
- `self-reported rationale present` records only that the shell exposed model
  rationale text. Its content is absent from passive state, and it is not an
  independent explanation of why a tool was or was not used.
- `result delivered` does not mean the model, user, or downstream artifact
  adopted the result.

## Current adapter routes

- **Codex:** owner-local persisted session events; tool and cumulative session
  usage projection. Detailed availability is limited to what the stored event
  format exposes.
- **Claude Code:** owner-local project events, with an optional official-hook
  bridge for deployments that enable it.
- **ZCode:** read-only usage SQLite plus bounded incremental model-I/O JSONL
  trajectory projection and explicit selected-source export.
- **DeepSeek Harness:** public durable `session/event` bridge. The bridge emits
  only the normalized metadata protocol; compressed canonical transcripts are
  not decoded by Observer as a substitute for the public extension.
- **Gemini CLI:** official local-file OpenTelemetry is the preferred route.
  With `telemetry.logPrompts=false`, Observer reads that exact local output
  incrementally and filters content-bearing records; it runs no collector or
  OTLP listener.
- **GitHub Copilot CLI:** official hooks are the preferred route. Agent Host
  supplies a metadata bridge writer and validates its output, while hook
  installation remains an explicit user change. One post-tool hook emits the
  call and result metadata together to avoid a second synchronous Node launch.

Claude command hooks are planned with `async=true`, empty output, and exit code
zero so Observer cannot block or steer the Agent. Copilot CLI hooks currently
run synchronously under its public contract, so the plan uses only post-tool,
failure, stop, and session-end events and a two-second timeout. The bridge
still records metadata only; shell-reported completion remains a runtime fact,
not a quality judgment.

## Honest limits

No passive adapter can prove Skill activation, semantic effect, result
adoption, non-use reason, task quality, opportunity, or product value. A user
or their Agent may analyze an explicitly selected pack and author a proposal,
but that proposal remains a separate assessment with its own provenance and
uncertainty.
