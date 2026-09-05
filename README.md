# Agent Host

[English](README.md) · [简体中文](README.zh-CN.md)

Agent Host installs and manages one compatible local environment for a small
set of Agent tools. It connects those tools to supported Agent apps through
their public extension points and operates local execution without modifying
the Agent apps themselves.

This repository contains the **Agent Host Suite** distribution unit. The npm
package, CLI, schemas, and other stable technical identifiers retain that name.

## Scope

- Capability contracts define stable typed operation meaning.
- Procedure contracts define stable multi-stage method when one exists.
- Independently useful Providers own their domain behavior and releases.
- Agent Host verifies and installs compatible artifacts, projects selected
  tools and thin Skills into supported Agent apps, manages the local runtime,
  and reports the environment it can currently observe.
- Host-owned execution, transport, observation, and routing-support packages
  remain behind explicit package, protocol, version, process, and failure
  boundaries.

Agent Host is not required for standards adoption, does not vendor external
Provider source, and never exposes a generic model-facing provider invocation
tool.

## Authority for current facts

This README describes durable product boundaries. It is not an installation
report or release manifest.

- `catalog/profiles/*.json` defines profile membership.
- A bound release catalog defines one compatibility release: its manifest owns
  the exact artifacts, versions, and hashes, while its separately validated
  `build-provenance.json` record owns build-source provenance.
- Installed `status`, `snapshot`, `usage`, and `doctor` results describe one
  machine at the time they are run.
- Source checks, installed Agent flows, Direct Runtime behavior, Manager
  behavior, distribution acceptance, and owner experience are separate verdict
  lanes; success in one does not establish another.

The tracked release catalog is deliberately unbound, so the source checkout
does not silently claim a public installable release.

## Profiles

- `standard` is the small default Agent-visible tool set.
- `observability` adds explicitly consented local monitoring without adding
  monitoring tools to the ordinary Agent catalog.
- `local-dogfood` adds the wider development inventory while retaining a
  smaller active set.
- `developer` installs the Agent Tool Development Kit as a Skill-only backstage
  component with no Agent MCP tools enabled by the profile.

Evaluation helpers are development and CI tooling, not an installable profile
or an ordinary Agent catalog.

Exact membership must be read from the profile files and the selected bound
release, not copied from prose. Installed inventory and active Agent-visible
tools are separate; after a binding change, start a fresh Agent task before
assessing discovery or natural tool selection.

## Typical operator flow

```text
agent-host setup --profile standard --host zcode --release-manifest /absolute/current.json
agent-host snapshot --json
agent-host usage --json
agent-host doctor --deep --skip-agent-apps --json
agent-host tools status
agent-host manager
agent-host update --release-manifest /absolute/new-current.json
agent-host rollback
agent-host uninstall
agent-host uninstall --purge-data
```

Use explicit Full Check or `doctor --deep` without `--skip-agent-apps` only when
current Agent-app binding verification is needed. If a failed service
replacement returns a structured recovery action, use that opaque recovery
identity and manifest digest against the same private Agent Host state; do not
construct or pass a recovery-directory path.

Agent Host preserves user-owned host entries and data by default. Monitoring is
opt-in and passive collection is metadata-only. `uninstall --purge-data`
removes Suite-owned snapshots and history, but the Observer's shared database
has its own data lifecycle and is retained. A recorded call or offered tool
does not establish Skill activation, result adoption, correctness, quality, or value. See
[Trace Plane](docs/TRACE_PLANE.md) for the observation and export boundary.

The explicit manifest on `update` selects a new release catalog. An
unparameterized `update` is appropriate only for a packaged carrier whose
built-in catalog is already bound.

## Distribution boundary

The repository is an Apache-2.0 developer preview. Public binary readiness is
determined per release candidate:

- Windows packaging and clean-device requirements are in
  [Windows distribution](docs/WINDOWS.md).
- macOS public binaries require Developer ID signing, notarization, stapling,
  Gatekeeper assessment, and clean-device acceptance.
- Local or internal ad-hoc-signed builds are validation artifacts, not public
  downloads.

Repository maintainers can read the
[release boundary](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/RELEASE.md)
for source, compatibility, internal, and public release requirements.

## Source-repository documentation

These maintainer documents are not bundled in the npm package; the links point
to the source repository:

- [Product model](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/PRODUCT_MODEL.md) — user, product object, profiles, and
  human surface.
- [Architecture](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/ARCHITECTURE.md) — Host, carrier, lifecycle, runtime, and
  state boundaries.
- [Tool integration](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/TOOL_INTEGRATION.md) — supported integration record
  versions and admission semantics.
- [Local dogfood](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/LOCAL_DOGFOOD.md) — isolated installation and current
  runtime verification method.
- [Review contract](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/REVIEW_CONTRACT.md) — minimum high-risk review seams,
  not a completion claim.
- [Terminology](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/TERMINOLOGY.md) — canonical product language and stable
  technical identifiers.
