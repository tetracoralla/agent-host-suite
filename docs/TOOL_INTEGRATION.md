# Agent Host tool integration v0.1-v0.5

This local contract admits one already-real Agent tool into an immutable Agent
Host compatibility set. It is not a marketplace listing, ranking system, or
universal plugin standard.

## Required claims

Each compatibility set is closed over the exact macOS runtimes it needs and is
bound by version, platform, byte length, SHA-256, license files, notices, SBOM,
entrypoints, and identity files. A component either carries its own executable
or declares the verified Suite Node executor. It never resolves `node` or
another executable from the developer's shell at use time.

The component descriptor's `integration` value validates against
`schemas/agent-host-tool-integration.schema.v0.1.json` or
`schemas/agent-host-tool-integration.schema.v0.2.json`; v0.3 adds the closed
discovery record in
`schemas/agent-host-tool-integration.schema.v0.3.json`, and v0.4 adds one closed
Direct Capability binding in
`schemas/agent-host-tool-integration.schema.v0.4.json`. v0.5 adds bounded,
component-declared optional path environments in
`schemas/agent-host-tool-integration.schema.v0.5.json`. The versions declare
independent closed shapes rather than cumulative feature flags: v0.5 extends
the v0.2 execution shape with optional path environments and does not also
accept v0.3 `discovery` or v0.4 `directCapability`. They declare only:

- the tool's human name and one task-oriented summary;
- the contained Codex marketplace and plugin roots;
- the exact MCP stdio command, arguments, working directory, expected tool
  names, and health timeout;
- in v0.2, an executor fixed to `component` or `suite-node`. `component` starts
  the contained executable. `suite-node` treats `runtime.command` as a
  contained JavaScript entrypoint and starts it with the release's one verified
  Node component;
- optional workspace environment variable names whose value comes from an
  explicit user grant. A capable Agent app may supply it directly; Codex uses
  the Suite-owned thin host projection bound by `--workspace-root`. The tool
  never guesses a root from source paths or model input;
- uninstall ownership fixed to `agent-host-created-only`.

In v0.5, `runtime.optionalPathEnvironment` declares environment variable names
that may receive one or more absolute directories explicitly selected by the
human at preview, import, or rollback time with repeated
`--path-grant NAME=PATH` values. The Host resolves and persists those
component-specific roots, rejects names the component did not declare, and
joins repeated roots with the platform path separator. A retained grant is
revalidated before rollback and before its component enters an active Agent
app transition, so a deleted or non-directory root fails closed. Optional grants are not
copied from the workspace root, inferred from the machine, or exposed as
Agent-call arguments. Omitting one leaves that provider lane ungranted;
`workspaceEnvironment` retains its existing single canonical workspace
semantics. Component status remains path-free and does not disclose granted
directory names; changing a grant remains an explicit preview, import, or
rollback input rather than an ambient state-derived action.

In v0.3, `discovery.kind: skill-cli` additionally binds one product Skill and
one direct CLI inside the same immutable component. Its Skill root must be the
declared Codex plugin's `skills/<id>` directory, its identity includes
`SKILL.md`, and its launcher path must be absent from provider bytes because
Agent Host owns and generates that forwarding script. The CLI again uses only
the component executable or verified Suite Node and declares exact version
arguments. This is a low-context route to an already-installed Provider, not a
generic provider invocation tool, a ranking, or permission to execute source.

In v0.4, `directCapability` binds one Provider Manifest v0.3, one canonical
Capability Profile, exact operation schemas, the contained adapter command,
its execution identity, lifecycle, and optional `host-required` workspace
authority. Agent Host resolves every path inside verified component bytes and
injects only the canonical workspace selected at Host setup. The Direct
Runtime binding stays available while the component is installed even when
its MCP surface is outside the active Agent catalog. It is neither semantic
discovery nor a fallback from a missing Provider adapter.

The separate backstage Developer Kit component uses
`schemas/agent-host-developer-kit-integration.schema.v0.1.json`. That closed
record binds one `suite-node` CLI entrypoint and version argv, one Skill-only
Codex marketplace/plugin identity, one product Skill root and generated
launcher location, and the same Host-created-only ownership. It cannot declare
MCP tools, workspace grants, provider invocation, Capability or Procedure
semantics, or publication state.

