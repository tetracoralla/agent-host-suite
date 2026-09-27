# Product model

This document defines the durable user, product object, ownership boundary,
profiles, and human surface. It does not record current component counts,
installed versions, machine state, or release acceptance.

## User and task

The intended **external user** is an individual desktop Agent user who wants a
coherent, trustworthy set of Agent capabilities plus reliable local execution
without cloning and configuring many repositories by hand. The default working
set may stay deliberately small, but that is an attention and context choice,
not a ceiling on the kinds of useful capabilities the environment may admit.
That path requires a bound
compatibility release. This source checkout is not that release: it has no
GitHub Release assets in-tree, no Apple-notarized DMG, and no tool marketplace.
Unsigned preview download is documented in [`UNSIGNED_PREVIEW.md`](UNSIGNED_PREVIEW.md).

**tools-dev dogfood** is a separate audience. Developers with authorized source
checkouts use [`LOCAL_DOGFOOD.md`](LOCAL_DOGFOOD.md) so installed execution
matches a stranger's package bytes while they still edit those repositories.
`local-dogfood` remains a local feedback profile, not a store.

Provider developers, Procedure developers and environment users are distinct
roles even when one person sometimes holds more than one:

- A **Provider developer** owns an implementation such as a program, tool or
  model-backed service. Its internals may be opaque to Host, but its admitted
  entrypoint, Capability contracts, effects, configuration and version identity
  are explicit.
