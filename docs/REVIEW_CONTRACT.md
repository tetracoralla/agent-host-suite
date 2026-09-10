# Review contract

Use this document to select checks for the user's intended outcome and the
Host behavior that could invalidate it. A whole-product review spans the
relevant installation, lifecycle, execution, observation and Manager flows;
a bounded change starts with its affected behavior and consumers.

## Scope and judgment

Read current requirements and inspect the relevant source and runtime before
accepting a prior result. Explore interactions suggested by actual behavior,
user expectations and failure paths, including risks missing from this file.
Expand when a failure or unresolved dependency warrants it. No fixed number
of discoveries, findings, test runs or report sections establishes quality.

Preserve user outcomes, authority, data ownership, consumed semantics and
honest failure reporting. Historical algorithms, internal representations and
test recipes can be replaced when those requirements are preserved and the
replacement is verified. Compare alternatives on the same realistic task when
usability, quality, reliability or cost is part of the claimed improvement.

Passive measurement limits constrain what the Host may report. They do not
prevent the construction Agent from interpreting evidence, forming hypotheses,
comparing alternatives or implementing authorized improvements. Label an
inference as an inference and verify it to the level needed by the claim.

Construction includes the Agent's own inspection, tests and repairs. This
contract does not commission an independent reviewer or additional model runs.
Existing task authorization and explicit scope, time and cost limits apply.

## Outcomes to protect

| Area | Required outcome | Detailed cases and current tests |
| --- | --- | --- |
| Artifact admission | Run the exact selected, validated component bytes; reject unsafe archives, identity drift and invalid typed entrypoints before mutation. External Provider products stay independently releasable; Host-owned packages retain explicit version and artifact boundaries. | [Artifact identity](../test/REVIEW_CASES.md#release-and-artifact-authority) |
| Private components | Preview and import have explicit, bounded effects; import defaults inactive, uses sealed bytes and preserves ownership and rollback. | [Private component cases](../test/REVIEW_CASES.md#private-component-boundary) |
| Lifecycle and failure | Concurrent mutations cannot corrupt state. Preflight precedes effects; failure restores the prior state or reports precise partial effects and a safe recovery path. Status reads do not mutate state. | [Lifecycle and recovery](../test/REVIEW_CASES.md#exclusive-lifecycle-and-recovery) |
| User configuration | Update, rollback, cleanup and uninstall preserve unrelated entries, later user edits and referenced packages. Recovery cannot overwrite a different current environment. | [Recovery ownership](../test/REVIEW_CASES.md#recovery-ownership), [host adapters](../test/REVIEW_CASES.md#host-inspection-and-mutation) |
| Active tools and projections | Installed, active, configured and healthy remain distinct. Catalog conflicts and declared resource-limit failures stop activation before mutation; thin projections retain exact provider identity and invocation. | [Profile truth](../test/REVIEW_CASES.md#profile-and-tool-truth), [projections](../test/REVIEW_CASES.md#thin-host-projection), [catalogs](../test/REVIEW_CASES.md#skill-link-catalog-truth) |
| Execution | Selected typed calls preserve provider semantics, whole-call budgets, cancellation, bounded residency and owned-process cleanup. A failure is followed by a verified recovery when recovery is claimed. | [Direct Runtime contract](../packages/direct-execution-runtime/docs/REVIEW_CONTRACT.md), [Host process cases](../test/REVIEW_CASES.md#bounded-management-surface) |
| Observation and storage | Collection is consented, local and metadata-only; explicit content export remains separately authorized. Freshness, coverage, missing values and provider-specific measurements stay honest. Cleanup retains live and rollback data. | [Observation](../test/REVIEW_CASES.md#observability-boundary), [storage](../test/REVIEW_CASES.md#snapshot-and-storage-economy), [Observer contract](../packages/agent-tool-observer/docs/REVIEW_CONTRACT.md) |
| Manager experience | Setup, status, tool changes and recovery are understandable and usable. Startup and ordinary refresh avoid intrusive Agent-app inspection; explicit Full Check owns that route. | [Inspection effects](../test/REVIEW_CASES.md#default-inspection-effect-budget), [human flows](../test/REVIEW_CASES.md#human-runtime-flow) |
| Updates and distribution | A transition preserves its declared release, profile, privacy and data boundaries. Released installers are verified on each claimed platform; mocks and cross-builds cannot establish native behavior. | [Update cases](../test/REVIEW_CASES.md#update-and-uninstall-safety), [release requirements](RELEASE.md) |
| Provider and task claims | Local process execution does not prove absent network egress or valid credentials. Installation, live health, tool selection and task success each need evidence that measures that claim. | [Instance truth](../test/REVIEW_CASES.md#provider-instance-truth), [HTTP bridge](../packages/capability-http-bridge/docs/REVIEW_CONTRACT.md), [catalog analysis](../packages/context-surface-analyzer/docs/REVIEW_CONTRACT.md) |

The linked regression cases retain detailed failure sequences near their
executable tests. Read the affected sections on demand; their presence neither
freezes an internal implementation nor adds every case to every task.

## Select evidence for the claim

- For a documentation-only change, inspect semantic consistency, entrypoints,
  links and any checks or packaging that actually consume the changed files.
- For a behavior change, exercise affected tests and the real entrypoint,
  including relevant failures, compositions and recovery. Use `npm run check`
  for broad development regression when shared changes or unresolved
  interactions warrant it; reuse applicable results after disjoint changes.
- For installed behavior, use the exact installed artifacts and affected host
  binding. Configuration or source tests cannot stand in for actual calls.
  Natural Agent selection requires a realistic fresh-session task, within
  existing authorization for model execution.
- For a Manager change, inspect the rendered UI and affected pointer, keyboard,
  accessibility, freshness and recovery flows. Repair clear defects directly.
- For performance or comparative advantage, use the same task, inputs, outcome
  criteria and conditions for alternatives. Count relevant integration and
  runtime costs; preserve failures and limitations. A local timing observation
  alone does not establish an SLO or general advantage.
- For release or distribution work, follow [RELEASE.md](RELEASE.md) and the
  applicable platform guide. Ordinary development does not initiate release,
  installation, signing, content export or remote actions.

Keep development, installed Agent flow, direct runtime, human experience,
distribution and owner acceptance distinct where they affect the conclusion.
There is no obligation to run or report unrelated lanes. If an in-scope claim
cannot be checked, state the missing evidence and concrete reason.

## Completion and reporting

Complete the authorized outcome and its material verification. If the change
has uncovered a defect or an unverified advantage central to the user's goal,
continue the necessary work within the task's limits. Disclosing that gap does
not complete the goal. Once the outcome is supported and no material concern
remains, stop; repeated green runs or unrelated exploration add no completion
credit. Final user acceptance remains the user's decision.

Report the result, actionable findings, relevant evidence and material limits
in plain language. Identify an actual shared-contract drift, host conflict,
adjacent dependency or resource concern when found; no fixed escalation
heading or empty section is required. A checklist, test count or generated
report is not a product-quality certificate.