Ratings, screenshots, categories for discovery, payment, reviews, featured
placement, and speculative host adapters are deliberately absent.

## Execution-path boundary

Discovery is not an execution transport. The v0.3 Skill tells an Agent when a
Provider applies; its direct launcher is the low-frequency cold path when the
full MCP surface is intentionally inactive. Repeated independent exact ids
should use the provider's bounded batch command. Repeated interactive calls
should activate the provider's MCP surface so the Agent app can retain a warm
stdio session.

Direct Execution Runtime remains the fast conveyor for already-selected,
closed typed work orders whose Provider has a real Direct Runtime adapter. It
owns persistent sessions, deadlines, cancellation, queueing, and recovery for
that contract. It is not a natural-language discovery layer and does not expose
a generic model-facing `invoke provider` tool. Adding such a route would move
schemas, routing ambiguity, and permission decisions into one privileged
interface instead of reducing them.

Across current Provider products these paths may coexist as separately declared
carriers:

- Skill + direct CLI: discoverable, version-locked cold fallback with zero MCP
  catalog bytes;
- active MCP: model-visible typed operations and a warm session when ordinary
  Agent interaction justifies the schema cost;
- Direct Runtime: high-throughput execution only after a concrete typed adapter
  and work-order boundary exist.

One integration descriptor still selects one closed schema shape. In
particular, v0.5 optional path environments cannot currently be combined in the
same component descriptor with v0.3 Skill discovery or v0.4 Direct Capability;
a real combined consumer is required before that public contract is expanded.

For a v0.4 Provider, deactivating MCP removes model-visible tool schemas but
does not remove its installed Direct Capability binding. Removing or replacing
the immutable component updates both paths together.

## Admission

An integration is admitted only when the release builder and installed probe
confirm all of the following from unpacked immutable bytes:

1. no links, special files, source-checkout paths, or unbound absolute runtime
   commands occur in the component;
2. every expected MCP tool is present and advertises both `inputSchema` and
   `outputSchema`;
3. the real stdio server starts within its declared cold-start window;
4. Codex can install the contained marketplace without adopting unrelated
   user-owned entries;
5. update and uninstall record and restore only the entries they displaced.

Tool success is not task success. Product-specific Skills keep the remaining
judgment and routing method; Agent Host owns only installation, compatibility,
health, recovery, and removal.

## Owner-selected private import

`agent-host component preview` and `agent-host component import` apply this
same admission contract to one explicit local artifact. They do not infer that
a Skill should become a tool and do not create a component. That semantic and
engineering work belongs to the user's Agent and the provider build that emits
the sealed archive.

Preview persists no Agent Host state. It does start the explicitly selected
component to reacquire its typed MCP catalog; dry-run does not establish or
contain effects outside Agent Host state. Preview rejects a directory,
relative artifact path, link, special file, unsafe archive path, non-`agent-tool` descriptor,
unsupported or incomplete integration, inventory above the declared local
bounds, file or descriptor digest mismatch, and an MCP catalog without closed
input and output schemas. The returned binding contains archive SHA-256 and
bytes, descriptor SHA-256, component id and version, current platform, and the
owner-supplied SPDX expression. Import accepts that exact binding from an
absolute JSON file and fails if any fact changed. Agent Host records that
expression but does not establish ownership, license compatibility, or
redistribution rights.

Developer tooling may call `component preview --standalone` before an Agent
environment exists. That route uses the Node runtime executing the current
Agent Host CLI only for a temporary `suite-node` health start, materializes the
selected archive under a temporary package root, and reads or writes no Agent
Host state or Agent-app configuration. It establishes the same archive,
descriptor, integration, and live catalog observations as ordinary preview;
it does not establish compatibility with a separately installed Agent Host
release, installation, activation, semantic correctness, or absence of effects
outside the selected component process. `--standalone` and `--state-root` are
mutually exclusive.

An owner may select a private component that is itself one configured Provider
Instance. Its provider-specific Instance JSON must be contained in the sealed
inventory and identity files, while credentials remain external references.
Agent Host binds and health-probes the complete archive; it does not interpret
Provider-specific fields, prove current privacy authority, or turn `tools/list`
health into model-quality acceptance. Changing the Instance requires a new
archive and ordinary preview/import binding. A consumer-specific development
example does not become part of this durable integration contract; the user may
author semantic plans with any Agent or harness outside Agent Host.

