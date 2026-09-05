# Report v0.7 migration

`openadam.agent-tool-observer.report.v0.7` adds a bounded UTC daily activity
series plus current and longest observed-day streaks. Daily rows retain only
provider, date, counts, and provider-reported Token measurements. They do not
store prompts, arguments, results, paths, or identifiers.

Codex Token observations remain latest cumulative session rollups. Grouping
those records by their observed UTC date does not turn them into incremental
daily consumption. Consumers must preserve `dailyTokenSemantics`, daily-row
truncation, the session-span boundary, and all existing unavailable or
not-observed fields.
