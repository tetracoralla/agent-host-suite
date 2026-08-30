# Product model

## User and task

The initial user is an individual macOS user who runs Codex or Claude Code and
wants a small set of deterministic tools plus a reliable direct execution
service without cloning and configuring many repositories by hand.

The user chooses an installed profile and a smaller active tool set, reviews
the requested Agent-app and background-service changes, installs one Agent
environment, checks current health, updates or rolls back a bound compatibility
release, and can remove everything Agent Host created.

## Product object

Agent Host is a distribution and local operations product. The Agent Host Suite
is this repository's technical distribution unit. Neither is the Agent-Host
architecture itself, and Agent Host is not required for standards adoption.
Its durable product object is an **Agent environment**: one installed
compatibility set containing:

- one exact suite release;
- exact provider and runtime artifacts with hashes and licenses;
- the selected profile;
- the profile's installed component set and its separately declared
  Agent-visible component set;
- explicit host adapters installed through supported host interfaces;
- private current-host configuration and service state;
- optional, separately consented observation components.

The compatibility set states which bytes are intended to work together. It
does not establish provider value, universal compatibility, live availability,
or business acceptance.

## Layer boundary

- Capability and Procedure repositories own normative semantic contracts.
- Provider repositories own provider source, binaries, domain behavior,
  product Skills, plugins, and their releases.
- Direct Execution Runtime owns bounded host execution mechanics.
- Agent Host owns artifact acquisition, hash verification, installation,
  official host integration, local service lifecycle, profiles, update,
  rollback, removal, a human status surface, and one bounded product operations
  Skill for external Agents.
- Agent apps remain independently updated hosts. Agent Host never patches their
  binaries or private implementation files.

## Profiles

`standard` initially contains Math Anchor and Migratory Time plus Direct
Execution Runtime. It is deliberately small.

`observability` adds Agent Tool Observer, a host-owned catalog snapshot
exporter, and Context Surface Analyzer. It is opt-in because it creates local
operational data and background work. Those components remain backstage and do
not add tools or MCP processes to an ordinary Agent session.

`local-dogfood` extends that consented profile with BatchTicket, Armorial,
Laniakea, Projective, Equatorium, and File Vitals. It is the primary local
feedback configuration, not a public marketplace: every component is admitted
through one versioned integration record and still keeps its provider-owned
identity and Skill. The local tools are Agent-visible; observation components
stay installed but backstage.

`evaluation` is for developers and CI. It is not installed into an ordinary
Agent catalog.

`developer` accepts explicit local source roots and is not a public end-user
release channel.

An installed environment may also carry a small, owner-selected set of
**private Agent tools** outside the profile release. This is a local overlay,
not another profile, registry, marketplace, or discovery channel. Agent Host
accepts only one self-contained `agent-tool` archive at a time through the
human CLI. It never accepts a source checkout, runtime command, or model-facing
generic invocation request. A preview reacquires the archive and descriptor
digests, file and expanded-byte bounds, an owner-supplied SPDX expression, the
contained v0.1/v0.2 integration, and the live typed MCP catalog. Import
requires those exact preview facts before immutable storage or host bindings
can change.

## Dominant flows

1. Setup preflights the selected profile, artifacts, host conflicts, private
   state location, explicit workspace grant for tools that require one, and
   proposed background services before changing anything.
2. Host adapters use official marketplace, plugin, MCP, or extension commands.
3. Direct Runtime receives provider bindings with exact paths and starts as a
   user-owned local service; it is not exposed as a generic Agent tool. For a
   declared multi-operation MCP tool, the suite binds operation-level contract
   projection, an explicit provider-owned schema lookup when the listed schema
   is compact, and its native batch carrier. Current Math and Time bindings use
   the `per-call` lifecycle: only the small host service stays resident, while
   provider processes close after each selected structured request.
4. Doctor reacquires installed plugin state, service state, live provider
   contracts, and optionally projects one selected Math contract and runs
   bounded single, native-batch, and time-zone semantic probes. The Manager's
   automatic refresh uses the deep local route without starting Agent-app
   CLIs; explicit Full Check adds current Codex and Claude binding inspection.
5. Update retains the prior complete compatibility set until the new set is
   installed and checked. Rollback reactivates that retained set.
6. Storage inventory separates the Manager App from private state, then splits
   private packages, thin host projections, downloads, history, backups,
   runtime, observations, and catalog snapshots. The CLI's ordinary human
   output shows the combined and sectional allocated footprint plus the exact
   cleanup candidate summary instead of a bare status word. Cleanup verifies
   the active and one rollback release, then removes only older unreferenced
   suite-owned package versions and completed downloads; a dry run reports the
   exact eligible allocated bytes first.
7. `agent-host snapshot` composes a path-free, 16 KiB-bounded status view from
   current Agent Host product results. The installed operations Skill makes
   that the default collaboration route for an external Agent. Codex carries
   it in a Skill-only plugin without an MCP server; Claude links to one
   immutable private copy. Full doctor, observability, or activity output is
   an explicit question-driven escalation, not default context.
8. Weekly maintenance refreshes observation and catalog state, applies the
   Observer's bounded retention and SQLite compaction, and then performs the
   same verified storage cleanup.
