# Architecture

```text
Capability / Procedure standards (independent, normative)
                         |
Provider releases -------+------ compatibility manifest
                         |                |
                         v                v
                   Agent Host Manager
                   |       |        |
             host adapter  |   optional observability
                   |       |
     Codex / ZCode / Claude +--- Direct Execution Runtime
             official              |
          extension point      provider bindings
                   |               |
                   +------ provider artifacts
```

## No Agent app patching

The Manager calls documented Agent-app extension commands and writes only state
owned by those public mechanisms. An Agent-app update may require a fresh
compatibility check, but it cannot overwrite a patched runtime because Agent
Host never patches the Agent app.

Claude Code integrations are owned at user scope. Agent Host reads and changes
selected `mcpServers` fields in the public user `.claude.json` file, preserving
exact argument arrays, complete displaced entries, and unrelated settings.
It retains the resolved config path in Host state; project-scoped entries are
untouched. The installed-version query uses `setting-sources=user` with Skills
and Chrome integration disabled. Binding inspection does not invoke a Provider
health query or reconstruct arguments from human CLI output. Legacy displacement
that was recorded only as a lossy argument rendering cannot be automatically
restored as though it were exact.

ZCode integrations use its documented user configuration and Skill locations:
`~/.zcode/cli/config.json` under `mcp.servers`, and `~/.zcode/skills`.
Agent Host atomically rewrites only selected Suite-managed MCP keys, retains
exact displaced user entries for restoration, preserves unrelated config, and
projects Skills from immutable Host storage. It does not patch ZCode, its plugin
cache, model provider, credentials, or running sessions.

## No central Agent tool

The model continues to see provider-specific domain tools. It never receives a
generic `invoke(provider, operation, opaqueInput)` surface. Once a host already
has a selected, validated Capability, Procedure, or declared MCP operation and
structured input, it can send that closed work below the model to Direct
Execution Runtime. For a broad MCP Provider such as Math Anchor, the suite
binds `math.run` as an explicit operation-projectable tool and `math.batch` as
its native batch carrier. The runtime keeps the public tool and selected
operation identities visible while loading only the selected contract. When
the public tool listing is deliberately compact, the binding names the
provider's distinct read-only description tool and exact response path; the
runtime validates that live response and caches it only for the current
provider session.

This projection occurs after selection. Current Codex, ZCode, and Claude public
extension points do not let the suite replace a tool schema dynamically inside
an already-open model turn, so their initial Agent catalog still uses each
Provider's compact advertised schema. Agent Host does not patch the Agent app
to change that limitation.

Agent Host does expose one management Skill, not a domain invocation tool. Its
default launcher calls the packaged `agent-host snapshot --json` interface and
adds no MCP server, provider operation, generic invoke surface, or model call.
Codex carries it as a Suite-managed Skill-only plugin so it does not replace a
user's canonical local Skill source; ZCode and Claude link to separate immutable
private projections. The snapshot has a 16 KiB serialized budget and excludes private
paths, raw Observer records, prompts, arguments, results, and source. Its
assessment boundary is part of the response contract.

See [`TERMINOLOGY.md`](TERMINOLOGY.md) for the product-facing names represented
by these technical layers.

## Source and release boundaries

Repository boundaries follow current ownership rather than every typed module.
The standards remain Host-independent, and independently useful external
providers retain their own histories and releases. Host-owned Runtime,
transport, observation, instance, and routing-support code may share this
source workspace while preserving explicit internal package and process
boundaries. The suite repository stores:

- schemas for its own manifest and state;
- compatibility and profile declarations;
- host adapter and lifecycle code;
- Host-owned Runtime and supporting packages;
- a small human management app;
- release automation and checks.

External domain-provider source is never vendored. Release archives may contain
independently licensed provider binaries as verified nested artifacts, with
their original licenses, notices, SBOMs, identities, versions, and hashes
preserved. Internal package co-location never authorizes a model-facing generic
invoke surface or weakens process, schema, version, and error isolation.

On Windows, the application distribution is a current-user ZIP with a private
Node runtime, verified payload manifest, Start menu lifecycle shortcuts, and a
loopback-only browser Manager. Direct Runtime uses a per-install named pipe;
runtime, Observer collection, and weekly maintenance use current-user Task
Scheduler entries. Application update retains one verified previous payload,
while tool-environment update and rollback remain separate Agent Host
lifecycle operations. Installed execution continues to resolve from private
immutable packages, never from `tools-dev`.

