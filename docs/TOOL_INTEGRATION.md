# Agent Host tool integration v0.1 and v0.2

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
`schemas/agent-host-tool-integration.schema.v0.2.json` and declares only:

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

Ratings, screenshots, categories for discovery, payment, reviews, featured
placement, and speculative host adapters are deliberately absent.

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
the same canonical, explicitly configured workspace root.

The projection is not another provider release and cannot replace package
verification. Host inspection fingerprints the projection separately, while
deep doctor starts the package command. This avoids copying provider runtimes
into Codex's plugin cache and fails closed when a workspace-dependent tool has
no explicit grant.

## Current profile

`local-dogfood` composes the Standard set with the locally admitted tools. It
exists so this Mac can exercise stranger-equivalent installed bytes while
Agents retain normal access to every authorized `tools-dev` repository.
Changing source does not change an installed tool until a new immutable
compatibility set is built and activated.

Profile schema v0.2 separates `components` from `agentComponents`. The first
list owns immutable installation and rollback bytes; the second is the subset
connected to Agent apps and measured as the active catalog. Backstage Observer,
Analyzer, runtime, and Node components can therefore remain installed without
creating Agent-facing tools or one MCP process per fresh session. A profile
cannot activate a component it does not also install.

After installation, `agent-host tools set` may select a smaller active subset
from that immutable inventory and `agent-host tools reset` restores the profile
default. Inactive packages remain available for fast reactivation and rollback.
Agent Host suspends its managed host bindings without restoring a displaced
source-checkout plugin; only profile removal, host disconnect, or uninstall
restores the preserved user-owned entry.
