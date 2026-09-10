# Host regression cases

These are detailed cases retained from the review contract on 2026-09-07,
grouped beside their executable regressions. Use only the sections relevant to
the current task, affected behavior and claims. Test links locate evidence;
neither a link nor this inventory proves that the current implementation passes.

[Review scope and outcomes](../docs/REVIEW_CONTRACT.md) owns how to select and
report checks. Product requirements and public semantics remain binding; an
internal algorithm or a historical test recipe may change when those outcomes
are preserved and the replacement is verified. Keep this reference and its
affected tests aligned when a mechanism changes. Do not add unrelated review
work or model runs merely because a case appears here.

## Release and artifact authority

Start with [local-artifact-safety.test.mjs](local-artifact-safety.test.mjs), [bundled-release.test.mjs](bundled-release.test.mjs), [release-source-provenance.test.mjs](release-source-provenance.test.mjs), [component-warmup.test.mjs](component-warmup.test.mjs), [mcp-catalog.test.mjs](mcp-catalog.test.mjs).

Every component is admitted by exact archive bytes and digest, descriptor identity,
version, platform, SPDX expression, complete inventory, and current typed
entrypoints. Unknown fields, unsafe paths, malformed archives, undeclared
files or directories, digest drift, and incomplete operation schemas fail
before state mutation.
Every application-profile projection revalidates each selected source
archive's declared size and digest before copying it, then revalidates the
copied archive before publishing the bundled catalog. App or DMG packaging
cannot convert a stale post-probe catalog into a valid distribution.
The distribution manifest binds the complete release-catalog tree digest
and file count. Verification requires the external and DMG-embedded catalog
trees plus release identity to match that exact binding.
Provider fallback paths locate candidates only: component version comes
from the staged Plugin manifest, artifact identity and digest come from the
complete staged bytes, and remote provenance comes from the verified locked
revision. A fallback filename is authority for none of those fields. A
remote-tagged Armorial build begins from a verified `git archive` snapshot
with no ignored `.release` input, runs Armorial's own lockfile and release
workflow in scratch, validates its identity and checksum, reproduces the
same bytes from the same fixture source, and leaves no published candidate
after failure.
On first setup or warm-up policy migration, every public Agent-tool package
also completes a sequential first-and-repeat live MCP health start from its
final immutable path before host activation, with full catalog fingerprint
and serialized-byte stability. Later updates select changed fingerprints;
already covered unchanged packages are not restarted.
Setup, update, rollback, private-component activation, and working-set
changes must also measure the exact proposed live catalogs and fail before
host or state mutation when canonical catalog bytes, largest-tool bytes, or
tool count exceed their declared limit. Installed-but-inactive tools do not
count toward the Agent-visible working set.

## Private component boundary

Start with [local-components.test.mjs](local-components.test.mjs), [tool-integration.test.mjs](tool-integration.test.mjs).

Preview accepts one explicit absolute archive
and exact binding, starts only the selected contained component, changes no
Agent Host state, and discloses that it cannot rule out effects outside that
state. Import stores immutable bytes, defaults inactive, never accepts a
source directory or caller-supplied runtime command, and preserves Suite-only
ownership. Tests own the exact archive/parser edge-case matrix. The optional
sibling-source vertical must build and call the relocatable Mining and
Refinery Plugin artifacts, start from one exact selected Skill rather than a
prebuilt corpus fixture, use temporary Host/Codex state, revalidate all
bindings, execute the generated Provider, and leave zero model runs and no
user-host mutation. Its fixed synthetic plans exercise deterministic
validation and lowering only; they do not test or grade the user's authoring
Agent. Its evaluation preflight must report the practical Agent capability
frontier and long-horizon human equivalence as unobserved.
Standalone preview must succeed without installed state, use only the Node
runtime executing the current CLI for `suite-node`, reject an ambiguous
simultaneous state-root selection, and leave both Agent Host state and
Agent-app configuration absent.

## Exclusive lifecycle and recovery

