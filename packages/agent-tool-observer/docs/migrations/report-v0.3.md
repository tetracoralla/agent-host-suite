# Report v0.3 migration

`openadam.agent-tool-observer.report.v0.3` adds measurement fields without
promoting them into correctness or value claims.

- `tools[].payload` reports serialized request/result byte totals and measured
  call counts. No payload content is stored.
- `tools[].turnAssociatedUsage` reports Claude/ZCode usage sharing the same
  hashed turn. Its allocation is explicitly
  `shared-turn-not-attributed-to-one-tool`; Codex remains unavailable at this
  granularity because its source is cumulative per session.
- `cost` reports coverage and keeps monetary cost unavailable when model and
  pricing identity are not observed compatibly.
- `semanticExecutions` and `directRuntime` describe metadata events emitted by
  Direct Execution Runtime.
- `contextSurfaces` contains explicitly imported Context Surface measurements
  and keeps current installed binding `not_assessed`.

Procedure candidates now exclude orchestration wrappers and derived nested
calls. Older report snapshots are stale and are rebuilt from the current
database.
