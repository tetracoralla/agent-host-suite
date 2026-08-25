# Product model

## User and task

The initial user is an individual macOS user who runs Codex or Claude Code and
wants a small set of deterministic tools plus a reliable direct execution
service without cloning and configuring many repositories by hand.

The user chooses a profile, reviews the requested host and background-service
changes, installs once, checks current health, updates or rolls back a bound
release, and can remove everything the suite created.

## Product object

Agent Host Suite is a distribution and local operations product. It is not the
Agent-Host architecture itself and it is not required for standards adoption.
Its durable product object is an installed compatibility set:

- one exact suite release;
- exact provider and runtime artifacts with hashes and licenses;
- the selected profile;
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
- Agent Host Suite owns artifact acquisition, hash verification, installation,
  official host integration, local service lifecycle, profiles, update,
  rollback, removal, and a human status surface.
- Agent shells remain independently updated clients. The suite never patches
  their binaries or private implementation files.

## Profiles

`standard` initially contains Math Anchor and Migratory Time plus Direct
Execution Runtime. It is deliberately small.

`observability` adds Agent Tool Observer, a host-owned catalog snapshot
exporter, and Context Surface Analyzer. It is opt-in because it creates local
operational data and background work.

`evaluation` is for developers and CI. It is not installed into an ordinary
Agent catalog.

`developer` accepts explicit local source roots and is not a public end-user
release channel.

## Dominant flows

1. Setup preflights the selected profile, artifacts, host conflicts, private
   state location, and proposed background services before changing anything.
2. Host adapters use official marketplace, plugin, MCP, or extension commands.
3. Direct Runtime receives provider bindings with exact paths and starts as a
   user-owned local service; it is not exposed as a generic Agent tool.
4. Doctor reacquires installed plugin state, service state, live provider
   contracts, and optionally runs bounded semantic probes.
5. Update retains the prior complete compatibility set until the new set is
   installed and checked. Rollback reactivates that retained set.
6. Uninstall removes only suite-created host entries and services. The optional
   `--purge-data` removes the suite's private snapshots, history, and retained
   state. Observer's shared local database remains owned by Observer and needs
   a separate explicit removal action so pre-existing history is never erased.

## Human surface

The macOS app is a backstage management surface with four questions:

- What profile and release are active?
- Which selected tools are healthy?
- Is direct execution and optional observation running?
- Can I update, roll back, repair, or remove the installation?

It does not show MCP schemas, Agent reasoning, Capability catalogs, protocol
metadata, prompts, or marketing explanations in the primary interface.

## Current completion boundary

The first practical completion line is one macOS arm64 machine with no
`tools-dev` dependency after installation: one verified release installs the
standard profile, Codex discovers both providers in a fresh session, one
structured Math and one time-zone call run through Direct Runtime without a
model, doctor reports current state, and update, rollback, privacy disable, and
uninstall operate without editing config by hand.

Claude Code is the second installed-host route. Gemini, Linux, and Windows may
have validated adapters and CI packages before physical-device runtime is
available, but they cannot be reported as runtime-complete until exercised on
those hosts.
