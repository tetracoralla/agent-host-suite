---
name: agent-host-operations
description: Discover and invoke installed Procedure products, or analyze the Agent Host environment's health, tool activity, version history, reliability, storage and monitoring through packaged commands.
---

# Agent Host operations

Resolve the packaged launcher relative to this Skill: `scripts/agent-host` on
macOS/Linux or `scripts/agent-host.cmd` on Windows. Installed facts come from
these product commands, not a development checkout or private database query.

## Use an installed Procedure

When a task matches a reusable Procedure, use the Host product boundary instead
of reconstructing its internal stages:

1. Run `procedure list --json` for compact summaries. Use `--query TEXT`,
   `--limit 1..100`, `--budget-bytes 1024..262144`, and the returned
   `page.nextCursor` when the catalog is larger than the current context budget.
   Do not expect full schemas in list results.
2. Select one exact `id` and `version`, then run `procedure describe --id ID
   --version VERSION --json`. Use its full input/output schemas, declared
   permissions, installed `permissionCeiling`, resource requirements and Run
   Request defaults. Do not switch versions between describe and invoke.
3. Build one `openadam.agent-host-procedure-run-request.v0.1` object containing
   that exact `{id, version}`, schema-valid `inputs`, the explicit task `grants`,
   all required `resources`, bounded `limits`, and a caller-owned idempotency
   key. A declaration says what the product may need; it is not task authority.
   Grant only what the current task authorizes and never more than the installed
   ceiling. Bind workspace, file and account resources exactly as described.
4. Pipe the whole request to `procedure invoke --request - --json`. Retry an
   uncertain invocation with the exact same request and idempotency key; changing
   content under that key is a conflict.
5. Consume only the declared `outputs` in the returned result. If the result is
   not complete, preserve its `taskId`, interaction or error exactly. Inspect it
   with `procedure status --run TASK_ID --json`; answer a reported question or
   resume a failed or paused run by piping the corresponding action object to
   `procedure continue --run TASK_ID --input - --json`.

Keep availability fields separate. `lastSuccessfulInvocationAt` is historical;
`invocationEvidence.valid` is current only while the Procedure, runtime and
binding fingerprints still match. `currentHealth` and
`currentSessionDiscovery` are independent, and `not-observed` is not success.
Provider one-time permission requests cannot add authority: the Runner rejects
one unless its required grant already exists on both the Run and active node.

Do not inspect or narrate the Procedure's private stage graph, provider routing,
logs or intermediate artifacts unless the user is diagnosing that product.

## Choose the report for the question

- `usage --json`: tool activity, Agent-reported Tokens, runtime failures,
  version history, and coverage. This is the primary route for reviewing whether
  Host-managed tools are being used and how observed execution behaves.
  For independently installed tools, use `usage --all-tools --json`; use
  `--tool NAME` to select a tool-name substring or exact Host component id.
  Check `toolScope.available`: an older snapshot without this scope is missing
  evidence, not zero usage. An unmapped tool is not proof of installation ownership.
- `snapshot --json`: environment, active tools, storage, lifecycle, collection
  health and compact historical activity.
- `doctor --json`: current executable health; add `--deep` when actual provider
  readiness matters. These are diagnostic executions, not ordinary Agent tasks.
- `tools status --json`: active versus installed inventory.
  `on-demand` requires a retained callable Skill; `inactive` requires enabling
  MCP and starting a fresh task. The Host inventory excludes independent installs.
- `tools inventory --json`: compare that inventory with public Codex plugin
  and Claude/ZCode user-level MCP configuration, including independent entries.
  Configuration presence is not runtime readiness or current-session discovery.
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

## Authorized operations, task activity, and selected trace analysis

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

For a question about what happened in one task, do not stop at aggregate
`usage` totals. Use `observability task-sources --provider
PROVIDER --json` to find the pseudonymous ordinary task session, then export
one selected session with `observability export-task --provider PROVIDER
--session HASH --output FILE --json`. The pack deliberately distinguishes
`direct-execution-observation` from `static-reference`; an orchestration source
mention is not a child execution receipt. Start with the human-readable summary
and open the detailed JSON only when the decision needs it.
These task-activity commands require installed Observer 0.6.5 or newer. If the
installed component is older, report the update requirement; aggregate `usage`
cannot reconstruct the missing task pack.

Interpret the selected activity together with the task-native artifact and
relevant tests. Provider-reported rationale presence or stable completion
reasons are optional source reports, not Host conclusions. Do not require an
Agent to explain every choice, infer a reason from silence, or convert activity
into an adoption, quality, or value score. The user may accept, challenge, or
ignore an interpretation.

If setup/update/rollback returns `SERVICE_INSTALL_ROLLBACK_FAILED`, preserve its
recovery details and report that rollback did not succeed. For authorized recovery,
pass the returned `service recover --recovery ... --manifest-sha256 ...` unchanged;
do not guess or search for a recovery bundle. Verify the resulting running/ready
state. Keep a failed recovery bundle for intervention.

Reports or lifecycle tools do not authorize external messages, extra model calls,
or recurring analysis. If the user requests recurring feedback, use their selected
scheduler and preserve notification preferences; do not add a model to the passive
collector.
