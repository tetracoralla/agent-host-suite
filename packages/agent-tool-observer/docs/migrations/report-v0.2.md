# Report v0.2 migration

Migrate `correctnessEvidence` to `correctnessStatus` and
`opportunityEvidence` to `opportunityStatus` when consuming
`openadam.agent-tool-observer.report.v0.2`.

Both statuses remain `unknown`: passive metadata does not establish either
judgment. Report snapshots without the v0.2 `schemaVersion` are treated as
stale and rebuilt from the current local database instead of being served as a
current report.
