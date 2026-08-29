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
          Codex / Claude    +--- Direct Execution Runtime
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

This projection occurs after selection. Current Codex and Claude public
extension points do not let the suite replace a tool schema dynamically inside
an already-open model turn, so their initial Agent catalog still uses each
Provider's compact advertised schema. Agent Host does not patch the Agent app
to change that limitation.

Agent Host does expose one management Skill, not a domain invocation tool. Its
default launcher calls the packaged `agent-host snapshot --json` interface and
adds no MCP server, provider operation, generic invoke surface, or model call.
Codex carries it as a Suite-managed Skill-only plugin so it does not replace a
user's canonical local Skill source; Claude links to one immutable private
projection. The snapshot has a 16 KiB serialized budget and excludes private
paths, raw Observer records, prompts, arguments, results, and source. Its
assessment boundary is part of the response contract.

See [`TERMINOLOGY.md`](TERMINOLOGY.md) for the product-facing names represented
by these technical layers.

## Independent repositories

The architecture, standards, runtime, providers, observer, analyzer, and suite
retain independent histories and releases. The suite repository stores only:

- schemas for its own manifest and state;
- compatibility and profile declarations;
- host adapter and lifecycle code;
- a small human management app;
- release automation and checks.

Provider source is never vendored. Release archives may contain independently
licensed provider binaries as verified nested artifacts, with their original
licenses, notices, SBOMs, identities, versions, and hashes preserved.

## Two current provider shapes

Math Anchor and Migratory Time keep their specialized Direct Runtime bindings.
Additional Codex tools enter through the closed
`openadam.agent-host-tool-integration.v0.1` or v0.2 record: exact marketplace
and plugin identity, one MCP stdio entrypoint, expected tools, health deadline,
workspace environment variables, and suite-created-only uninstall ownership.
V0.2 additionally distinguishes a contained component executable from a
contained JavaScript entrypoint launched by the release's shared, verified Node
component. A provider may also retain a separate CLI entrypoint for local
maintenance; Agent Host must not overwrite that CLI with its Codex MCP carrier.

This record is an admission seam for current products. It is not a registry,
universal installer, third-party marketplace, or permission to invent future
provider fields without a current consumer.

## Private state

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
active-set reduction removes only Agent Host's managed host binding and keeps
the displaced user entry suspended, so a source-checkout plugin cannot silently
reappear. Removing a component from the installed profile, disconnecting the
Agent app, or uninstalling the environment restores the preserved user entry.

Codex does not currently provide a task root through MCP initialization. The
Suite therefore requires one explicit workspace root when an active tool
declares workspace environment variables. It creates a content-addressed thin
Codex projection containing plugin identity and Skill resources, while every
MCP command and working directory points to the immutable package. Codex may
cache that small projection; it does not cache a second provider runtime.

### Bounded Direct Runtime residency

The Direct Runtime host service remains available, but current Math and Time
provider bindings use the runtime's `per-call` lifecycle. Provider trees start
only for a selected structured request and close before that request finishes.
This trades cold-call latency for bounded idle memory and avoids duplicating
the Agent app's own MCP processes in the background.

Backstage Node utilities and v0.2 `suite-node` Agent integrations use the
suite's single verified Node runtime. They do not embed another Node executable
merely because a standalone provider distribution offers one. This sharing is
an Agent Host packaging property; provider-owned standalone releases remain
independent and self-contained.

The management Skill launcher prefers a published `agent-host` executable and
otherwise resolves the CLI and Node runtime inside `Agent Host.app`. It never
discovers an implementation checkout. Setup, update, rollback, doctor, and
uninstall track its host ownership independently from provider bindings;
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
