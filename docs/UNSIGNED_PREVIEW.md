# Unsigned preview download

This is the external-user path for obtaining Agent Host **without** Apple
Developer ID signing, notarization, stapling, or an App Store listing. Those
credentials are **not** part of this product and are not a remaining blocker.

This checkout does **not** currently attach installers to GitHub Releases.
After an owner publishes a tag, the assets go on that Release (or on a
self-hosted HTTPS index). Until then, Host says **public download is not
configured** rather than pretending there is a store.

## Where to download

1. **GitHub Releases** (recommended once an owner publishes a tag):
   [https://github.com/tetracoralla/agent-host-suite/releases](https://github.com/tetracoralla/agent-host-suite/releases)
2. **Self-hosted HTTPS**, using the same `preview-distribution.json` index.

Asset names, when published, match the packagers already in this repository:

| Platform | Kind | File |
| --- | --- | --- |
| macOS Apple silicon | DMG | `Agent-Host-{version}-darwin-arm64.dmg` |
| macOS Intel | DMG | `Agent-Host-{version}-darwin-x86_64.dmg` |
| Windows x64 | ZIP | `Agent-Host-{version}-win32-x64.zip` |
| Windows ARM64 | ZIP | `Agent-Host-{version}-win32-arm64.zip` |
| Index | JSON | `preview-distribution.json` |
| Bound catalog | JSON | `current.json` plus sibling `build-provenance.json` |
| Digests | text | `SHA256SUMS` |

Convention for Host to fetch the index:

```text
https://github.com/tetracoralla/agent-host-suite/releases/latest/download/preview-distribution.json
```

That URL is a **naming convention**. This checkout does not claim the asset
exists. Tracked `catalog/preview-distribution.json` is the unpublished
placeholder (`publicReleasePublished: false`, empty `carriers`, `catalog: null`).

## Open an unsigned macOS DMG (Gatekeeper)

The DMG and `Agent Host.app` are ad-hoc signed at most. They are **not**
Apple-notarized.

1. Compare the DMG to `SHA256SUMS`.
2. Open the DMG.
3. Drag **Agent Host** to Applications if the disk image offers that, or open
   **Agent Host.app** from the mounted volume.
4. **Control-click** (or right-click) **Agent Host.app**, choose **Open**, then
   confirm the Gatekeeper warning. The warning is expected.
5. Later launches can use a normal double-click after that first Open.

Do not bypass Gatekeeper by disabling system security. Do not describe this
preview as notarized or as an App Store app.

## Open an unsigned Windows ZIP (SmartScreen)

The ZIP is **not** Authenticode-signed. SmartScreen may warn on first open.

1. Compare the ZIP to `SHA256SUMS`.
2. Extract the complete ZIP.
3. Run `Install Agent Host.cmd`.
4. If Windows warns that the app is unrecognized, choose **More info** →
   **Run anyway** only after the digest matches. See
   [`WINDOWS.md`](WINDOWS.md).

## How Host installs tools from a bound catalog

Installing Agent Host is separate from installing featured tools (Armorial and
the rest of the `featured` profile). Host never pretends to be a plugin store.

Once an owner publishes `preview-distribution.json` (with a `catalog` pointer)
or a bound `current.json`:

```text
export AGENT_HOST_FEATURED_CATALOG_URL=https://github.com/tetracoralla/agent-host-suite/releases/latest/download/preview-distribution.json
agent-host profiles list --json
agent-host profiles fetch --json
agent-host setup --profile featured --no-host
agent-host tools set --profile featured
```

`profiles fetch` downloads the bound `current.json` and `build-provenance.json`
into Host private downloads, verifying size and SHA-256 (a missing
`Content-Length` is allowed; the streamed byte count and digest still must
match). `setup` / Manager setup / `update --profile featured` reuse the same
hook: if `AGENT_HOST_FEATURED_CATALOG_URL` is set and no
`--release-manifest` is given, Host fetches that catalog, then
`acquireArtifact` downloads each component archive.

Add `--carrier` to also download the current platform’s DMG or ZIP named by
the index:

```text
agent-host profiles fetch --carrier --json
```

Failures are explicit:

| Situation | Result |
| --- | --- |
| No `AGENT_HOST_FEATURED_CATALOG_URL` | `PREVIEW_DOWNLOAD_NOT_CONFIGURED` — public download is not configured; not a store |
| Index exists but `catalog` is null | same code — assets not published yet |
| HTTP / credentials / HTML Releases page | `PREVIEW_DOWNLOAD_INVALID_URL` or `PREVIEW_DOWNLOAD_INVALID` |
| Digest or size mismatch | `PREVIEW_DOWNLOAD_DIGEST_MISMATCH` / `PREVIEW_DOWNLOAD_SIZE_MISMATCH` |
| No installer for this platform | `PREVIEW_CARRIER_UNAVAILABLE` |

`--release-manifest` still accepts a local `current.json` path, or an `https://`
URL to `preview-distribution.json` / `current.json`.

## Owner checklist: publish a GitHub Release

Build on a machine that already has a **bound** catalog (not
`catalog/releases/draft-unbound`). This repository does not invent Apple
certificates.

1. Produce the bound catalog (`npm run build:remote-release-artifacts` or the
   documented internal-beta build).
2. macOS: `npm run package:internal-beta` (ad-hoc signed DMG) or
   `./scripts/package-macos-app.sh release` then wrap the app in a DMG.
3. Windows: `npm run package:windows` →
   `.build/windows/distribution/Agent-Host-{version}-win32-*.zip`.
4. Write the index:

   ```text
   node scripts/write-preview-distribution.mjs \
     --output preview-distribution.json \
     --catalog /absolute/release-catalog/current.json \
     --base-url https://github.com/tetracoralla/agent-host-suite/releases/download/vX.Y.Z \
     --dmg /absolute/Agent-Host-X.Y.Z-darwin-arm64.dmg \
     --zip /absolute/Agent-Host-X.Y.Z-win32-x64.zip
   ```

5. `shasum -a 256` every asset into `SHA256SUMS`.
6. Create a **prerelease** GitHub Release for tag `vX.Y.Z` and attach the
   DMG/ZIP, `preview-distribution.json`, `current.json`,
   `build-provenance.json`, and `SHA256SUMS`. Release notes must say the build
   is **not Apple-notarized** and must include the Gatekeeper steps above.
7. Point Host at the index with `AGENT_HOST_FEATURED_CATALOG_URL`.

Component `artifact.url` values in a remotely fetched `current.json` must be
**HTTPS** (GitHub Release asset URLs are fine). Host follows HTTPS redirects
so `github.com/.../releases/download/...` may land on
`objects.githubusercontent.com`; SHA-256 still binds the bytes.

## Optional workflow draft

The tracked `.github/workflows/release.yml` still contains the older
notarization job. This product does **not** use those Apple secrets. Copy
[`unsigned-preview-release.yml`](unsigned-preview-release.yml) to
`.github/workflows/unsigned-preview-release.yml` (or replace `release.yml`)
with GitHub Desktop from an account that has the `workflow` scope. The draft
uploads an unsigned prerelease, does not call `notarytool`, and fails closed
when a bound catalog is missing; it does not invent artifacts.

## Non-goals

- Applying for or simulating a Developer ID certificate
- Claiming this checkout already has Release assets
- A third-party plugin marketplace
- Treating a completed `profiles fetch` as unnamed adoption
