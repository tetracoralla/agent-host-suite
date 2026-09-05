# Agent Tool Observer

> **Source ownership:** this is an opt-in backstage Agent Host package, not an
> independently marketed product or ordinary Agent-visible tool.

Agent Tool Observer is a private, local-only observer for the Agent clients on
this Mac or Windows PC. It incrementally reads the structured records already
written by Codex, Claude Code, and ZCode, plus explicitly connected metadata
bridges, projects only bounded usage and trace metadata into its own SQLite
database, and produces conservative reports.

It does not instrument tools, modify client records, capture screens or
keystrokes, upload data, call a model, or run baseline/treatment evaluations.

Direct Execution Runtime may write an optional metadata-only
`openadam.direct-execution-observation.v0.1` JSONL log. The observer reads that
exact owner-local file incrementally and records versioned Capability,
Procedure, or MCP target identity together with terminal state, latency, queue
time, serialized request/result byte counts, and cold/warm session state. Work
orders, call IDs, inputs, results, and error messages are not retained.

Context Surface Analyzer remains responsible for measuring an explicit tool
catalog snapshot. Its successful `context-surface.analysis.v0.1` result can be
imported into the observer; the observer stores only source revision, digests,
counts, byte measurements, and explicitly reported token measurements. It does
not discover or crawl installed catalogs.

Agent Host may also hand the observer one bounded
`openadam.agent-host-deployment-observation.v0.1` file. It contains the active
compatibility-release identity, immutable component versions and digests,
declared Agent-visible tool bindings, and the exact imported catalog digest.
That lets reports correlate passive calls with the release that declared the
binding without storing task content, commands, or filesystem paths.

## Commands

```sh
node --no-warnings src/cli.mjs collect
node --no-warnings src/cli.mjs status
node --no-warnings src/cli.mjs report --days 30
node --no-warnings src/cli.mjs report --days 30 --openadam --json
node --no-warnings src/cli.mjs ingest-context-surface --file /path/to/analysis.json --json
node --no-warnings src/cli.mjs ingest-agent-host-deployment --file /path/to/deployment.json --json
node --no-warnings src/cli.mjs adapters --json
node --no-warnings src/cli.mjs adapter-plan --adapter openadam.gemini-cli-otel --json
node --no-warnings src/cli.mjs trace-export --provider zcode --file /exact/model-io-file.jsonl --output /new/trace-pack.json
node --no-warnings src/cli.mjs maintain --dry-run --json
node --no-warnings src/cli.mjs maintain --json
node --no-warnings src/cli.mjs install --dry-run
node --no-warnings src/cli.mjs install
```

For a path-free current-machine performance baseline against exact user-owned
ZCode model-I/O files, use `npm run measure:trace-plane -- --zcode-file
/absolute/model-io-....jsonl --json`. It copies the selected records to a
temporary owner-only snapshot, reports if a live source changed during that
snapshot, measures bounded ingestion, settled incremental scans, hook process
cost, and public-event projection, then deletes the temporary copy. The result
is a measurement, not an SLA or a quality assessment.

`--dry-run` is accepted only by `maintain` and `install`; command-specific or
duplicate options fail before any action instead of being silently ignored.

`adapter-plan` is deliberately non-mutating. It reports the exact current-user
configuration fragment, installed bridge path, passive-storage boundary, and
removal action for one adapter with `appliesChanges: false`. See
`integrations/README.md` for the per-shell routes and lifecycle boundary.

Disabling or uninstalling the LaunchAgent preserves the database. To remove
that shared local history as a separate destructive action:

```sh
node --no-warnings src/cli.mjs purge --confirm-local-data-removal --confirm-external-adapters-disconnected
```

Before purge, remove any explicit DeepSeek, Gemini, Claude-hook, or Copilot
integration using its adapter plan. The second confirmation prevents an easy
accidental deletion of the stable bridge launcher while a user-owned shell
configuration still points to it. Ordinary uninstall preserves the runtime,
bridge data, and database.