Import dry-run reports the proposed component version with `installed: false`,
`active: false`, and no import timestamp or rollback record. Planned activation
details remain in the dry-run transition; they are not reported as current
installed state.

An imported tool is inactive by default. `--activate` opts into the existing
Codex projection and ownership flow; `tools set` can change availability later.
`--replace` retains the current imported component as the one component-level
rollback target. `component remove` removes the Suite-owned binding but keeps
the sealed package for `component rollback`. Storage cleanup treats current
and private rollback packages as referenced. No private import command is
exposed by the Agent Host operations Skill or an MCP server.

The `suite-node` executor exists only in the Agent Host compatibility artifact.
It does not change a provider's standalone plugin or source release: those
remain independently runnable and self-contained according to their own
release contract.

## Codex thin projection

Agent Host keeps provider runtimes once in immutable package storage. For
Codex it materializes a private, content-addressed projection containing only
the marketplace record, plugin manifest, Skill resources, small interface
assets, and a generated MCP configuration. That MCP configuration points its
absolute command and working directory back to the verified package. When a
tool declares workspace environment variables, every declared variable gets
the same canonical, explicitly configured workspace root. A v0.5 component's
optional path environments instead receive only their separately approved,
component-specific roots.

The projection is not another provider release and cannot replace package
verification. Host inspection fingerprints the projection separately, while
deep doctor starts the package command. This avoids copying provider runtimes
into Codex's plugin cache and fails closed when a workspace-dependent tool has
no explicit grant.

For a Skill-only Developer Kit component, the projection copies the same small
marketplace, plugin, Skill, and asset surfaces but writes no `.mcp.json`. It
adds one executable launcher inside the projected Skill that forwards argv to
the exact installed Suite Node and bundled CLI entrypoint. Claude uses the same
version-locked launch shape in its separately owned immutable Skill projection.

For a v0.3 tool, the product Skill and generated direct launcher stay in the
Codex projection even when its MCP surface is inactive. The projected plugin
manifest omits `mcpServers` and no `.mcp.json` is written in that state. When
the tool is active, the same Skill and launcher coexist with the generated MCP
configuration. Active and Skill-only projections have distinct content
addresses, and only the active subset contributes its full schemas to catalog
preflight.

Claude receives the same immutable product Skill through a Host-owned link to
a content-addressed private projection. It has no added MCP entry for a v0.3
tool; active MCP management remains limited to Claude integrations the Host
explicitly supports. Conflict replacement and uninstall preserve or restore a
displaced user-owned Skill instead of deleting it.

## Local dogfood profile

`local-dogfood` composes the Standard set with the locally admitted tools. It
exists so a development Mac can exercise stranger-equivalent installed bytes
while Agents retain normal access to every authorized `tools-dev` repository.
Changing source does not change an installed tool until a new immutable
compatibility set is built and activated.

The same profile installs the Agent Tool Development Kit as a backstage
component. Codex, ZCode, and Claude receive its thin development Skill and exact
launcher, but the Kit does not enter `agentComponents` or add an MCP schema to
ordinary task context.

Profile schema v0.2 separates `components`, `agentComponents`, and the optional
`defaultAgentComponents`. The first owns immutable installation and rollback
bytes, the second is the complete activatable inventory, and the third is the
smaller set bound on setup or an explicit profile change. Backstage Observer,
Analyzer, runtime, and Node components can therefore remain installed without
creating Agent-facing tools or one MCP process per fresh session. A profile
cannot activate a component it does not also install.

Local setup binds the profile's declared `defaultAgentComponents`; the profile
file, rather than this document, owns that exact list. After installation,
`agent-host tools set` may select any explicit non-empty subset from the
immutable inventory and `agent-host tools reset` restores the declared profile
default. Inactive packages remain available for fast reactivation and rollback.
Agent Host suspends its managed host bindings without restoring a displaced
source-checkout plugin; only profile removal, host disconnect, or uninstall
restores the preserved user-owned entry.