Application bytes and environment state form an explicit compatibility seam.
Before tool-environment update or rollback, the installed application reads an
exact temporary candidate state through its packaged command; this occurs in
dry-run as well as activation and precedes host or service mutation. Windows
application install and restore perform the inverse check by asking the staged
or retained application to read the current state before swapping directories.
Strict state validation is retained rather than silently ignoring unknown
fields. Observer maintenance resolves a durable installed application carrier;
it never persists the Node executable or CLI path of the process that happened
to request the update. Ordinary update rejects a target semantic Suite version
older than the installed environment; rollback remains the only reversion path.

Every mutation of one Agent Host state root shares one durable exclusive
lifecycle lock, including setup, Agent-app connection changes, compatibility
update/rollback, working-set and private-component transitions, monitoring,
storage cleanup, and uninstall. The lock is published atomically with a process
ID plus process-start identity. A dead owner may be reclaimed; a live owner is
reclaimed for PID reuse only where its start identity is current and
unambiguous. POSIX wall-clock process output is not such an identity, so an
external live PID fails closed. Each stale-recovery contender atomically
publishes its own immutable claim inside the still-published lock, then an
immutable bakery-style ticket. A choosing contender makes peers wait; equal
tickets use the random claim token as a total order, and a later contender sees
the published ticket and must choose a greater one. The elected contender
rechecks the same lock-owner token and liveness before retirement. A crashed
contender therefore leaves only uniquely named files that a later contender may
ignore and remove after confirming that process is dead; live or
identity-uncertain contenders remain blocking, malformed claims fail closed,
and garbage cleanup is bounded per attempt. A published final claim or ticket
whose JSON value is `null` is malformed; only a file that another contender
removed after the directory snapshot is treated as absent. Ordinary publishers cannot fill a
path gap before retirement, and after retirement their atomic publication race
with the reaper admits only one lifecycle callback. Windows removal of the
uniquely retired directory tolerates transient open files with bounded retries;
persistent cleanup failures prevent the recovering caller's mutation callback.
If the final sharing-failure scan observes that competing recovery claimants
have exited, the elected contender makes one last retirement attempt through
the same owner-identity and liveness checks. A replacement owner still blocks
recovery, and persistent permission errors never grant a lease.
When no state root exists, one private candidate containing the lock is renamed
into place atomically, so losing contenders cannot create state subdirectories.
Nested Suite operations may re-enter only with the authenticated in-process
lease. Read-only status, catalog, usage, monitoring, storage, and component
inspection validates an existing private root but never creates it. A failed
first mutation retires a newly published root only while it still contains
nothing except the empty state scaffold; retained compensation or diagnostic
state keeps the root. Successful empty no-ops follow the same retirement path,
so setup preview and absent uninstall cannot leave a newly manufactured
scaffold. Purge and eligible failed first mutations retire the
entire locked root by atomic rename and delete it only after lease release.
Deletion therefore targets only that retired identity, so a new installation
at the original path cannot be deleted by the earlier operation. A mutation
failure followed by lease-release failure returns both bounded, path-free
failures. Cleanup additionally revalidates canonical current and rollback state
digests immediately before its first removal. A target activation failure
reactivates the complete prior Host, runtime/service, and monitoring state; a
failed compensation returns one typed compound error without rewriting saved
state. Setup, Agent-app add/remove, monitoring enable/disable, update, rollback,
tool-set/private inventory changes, and uninstall include state-commit failures
inside that compensation boundary. Monitoring refresh and retention maintenance
cannot reverse already-collected Observer rows, so typed failures disclose the
committed and possible partial effects instead of claiming atomicity.

Service installation, replacement and removal require the owning environment
transaction. The before-effect journal records carrier bytes, native identity
and configured/running/endpoint-ready state as separate facts. Windows also
records the launcher owner/group/access ACL and the scheduled task definition
and ACL. Windows stopped and disabled tasks remain stopped or disabled after
recovery; queued/unknown prior tasks and read-only launchers are unsupported
before mutation. A loaded-but-stopped macOS LaunchAgent is likewise refused.
Generated macOS descriptors retain `RunAtLoad`; bootstrap starts them without
an immediate force-kickstart. Removal waits for native absence before changing
carrier files. Unchanged ready services retain their process only when their
recorded identity and declared Runtime fingerprint also match.

