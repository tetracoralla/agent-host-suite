# Local dogfood contract

Local dogfood makes the development Mac behave like an external Agent Host
installation while Agents continue to work in authorized source repositories.
It isolates executable provenance, not workspace access. Current installed
state and rerunnable checks control runtime claims; this document defines the
stable boundary only.

## Isolation invariants

- Agents may edit authorized repositories under `tools-dev`, but every
  installed Skill, launcher, runtime, service, and plugin resolves to immutable
  Agent Host package storage. Archived projects and source checkouts are never
  runtime inputs.
- Workspace-aware tools receive only the canonical root explicitly granted at
  setup. A package cannot discover or substitute another development root.
- ZCode is the primary local Agent app. Codex and optional Claude Code use
  separate public carriers. Provider/model credentials remain user-owned and
  are not changed by Agent Host.
- The installed inventory is distinct from the active Agent-visible set.
  Inactive tools retain their immutable Skills and direct launchers without
  adding MCP schemas to the current model catalog.
- Direct Runtime remains the structured fast path after Capability selection.
  It does not replace task discovery or Agent judgment and makes no model call.
- Observer is opt-in, local, bounded, short-lived, and metadata-only. It may
  report recorded use, partial runtime outcome, provider-specific usage, and
  Trace Plane coverage; it leaves Skill activation, non-use reason, semantic
  effect, adoption, correctness, quality, opportunity, and value unknown.
- Automatic record adapters are read-only. Event, telemetry, and hook adapters
  require a non-mutating plan plus an explicit user-owned configuration change.
  No provider credentials, prompts, routing rules, or live Agent task are
  modified.
- Setup, update, rollback, active-set changes, cleanup, disconnect, monitoring
  disable, and uninstall preserve user-owned Agent-app entries and the declared
  recovery release. Destructive data removal remains a separate confirmation.

## Build and install an isolated release

Build a current release catalog and run all source-independent package probes:

```text
npm run check
npm run build:internal-beta-artifacts
npm run probe:internal-beta-artifacts -- /absolute/release-catalog/current.json
node scripts/check-developer-kit-hosts.mjs --release-manifest /absolute/release-catalog/current.json
node scripts/check-packaged-trace-plane.mjs --release-manifest /absolute/release-catalog/current.json
```

Then install into an explicit temporary state root or through the packaged
native macOS app. Do not point setup at a development root when validating the
external-user path. The Developer Kit check uses temporary Codex, ZCode, and
Claude configuration roots and invokes no model.

## Runtime verification

Use the packaged Agent Host executable, not `src/cli.mjs`, for installed claims:

```text
agent-host status --json
agent-host snapshot --json
agent-host usage --json
agent-host observability adapters --json
agent-host doctor --deep --skip-agent-apps --json
agent-host rollback --dry-run --json
agent-host storage --json
agent-host cleanup --dry-run --json
```

Default Manager refresh does not launch an Agent app. `doctor --deep` without
`--skip-agent-apps` and **Run Full Check** are explicit current binding probes.
A real fresh Agent task is still required to assess discovery and natural
selection; an installed binding, historical call, or offered tool is not an
adoption result.

For Trace Plane cost, run the packaged Observer measurement against exact
user-authorized ZCode sources. It copies them into a temporary owner-only
snapshot, removes the copy afterward, reports source rotation, and emits no
paths:

```text
npm run measure:trace-plane --workspace @openadam/agent-tool-observer -- \
  --zcode-file /absolute/model-io-session.jsonl --json
```

## Verdict lanes

Report source regression, immutable package probes, installed Agent flow,
Direct Runtime, automatic monitoring, native Manager runtime, Windows artifact,
and owner experience separately. A macOS source or package PASS cannot establish
a Windows-device result. Ad-hoc macOS signing is sufficient only for local
dogfood; public macOS distribution still requires Developer ID, notarization,
and Gatekeeper acceptance.

Prior dated observations remain outside the default reading path under
an ignored local evidence directory. They can generate hypotheses but never establish the
current installation.
