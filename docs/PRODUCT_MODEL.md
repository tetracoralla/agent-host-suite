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
   bounded single, native-batch, and time-zone semantic probes.
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
  configuration;
- **Agent Apps** — detected Codex and Claude installations, connected state,
  health, and explicit connect/disconnect actions;
- **Activity** — bounded local lifecycle history for setup, connection changes,
  update, rollback, monitoring, and removal.

Before installation, the same app presents one setup path: selected standard
tools, detected Agent app, preflight review, then installation. Recoverable
errors use product language and one next action; raw paths and protocol detail
remain outside the primary interface.

The manager's default health refresh includes the bounded direct semantic
probes. It must not report the environment or an individual tool as ready when
only its files and Agent-app entries are present but the direct route is broken.

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