Whole-journal recovery preflights all remaining resources and reverses them
before restoring stable lifecycle state. Another application's changed resource
blocks restoration and keeps its bytes and ownership record. Successful service
startup does not retire the journal: only whole-environment commit does. The
normal service writer has no standalone fallback and produces no new v0.2
service-recovery bundles. Current environment operations recover an interrupted
journal before retrying the requested change; read-only status never repairs it.

Historical service-recovery bundles retain the dedicated
`agent-host service recover` compatibility route. The command accepts only that
identity and its manifest digest; it resolves the bundle beneath the selected
Host private-state root and never accepts a bundle path. Before creating a lock
or state scaffold, the CLI read-only preflight requires an existing canonical,
owner-private Host state file, its matching runtime-service identity, and the
named recovery bundle. The same lifecycle lock used by setup, update, rollback,
and uninstall then protects recovery. The Host matches the saved lifecycle-state
bytes and the failure-time carrier and job/task binding before any removal or
overwrite. A retained macOS job binding includes the observed descriptor path,
program, and state, so an unrelated job or a running-to-exited transition cannot
be consumed as the same residue. The Host then rechecks lifecycle bytes,
restored carrier bytes, task identity, running state, and endpoint readiness.
For macOS, the expected post-restore program is derived from the retained prior
descriptor rather than the request or current job; the bundle is retained and a
path-free current-state observation is returned if the job reports another
program, even at the same descriptor path while running and ready.
Because the carrier may already contain the retained prior descriptor at that
point, Host does not return the now-stale failed-replacement action. It first
atomically advances the manifest to an explicit `partial-restore` phase with a
new digest, rebinding the verified prior carrier, lifecycle bytes, and current
job/task observation. Only that refreshed action may be retried; if rebinding
cannot be confirmed, the bundle remains retained without an automatic retry
action. The retained macOS descriptor parser accepts exactly one direct
`Program` string or the first direct string of one `ProgramArguments` array.
Duplicate, conflicting, nested, non-string-first, or entity-ambiguous forms are
rejected before bootout or overwrite.
A successful response reports the newly observed
service state; it is not an automatic recovery promise.
This makes a stale bundle incapable of replacing a newer successful service;
unknown or changed state remains retained and requires owner intervention.

Host-owned MCP health, managed-catalog export, and Skill-link catalog probes
run each short-lived Provider in an owned process scope. POSIX uses a detached
process group and verifies that the group, rather than only its leader, is gone;
Windows uses `taskkill /T /F` and waits for root close. Work that creates a new
session or otherwise leaves that scope is `not-observable`; this boundary is
not an OS process sandbox. Probe completion does not hide a cleanup failure,
and a simultaneous probe/cleanup failure is reported as one bounded compound
error. After a POSIX root has been reaped, a live process at the same positive
PID proves that numeric group identity was recycled; cleanup then refuses to
signal that foreign group.

The public macOS application bundles the `observability` compatibility layer
while initial Manager setup still selects `standard`. Windows distributions
bundle `standard`, `observability`, and `developer`. Bundling makes the bytes
available but grants no monitoring consent and starts no collector. The later
explicit enable action runs an ordinary atomic environment update to the
`observability` profile, then installs the collector and maintenance carrier
before the new state is committed. Any failure restores host/runtime bindings
and deletes the uncommitted monitoring package versions. This immediate action
is constrained to the same release identity and the two monitoring components;
a different App catalog must first pass through the separately reviewed update
flow.

Public Agent-tool packages undergo one sequential first-and-repeat MCP health
start from their final immutable paths before activation on first setup or
policy migration; subsequent updates select only changed fingerprints. The
sequence is deliberately not parallel: macOS may serialize executable trust
evaluation for newly created ad-hoc internal builds, and simultaneous heavy
Python bundles amplify rather than hide that work. A persisted policy marker
ensures an Agent Host upgrade also covers previously materialized packages once.
This internal installation
step does not replace Developer ID signing, notarization, or clean-machine
distribution verification for a public binary.

