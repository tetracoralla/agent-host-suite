# Product model

This document defines the durable user, product object, ownership boundary,
profiles, and human surface. It does not record current component counts,
installed versions, machine state, or release acceptance.

## User and task

The intended user is an individual desktop Agent user who wants a small set of
deterministic tools plus reliable local execution without cloning and
configuring many repositories by hand.

The user chooses an installed profile and a smaller active tool set, reviews
the requested Agent-app and background-service changes, installs one Agent
environment, checks current health, updates or rolls back a bound compatibility
release, and can remove everything Agent Host created.

The Windows Manager and native macOS Manager present English and Simplified
Chinese, follow the operating-system language by default, and keep the explicit
override in their secondary Settings surface. Platform-specific carrier and
release claims remain in the platform and release documents.

## Product object

Agent Host is a distribution and local operations product. The Agent Host Suite
is this repository's technical distribution unit. Neither is the Agent-Host
architecture itself, and Agent Host is not required for standards adoption.

Its durable product object is an **Agent environment**: one installed
compatibility set containing:

- one exact Suite release;
- exact Provider and runtime artifacts with hashes and licenses;
- the selected profile;
- the profile's installed component set and its separately declared
  Agent-visible component set;
- explicit host adapters installed through supported host interfaces;
- private current-host configuration and service state; and
- optional, separately consented observation components.

The compatibility set states which bytes are intended to work together. It
does not establish Provider value, universal compatibility, live availability,
or business acceptance.

Within an environment, Agent Host manages **Provider Instances**, not
Capability meaning. A Provider implementation may be an independently released
product, a Host-owned package, or an explicitly bounded service. Its Instance
is the exact installed or configured realization with a package root or
endpoint, account or credential reference, grants, bindings, and current
health. Capability Profiles remain in their standards source. Agent Host
projects each admitted Instance into the Provider-specific Tools and thin
Skills supported by the selected Agent app.

A Provider-specific local Instance may seal non-secret configuration beside
its runtime as an identity file. Agent Host manages the exact archive,
activation, catalog health, and removal. It does not interpret the Instance
schema, retrieve a credential, prove privacy authorization, or assess model
quality. Replacing configuration requires a newly built and previewed archive.

## Ownership boundary

- Host-independent Capability and Procedure standards own normative semantic
  contracts.
- Independently useful Provider products own their source, binaries, domain
  behavior, product Skills, plugins, and releases.
- Host-internal packages own execution, transport, instance, observation, and
  routing-support implementation behind explicit contracts.
- `packages/direct-execution-runtime` owns bounded Host execution mechanics.
- Agent Host owns artifact acquisition, hash verification, installation,
  official host integration, local service lifecycle, profiles, update,
  rollback, removal, a small human status surface, and one bounded product
  operations Skill for external Agents.
- Agent apps remain independently updated hosts. Agent Host never patches their
  binaries or private implementation files.

Agent Host never exposes a model-facing generic Provider invocation tool.
Direct Runtime receives only already-selected, schema-validated structured
work. Details of that carrier, lifecycle locking, service recovery, process
scope, state, and observation projection belong to
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Profiles and private overlays

Profile membership is defined only by `catalog/profiles/*.json` and the selected
bound release. This document defines profile behavior, not a copied inventory:

- `standard` is the deliberately small default Agent-visible set plus the
  required Host runtime.
- `observability` extends standard with opt-in local observation and analysis.
  Those components remain backstage and add no tools or MCP processes to an
  ordinary Agent session. Consent remains off until the user selects the
  Manager action or equivalent explicit CLI action.
- `local-dogfood` extends the consented environment with a wider development
  inventory. It is a local feedback configuration, not a public marketplace;
  every component retains its Provider identity, integration record, and Skill.
- `developer` installs the Agent Tool Development Kit as an immutable backstage
  component. It starts with a zero-tool Agent catalog and projects only the thin
  development Skill and version-locked launcher. It requires a bound release
  and rejects mutable development-root installation.

Evaluation helpers are development and CI tooling, not an installable profile
or an ordinary Agent catalog. They do not need standalone product repositories
merely because they exercise typed boundaries.

Installed inventory and active Agent-visible tools are separate. An inactive
Provider may retain an immutable Skill and direct launcher without contributing
MCP schemas to the current Agent catalog. Working-set changes retain rollback
bytes and displaced user entries and require a fresh Agent task before current
discovery can be assessed.

