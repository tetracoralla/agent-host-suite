# Agent Host Suite implementation anchor

This is a continuation locator, not completion authority. Reacquire current
source, installed state, artifacts, and product results before making claims.

## Objective

Operate this Mac as the primary stranger-equivalent Agent Host dogfood
environment. Agents may implement anywhere under `tools-dev`, but installed
openAdam tool calls must resolve through immutable Agent Host product packages,
never provider source checkouts. Keep routing, context, storage, process,
rollback, observation, and management cost suitable for eventual stranger use.

## Current phase

`Dogfood.25 isolated candidate verified; installed dogfood.24 remains the ordinary-use baseline`

## Standing boundaries

- Preserve uncommitted work. Do not commit, push, publish, tag, deploy, or
  publicly distribute without separate owner authorization.
- Isolate installed execution provenance, never Agent workspace access.
- Keep Observer deterministic and model-free. It records exact observations,
  joins, limits, and unknowns. Causal attribution, adoption, opportunity,
  usefulness, and task quality belong to an external Agent assessment.
- Retain one complete byte-verifiable rollback while removing superseded,
  reconstructable copies.
- Keep development regression, installed Agent runtime, human app runtime,
  internal distribution, public distribution, and owner acceptance separate.

## Current facts to reacquire

- Installed release: `local-dogfood-20260828.24`, suite `0.1.0-dogfood.24`;
  verified rollback target: dogfood.23. The dogfood.24 update reported zero
  changed components; current and rollback releases share one package set.
- Current uncommitted source was rebuilt as the uninstalled
  `local-dogfood-20260829.25` / `0.1.0-dogfood.25` candidate. The repository
  check, isolated 12-component materialization, all eight MCP tool probes,
  ad-hoc-signed App/DMG build, DMG checksum, embedded release catalog,
  bootstrap, and distribution validation passed. Math Anchor came from the
  explicitly supplied relocated checkout; the candidate remains a local
  validation artifact and has not changed the installed dogfood.24 state.
- Dogfood.24 changes only the Suite manager CLI: the human-readable
  `agent-host observability status` output crashed with `AGENT_HOST_INTERNAL`
  on every installed invocation (renderer branch collision on a missing
  `hosts` field; `--json` was unaffected). It now renders monitoring state and
  a negative regression covers it in `test/cli.test.mjs`.
- Local profile contains 12 installed components and 8 available Agent tools.
  The current active set is all eight. Observer and Context Surface Analyzer
  remain backstage components and do not add an ordinary task MCP process.
- The dogfood.25 Local catalog is 31 tools, 62 schemas, and 191,059 canonical UTF-8
  bytes. The Standard catalog is 8 tools, 16 schemas, and 20,505 bytes. A
  File-Vitals-only active set is 3 tools, 6 schemas, and 29,912 bytes. These are
  exact schema measurements, not token estimates.
- One deliberately overlapped candidate run performed full release
  materialization/catalog measurement while probing every component. BatchTicket
  and Math Anchor exceeded the health timeout in that overlap; the same probe
  passed immediately when run alone. Treat this as one current cold-start and
  resource-contention lead, not as a proven component defect or a sustained-load
  threshold.
- `agent-host tools set` suspends inactive Agent Host-owned projections without
  restoring displaced source-checkout plugins. Reset restores Agent Host
  projections; terminal uninstall or host removal restores prior user
  ownership. Update preserves the suspended state. Verified end to end on
  dogfood.24: a manager-app switch moved Laniakea to installed-inactive with a
  fresh-task notice, removed only the suite-owned thin Codex projection, and
  restoration recreated the package-backed binding.
- Tool integration schema v0.2 adds the `suite-node` executor. Armorial,
  Laniakea, and Equatorium now share the Suite Node component inside Agent
  Host instead of embedding three more Node copies. Their standalone provider
  releases remain independently self-contained.
- The installed App is 187,988 KiB. Agent Host private state is about
  526,405,632 allocated bytes, of which packages use 519,864,320 and host
  projections use 1,101,824; growth since dogfood.23 is observations and
  activity only. App plus private state is about 718,905,344 bytes, 43.8%
  below the dogfood.20 baseline of 1,279,827,968 bytes. Both the superseded
  dogfood.23 DMG (cleanup candidate after owner acceptance) and the current
  dogfood.24 DMG remain under `.build/internal-beta/distribution`.
- A fresh Codex task on dogfood.24 discovered the packaged operations Skill
  directly, ran `snapshot --json` first, returned the exact Math residue
  (independently cross-verified), produced a DST-correct Migratory Time
  conversion, and hit `E_FILE_NOT_FOUND` for a workspace-relative File Vitals
  path; the absolute path succeeded from the nested repository. That is the
  documented routing/recovery sequence, not a product defect. Observer
  attributed all 7 calls to the release activation; the later tool-set
  restoration activation correctly reset the per-activation counter.