Package inventory and Agent-visible working set are separate. Every transition
that can change the working set measures the proposed live catalogs and blocks
activation when their canonical bytes, largest tool, or tool count exceed the
declared resource limits. The 64 KiB aggregate limit protects admission of the
selected managed catalog; it does not require uninstalling inactive tools.
This is a Host resource policy, not an observed Codex/Claude context-window
limit or a measurement of a model's input. Provider `tools/list`, a host's native
inventory, enabled Skill metadata, loaded Skill contents and the final model
request are distinct surfaces. A host may filter, defer, add to or transform
the catalog. Catalog bytes must not be converted into claimed token savings
without an explicit tokenizer/input observation and a comparable run.

Current Codex 0.152.0 public read-only inventories can verify effective native
configuration, active Skill identities and MCP tool metadata in isolated homes.
They do not establish the assembled model request. The natural four-route
Controller and native driver live in `agent-tool-labs/packages/agent-tool-evals`;
their preparation digest separates common configuration from declared exposure.
The normal Host does not gain an evaluator or another routing service. Future
host-specific exposure changes should use a verified public mechanism and
preserve the same task/native tools; a feature's name or a catalog byte count
alone is insufficient evidence to select that change.

The former `measure:local-dogfood` script has been removed. It forced tool use,
defaulted to a different model and wrote overlays into the live Codex home.
Its reports retain their historical meaning; they are not migrated into natural
four-route reports. Run construction, explicit model/budget admission and
descriptive task comparison now belong to the separate evaluation package.

The Local profile declares a small initial working set separately from its
complete activatable inventory. Setup and profile changes warm and bind only
that default unless the caller explicitly selects tools. Inactive providers
retain package-owned Skill and CLI discovery without contributing MCP schema
bytes or provider-process cold starts. `tools reset` restores the small profile
default; selecting the entire inventory is still possible with an explicit
`tools set` request and the same preflight.

## Supported Provider shapes

Math Anchor and Migratory Time keep their specialized Direct Runtime bindings.
Additional Agent tools enter through a supported closed tool-integration record.
The record binds exact marketplace and plugin identity, contained entrypoints,
expected tools, health bounds, optional Host-owned grants, and Suite-created-only
uninstall ownership. A Provider may retain a separate CLI entrypoint for local
maintenance; Agent Host must not overwrite that CLI with its MCP carrier. The
supported schema versions and their non-cumulative shapes are defined in
[`TOOL_INTEGRATION.md`](TOOL_INTEGRATION.md) and the corresponding schemas.

This record is an admission seam for selected products. It is not a registry,
universal installer, third-party marketplace, or permission to invent future
provider fields without a current consumer.

## Product, Instance, Capability and Tool

Agent Host installs or configures a Provider Product as one Provider Instance,
binds its exact current implementation to a Capability or provider-native
contract where applicable, and projects callable Tools plus owned Skill
guidance through official Agent-app extension points. It does not “provide a
Capability” without an implementation and it does not redefine Capability
semantics from a tool schema.

For Skill refinement, the Host may export one exact link-catalog projection.
Configured Capability and Procedure entries are read from the private Direct
Runtime configuration; active provider-native Tool entries are reacquired from
their live MCP catalogs. The projection discloses only kind, exact identity,
version, and a digest over the complete input/output schema pair. It neither
selects a Provider nor claims that equal schemas have equal semantics.

The supported installable shapes are local MCP stdio packages and specialized
local Direct Runtime bindings. A bounded model-inference Provider may use the
same local MCP shape: one typed model call does not inherit tools, memory, a
planning loop, or autonomous stopping. Agent Host binds the complete archive
and live catalog but does not interpret a Provider-specific Instance file or
claim model quality. The user chooses any authoring Agent or harness outside
Agent Host.

Standard setup/update still has no dynamic endpoint/account/credential
provisioning record, and no Agent-runner Instance is currently admitted.
Remote or editable Instance configuration remains outside setup, update and
doctor until one concrete Provider requires it and the Suite can show network
scope, credential reference, health and recovery without storing a secret.

## Private component import

