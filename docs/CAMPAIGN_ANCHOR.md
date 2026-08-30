# Agent Host Suite implementation anchor

This is a continuation locator, not completion authority. Reacquire current
source, installed state, artifacts, and product results before making claims.

## Objective

Operate this Mac as the primary stranger-equivalent Agent Host dogfood
environment. Installed openAdam calls resolve through immutable Agent Host
packages rather than provider checkouts. Keep routing, context, storage,
processes, rollback, observation, and management suitable for eventual
stranger use.

## Current phase

`Dogfood.30 installed and verified; source review and GitHub merge in progress`

## Standing boundaries

- Preserve uncommitted work and independent repository histories.
- Isolate installed execution provenance, never Agent workspace access.
- Keep Observer deterministic and model-free. It records bounded observations
  and unknowns; causal, adoption, opportunity, quality, and value assessments
  remain outside the product.
- Retain one byte-verifiable rollback until the current release is accepted.
- Keep development regression, installed Agent runtime, human app runtime,
  internal distribution, public distribution, and owner acceptance separate.

## Current facts to reacquire

- Installed release: `local-dogfood-20260831.30`, suite
  `0.1.2-dogfood.30`; rollback: dogfood.29. Dogfood.29 changed only
  `agent-tool-observer`, from 0.1.1 to 0.2.0. Dogfood.30 reuses all twelve
  component artifacts and adds fail-closed validation of Observer semantic
  summary kinds and counts in the Suite consumer.
- Installed App: Agent Host 0.1.2 build 30. Its manager executable SHA-256 is
  `61ae84ccd109988f099e37003f33fa69bd6d1137e40112c302e48aa43983d160`.
  The replaced 0.1.1 App remains at the explicitly named backup path until
  owner acceptance.
- Twelve components are installed. Eight are available Agent tools; the
  current active set is Math Anchor, BatchTicket, and Equatorium. Codex has
  three managed bindings and Claude has one. Observer and Context Surface
  Analyzer remain backstage and do not occupy the Agent catalog.
- The active catalog is 9 tools, 18 schemas, and 64,804 canonical UTF-8 bytes,
  within the 65,536-byte reference budget with no hard name collision. This is
  the active-set result, not a claim that enabling every available local tool
  at once has the same cost.
- Observer report v0.5 no longer accepts or projects the retired pre-release
  Procedure receipt or human-checkpoint formats. Existing private legacy
  tables remain non-destructively readable for migration and ordinary
  retention only. Current Procedure and Capability totals derive from Direct
  Runtime semantic metadata; the latest snapshot reports 236 Procedure and
  412 Capability executions in the 30-day window.
- Deep installed doctor passed all 25 current checks: twelve immutable
  components, six packaged MCP tools, Direct Runtime service and projection,
  Math single/native-batch execution, time-zone Capability execution, metadata
  observation, and catalog budget. It skipped Agent-app CLI inspection by
  design; default Manager refresh does not own that effectful route.
- The internal Beta component probe, App/DMG build, ad-hoc signature checks,
  DMG checksum, embedded catalog, bootstrap, and distribution checks passed.
  The DMG is intentionally not Developer ID signed or notarized.
- Current snapshot storage is 722,935,808 allocated bytes in private state and
  192,745,472 bytes for the installed App. Product cleanup currently identifies
  eight unreferenced package versions totaling 197,271,552 allocated bytes;
  cleanup remains separate from release correctness and owner acceptance.
- A fresh Agent session is required after the binding activation before
  current-session uptake can be observed. Historical calls and successful
  doctor probes do not establish natural routing or adoption.
- The review contracts in Agent Host Suite, Observer, Direct Runtime,
  Capability Contracts, Procedure Contracts, and the architecture repository
  are minimum risk coverage. Each now requires a current-product reconstruction
  and an independent discovery route; completing named checks is not review
  completion.

## Rerunnable product checks

```text
npm run check
npm run build:internal-beta-artifacts
npm run probe:internal-beta-artifacts
npm run package:internal-beta
npm run check:internal-beta

agent-host status
agent-host snapshot
agent-host doctor --deep --skip-agent-apps
agent-host storage
agent-host cleanup --dry-run
agent-host observability status
agent-host tools status
```

Run installed-runtime claims through the packaged App, not the source
entrypoint. A full Agent-app binding check is explicit because it may launch an
external Agent CLI; opening or foregrounding Manager must not do so.

## Next action

Finish local diff review, commit each independent repository once, push one PR
per repository, wait for current-SHA checks, and merge. Then reacquire remote
default SHAs and local cleanliness. Keep the App backup and dogfood.29 rollback
until owner acceptance; do not publish the internal ad-hoc DMG as a public
binary. Use ordinary fresh tasks to evaluate tool routing, and keep the active
set within its declared context budget rather than treating installation as a
reason to expose every available tool simultaneously.
