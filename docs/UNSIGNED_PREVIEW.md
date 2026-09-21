# Unsigned preview download

This is the external-user path for obtaining Agent Host **without** Apple
Developer ID signing, notarization, stapling, or an App Store listing. Those
credentials are **not** part of this product and are not a remaining blocker.

This checkout does **not** currently attach installers to GitHub Releases.
After an owner publishes a tag, the assets go on that Release (or on a
self-hosted HTTPS index). Until then, Host says **public download is not
configured** rather than pretending there is a store.

## Where a non-developer downloads today

1. Open **[GitHub Releases](https://github.com/tetracoralla/agent-host-suite/releases)**.
2. If the **latest** Release lists `Agent-Host-*-darwin-arm64.dmg` (and `SHA256SUMS` / `preview-distribution.json`), download those assets. The unsigned preview publishes as a **non-prerelease** Release marked latest so `/releases/latest` can resolve it (GitHub excludes prereleases from latest).
3. Compare the DMG to `SHA256SUMS`, then follow **Open an unsigned macOS DMG** below (try to open → System Settings → Privacy & Security → Open Anyway). This path is **not** notarized and **not** a marketplace.
4. If the Releases page has **no** installer assets yet, public download is not configured — Host reports that honestly. There is no App Store / Homebrew cask stand-in in this slice.

Owner publish (macOS arm64 first) uses `scripts/publish-unsigned-preview.mjs` after packaging a DMG on a Mac; see **Owner checklist** below. The Actions draft `docs/unsigned-preview-release.yml` stays under `docs/` until a token with GitHub `workflow` scope can push `.github/workflows/`.

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
| Component archives | tar.gz | every `current.json` `artifact.url` (flat Release asset, not `artifacts/`) |
| Digests | text | `SHA256SUMS` |

Convention for Host to fetch the index:

```text
https://github.com/tetracoralla/agent-host-suite/releases/latest/download/preview-distribution.json
```

That URL is a **naming convention**. This checkout does not claim the asset
exists. Tracked `catalog/preview-distribution.json` is the unpublished
placeholder (`publicReleasePublished: false`, empty `carriers`, `catalog: null`).
`agent-host source status` / Manager Settings report that honestly as **catalog
assets are unpublished**, and can retry a check or point at a local bound
`current.json` / HTTPS index (`source set --release-manifest` or `source set --url`)
without publishing a GitHub Release. Interrupted, offline, and digest errors
keep a retry or local-catalog recovery.

## Open an unsigned macOS DMG (Gatekeeper)

The DMG and `Agent Host.app` are ad-hoc signed at most. They are **not**
Apple-notarized.

Apple’s current override for unsigned or unnotarized software on **macOS 15
Sequoia and later** is System Settings → Privacy & Security → Open Anyway;
Control-click no longer overrides Gatekeeper
([Apple developer note](https://developer.apple.com/news/?id=saqachfa),
[Open apps safely](https://support.apple.com/en-gb/102445)).

1. Compare the DMG to `SHA256SUMS`.
2. Open the DMG.
3. Drag **Agent Host** to Applications if the disk image offers that, or open
   **Agent Host.app** from the mounted volume.
4. **Try to open** the app. If macOS reports that it cannot verify the app,
   open **System Settings → Privacy & Security**, scroll to Security, and
   choose **Open Anyway**. Confirm the warning. This is the supported first-open
   path on macOS 15 Sequoia and later.
5. On **macOS 14**, Control-click (or right-click) **Agent Host.app** → **Open**
   may still confirm the warning. That override does not work on macOS 15+.
6. Later launches can use a normal double-click after that first Open.

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
the index. That file lands in Host private downloads; it does not replace or
relaunch the running application. Application replacement is `agent-host app
update` after digest comparison. See [`UPDATES.md`](UPDATES.md).

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

Preferred owner path (no notarization; works without `workflow` scope):

```text
# On a Mac with a built unsigned DMG (for example after npm run package:internal-beta):
node scripts/publish-unsigned-preview.mjs prepare \
  --tag vX.Y.Z-unsigned.1 \
  --output .build/unsigned-preview \
  --dmg /absolute/Agent-Host-X.Y.Z-darwin-arm64.dmg \
  --catalog /absolute/release-catalog/current.json   # optional but preferred
node scripts/publish-unsigned-preview.mjs publish \
  --tag vX.Y.Z-unsigned.1 \
  --assets .build/unsigned-preview
# Use --dry-run on publish to print the gh release create command only.
```

`prepare` / `publish` emit `gh release create … --latest` **without** `--prerelease`. That is intentional: the first public unsigned preview **is** the current download, and only a non-prerelease Release can occupy `/releases/latest`. `publish` validates a closed asset manifest (tag/repo/URLs, every declared asset size+sha256) and refuses wrong-tag, missing, or tampered carriers; leftover files in the output directory are never uploaded.

When `--catalog` points at a bound `current.json`, `prepare` copies **every referenced component archive** into that closed set and rewrites each `artifact.url` to `…/releases/download/<tag>/<basename>`. The standard builder writes local `artifacts/*.tar.gz` paths; those are not remotely consumable. A catalog that still names a local relative URL, or whose archive is missing next to `current.json`, is refused. GitHub Release assets are flat, so the basename (not the `artifacts/` prefix) is the uploaded file. After rewrite, Host binds the index digest to the **network-facing** `current.json`.

After assets exist, `agent-host source check` probes the Releases `latest` convention URL and flips off **public download is not configured** when carriers are published. Tracked `catalog/preview-distribution.json` remains the unpublished placeholder in git.

Manual equivalent still works:



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
6. Create a **non-prerelease** GitHub Release for tag `vX.Y.Z`, mark it
   **latest**, and attach only the closed asset set: DMG/ZIP,
   `preview-distribution.json`, `current.json`, `build-provenance.json`,
   every component archive named by that `current.json`, and `SHA256SUMS`
   (do not upload leftover logs from the output directory). Prefer
   `publish-unsigned-preview.mjs prepare --catalog` so relative `artifacts/`
   URLs are rewritten before the index digest is bound. Release notes must
   say the build is **not Apple-notarized** and must include the Gatekeeper
   steps above. Do not use `--prerelease`: GitHub REST cannot make a
   prerelease latest, and Host probes `/releases/latest/download/preview-distribution.json`.
7. Point Host at the index with `AGENT_HOST_FEATURED_CATALOG_URL`.

Component `artifact.url` values in a remotely fetched `current.json` must be
**HTTPS** (GitHub Release asset URLs are fine). `prepare --catalog` writes
those URLs and attaches the archives; do not publish a builder catalog whose
URLs still point at a local `artifacts/` directory. Host follows HTTPS
redirects so `github.com/.../releases/download/...` may land on
`objects.githubusercontent.com`; SHA-256 still binds the bytes.

## Unsigned preview workflow

Until GitHub `workflow` scope is available, the **live** owner publish path is `scripts/publish-unsigned-preview.mjs` (prepare + `gh release create`). Do not claim `.github/workflows/unsigned-preview-release.yml` is enabled while that file is absent.



The required unsigned pipeline draft is
[`unsigned-preview-release.yml`](unsigned-preview-release.yml). It remains under
`docs/` until an account with the GitHub `workflow` scope can push
`.github/workflows/unsigned-preview-release.yml`; do **not** claim that Actions
path is live while the file is absent from `.github/workflows/`.

Each platform job must:

1. Check out Host.
2. Obtain **version-pinned** Math Anchor and Migratory Time inputs using
   [`catalog/unsigned-preview-source-pins.json`](../catalog/unsigned-preview-source-pins.json)
   (source checkout at the pinned revision, or
   `AGENT_HOST_MATH_ANCHOR_ARTIFACT` /
   `AGENT_HOST_MIGRATORY_TIME_ARTIFACT` platform archives).
3. Admit GitHub tools for **that** runner.
4. Run `scripts/build-unsigned-preview-catalog.mjs`, which still **refuses** an
   incomplete default profile (`math-anchor`, `migratory-time`, and the Host
   runtime packages).

Native archives are not reused across operating systems. The draft does **not**
request Apple secrets. The notarized
[`.github/workflows/release.yml`](../.github/workflows/release.yml) is a
separate signed path and is not this preview. Copy
[`scan-github-tools.yml`](scan-github-tools.yml) to
`.github/workflows/scan-github-tools.yml` from an account with the GitHub
`workflow` scope if catalog pin automation is not yet enabled. See
[`UPDATES.md`](UPDATES.md).

## Non-goals

- Applying for or simulating a Developer ID certificate
- Claiming this checkout already has Release assets
- A third-party plugin marketplace
- Treating a completed `profiles fetch` as proof of Agent choice or task value