Start with [lifecycle-lock.test.mjs](lifecycle-lock.test.mjs), [environment-change.test.mjs](environment-change.test.mjs), [launchd-environment.test.mjs](launchd-environment.test.mjs), [windows-service-environment.test.mjs](windows-service-environment.test.mjs), [read-only-state.test.mjs](read-only-state.test.mjs), [service.test.mjs](service.test.mjs).

Setup, import, activation, tool-set changes, update,
rollback, remove, cleanup, and uninstall preflight the complete target state.
Every state-root mutation must hold the same atomic, process-identity-bound
exclusive lifecycle lease; nested operations re-enter only through that
authenticated lease. A dead owner may be reclaimed. PID reuse may be
reclaimed only from an unambiguous process-start identity; a live owner with
uncertain identity and every malformed owner, recovery claim, or recovery
ticket fails closed, including a final claim or ticket containing JSON
`null`; only an entry concurrently removed after enumeration is absent.
Stale recovery must use immutable uniquely owned claims and tickets whose
total order remains safe for late contenders; a crashed claimant cannot
permanently block later recovery, dead-claim cleanup targets only that
unique identity and stays bounded, and live or identity-uncertain claimants
remain blocking. The elected claimant must exclude competing reapers before
it rechecks and retires the same owner token; an ordinary publisher racing
the resulting path gap may win, but only one lifecycle callback may run.
First-root
publication, failed first mutations, and purge must preserve root identity:
a losing caller has zero state-root side effects, an empty failed scaffold
and a successful empty no-op scaffold are removed only after lease release,
retained compensation or diagnostics are not removed, and cleanup of a
retired root cannot delete a replacement root.
Agent-app removal validates a retained workspace grant as an absolute path
but does not require that previously granted directory to still exist;
caller-supplied replacement grants remain subject to current canonical-path
validation before any Host mutation.
A mutation failure plus lease-release failure preserves both bounded,
path-free failures in one stable compound error.
Read-only status, catalog, usage, monitoring, storage, and component routes
must not create a missing root or repair permissions as a side effect.
Cleanup must also bind its plan to
canonical current and rollback state digests and revalidate them before the
first removal.
Update and rollback must make the installed application read the exact
candidate state during dry-run and before warm-up, host, service, or saved
state mutation; an older application that rejects the state blocks the
transition without weakening strict state validation. Windows application
install and application restore must make the staged or retained payload
read the current state before any directory swap.
Failure before commit restores the prior state; post-commit activity or stale
projection cleanup failure returns authoritative success with a stable
warning rather than deleting referenced package bytes.
Setup, Agent-app add/remove, monitoring enable/disable, update, whole-suite
rollback, private inventory/tool-set transitions, and uninstall compensate
the full prior Host, runtime/service, and monitoring state through the state
commit. A failed compensation returns a stable compound error containing both
failures. Observer refresh/maintenance errors must instead disclose any
irreversible or uncertain collection, ingestion, retention, and storage
effects in the typed error.
Service rollback must preserve loaded/running/ready as distinct facts:
Windows uses the scheduled task state independently of named-pipe reachability,
and a macOS loaded-but-stopped descriptor that cannot be reproduced exactly
blocks replacement before mutation. All new service writes must participate
in the environment journal before native effects; no standalone service writer
may bypass it. Exercise initial installation, replacement, removal, owner death
before/after native registration, state-commit failure, and undo-before-progress
persistence. A changed carrier, task definition, task ACL or launcher ACL blocks
whole-journal recovery before an unrelated resource is restored. Windows queued
or unknown prior states and read-only launchers block mutation; stopped/disabled
tasks retain that state after recovery. Native removal must be confirmed before
carrier files change, and native creation must reject a concurrent registration.
Complete environment commit, not service readiness, retires recovery authority.
Windows protocol fixtures and PowerShell parsing are distinct from actual Task
Scheduler, complete XML/ACL round-trip, named-pipe, login and reboot evidence.
Historical v0.2 service-recovery bundles retain their reader and dedicated CLI.
Before a later process may consume a historical bundle identity, the bundle manifest digest,
pre-replacement lifecycle-state bytes, failed-replacement residue bytes, and
exact job/task observation are revalidated. The shipped
`agent-host service recover` entry accepts the opaque identity plus manifest
digest and resolves only beneath the selected private-state root. A read-only
preflight must reject a missing, empty, unknown, unsafe, or state-file-less
root without creating the root, lock, or ordinary Host scaffold. Only a
canonical existing Host state whose runtime service matches that bundle may
enter the lifecycle lock. A macOS failure binding must include and later
recheck the observed job path, program, and state before bootout or overwrite.
Recovery under the lock must revalidate lifecycle bytes,
restored carrier bytes, task identity, running state, and readiness before
retiring the bundle and reporting the observed service state. A real second
process covers successful recovery; stale state, changed carrier/task/job,
tampered content, wrong digest, and unknown identity all retain the bundle
and current state without an overwrite or removal. On macOS, post-restore
verification derives the expected program from the retained prior descriptor;
a same-path running and ready job with another program must return a path-free
current observation and retain the bundle. Because that attempt already wrote
the prior carrier, it must atomically rebind the current carrier, lifecycle,
and job/task into a `partial-restore` phase and return a new digest/action;
the production caller retries that refreshed action without manually editing
the carrier. Repeated wrong-program results refresh the action again, while
old digests and tampered partial manifests fail before mutation. If safe
rebinding fails, no automatic retry action is returned. Direct `Program` and
direct `ProgramArguments[0]` are accepted; duplicate, conflicting, nested,
entity-ambiguous, or non-string-first identities fail before mutation. A later successful
installation or any unknown state fails closed.

