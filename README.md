# Agent Host

[English](README.md) · [简体中文](README.zh-CN.md)

Agent Host installs and manages one compatible local environment for a small
set of Agent tools. It connects those tools to supported Agent apps through
their public extension points and operates local execution without modifying
the Agent apps themselves.

This repository contains the **Agent Host Suite** distribution unit. The npm
package, CLI, schemas, and other stable technical identifiers retain that name.

This checkout is source and a developer preview. It does **not** ship Apple
Developer ID signed or notarized builds, and it is **not** an App Store or
plugin marketplace. Strangers install from a GitHub Release or a configured
HTTPS URL (macOS DMG / Windows ZIP) once an owner publishes those assets;
until then Host says public download is not configured. macOS Gatekeeper on
15+ uses System Settings → Privacy & Security → Open Anyway after a blocked
first open. Host can fetch a bound catalog and install
tools when `AGENT_HOST_FEATURED_CATALOG_URL` is set. See
[Unsigned preview download](docs/UNSIGNED_PREVIEW.md). After Host is
installed, browse recommended tools or add a GitHub project/Release without
changing Host source; see [GitHub updates](docs/UPDATES.md).
`profiles fetch --carrier` downloads an installer and does not replace the
running application. A Host working-set selection is not proof that an open
Agent session loaded those tools.

## Download today (non-developers)

Public entry: **[GitHub Releases](https://github.com/tetracoralla/agent-host-suite/releases)**.

- When an owner has published an unsigned preview, download `Agent-Host-*-darwin-arm64.dmg` (first deep path), verify `SHA256SUMS`, try to open the app, then **System Settings → Privacy & Security → Open Anyway** if macOS blocks it. **Not notarized. Not a marketplace.**
- When Releases has no installer assets, Host says public download is not configured. See [Unsigned preview download](docs/UNSIGNED_PREVIEW.md).

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

## Audiences

- **External user.** Installs a **bound** compatibility release through a
  packaged carrier or `setup --release-manifest` pointing at that catalog.
  Tools come from the selected profile's membership in that release, then a
  fresh Agent task. This git checkout's tracked catalog is `draft-unbound`, so
  public setup fails closed until a bound manifest is supplied.
- **tools-dev dogfood.** Developers with authorized source checkouts follow
  [Local dogfood](docs/LOCAL_DOGFOOD.md). Sibling repositories are build
  inputs, not runtime paths, and `local-dogfood` is a local feedback profile,
  not a store.

A [featured catalog v1](docs/FEATURED_CATALOG.md) is the named `featured`
profile: an owner-selected subset of independently released tools installed
through those same APIs. Browser and native Managers can choose `featured` at
setup or Get featured tools (including Armorial) after a Standard install.
`tools set --profile` only enables the working set of already-installed tools.
It is not a marketplace. How Codex projections relate to session Skill/MCP
paths is in [Discovery and projection](docs/DISCOVERY_PROJECTION.md).

## Profiles

- `standard` is the small default Agent-visible tool set.
- `featured` is the external-user admission list. It extends `standard` and
  admits Armorial. List it with `agent-host profiles list`. It is not
  `local-dogfood`.
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

## External featured path

There is no public GitHub Release asset in this checkout. After an owner
publishes a Release or HTTPS index (see
[Unsigned preview download](docs/UNSIGNED_PREVIEW.md)):

```text
export AGENT_HOST_FEATURED_CATALOG_URL=https://github.com/tetracoralla/agent-host-suite/releases/latest/download/preview-distribution.json
agent-host profiles list --json
agent-host profiles fetch --json
agent-host setup --profile featured --host zcode
agent-host tools set --profile featured
agent-host doctor --deep --json
```

Or pass a local bound catalog with `--release-manifest /absolute/current.json`.

Tracked `draft-unbound` setup fails closed. `--development-root` is the
tools-dev path, not featured. Details:
[Featured catalog v1](docs/FEATURED_CATALOG.md).

## Unnamed adoption acceptance

This checkout does not record a completed live adoption. A Linux construction
box without Host GUI or a full Agent session cannot score it. On a machine
that already has Agent Host and a supported Agent app, follow
[Unnamed adoption acceptance](docs/ADOPTION_ACCEPTANCE.md): copy the page
fixtures out of this repository, start a **fresh Agent task**, and judge
whether icons entered the work without naming Armorial.

```text
agent-host doctor --featured-readiness --json
```

That command reports user-level Host readiness (required tools, connection,
projection) separately from `recipe.consistency`. It always reports
`adoptionEvidence: false`. A `local-dogfood` profile is not itself a
user-level failure. Host status and call counts are not adoption.

## Typical operator flow

```text
agent-host setup --profile standard --host zcode --release-manifest /absolute/current.json
agent-host snapshot --json
agent-host source status --json
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

The repository is an Apache-2.0 developer preview. **No notarization.** Public
preview installers are unsigned and are meant to be published on
[GitHub Releases](https://github.com/tetracoralla/agent-host-suite/releases)
or a self-hosted HTTPS index. This checkout does not claim those assets exist
today.

- There is no public Agent Host marketplace and no third-party plugin store.
- macOS preview DMGs are not Developer ID signed and not Apple-notarized.
  After a blocked first open, System Settings → Privacy & Security → Open Anyway
  is the supported preview path on macOS 15 Sequoia and later (Control-click no
  longer overrides Gatekeeper). That is not a temporary stand-in for the App Store.
- Windows preview ZIPs are unsigned. SmartScreen may warn; compare SHA-256
  first. Details: [Windows distribution](docs/WINDOWS.md).
- Host can download a bound catalog and install featured tools when
  `AGENT_HOST_FEATURED_CATALOG_URL` is set. See
  [Unsigned preview download](docs/UNSIGNED_PREVIEW.md).

Repository maintainers can read the
[release boundary](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/RELEASE.md)
for source, compatibility, internal, and public release **requirements**.
Meeting a requirement in that document is not a claim that a public candidate
exists.

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
  runtime verification method for tools-dev machines.
- [Discovery and projection](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/DISCOVERY_PROJECTION.md) — Host working set vs Agent-app
  cache and session Skill/MCP paths.
- [Unsigned preview download](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/UNSIGNED_PREVIEW.md) — GitHub Releases / HTTPS DMG and ZIP, Gatekeeper, Host catalog fetch; not notarized.
- [Featured catalog v1](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/FEATURED_CATALOG.md) — owner-selected tools through existing
  install APIs, not a marketplace.
- [Unnamed adoption acceptance](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/ADOPTION_ACCEPTANCE.md) — page tasks and a Host-only
  readiness probe; not a live-adoption claim from this checkout.
- [Review contract](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/REVIEW_CONTRACT.md) — minimum high-risk review seams,
  not a completion claim.
- [Terminology](https://github.com/tetracoralla/agent-host-suite/blob/main/docs/TERMINOLOGY.md) — canonical product language and stable
  technical identifiers.
