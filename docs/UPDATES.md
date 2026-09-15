# GitHub release and local update

Agent Host uses GitHub Releases as the public distribution channel. There is
no self-hosted update server. Adding a registered tool is a catalog data
change, not a Host source-code branch.

## What a person sees

`agent-host updates status`, Manager **Updates**, and Settings report:

- Agent Host application build
- installed Agent tools and GitHub-available versions
- connected Agent apps, with their official upgrade path
- last check, source, and the next action

States are named separately: update available, not installed, no platform
asset, check failed, waiting for a fresh Agent task. A green light is not
used as a substitute.

`profiles fetch --carrier` downloads an installer into Host private
downloads. It does **not** quit, replace, or relaunch Agent Host. Application
replacement is `agent-host app update` on a supported OS after digest
comparison. Unsigned macOS builds still require Control-click → Open.

## Tools

Registered public tools live in `catalog/github-tools.json`. Pinned Releases
live in `catalog/github-releases/current.json`. Host downloads the tool’s own
GitHub asset, verifies SHA-256, wraps Host integration metadata around
unmodified plugin bytes, probes CLI/MCP, then installs.

```text
agent-host tools browse --json
agent-host tools add --github https://github.com/tetracoralla/armorial/releases/tag/v0.8.0
agent-host tools add --github URL --preview
agent-host tools update --tool armorial
```

`--preview` reads GitHub project/Release metadata only and does not download
the plugin archive. Install persists the GitHub origin with the installed
instance. A later name or logo change cannot silently switch repositories.

Third-party projects that match the plugin contract use the same add/update
lifecycle. Host does not mirror their binaries into this repository.

## Host application

Unsigned preview tags `v*` attach application carriers and, separately, the
GitHub tool catalog. Do not publish a tool catalog as GitHub `latest` for the
Host application. Catalog automation uses branch `chore/github-tool-catalog`
and is documented below.

Stable application checks use GitHub’s latest non-prerelease. Preview checks
list prereleases. GitHub `latest` never includes prerelease.

## Automation

`docs/unsigned-preview-release.yml` is the unsigned preview pipeline. Copy it
to `.github/workflows/release.yml` from an account with the GitHub `workflow`
scope. It does not request Apple Developer ID or notary secrets. It admits
registered GitHub tools on a clean runner, packages unsigned macOS/Windows
carriers, and publishes a prerelease only after those jobs succeed.

`docs/scan-github-tools.yml` refreshes catalog pins and opens or updates one
catalog PR; copy it to `.github/workflows/scan-github-tools.yml` with the same
`workflow` scope. `GITHUB_TOKEN` pushes do not start downstream workflows.
One-time GitHub App (contents: write, pull requests: write) or a human push
re-runs CI. Without that App, the manual path remains:

```text
node scripts/sync-github-catalog.mjs
node scripts/admit-github-plugin.mjs --registry --output .build/github-tools
```

then open the catalog PR from GitHub Desktop.

## Sample

Armorial public Release v0.8.0 is the first closed loop. Current pin:

- https://github.com/tetracoralla/armorial/releases/tag/v0.8.0
- `armorial-0.8.0-codex-plugin-macos-arm64.tar.gz`
- SHA-256 `db2cd4acb1b1e0ba96ece12d03f1d2d4d1fc8f5fabc1b1c6999ea3cb07b87fcd`

Only macOS arm64 is claimed for that asset.