## Recovery ownership

Start with [release-lifecycle.test.mjs](release-lifecycle.test.mjs), [storage.test.mjs](storage.test.mjs), [environment-change.test.mjs](environment-change.test.mjs).

One complete rollback is retained and reverified by
content, descriptor, inventory, binding, and typed MCP health before
transition. Same-release operational snapshots must not be promoted into a
compatibility rollback target. Remove, rollback, cleanup, and uninstall
cannot restore or delete unrelated user entries. Deliberately displaced
entries are restored only when Suite ownership ends and later user changes
are preserved.

## Profile and tool truth

Start with [profile.test.mjs](profile.test.mjs), [mcp-catalog.test.mjs](mcp-catalog.test.mjs), [developer-kit-skill.test.mjs](developer-kit-skill.test.mjs).

Installed components, Agent-visible components,
and the smaller active tool set remain distinct. Backstage observation
components never enter the callable catalog or spawn Agent-session MCP
processes. Normalized tool-name conflicts fail before deployment observation
using the same semantic key as Observer.
Managed catalog byte/count limits are resource admission, not model-context
or token measurements. Distinguish Provider catalogs, native host inventory,
enabled/loaded Skills and the actual model request when making cost claims.
Ordinary MCP output schemas are optional: preserve omission and validate
advertised schemas without forcing on-demand contracts into discovery.
Formal semantic bindings and complete schema-pair exports keep their stricter
contract requirements; generic admission does not certify those semantics.
The `developer` profile must install the Developer Kit without adding it to
`agentComponents`, tool-set selection, catalog budgets, MCP health warm-up,
or Direct Runtime configuration. Mutable source-root installation fails
before package or host mutation.

## Thin host projection

Start with [codex-projection.test.mjs](codex-projection.test.mjs), [codex-config.test.mjs](codex-config.test.mjs), [developer-kit-skill.test.mjs](developer-kit-skill.test.mjs).

Host projections contain identity and invocation
only, never provider runtime. Workspace-dependent tools require one explicit
absolute grant whose variables all bind to that canonical root. Package-backed
commands, component/Skill identity, lifecycle ownership, and auxiliary CLI
entrypoints survive update, rollback, and uninstall. A cold isolated Codex
inventory must expose exactly the target private Plugin and its projected
MCP transport; an evaluation adapter must treat the Suite executor and
Provider package as separate, explicit, fingerprinted runtime roots rather
than assuming executable bytes live inside the projection.
Developer Kit projections are Skill-only, contain no `.mcp.json`, and launch
the exact immutable Suite Node plus CLI. ZCode and Claude replacements back
up and restore an occupied user Skill; uninstall preserves a later changed target.

