---
name: agent-host-operations
description: Analyze the installed Agent Host environment's health, tool activity, version history, reliability, storage and monitoring through packaged commands. Use for operations questions or an explicitly requested environment change.
---

# Agent Host operations

Resolve the packaged launcher relative to this Skill: `scripts/agent-host` on
macOS/Linux or `scripts/agent-host.cmd` on Windows. Installed facts come from
these product commands, not a development checkout or private database query.

## Choose the report for the question

- `usage --json`: tool activity, Agent-reported Tokens, runtime failures,
  version history, and coverage. This is the primary route for reviewing whether
  installed tools are being used and how observed execution behaves.
- `snapshot --json`: environment, active tools, storage, lifecycle, collection
  health and compact historical activity.
- `doctor --json`: current executable health; add `--deep` when actual provider
  readiness matters. These are diagnostic executions, not ordinary Agent tasks.
- `tools status --json`: active versus installed inventory.
- `activity --json`: bounded environment lifecycle events.
- `observability status --json`: a named detail missing from the compact report.
  Select the needed fields before returning it to context. Follow gaps that are
  material to the user's question; do not treat a report's display limit as the
  limit of an explicitly requested investigation.

Read the report timestamps, `observationSource`, `freshness`, collector status,
coverage and truncation before interpreting counts. `cached-agent-host-refresh`
may be stale; preserve `currentReadErrorCode` and never present a cached zero as
current. A loaded collector alone does not establish every source is healthy.
Installed inventory and the active set exposed to new Agent tasks differ.

`usage` has a 32 KiB whole-response limit. Full totals precede detail limits.
Every truncated section declares available and returned rows. Historical tool
observations are within the stated sliding window. `versionHistory` is a separate
longitudinal summary of retained and archived Direct Runtime metadata; it survives
updates and raw-event cleanup. Earlier deleted records cannot be reconstructed.
Old reports may lack these fields: missing is unavailable, never zero.

## Interpret the evidence without inventing causes

- `directCalls` and `referencedCalls` differ. Static references inside an
  orchestration script do not prove the branch ran or the nested tool completed.
- `currentBindingCalls` follows this component's contiguous binding, so unrelated
  upgrades do not reset it. Binding metadata cannot attest which executable an
  already-open Agent session used. Exact version attribution exists for Direct
  Runtime execution records.
- Transport completion, provider-declared partial results, batch item failures,
  and semantic correctness differ. Preserve `providerOutcome` and its missing or
  invalid status. Do not turn unmeasured results into success.
- `purpose` separates task, diagnostic and validation executions where explicitly
  recorded. Old records are unspecified; do not retrospectively guess their use.
- `runtimeErrorCodes` preserves code, version and observation layer. Codes from
  different layers may describe the same failure; do not sum them blindly.
- Skill inventory is not Skill activation. Adoption, quality, opportunity and
  reasons for non-use remain unknown unless there is task-specific evidence.
  Token usage has provider-specific coverage and semantics, not per-tool cost.

The collector stores metadata, uses no model, and makes no recommendations.
Interpretation belongs to the user's selected Agent in the current task. For an
engineering review, use current usage and error history as evidence alongside
source and reproducible flows. Form alternative explanations and test the ones
that affect the decision; counts alone do not choose a repair or retirement.
Authorized implementation work follows the owning repository's instructions.
It does not make private runtime storage a substitute for a missing product API.

## Authorized operations and selected trace analysis

Run refresh, update, rollback, cleanup, tool-set changes or uninstall only within
the user's requested scope. Preserve current component versions and private
extensions when updating part of the environment. `tools set --tool COMPONENT`
takes the complete desired active set; `tools reset` restores the profile default.
A changed binding requires a fresh task to validate new uptake. Do not restart
live Agent tasks merely to make an installation check green.

For selected historical trace analysis, use
`observability trace-sources --provider PROVIDER --json` to list bounded,
pseudonymous retained sessions. Export a selected session to an authorized new
file with `observability export-trace --provider PROVIDER --session HASH --output
FILE --json`. Add `--from-ms`/`--to-ms` only for the selected time range. Export is
metadata-only and does not establish complete trace coverage. Start with its
bounded summary; expand content-addressed tool catalogs only when needed.
A temporary analysis does not authorize updating Agent memory.

If setup/update/rollback returns `SERVICE_INSTALL_ROLLBACK_FAILED`, preserve its
recovery details and report that rollback did not succeed. For authorized recovery,
pass the returned `service recover --recovery ... --manifest-sha256 ...` unchanged;
do not guess or search for a recovery bundle. Verify the resulting running/ready
state. Keep a failed recovery bundle for intervention.

Reports or lifecycle tools do not authorize external messages, extra model calls,
or recurring analysis. If the user requests recurring feedback, use their selected
scheduler and preserve notification preferences; do not add a model to the passive
collector.