The optional local import path reuses that same component descriptor and tool
integration seam; it introduces no provider-neutral schema and no discovery
catalog. The CLI accepts one explicit absolute path to a sealed `tar.gz`
artifact. Preview observes its current archive SHA-256 and byte length,
descriptor SHA-256, id, version, platform, file count, expanded bytes, and live
typed MCP catalog. The owner supplies the SPDX expression. Import requires an
exact binding object containing those facts, so a changed package cannot reuse
an earlier approval. Live catalog inspection starts the selected component in a
temporary package root. It persists no Agent Host state, but is not a sandbox
and cannot establish absence of effects outside Agent Host state. Recording a
syntactically valid owner-supplied SPDX expression does not verify ownership,
license compatibility, or redistribution rights.

Only `kind: agent-tool` is accepted. Runtime commands, plugin identities, and
working directories come from the already-validated contained integration;
the CLI exposes no command or arguments option. `suite-node` resolves to the
environment's verified Node component. A provider-specific Instance file may
be one of the sealed identity files when it contains configuration and
external credential references only, never a credential. Replacing that
configuration means building and previewing a new exact archive; Agent Host
does not silently edit the Instance. The package enters immutable private
storage, is inactive by default, and can be projected to Codex only through the
existing content-addressed thin projection and Suite-owned binding lifecycle.
One previous private version or removal is retained for rollback. Source
directories, links, special files, unbounded inventories, implicit activation,
Claude expansion, model calls, and generic Agent-visible invocation remain out
of scope.

## Private state

The current writer uses `openadam.agent-host-state.v0.2`. It still reads v0.1
without changing it. New ownership records retain complete displaced Claude
JSON bindings; older writers cannot interpret them safely and must reject v0.2.
Initial setup and legacy-state migration check the installed application through
an isolated `status` invocation before mutating host bindings or services. A
preview runs that read-only compatibility check too. Migration retains the
original v0.1 record in history and publishes v0.2 only on commit. Existing
interruption recovery restores the recorded previous version before migration
preflight; dedicated service-bundle recovery preserves its bound old state.
An incompatible application must be updated through the separate authorized
installation workflow before a migration can proceed.

Installed paths, local development roots, service sockets, process state, and
observations live in a user-private state directory. Tracked examples contain
placeholders only. The manager writes state atomically and records which host
entries it created so removal cannot claim ownership of pre-existing entries.

### Execution provenance, not workspace restriction

The release boundary controls where installed tools load from. It does not
control where an Agent may work. An Agent can implement a repository under
`tools-dev` while its tool calls still resolve to immutable private packages,
which makes the installed behavior comparable to an unrelated user's Agent.
Historical displaced bindings may be retained for recovery, but they are not
active execution entries. No path denylist or extra workspace sandbox is part
of this architecture.

The installed profile and active Agent tool set are separate. A temporary
active-set reduction deactivates Agent Host's managed exposure and keeps
the displaced user entry suspended, so a source-checkout plugin cannot silently
reappear. Removing a component from the installed profile, disconnecting the
Agent app, or uninstalling the environment restores the preserved user entry.

Codex does not currently provide a task root through MCP initialization. The
Suite therefore requires one explicit workspace root when an active tool
declares workspace environment variables. It creates a content-addressed thin
Codex projection containing plugin identity and Skill resources, while every
MCP command and working directory points to the immutable package. Codex may
cache that small projection; it does not cache a second provider runtime.

Native Codex bindings use a fresh Host-specific marketplace identity for each
new projection installation. User plugins are disabled and their prior enabled
cell is retained; their marketplaces and cached bytes remain untouched. The
native install receipt identifies the cached path, whose complete file inventory
and contents must match the verified projection. An upstream source path does
not establish installed identity. Working-set suspension preserves the cache
and registration, and inactive projections remain retained until removal.

The public config API provides version-checked field writes. The native plugin
installer's enablement side effect is journaled before invocation; its cache
copy has no public version-check option. Recovery removes fresh registrations
without rewriting an existing native cache. User-edited or newly shared Host
registrations must be resolved while their ownership and supporting files remain
recorded. Legacy migration only retires exact, exclusively Host-owned records;
lossy old displacement records are not silently reconstructed.

### Native service carriers

Normal macOS lifecycle changes journal the LaunchAgent descriptor, its observed
job identity and readiness before stopping, replacing or removing it. They share
whole-resource recovery with Agent-app configuration and Skill projections.
A user-modified descriptor or job blocks recovery instead of being overwritten;
committed state ends the old journal's authority. Unchanged ready services retain
their process only when both descriptor and Runtime fingerprint match.