- A **Procedure developer** (or that developer's Agent) authors, validates,
  tests and packages a reusable Procedure product against declared Capability
  requirements. This is development work, not per-task consumer setup.
- A **user's Agent** selects an installed Procedure, derives its inputs from the
  user's task, invokes it and evaluates the declared outputs. It does not rebuild
  the Procedure's internal plan on every use.
- The **human user** manages which Provider and Procedure products are installed,
  available and healthy. They do not operate routine Run state, stage transitions,
  bindings or logs.

The `featured` profile is the external-user admission list: an owner-selected
subset of independently released tools installed through the existing setup,
`profiles list`, `update --profile featured`, and private-import APIs. Browser
and native Managers use those same APIs to choose featured at setup and to Get
uninstalled featured tools. `tools set --profile` only enables the working set
of already-installed tools. It is not `local-dogfood` and not a store. See
[`FEATURED_CATALOG.md`](FEATURED_CATALOG.md).
Host working-set selection is not current-session discovery; see
[`DISCOVERY_PROJECTION.md`](DISCOVERY_PROJECTION.md).

The user chooses an installed profile and a smaller active tool set, reviews
the requested Agent-app and background-service changes, installs one Agent
environment, checks current health, updates or rolls back a bound compatibility
release, and can remove everything Agent Host created.

Making a capability available is an offer, not an endorsement or an obligation
to use it. The user and their Agent may activate, ignore, challenge, replace, or
remove it without first accepting Agent Host's interpretation of its value.

The Windows Manager and native macOS Manager present English and Simplified
Chinese, follow the operating-system language by default, and keep the explicit
override in their secondary Settings surface. Platform-specific carrier and
release claims remain in the platform and release documents.

## Product object

### Optional task coordination

An installed Procedure is a developer-produced, validated and versioned product.
Every Procedure package has one common identity, input schema, output schema,
permission declaration and lifecycle declaration. Its execution binding then
selects either `direct-runtime` for a synchronous structured call or
`agentic-runner` for a stateful Method/Run. These are two execution kinds of one
installed product model, not two independent catalogs that happen to share a
name.

Host's immutable installed component state is the catalog authority. At use
time, the person's Agent selects an exact installed `id` and `version`, maps the
person's task into its declared inputs, invokes it through the Host Procedure
interface, and consumes only the declared outputs. Agentic products are loaded
from that installed state into the
[Procedure Runner](../packages/procedure-runtime/README.md); the Runner does not
quietly inject consumer-visible built-in products. Neither the person nor that
Agent assembles a new workflow for the Run. The consumer API is read-only for
Procedure definitions.

The Runner is headless and the user's Agent is its consumer. `procedure list`
provides searchable, paged, byte-budgeted summaries without embedding every
input/output schema. `procedure describe ID VERSION` returns the one exact full
contract. `procedure invoke --request` accepts that same exact identity inside a
versioned Run Request; `procedure status` and `procedure continue` preserve the
durable read/continue boundary. If a Run needs a
human decision or permission, the Agent mediates that through the Agent app's
existing conversation or native permission surface. Agent Host Manager does not
become a Run console: it shows installed Procedure products and whether they are
available to Agents, not stages, logs, provider bindings, checks or internal
state. A workspace is an adapter selected by the Procedure product, not an
assumed Git checkout.

An agentic Method uses the closed, versioned `openadam.method-graph.v2` source
model. Nodes can be Agent turns, Direct Capability calls, exact-version
subprocedure calls, human input/checkpoints, deterministic conditions or
deterministic transforms. Every edge, consumed/produced artifact, permission and
resource reference is explicit. Unknown fields are rejected so a future Studio
cannot silently discard source it does not understand. `parallel` and `wait` are
declared extension points with `supported: false`; they are not claimed as
implemented execution behavior.

Authority has four separate layers. A product permission declaration states
what the product may need. Installed state records a distinct permission ceiling
(initially the admitted declaration). Each Run Request supplies the smaller
grant set actually authorized for that task and binds required workspace, file
or account resources. Because the current Direct Runtime work-order has no
per-node permission or resource carrier, a Direct Procedure must receive every
declared permission as an explicit Run grant and cannot yet declare resources;
admission rejects an unusable contract instead of deferring the failure until
invocation. An agentic graph can require only the permissions and resources on
the nodes actually reached. A Provider callback may ask for a one-time decision
while a node runs, but it is automatically refused unless both the Run and that
node already contain its required grant. A declaration or callback never
enlarges task authority.

Procedure authoring belongs to a separate developer-facing **Procedure Studio**.
Its primary representation is graphical structure and contract relationships,
with direct manipulation for stages, Capability requirements, typed inputs and
outputs, conditions, permissions and composition. Validation, test Runs and
package/export are part of that developer flow. Source text and diagnostics are
secondary inspectable detail, not long forms or explanatory prose that the
developer must read before acting. An authoring Agent may create or revise the
same source model, but the Studio remains a first-class product for inspection,
debugging and deliberate editing.

The Git development-and-review profile owns its stronger candidate, independent
review, staging and commit rules. A no-workspace research-brief method provides
a structurally different Agent flow with a question/continuation branch. A
workspace composition reference crosses an Agent turn, a Direct Capability and
an exact subprocedure under explicit grants and resource bindings. These prove
the local model is not defined by the development profile; they do not by
themselves qualify real provider behavior or every future domain.
Concrete task coordination owns local run state, permissions and recovery;
portable Procedure semantics and conformance remain in the standards repository.

Procedure availability is never one inferred green flag. Host separately
reports installed/contract-validated/discoverable state, the timestamp of the
last successful invocation, whether that invocation evidence still matches the
current product/runtime/binding fingerprints, current health, and current Agent
session discovery. Product, runtime or binding changes invalidate only the
current evidence while retaining the historical success time. Current-session
discovery remains `not-observed` until that session is actually observed; no
Host projection claims that an already-open Agent session loaded new bytes or
that a Procedure result is fit for the user's task.

### Environment

Agent Host is a distribution and local operations product. The Agent Host Suite
is this repository's technical distribution unit. Neither is the Agent-Host
architecture itself, and Agent Host is not required for standards adoption.

The Manager client is an optional human control surface, not the ecosystem's
protocol or a task Agent. Its purpose is to make installation, connections,
grants, updates and recovery convenient. The CLI uses the same lifecycle
implementation. Once configured, Agent apps invoke the projected Provider
entrypoints or separately managed execution service without routing each call
through an open Manager window. This does not make the configured runtime or
background services optional for calls that depend on them.

Its durable product object is an **Agent environment**: one installed
compatibility set containing:

- one exact Suite release;
- exact Provider and runtime artifacts with hashes and licenses;
- the selected profile;
- the profile's installed component set and its separately declared
  Agent-visible component set;
- exact installed Procedure products with their common identity, input/output
  schemas, permissions, lifecycle and one explicit execution binding;
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
- Independently useful Procedure products own their source, tested method,
  declared Capability requirements, schemas, package identity and releases.
- Host-internal packages own execution, transport, instance, observation, and
  routing-support implementation behind explicit contracts.
- `packages/direct-execution-runtime` owns bounded Host execution mechanics.
- Agent Host owns artifact acquisition, hash verification, installation,
  official host integration, local service lifecycle, profiles, update,
  rollback, removal, optional passive observation and explicit task-activity
  export, Provider/Procedure availability in its small human management surface,
  and one bounded product
  operations Skill for external Agents.
- Agent apps remain independently updated hosts. Agent Host never patches their
  binaries or private implementation files.

Agent-facing domain calls retain Provider identity and typed meaning. Current
integrations do not expose a generic opaque Provider invocation tool.
Direct Runtime receives only already-selected, schema-validated structured
work; ordinary native MCP calls do not have to pass through it. Details of
those routes, lifecycle locking, service recovery, process
scope, state, and observation projection belong to
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Stable responsibilities, evolving integrations

The strategic aim is to make useful Provider capabilities cheaper to adopt and
keep using as Agent apps, models and implementations change. It is not to make
every participant adopt today's desktop client, tool-call loop, transport or
execution engine. The current local desktop product is one delivery path, not
a claim that every future consumer must look like it.

The narrow waist concerns **mandatory shared meaning**, not the breadth of
useful products. Capability contracts can preserve the meaning, version,
inputs, outputs and failures of an operation where implementations genuinely
share them. Host preserves the selected implementation's identity, explicit
authority, configuration and lifecycle; it must not silently change semantics
to make an adapter appear compatible. Provider-native features can remain
native. Procedure contracts apply to settled reusable methods, not to every
Agent's planning or private working state. None of these standards requires
the Manager or this Suite as its universal intermediary.

Compatibility is a continuing engineering responsibility, not a promise of no
future development:

- A model change behind an unchanged supported Agent interface may require no
  Host change; verify the affected interface rather than inferring compatibility
  from the model's name or architecture.
- A changed harness or Provider transport belongs in its adapter when the
  existing meaning and authority can be preserved. It does not automatically
  require changing every Provider or the semantic standards.
- A genuinely new kind of work may need new semantics, lifecycle or authority.
  Establish it with a concrete consumer and executable cases, then add a
  versioned contract or a separate binding. Do not disguise missing behavior
  as a successful legacy call, or add speculative universal fields now.

World models, multimodal agents and large Agent groups are possible consumers,
not reasons to predefine their memory, scheduling, continuous state or
coordination in today's mandatory ABI. Current synchronous structured calls
and the Direct Runtime's read-only, idempotent, closed-world admission scope
remain actual supported limits, not permanent limits on the whole ecosystem.
Broadening a safety boundary requires its own implementation and verification;
this direction does not relax the current checks.

A new integration earns a shared abstraction when real task evidence shows
preserved meaning and lower adoption or maintenance cost across distinct
implementations. An adapter name, common JSON envelope or growing catalog
alone does not establish interoperability. The test is whether useful Provider
work survives a change of consumer or implementation without rewriting its
domain behavior or forcing every participant into one Host-specific product
template. Widespread ecosystem adoption remains an outcome to earn, not a
property this architecture can declare.

## Profiles and private overlays

Profile membership is defined only by `catalog/profiles/*.json` and the selected
bound release. This document defines profile behavior, not a copied inventory:

- `standard` is the deliberately small default Agent-visible set plus the
  required Host runtime.
- `featured` extends standard with the independently released tools admitted
  for external users (currently Armorial). Membership is the profile file, not
  `local-dogfood`. It requires a bound compatibility release and rejects
  development-root installation.
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
MCP schemas to the current Agent catalog (`on-demand`). Without that declared
CLI Skill it is `inactive`: enable its MCP entrypoints before opening a new
Agent task. Status and both Managers derive that distinction from the installed
component, never from the toggle alone. `tools pause` fully
pauses ordinary tools: new tasks get neither MCP nor those Skills, while a
Developer Kit Skill, if installed, remains. `tools resume` restores the
previous working set. Pause, host connect/disconnect, monitoring consent, and
failed working-set recovery do not overwrite each other.

Monitoring consent is independent of profile inventory. Turning local
monitoring off keeps installed tools, versions, Agent connections, documents,
and history; turning it back on does not require switching profile or
reinstalling unrelated tools. A profile is the initial recipe, not a permanent
constraint on those dimensions.

Working-set changes retain rollback bytes and displaced user entries and
require a fresh Agent task before current discovery can be assessed.

An environment may also carry a small owner-selected set of private Provider
and Procedure products
outside the release profile. This is a local overlay, not another profile,
registry, marketplace, or Agent-facing import route. The human CLI accepts only
self-contained sealed component archives through closed integration contracts,
previews exact artifact facts before import, and retains one component-level
rollback. Provider activation remains a separate working-set choice. Procedure
products are admitted with their common product envelope and exact execution
binding, then appear in the Agent-readable Procedure catalog; they are
not placed in the Provider tool toggle. Optional path grants are explicit,
component-specific, and never supplied by Agent input. Exact fields belong to
[`TOOL_INTEGRATION.md`](TOOL_INTEGRATION.md) and the corresponding Provider and
Procedure integration schemas.

## Core flows

1. **Setup and changes.** Setup, update, rollback, monitoring changes, host
   connection changes, active-set changes, private-component changes, cleanup,
   and uninstall preflight the complete target before mutation and share the
   Host lifecycle boundary. They preserve user-owned host entries and either
   commit the new state or disclose bounded partial effects.
2. **Host connection.** Host adapters use only each Agent app's public
   marketplace, plugin, MCP, Skill, or extension APIs. That is not an Agent
   Host store or public plugin marketplace. Conflicts fail closed; deliberate
   replacement remains recoverable. A recorded Host working set or
   `enabled: true` registration is not proof that an open session loaded the
   current Skill path or MCP catalog.
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
   never enters Observer storage. A user can explicitly export one bounded,
   pseudonymous task session with direct calls kept distinct from static nested
   references. See [`TRACE_PLANE.md`](TRACE_PLANE.md).

An observation controls only what it directly reports. Offered tools,
historical calls, or installed Skills do not establish current-session Skill
activation, non-use reason, semantic effect, result adoption, correctness,
task quality, opportunity, or value. Those remain unknown unless a separate
current assessment or controlled task establishes them. A user or their Agent
may interpret an explicitly selected export, combine it with task-native work,
or ignore it. Provider-reported rationale presence and stable completion
reasons may be retained when available, but remain source-reported context—not
Host judgments and not required setup.

## Human surface

The Agent Host Manager is a backstage environment-management surface. It is for
the person using Agents, not for Procedure authors and not for operating Runs.
Primary navigation follows what is already on this machine:

- **Library** — installed Provider and Procedure products and whether new Agent
  tasks can use them; Provider working-set controls apply only where relevant;
- **Browse** — the compatible catalog and a GitHub compatibility preview; and
- **Agents** — detected apps, connection, health, and repair.

History and Usage appear only after an environment exists. Versions, catalog
source, monitoring, the installed profile, rollback, and removal stay in
Settings. Those are environment operations, not a second home screen and not
a reason to open an Agent app.

Before installation, the same app opens on an honest empty local inventory and
puts compatible recommendations below it. Installation still receives a
preflight review. After installation, local tools occupy that first section;
recommendations move below them. **Agents** exposes connection and repair
without mixing Agent shells into the tool catalog, and keeps a start-work
handoff with one next action (and its classified recovery path on demand) when
something blocks new work. Changing the tool set says plainly that already-open
tasks keep their old tools. Host confirms only what it
can observe and does not pretend an already-open task loaded tools. Recoverable
errors use product language and one next action; raw paths and protocol detail
remain outside the primary interface.

Product collections use compact, unframed rows with a product mark, name, short
purpose, and one availability or attention indicator. Provider and Procedure
products are visibly distinct without exposing their internal contracts.
Versions, configuration, source and diagnostics belong in detail or recovery
views. Returning preserves the search, position and keyboard focus. Normal
states do not repeat their icon as a caption or legend. Consequential differences
(such as pausing on-demand Providers when the last active Provider is turned
off) remain explicit at the action. Agent connections use aligned rows,
lifecycle changes use a chronology, and usage uses data sections rather than a
universal card layout.

The Manager refreshes stale in-memory state on foreground return and shows when
visible status was last checked. Automatic refresh does not launch Agent apps;
mutations remain disabled while current local state is being reacquired. Full
Check is the explicit current Agent-app binding route.

**Library** is the default destination. It shows products installed on this
machine first, with separate Provider and Procedure sections and a compact empty
state when neither exists. Compatible recommendations follow that local
inventory; a person can search or open **Browse** for the available catalog.

The primary interface uses recognizable product identity, a short job label,
current availability, and one useful environment action when install, connect,
enable, repair, or resume is still needed. A ready product does not offer a
try-in-a-new-task action. Manager does not provide Procedure authoring or Run
controls. It does not show MCP schemas, Procedure graphs, Agent reasoning,
Capability catalogs, protocol metadata, or long marketing explanations. Usage &
Reliability shows recent task activity through direct calls, errors, and static
references before offering a detail export. It preserves unavailable and
partial coverage and never derives a non-use reason, correctness, adoption,
quality, opportunity, or value.

Public-release and private-contributor participation paths, including who owns
each decision, are defined in [`ECOSYSTEM_PATHS.md`](ECOSYSTEM_PATHS.md).

Canonical product language and its stable-identifier boundary are defined in
[`TERMINOLOGY.md`](TERMINOLOGY.md).

## Validation and completion claims

No prose statement in this document establishes that a release or installation
is current, healthy, complete, or accepted. Reacquire the facts needed by the
task and keep these kinds of evidence distinct when they affect the claim:

- development regression;
- immutable package and installed Agent flow;
- Direct Runtime behavior;
- human Manager runtime;
- platform distribution; and
- owner business and experience acceptance.

These categories are not a mandatory reporting template or work queue. The
local installed route and its fresh-session observation limit are defined in
[`LOCAL_DOGFOOD.md`](LOCAL_DOGFOOD.md). Optional unnamed page situations, when
a machine has Host plus Agent, are in
[`ADOPTION_ACCEPTANCE.md`](ADOPTION_ACCEPTANCE.md); Host status remains context,
not a verdict. Select affected risks and evidence using
[`REVIEW_CONTRACT.md`](REVIEW_CONTRACT.md). CI or cross-compilation cannot
establish physical-device runtime or owner acceptance.