## Host inspection and mutation

Start with [codex-host.test.mjs](codex-host.test.mjs), [claude-host.test.mjs](claude-host.test.mjs), [zcode-host.test.mjs](zcode-host.test.mjs).

Absence, unverified configuration, and
failed inspection remain distinct. ZCode management stays within its public
user MCP/Skill configuration, preserves unrelated fields and exact displaced
entries, and never changes its model provider or credentials. Claude management
uses its public user JSON and retains exact argv, non-stdio displaced entries,
aliases, and environment fields. Version discovery disables Skills and Chrome;
binding inspection neither loads project/local settings nor parses human
health-query prose. Later user edits and occupied displaced aliases are
preserved or rejected before writes. A failed recorded replacement restores
the prior binding; a legacy lossy record is not an exact restoration receipt.

## Default inspection effect budget

Start with [doctor.test.mjs](doctor.test.mjs), [web-manager.test.mjs](web-manager.test.mjs).

Manager startup and foreground refresh
resolve Agent apps without launching their CLIs, retain deep local package,
catalog, and direct semantic probes, and label Agent bindings configured but
unverified. Opening the Manager must not trigger access to an unrelated
protected folder; explicit Full Check owns deep Agent-app binding inspection.

## Bounded management surface

Start with [managed-mcp-stdio-transport.test.mjs](managed-mcp-stdio-transport.test.mjs), [process.test.mjs](process.test.mjs), [cli.test.mjs](cli.test.mjs).

Every Manager CLI action has a termination
path even when a child ignores graceful termination. Activity contains
bounded actions and state, never prompts, tool inputs, or results. Human copy
uses product labels while CLI JSON retains stable identifiers. Host MCP
health, context export, and Skill-link probes use the Host-owned
process-scope transport rather than the SDK transport's root-only delayed
kill path. POSIX close verifies the detached group after stubborn-root and
root-exited/descendant-survived cases without signalling a numeric group ID
whose ownership is uncertain after root reap. An inaccessible group whose old
identity remains reserved is a cleanup failure unless the root is reaped and a
later bounded probe confirms absence, including the short macOS zombie-only
interval. If the reaped root's positive PID is live (including `EPERM`), POSIX
has recycled the number and the Host must not signal the unrelated group now
addressed by it. Windows requires successful tree
termination plus root close. Cleanup failure remains visible, including
when the probe itself also failed.

## Observability boundary

Start with [observability.test.mjs](observability.test.mjs), [usage-summary.test.mjs](usage-summary.test.mjs), [execution-observation-contract.test.mjs](execution-observation-contract.test.mjs).

Observer retention is not shorter than report
 lookback, preserves current deployment/catalog correlation, and performs WAL
 checkpoint and compaction. Reports preserve provider session-start bases,
 current-release separation, routing bounds, activity semantics, observation
 coverage, and uncertainty. Available Skill inventory is never presented as
 Skill activation; passive absence never supplies non-use reason, semantic
 effect, or result adoption. Provider-specific Token semantics, bounded UTC
 daily rows, current/longest observed-day streaks and the not-chat-duration
 session-span boundary remain explicit. Current Procedure/Capability
 execution totals derive from Direct Runtime metadata, not retired receipt
 projections.

## Snapshot and storage economy

Start with [operations-snapshot.test.mjs](operations-snapshot.test.mjs), [storage.test.mjs](storage.test.mjs).

`snapshot --json` is path-free, bounded to
 16 KiB serialized output, limits recent activity, preserves freshness and
 provider coverage, and states its assessment boundary. With observation
 enabled it reads current packaged Observer status/report snapshots without
 collecting; cached Host refresh is only an explicit fallback. Storage
 reports total and sectional allocated bytes plus exact cleanup candidates;
 cleanup retains active and rollback packages and runtime configurations,
 packages referenced by live Agent processes, recent/staging artifacts, and all paths outside private
 Suite state. A live-process scan failure blocks cleanup-candidate
 calculation instead of risking an in-use package. A deliberately displaced Skill
 symlink in the backup section is counted without following its target;
 package, download, and managed runtime-configuration storage still reject links.