- A fresh Claude installed-flow task on dogfood.24 succeeded after the earlier
  external HTTP 502 block cleared: operations Skill plus snapshot first, then
  one Migratory Time conversion, tools only, with the external-agent inference
  boundary respected. The Claude lane is unblocked.
- The manager-app click lane is unblocked on the native accessibility channel:
  the toggle, fresh-task notice, installed-versus-active states, suspension,
  and restoration all behaved as specified.
- Direct Execution Runtime real-provider pilots passed: provider burst with
  zero failures, cancellation recovery (`HOST_CANCELLED`, recovery ok),
  deadline timeout that reaped the child process (`childPidAfterTimeout`
  null), and cold replacement recovery. The Swift manager build compiles, but
  the package declares no test target; manager verification is build,
  packaging smoke checks, and the installed human lanes.
- The architecture checker regression now has four negative cases (missing
  siblings disclosed locally and rejected strictly, tampered sibling digest,
  personal path in public text, published-bound without a release anchor);
  normal and strict modes pass in the complete workspace.
- Pre-suite Codex plugins remain enabled outside package governance:
  decision-table, state-machine, schedule-algebra, and context-surface-analyzer
  (`node ./server/index.mjs` with a cwd-relative command). Migrating them into
  Suite releases or retiring those bindings is an owner decision; Suite
  lifecycle must not remove user-owned entries on its own.
- Cosmetic Ajv warnings remain during lifecycle validation (`unknown format
  "uint32"/"uint64" ignored`, for example `#/$defs/RenderEvidence/
  properties/outputWidth`): the MCP SDK's Ajv dependency has no uint formats
  for zod-derived schemas, and validation is unaffected. Candidate fixes are
  component schema typing or a future SDK upgrade.
- Observer refreshes deduplicate the same deployment/activation observation.
  Its fresh-session basis is disclosed per provider: native Codex session
  metadata, earliest observed Claude session record, and ZCode schema-exposed
  creation time. Bounded routing-observation counts are not labeled as total
  turns. Observer stores no model judgment and reports unassessed or unknown
  fields when current facts cannot establish them.
- The native App bootstrap is a small launcher. It extracts and verifies the
  bundled Suite Node from the immutable release catalog rather than carrying a
  second uncompressed Node tree. The default App stages the profile-scoped
  public catalog; the internal dogfood build opts into Local explicitly.
- Migratory Time still carries a specialized Node runtime and is the largest
  remaining obvious runtime-deduplication candidate. Any change must preserve
  its standalone release and exact behavior.
- The stage's work remains uncommitted across agent-host-suite,
  agent-host-execution-architecture, and agent-tool-observer; each of those
  three repositories also carries one earlier unpushed milestone commit from
  the same 2026-08-28 01:25:52 batch. No source has been reset and nothing has
  been pushed, tagged, published, or deployed.

## Rerunnable product checks

```text
npm run check
npm run build:internal-beta-artifacts
npm run probe:internal-beta-artifacts
npm run package:internal-beta
npm run check:internal-beta

agent-host status
agent-host snapshot
agent-host doctor --deep
agent-host storage
agent-host cleanup --dry-run
agent-host maintenance
agent-host rollback --dry-run
agent-host observability status
agent-host tools status
```

Run Agent Host commands through the packaged App or installed product boundary,
not this repository's source entrypoint, when making installed-runtime claims.

## Next action

Keep dogfood.24 installed while dogfood.25 remains an isolated candidate. Use
task-specific active sets during ordinary Codex and ZCode work, then restore or
replace the set for the next task. Tool activation is independent from
Observer coverage: a tool need not occupy every Agent catalog for Observer to
record bounded provider/session and managed-tool facts. Let an external Agent
assess task context, alternatives, uncertainty, recovery, and final quality.

Use ordinary tasks to decide which tools earn default activation; do not infer
that from installation, a green health check, or catalog presence. Reproduce
the overlapped cold-start timeout under a bounded realistic workload before
changing timeout or lifecycle code. Continue schema-level catalog cost work
and investigate the remaining Migratory Time runtime duplication without
introducing a generic invocation tool, losing typed semantics, or weakening
standalone provider releases. Decide the disposition of the four pre-suite Codex plugins
(migrate into Suite releases or retire the bindings), watch whether the
relative-path `E_FILE_NOT_FOUND` routing sequence keeps recurring, and remove
the superseded dogfood.23 DMG only after owner acceptance of dogfood.24.
Public signing, notarization, clean-machine distribution, and publication
remain separate owner-authorized work.