9. Uninstall removes only suite-created host entries, operations Skill
   carriers, and services. The optional
   `--purge-data` removes the suite's private snapshots, history, and retained
   state. Observer's shared local database remains owned by Observer and needs
   a separate explicit removal action so pre-existing history is never erased.
10. Private component preview leaves Agent Host state unchanged, but it does
    start the owner-selected component to inspect the live MCP catalog; effects
    outside Agent Host state remain the component's responsibility and are not
    established by dry-run status. Explicit import keeps the package inactive
    unless `--activate` is selected, uses the same content-addressed
    package store and Codex thin projection as release tools, and preserves one
    prior imported version or removal as a byte-verifiable rollback target.
    Import dry-run removes every package directory it created and reports the
    proposed component as not installed and inactive. Component
    rollback revalidates the retained content-addressed root, approved binding,
    descriptor and every declared file, then repeats the live typed MCP health
    probe before changing state or host bindings.
    These overlay transitions do not enter compatibility-release rollback
    history. If the authoritative state and host transition commits but the
    append-only activity entry or stale projection cleanup cannot complete, the
    command reports success with a structured warning instead of claiming the
    component change failed.
    Status is path-free. Removal disconnects only Suite-owned bindings and
    retains the sealed package until the rollback target changes or verified
    storage cleanup makes it unreferenced. Removal is an explicit rollback
    state, so every component rollback returns to the immediately preceding
    installed-or-removed state instead of skipping over the latest user action.
    Current private import connects to
    Codex only; it does not broaden the closed Claude integration set.

Before a deployment observation is written, Agent Host normalizes every
Agent-visible tool name with the same exact semantic key used by Observer's
deployment contract and fails with `AGENT_TOOL_BINDING_CONFLICT` on any empty
or duplicate binding. Observer never becomes the first component to discover a
Suite-owned catalog conflict.

Observation summaries preserve Observer's provider-by-provider session-start
basis and known/unknown coverage for Codex, Claude, and ZCode. Returned routing
records are named as bounded observations, with their truncation state; a zero
count is not presented as an adoption conclusion.

The operations Skill does not add reasoning to Observer or Agent Host. It
preserves timestamps, provider coverage, unknowns, and truncation, then leaves
causation, opportunity, routing quality, task quality, user value, and action
selection to the external Agent shell. A product result that is insufficient
for the question remains insufficient; the Skill forbids bypassing that limit
by reading private databases, provider event files, or implementation source.
The snapshot's fresh-session requirement is installation policy only; current
session uptake is explicitly `not-observed` until a real new host session is
exercised.

An active-set change is not an uninstall. Packages and rollback bytes remain
installed, and an inactive Agent Host binding stays absent in the host. Any
user-owned or source-checkout entry displaced during installation remains
suspended until the component leaves the installed profile, the Agent app is
disconnected, or Agent Host is uninstalled; those terminal flows restore it.

## Human surface

The Agent Host Manager is a backstage management surface organized around four
durable objects:

- **Environment** — overall readiness, profile, version, background service,
  monitoring, check, repair, rollback, and removal;
- **Tools** — installed version, current health, an availability switch for the
  active Agent-app set, and whether an entry is suite-owned or preserved user
  configuration; this list is derived from the environment's declared
  Agent-visible components and excludes backstage observation components;
- **Agent Apps** — detected Codex and Claude installations, connected state,
  health, and explicit connect/disconnect actions;
- **Activity** — bounded local lifecycle history for setup, connection changes,
  update, rollback, monitoring, and removal, translated into product names and
  human labels rather than raw state-field identifiers.

Before installation, the same app presents one setup path: selected standard
tools, detected Agent app, preflight review, then installation. Recoverable
errors use product language and one next action; raw paths and protocol detail
remain outside the primary interface.

The Manager refreshes an outdated in-memory environment when it returns to the
foreground and shows when the visible status was last checked. A long-running
window must not present a pre-update catalog or health result as current. The
initial load blocks incomplete actions; a later foreground refresh keeps the
existing pages navigable, disables mutations, and labels the status as
refreshing until the current local check completes.

The manager's default health refresh includes the bounded direct semantic
probes. It must not report the environment or an individual tool as ready when
only its files and Agent-app entries are present but the direct route is broken.
It resolves Agent-app executables without launching them and labels their
bindings as configured but unverified. This prevents a host CLI from loading
unrelated project-scoped configuration or requesting protected-folder access
merely because the Manager opened. Full Check is the explicit current binding
verification route.

It does not show MCP schemas, Agent reasoning, Capability catalogs, protocol
metadata, prompts, or marketing explanations in the primary interface.

Canonical product language and its stable-identifier boundary are defined in
[`TERMINOLOGY.md`](TERMINOLOGY.md).

## Current completion boundary

The first practical completion line is one macOS arm64 machine with no active
`tools-dev` execution dependency after installation: one verified release
installs the selected profile, Codex discovers the installed providers in a
fresh session, one
structured Math call, one native Math batch, and one time-zone call run through
Direct Runtime without a model, doctor reports current state, and update,
rollback, privacy disable, and uninstall operate without editing config by
hand.

Claude Code is the second installed-host route. Gemini, Linux, and Windows may
have validated adapters and CI packages before physical-device runtime is
available, but they cannot be reported as runtime-complete until exercised on
those hosts.