An environment may also carry a small owner-selected set of private Agent tools
outside the release profile. This is a local overlay, not another profile,
registry, marketplace, or Agent-facing import route. The human CLI accepts only
self-contained sealed component archives through the closed tool-integration
contract, previews exact artifact and live catalog facts before import, defaults
the tool to inactive, and retains one component-level rollback. Optional path
grants are explicit, component-specific, and never supplied by Agent input.
Exact versions and fields belong to
[`TOOL_INTEGRATION.md`](TOOL_INTEGRATION.md) and the corresponding schemas.

## Core flows

1. **Setup and changes.** Setup, update, rollback, monitoring changes, host
   connection changes, active-set changes, private-component changes, cleanup,
   and uninstall preflight the complete target before mutation and share the
   Host lifecycle boundary. They preserve user-owned host entries and either
   commit the new state or disclose bounded partial effects.
2. **Host connection.** Host adapters use only public marketplace, plugin, MCP,
   Skill, or extension mechanisms. Conflicts fail closed; deliberate
   replacement remains recoverable.
3. **Direct execution.** Direct Runtime runs already-selected typed work below
   the model and bounds Provider residency. It is not an Agent-visible router.
4. **Health.** Local deep doctor reacquires installed package, service, live
   contract, semantic-probe, and catalog-budget facts without needing to launch
   Agent apps. Full Check is the separate explicit binding-verification route.
5. **Release lifecycle.** Update retains one complete, byte-verifiable prior
   compatibility release; rollback revalidates and restores it. Release and
   platform qualification are governed by [`RELEASE.md`](RELEASE.md).
6. **Storage and removal.** Inventory separates the Manager from private state
   and distinguishes active, rollback, observation, download, and cleanup
   classes. Cleanup removes only verified unreferenced Suite-owned bytes.
   Uninstall removes only Suite-created host entries; destructive data removal
   remains explicit.
7. **Operations view.** `snapshot` provides the bounded default environment
   view for the operations Skill; `usage` provides a separate bounded Usage &
   Reliability result. Both preserve source, freshness, coverage, truncation,
   Provider-specific semantics, and unknowns.
8. **Catalog projection.** `catalog` exports only configured Capability and
   Procedure bindings plus complete live schemas from active native Tools. It
   is an exact point-in-time projection, not discovery, ranking, readiness,
   semantic equivalence, or a Provider registry.
9. **Observation.** Automatic record adapters are read-only. Telemetry and hook
   adapters require an explicit user-owned configuration action. Passive
   storage is metadata-only; content export requires a second confirmation and
   never enters Observer storage. See [`TRACE_PLANE.md`](TRACE_PLANE.md).

An observation controls only what it directly reports. Offered tools,
historical calls, or installed Skills do not establish current-session Skill
activation, non-use reason, semantic effect, result adoption, correctness,
task quality, opportunity, or value. Those remain unknown unless a separate
current assessment or controlled task establishes them.

## Human surface

The Agent Host Manager is a backstage management surface organized around four
durable objects:

- **Environment** — readiness, profile, version, background service,
  monitoring, check, repair, rollback, and removal;
- **Tools** — installed version, current health, Agent-app availability, and
  Suite-owned versus preserved user configuration;
- **Agent Apps** — detected supported apps, connected state, health, and
  explicit connect or disconnect actions; and
- **Activity** — bounded local lifecycle history translated into product names
  and human labels rather than raw state-field identifiers.

Before installation, the same app presents one setup path: selected standard
tools, detected Agent app, preflight review, then installation. Recoverable
errors use product language and one next action; raw paths and protocol detail
remain outside the primary interface.

The Manager refreshes stale in-memory state on foreground return and shows when
visible status was last checked. Automatic refresh does not launch Agent apps;
mutations remain disabled while current local state is being reacquired. Full
Check is the explicit current Agent-app binding route.

The primary interface does not show MCP schemas, Agent reasoning, Capability
catalogs, protocol metadata, prompts, or marketing explanations. Usage &
Reliability preserves unavailable and partial coverage and never derives a
non-use reason, correctness, adoption, quality, opportunity, or value.

Canonical product language and its stable-identifier boundary are defined in
[`TERMINOLOGY.md`](TERMINOLOGY.md).

## Validation and completion claims

No prose statement in this document establishes that a release or installation
is current, healthy, complete, or accepted. Reacquire the relevant facts and
report these lanes separately:

- development regression;
- immutable package and installed Agent flow;
- Direct Runtime behavior;
- human Manager runtime;
- platform distribution; and
- owner business and experience acceptance.

The local installed route and its fresh-session adoption limit are defined in
[`LOCAL_DOGFOOD.md`](LOCAL_DOGFOOD.md). The minimum high-risk review seams are
defined in [`REVIEW_CONTRACT.md`](REVIEW_CONTRACT.md); that contract is a review
floor, not a completion runway. CI or cross-compilation cannot establish
physical-device runtime or owner acceptance.
