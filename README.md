# Agent Host

Agent Host installs and manages one compatible local environment for a small
set of independently released Agent tools. It connects those tools to supported
Agent apps and operates local execution without modifying the Agent apps
themselves.

This repository contains the **Agent Host Suite** distribution unit. The npm
package, CLI, schemas, and other stable technical identifiers retain that name.

The standards and the suite are separate:

- Capability contracts define stable typed operation meaning.
- Procedure contracts define stable multi-stage method when one exists.
- Providers implement those contracts and remain separate products.
- Direct Execution Runtime runs already selected structured work without a
  model relay.
- Agent Host installs compatible artifacts, connects them through each Agent
  app's public extension points, manages the local runtime, and reports the
  current Agent environment.

An Agent vendor can adopt the standards without installing Agent Host. Today,
Agent Host is the practical bridge for Agent apps that do not natively
understand Capability and Procedure contracts.

For broad Providers, the host can keep the public tool identity while selecting
one inner operation. In the current Math Anchor integration, Direct Runtime
uses the provider's declared read-only description route to acquire, project,
and compile only the chosen `math.run` operation after selection, then validates
every `math.batch` item against its own operation contract. This does
not rewrite the initial tool catalog already supplied to a current Codex or
Claude model turn; those Agent apps still receive Math Anchor's compact
advertised schema through their public plugin/MCP interface.

## Current release boundary

The repository is an Apache-2.0 developer preview. The current self-contained
internal macOS Beta binds twelve components—including Node, Direct Execution
Runtime, local monitoring, and eight Agent tools—to immutable archives and
installs them without a `tools-dev` checkout. It is ad-hoc signed for internal
validation. Public binary
distribution remains blocked on Developer ID signing, Apple notarization,
Gatekeeper acceptance, and a full App-driven run on a separate clean Mac.

```text
agent-host setup --profile standard --host codex
agent-host setup --profile local-dogfood --host codex --workspace-root /absolute/workspace
agent-host snapshot
agent-host doctor --deep
agent-host status
agent-host activity
agent-host storage
agent-host cleanup --dry-run
agent-host cleanup
agent-host tools status
agent-host tools set --tool file-vitals
agent-host tools reset
agent-host host add claude
agent-host observability enable
agent-host observability refresh
agent-host update
agent-host rollback
agent-host uninstall
```

Uninstall preserves both Agent Host history and the Observer database by
default. `--purge-data` removes only Agent Host's private state; it never erases a
pre-existing Observer database.

Profiles distinguish immutable components kept on disk from the smaller set of
plugins exposed to each fresh Agent session. Local monitoring remains installed
and runs through Agent Host maintenance, while Observer and Context Surface
Analyzer do not occupy the ordinary Agent tool catalog. Weekly maintenance
keeps the active release plus one byte-verifiable rollback, removes older
suite-owned packages and completed downloads, applies Observer retention, and
compacts its database.

The active tool set can be narrowed without uninstalling packages. Agent Host
keeps displaced user plugins suspended during that temporary reduction, so a
source-checkout route cannot silently replace an inactive managed tool. A fresh
Agent task is required after every binding change.

`agent-host storage` prints the combined Manager App plus private installed
footprint, their split, storage classes including package bytes and thin host
projections, and exact cleanup candidates in ordinary human mode; `--json`
retains the complete machine-readable inventory.

Every connected Agent app also receives the packaged `agent-host-operations`
Skill. Its default `agent-host snapshot --json` route returns one path-free,
16 KiB-bounded environment, storage, activity, catalog, collection,
fresh-session, and top-eight historical tool-usage summary. Codex receives
that Skill through a Skill-only managed
plugin with no MCP server; Claude receives a link to one immutable private
projection. The Skill directs the external Agent to make any causal, adoption,
quality, or cleanup assessment itself and never to read Agent Host source or
Observer storage as a substitute.

If setup finds an enabled plugin with the same product name but different
bytes, it stops. A deliberate migration uses `--replace-host-conflicts`; the
displaced entry is recorded and restored by uninstall.

The development route remains available only when explicitly selected with
`--development-root`; it records current local paths only in private user
state. Tracked files never contain a developer's machine paths.

Local dogfood isolates installed execution provenance, not Agent access to the
workspace. Agents can continue implementing anywhere under `tools-dev` while
the installed tools load from private immutable packages. Codex caches only a
small Suite-owned projection of plugin identity and Skills; workspace-aware
tools receive the canonical root supplied by `--workspace-root`. The current
admission rules, catalog measurement, and routing observations are recorded in
[`docs/LOCAL_DOGFOOD.md`](docs/LOCAL_DOGFOOD.md).

The optional macOS manager has one canonical development run action:

```text
./script/build_and_run.sh
```

The packaged development app is ad-hoc signed for local testing. Public app
artifacts require Developer ID signing and notarization; the release workflow
fails if those credentials are unavailable.

See [the product model](docs/PRODUCT_MODEL.md),
[terminology](docs/TERMINOLOGY.md), [architecture](docs/ARCHITECTURE.md), and
[release boundary](docs/RELEASE.md).