## Update and uninstall safety

Start with [release-lifecycle.test.mjs](release-lifecycle.test.mjs), [local-components.test.mjs](local-components.test.mjs), [observability.test.mjs](observability.test.mjs).

A compatibility update cannot silently add
 a private component to a release profile. Uninstall preserves pre-existing
 host entries and user data while removing Suite-created entries. A host's
 fresh-session requirement is policy after binding change, never evidence
 that an open process reloaded or remained stale.
 Multiple private components may coexist only as independently sealed,
 versioned records. Every import, activation, removal, and rollback must
 preflight the complete active catalog so tool-name conflicts and catalog
 budget overflow stop before host bindings or saved state change.
 Observer maintenance must execute through an installed application carrier
 (or its packaged CLI plus Suite-owned Node runtime), never through a source
 checkout or the transient caller. Doctor must report a mismatched launcher.
 A standard release installed from an ordinary application must be able to
 opt into bundled local monitoring later in one explicit atomic transition:
 Observer and analyzer packages appear only backstage, the active Agent tool
 set does not grow, and injected collector or maintenance failure preserves
 the exact preceding standard state and bindings.
 A monitoring toggle must reject a different bundled release rather than
 updating Provider bytes as a side effect. Ordinary update must reject an
 older semantic Suite version before downloads, warm-up, host inspection, or
 state mutation; the explicit retained rollback path remains usable.

## Provider Instance truth

Start with [provider-binding-runtime.test.mjs](provider-binding-runtime.test.mjs), [tool-integration.test.mjs](tool-integration.test.mjs).

Product release, installed package, configured
 Instance, Capability binding, live health, Agent-tool projection and natural
 routing remain separate states. A local bridge command cannot imply absent
 network egress, valid credentials or a healthy remote endpoint. Until a
 concrete remote integration record exists, setup and doctor must not
 present dynamic remote or Agent-runner provisioning as supported. A sealed
 private model-inference Instance pack may be admitted only as exact
 provider-owned bytes with external credential references, explicit privacy
 authority, live typed health, and a product-specific result check kept as
 separate facts.

## Skill-link catalog truth

Start with [skill-link-catalog.test.mjs](skill-link-catalog.test.mjs).

Catalog export includes only configured
 Capability/Procedure bindings and currently active native Tool schemas,
 uses exact identity/version/schema-pair digests, is bounded and path-free,
 and never presents configuration or a successful list-tools call as
 semantic equivalence, provider selection, readiness, or task quality.

## Runtime evidence selection

The following flows are examples for claims that require actual Agent, Manager,
trace or distribution behavior. Select the affected route and honor the task's
authorization before running it. An installed Agent selection claim needs
a fresh session; a documentation change does not. Source fixtures cannot
establish installed behavior, and this list does not authorize model calls,
live configuration changes, content export or publication.

## Installed Agent flow

- start a fresh supported Agent session after installation or binding change;
- ask an ordinary system-status question and verify the packaged
  `agent-host-operations` Skill calls `snapshot --json` before larger reports,
  avoids private storage/source, reports the observation source and freshness,
  does not turn cached zeroes or Skill inventory into current Skill use, and
  labels any judgment as external-Agent inference;
- when a non-use reason, semantic effect, or result-adoption claim is material,
  verify the Agent either leaves it unknown or uses a contemporaneous explicit
  assessment or controlled baseline/treatment task with a task-native outcome
  check; passive telemetry alone cannot satisfy the claim;
- reacquire installed plugin/Skill paths, component versions, and live tool
  registry for the affected Providers, then use realistic prompts to observe
  calls, retries, and generic fallbacks;