The service's default label remains stable. Native job inspection uses the
retained label and exact arguments/environment, with bounded parsing of the
current public diagnostic output. Removal waits for confirmed native absence;
command return alone does not establish that the old job has gone.

Windows uses the public Task Scheduler 2.0 COM API through a bounded, private
JSON/stdin adapter. Preparation fills an unregistered task definition; observation
and recovery compare its complete native XML serialization and owner/group/access
security descriptor. Registration uses create-only semantics, preserves the
recorded ACL, and ignores registration triggers. The native helper rechecks the
expected definition/ACL before stop, delete or run; create refuses a concurrent
same-name registration. There is no forced overwrite or credential prompt.
Only the current user's limited interactive-token/logon-trigger task can be
restored without collecting a password or replaying a time/registration event.
Unknown serialization changes fail closed; the implementation does not strip
fields to make an unexpected native response match.

Launcher bytes and owner/group/access ACL are restored together by preparing a
private file before atomic rename. Task and launcher ACL edits block recovery;
NTFS permissions are not inferred from synthetic POSIX mode bits. SACL auditing
is outside the unprivileged Host's access-list contract. A newly needed shared
`\openAdam` task folder may remain empty after removal; it is never recursively
deleted as though it belonged only to this service. Native Windows verification
is explicit through `node scripts/probe-windows-service-journal.mjs`, which uses
unique suffixed task names, a temporary private root, a named-pipe fixture and
actual process termination. It retains a failed probe's own state for diagnosis.
The current macOS source/protocol and PowerShell-parser checks do not establish
Windows Task Scheduler execution, XML/ACL round-trip behavior, or login recovery.

### Bounded Direct Runtime residency

The Direct Runtime host service remains available, and its installed
configuration carries the complete configured Provider set while naming a
separate preparation allowlist derived from the active Agent component set.
Only active persistent Providers are prepared sequentially before publishing
the service Socket; inactive installed Providers remain non-resident. This
moves command-copy and operating
system admission out of the first user work order without weakening the frozen
execution view or silently extending a caller's whole-call deadline. Library
consumers remain lazy unless their configuration explicitly selects service
preparation. Provider configuration v0.3 owns that exact allowlist; retained
v0.2 runtimes receive their unchanged lazy schema during rollback. Calls never
create an unbounded session pool:
each Provider has at most one current generation, and timeout, cancellation,
identity replacement, service shutdown, and update close or replace that
generation. This retains the conveyor's millisecond warm path for repeated
deterministic work while bounding residency by the fixed configured Provider
set. Agent-app MCP sessions remain separate public-host connections.

Backstage Node utilities and v0.2 `suite-node` Agent integrations use the
suite's single verified Node runtime. They do not embed another Node executable
merely because a standalone provider distribution offers one. This sharing is
an Agent Host packaging property; provider-owned standalone releases remain
independent and self-contained.

The management Skill launcher prefers the CLI and Node runtime inside the
currently installed system or user `Agent Host.app`, then falls back to a
published `agent-host` executable. An explicit `AGENT_HOST_CLI` remains a
developer-controlled override. Ambient `PATH` therefore cannot silently make
a source-linked CLI shadow an installed application's compatibility set.
Setup, update, rollback, doctor, and uninstall track host ownership
independently from provider bindings;
conflicts fail closed, deliberate replacement is recoverable, and a
user-changed exposure is preserved rather than deleted.

### Observation projection boundary

Agent Host validates the normalized Agent-visible tool bindings before it
writes a deployment observation, so a duplicate catalog identity fails with a
Suite-owned error rather than surfacing later as an opaque Observer import
failure. The Suite then preserves Observer's per-provider session-start source,
known/unknown call coverage, and both routing bounds. Its summary names the
returned items as routing observations, not total turns. These fields remain
mechanical correlations; adoption, opportunity, route quality, task quality,
and causation stay outside the Suite.


Windows private storage uses NTFS access lists rather than synthetic POSIX mode
bits. The Suite owns `src/windows-private-access.mjs`; the Direct Runtime and
Observer carry verified identical copies so each component remains self-contained.
`node scripts/sync-platform-support.mjs --write` refreshes those copies, and the
repository check rejects drift. Concurrent asynchronous checks are batched only
within the pending request; no permission result survives for a later read.