The default local state lives under:

```text
~/Library/Application Support/OpenAdam/Agent Tool Observer/
```

The installer registers `com.openadam.agent-tool-observer` as a macOS
LaunchAgent. It runs one short-lived incremental collection every five minutes
and at login. Uninstalling the LaunchAgent preserves the local observation
database. Each run also refreshes owner-only `latest-status.json` and
`latest-report.json` snapshots so sandboxed local Agents can inspect the result
without opening the live SQLite database. Successful background runs are
silent; provider state remains visible in those snapshots and explicit CLI
commands still print normally.

Installation copies the current Observer runtime into an owner-only,
content-addressed directory under its state folder. The LaunchAgent points to
that fixed copy, so later edits to a development checkout cannot silently
change scheduled collection. Reinstalling selects a new digest while retaining
older copies for inspection or rollback.

An embedding release may set `ATO_NODE_EXECUTABLE` to its own verified Node
binary. The installer then binds the LaunchAgent to that exact executable and
fails closed instead of falling back to another machine installation.

The current report schema is
`openadam.agent-tool-observer.report.v0.8`. Older report snapshots are rebuilt
from the current database before they are returned. v0.8 retains v0.7 semantic
execution only from the current Direct Runtime metadata boundary; retired
pre-release Procedure receipts are not accepted or projected. Portfolio fields
contain neutral repeated-use, repeated-sequence, and high observed error-rate
measurements; they do not nominate repairs, Capabilities, Procedures, routing
changes, or retirement.

The report also includes bounded provider activity summaries: observed hashed
sessions and turns, UTC active days, current/longest observed-day streaks,
first/last metadata timestamps, and the longest span between retained events
in one session. A bounded daily series adds tool calls, usage records, sessions,
turns, and provider-specific Token fields. Codex daily values are cumulative
session rollups grouped by the UTC day on which they were observed, not exact
incremental daily consumption. The session span is not chat duration.
`observationCoverage` keeps observable tool calls separate from
partial runtime/token coverage and from unavailable Skill activation,
non-observed non-use reason, semantic effect, and result adoption. A Skill
listed in session context is available inventory, not proof that it ran.

The v0.8 `tracePlane` projection separately reports negotiated adapter health,
model-step and tool-offer counts, provider-reported usage where available, and
turn terminal states. A tool offer means only that a named tool appeared in one
recorded request catalog.

For local Agent analysis, Agent Host's installed `snapshot --json` projection
is the default handoff. It reads the current packaged Observer status and report
snapshots without collecting, remains path-free and 16 KiB-bounded, and can be
listed explicitly as an `observer-snapshot` source in a Developer Kit authorized
material set. This is an observation input, not an opportunity detector or an
automatic recommendation. External developers do not receive passive local
monitoring unless they separately install and consent to the corresponding Host
profile.

The default reporting window is 30 days and the default retained event window
is 45 days. `maintain` removes only rows older than that bound, preserves the
latest Context Surface measurement per source and the current Agent Host
deployment observation, checkpoints the write-ahead log, and compacts SQLite.
`ATO_RETENTION_DAYS` may raise the bound but cannot be lower than
`ATO_LOOKBACK_DAYS`.

Each source may consume at most 32 MiB of its fair share in one collection;
the whole short-lived run remains capped at 128 MiB of source reads and the
line, row, depth, and wall-time limits still apply. This lets a large current
trajectory catch up in fewer five-minute runs without weakening the aggregate
bound. If a byte boundary lands inside a record, the next pass rereads only
that uncommitted bounded line rather than persisting partial content.

Explicit provider roots, the ZCode database, and Direct Runtime log overrides
must be absolute paths. `ATO_DISABLE_PROVIDERS` accepts only `codex`, `claude`,
`zcode`, and `direct-runtime`; misspellings fail closed.

## Supported sources

- Codex session JSONL under `~/.codex/sessions` and
  `~/.codex/archived_sessions`;