- from a stranger-equivalent fresh process, give one realistic task to an
  installed-but-inactive Provider whose thin Skill is discoverable but whose
  MCP catalog is absent. Record whether the Agent selected the Provider,
  loaded only the task-relevant Skill references, invoked the immutable CLI,
  how many successful and failed Provider calls it made, whether it inspected
  geometry or substituted handwritten output, its serialized context/usage
  measurements, elapsed time, and the current task result. Reproduce the
  result through the task's real runtime carrier; an Agent-authored final
  report is not authority for visual, browser, or semantic correctness;
- for a workspace-dependent tool, verify the live host entry carries the
  explicit grant and package-backed command, then call it from a nested
  repository without source or shell fallback;
- report Codex, ZCode, and Claude independently; an intentionally inactive
  carrier is not a failure of the active carrier.

## Direct runtime flow

- reacquire provider schemas and bindings from installed immutable artifacts;
- select representative single-call, native-batch and work-order flows from
  the affected Providers and execute them through the local service;
- exercise timeout/cancellation, overload/fairness, replacement, shutdown, and
  recovery, then verify warm calls reuse one Provider generation, failed
  generations are replaced, session count stays bounded to one per Provider,
  and service shutdown reaps every owned Provider process;
- report cold latency, warm/idle resources, and zero-model execution separately;
- verify observations contain no input, result, or provider error message.

## Human runtime flow

- complete the current primary setup and environment inspection path, one tool
  availability change and restoration, explicit Full Check, update/rollback,
  error recovery, and the non-destructive observability-disable/uninstall
  previews relevant to the reviewed change;
- keep the Manager open across one environment change and foreground return;
  verify freshness advances without a duplicate just-completed refresh;
- verify visible Environment and Tools counts exclude backstage components while
  context cost counts only Agent-callable operations;
- verify default refresh detects a broken direct route rather than promoting
  file or binding presence to overall readiness;
- verify startup performs no Codex, ZCode, or Claude binding subprocess inspection and
  produces no protected-folder request, while Full Check still detects a broken
  Agent-app binding;
- exercise keyboard/accessibility and inspect the rendered surface separately
  from build results.
- on Windows, distinguish application install/update/restore/uninstall from the
  tool environment's setup/update/rollback/disconnect actions; exercise Start
  menu entry points, loopback authentication, narrow and wide layouts, and both
  data-retention choices without a source checkout.

## Trace Plane flow

- derive the adapter inventory from the installed component and verify the
  catalog is path-free, versioned, and reports per-signal availability rather
  than upgrading unavailable to zero;
- verify automatic record adapters make no Agent-shell change and every public
  event, telemetry, or hook plan reports `appliesChanges: false`, an exact
  user-owned configuration action, and a corresponding removal action;
- exercise ZCode incremental multi-file collection to settled state, an
  incomplete append and recovery, hook-only provider reporting, DeepSeek queue
  shutdown, Gemini concatenated-object recovery, and bridge replay;
- compare cold, settled, sustained, and bounded-overload collection costs;
  measure asynchronous Claude hook projection and the single-post-event
  Copilot bridge path separately;
- export one metadata-only pack and one explicitly double-confirmed selected-
  content pack into new owner-only files, verify complete-output limits and
  secret filtering, and prove neither pack enters Observer storage;
- list bounded, path-free retained sessions for at least one model-step adapter
  and one hook-only adapter; export one explicit retained session/time range,
  verify v0.2 contains only normalized metadata and declares retention plus
  unknown completeness, and reject mixed file/session, empty-range, expired,
  content-bearing, unsafe-output, and over-budget requests before publication;
- confirm no passive field or Manager label claims a Skill activation, non-use
  reason, semantic effect, correctness, result adoption, task quality,
  opportunity, or value.

## Distribution

When a binary or installer release is in scope, install on a clean supported
machine from the declared artifacts rather than sibling source. Verify detached
digests, nested licenses/notices, SBOM, signature, notarization, Gatekeeper, and
each claimed platform separately. Record intentionally absent signed or
cross-platform artifacts rather than treating silence as parity.
For Windows, additionally verify the payload manifest before and after copy,
current-user PATH and shortcut ownership, named-pipe execution, scheduled-task
recovery after login/reboot, application rollback, SmartScreen/signing state,
and zero residual application processes or files after uninstall.
