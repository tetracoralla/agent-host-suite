# Report v0.4 migration

`openadam.agent-tool-observer.report.v0.4` adds explicit Agent Host deployment
correlation. The top-level `currentAgentHostDeployment` contains the latest
bounded deployment observation. Each passive tool row gains
`currentAgentHostDeployment`, which names the release, component, and declared
tool binding. `fresh-session-observed` means at least one call came from a
session recorded as starting at or after activation; `declared-binding-only`
means no bound call has been observed since activation. Calls since activation
are split into fresh, pre-activation-session, and unknown-session-start counts.

Top-level `freshSessionCorrelation` discloses per-provider coverage for Codex,
Claude, and ZCode. Codex uses the session metadata timestamp; Claude uses the
earliest timestamp observed in its session log; ZCode uses
`session.time_created` when the current source schema exposes it. Zero calls
remain an observed count, while adoption, task quality, and opportunity remain
unassessed or unknown.

Top-level `routingObservations` contains at most 100 fresh-session metadata
records for turns that used a declared current-release tool. The routing
summary separately reports records returned, matching turns found in the
bounded source-event scan, both limits, and truncation. It retains hashed
session/turn identity, tool order and counts, route classes, retries, errors,
and observed recovery. Task opportunity and quality remain `unknown`.

Repeated ingestion of the same activated deployment no longer creates one row
per refresh. `observedAtMs` is freshness metadata and is excluded from the
semantic deployment identity; a later refresh advances that timestamp in the
existing row.

Context Surface rows may now report
`matched-current-agent-host-deployment` only when source id, source revision,
and catalog SHA-256 all match that deployment observation. Without the explicit
observation, the prior `not_assessed` boundary remains.

Older snapshots are rebuilt from the current database. No correctness,
opportunity, routing-quality, or task-quality claim is introduced.