- Claude Code project JSONL under `~/.claude/projects`;
- ZCode usage tables in `~/.zcode/cli/db/db.sqlite`.
- ZCode `model-io-*.jsonl` under `~/.zcode/cli/rollout`, read incrementally and
  projected without retaining messages, reasoning, arguments, results,
  headers, provider options, credentials, commands, or source paths;
- exact owner-selected normalized bridge files for supported public-event,
  official-hook, or telemetry adapters. The optional DeepSeek Harness plugin
  under `integrations/deepseek-harness` uses its public `session/event` stream;
- the exact Direct Runtime metadata log named by `ATO_DIRECT_RUNTIME_LOGS`
  (or the standalone default path) when that runtime is launched with the
  matching `--observation-log` option;
- explicit Context Surface analysis files supplied to
  `ingest-context-surface`.
- explicit Agent Host deployment observations supplied to
  `ingest-agent-host-deployment`.

Direct Runtime targets retain the distinction between a whole MCP tool and one
explicitly projected MCP operation, so reports do not erase the selected
operation identity.

Missing or changed providers are reported independently; one provider cannot
silently make the others look healthy.

See `../../docs/TRACE_PLANE.md` for adapter negotiation, privacy tiers, and the
explicit Trace Analysis Pack boundary. Selected content is never collected
passively. It enters only a user-selected output file after the separate
`--include-selected-content --confirm-sensitive-content` confirmation, and is
never inserted into Observer state. Known transport credential fields are
removed, but arbitrary selected text can itself contain secrets; the pack
reports this residual risk instead of claiming complete secret detection.
If the original provider file has rotated away, `trace-sources` can list a
bounded, path-free set of retained pseudonymous sessions for one provider, and
`trace-export --session` can publish one explicit session/time range as a
metadata-only v0.2 pack. This read-only route never offers selected content,
never triggers collection, and keeps retention and completeness limits visible.

## Claim boundary

The report can show observed calls, transport/runtime completion, errors,
cancellation, retries, latency, and token usage where the client exposes them.
For Claude and ZCode, token counts may be associated with a tool-bearing turn,
but a multi-tool turn shares the same counts and the report does not attribute
them to one tool. Codex currently exposes a cumulative session rollup, so it is
not assigned to individual tools. Serialized payload byte counts are
measurements only; their content is never stored. Monetary cost remains
explicitly unavailable until model and pricing identity are observed at a
compatible granularity.
Direct Runtime metadata may add versioned Procedure, Capability, or projected
MCP execution identity, but correctness remains unknown. Repeated unmapped MCP
use and repeated same-turn tool sequences remain neutral pattern observations;
they do not nominate a Capability, Procedure, evaluation, repair, or route
change.
It cannot prove task correctness, that an unused tool had an opportunity, that
the Agent selected a tool naturally, that a repeated sequence is professionally
correct, or that a tool should be changed or retired. A user or user-selected
Agent owns any separate interpretation, evaluation choice, and action.
For consequential non-use, effect, or adoption questions, use a
contemporaneous explicit Agent assessment or a controlled baseline/treatment
task with a task-native outcome check; otherwise keep the answer unknown.

An Agent Host deployment observation can establish that a passive tool name
matches one declared binding in one named compatibility release. Codex, Claude,
and ZCode session-start coverage and its provider-specific basis are reported
separately. Calls from a hashed session whose recorded start is at or after
release activation are counted separately from calls made by pre-activation or
unknown-start sessions. For fresh sessions the report also preserves bounded
tool-order metadata: whether the release tool was first, preceding
shell/orchestration call counts, retries, errors, and observed same-tool
recovery. Both scan and returned-record truncation are explicit, so the number
of returned routing records is never presented as total turns. It does not
store commands or task content and does not establish that the Agent had an
opportunity, selected the best tool, or produced a good result.

## Development

```sh
npm test
npm run check
```

There are no third-party runtime dependencies.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
