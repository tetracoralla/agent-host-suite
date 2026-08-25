# Agent Host Suite

Agent Host Suite installs and operates a small set of independently released
Agent tools and host services without modifying the Agent shell itself.

The standards and the suite are separate:

- Capability contracts define stable typed operation meaning.
- Procedure contracts define stable multi-stage method when one exists.
- Providers implement those contracts and remain separate products.
- Direct Execution Runtime runs already selected structured work without a
  model relay.
- Agent Host Suite installs compatible artifacts, connects them through each
  shell's public extension points, manages the local runtime, and reports
  current host state.

An Agent vendor can adopt the standards without installing this suite. Today,
the suite is the practical bridge for shells that do not natively understand
Capability and Procedure contracts.

## Current release boundary

The repository is an Apache-2.0 developer preview. The local development
channel targets macOS and current Codex first, with Math Anchor and Migratory
Time as the two provider pilots. Published binary distribution remains blocked
until the compatibility set and provider artifacts are bound to immutable
revisions and the macOS app is signed and notarized.

```text
agent-host setup --profile standard --host codex \
  --development-root /path/to/tools-dev
agent-host doctor --deep
agent-host status
agent-host host add claude
agent-host observability enable
agent-host observability refresh
agent-host update
agent-host rollback
agent-host uninstall
```

Uninstall preserves both suite history and the Observer database by default.
`--purge-data` removes only Agent Host Suite's private state; it never erases a
pre-existing Observer database.

If setup finds an enabled plugin with the same product name but different
bytes, it stops. A deliberate migration uses `--replace-host-conflicts`; the
displaced entry is recorded and restored by uninstall.

The development route is intentionally explicit: it records current local
paths only in private user state. Tracked files never contain a developer's
machine paths.

The optional macOS manager builds with Swift Package Manager:

```text
swift build
./scripts/package-macos-app.sh debug
```

The packaged development app is ad-hoc signed for local testing. Public app
artifacts require Developer ID signing and notarization; the release workflow
fails if those credentials are unavailable.

See [the product model](docs/PRODUCT_MODEL.md),
[architecture](docs/ARCHITECTURE.md), and [release boundary](docs/RELEASE.md).
