# Release boundary

## Distribution intent

Windows is the primary next external distribution target. The macOS app remains
the local dogfood carrier, but Apple Developer ID signing, notarization, and a
polished public DMG are deferred and do not block Windows engineering.
This intent does not establish that either carrier has passed its release
requirements; only a named candidate and current rerun results can do that.

## Local dogfood release

The local dogfood target is a private release installation on a development
Mac, not anonymous public distribution. Agents retain normal
access to every authorized `tools-dev` repository; only installed execution
provenance is isolated. The active plugin, MCP, runtime, and LaunchAgent paths
must resolve to private versioned packages. See `LOCAL_DOGFOOD.md` for the
admission and whole-machine gap rules.

## Internal macOS Beta

The internal Beta channel is bound to the immutable artifacts selected by its
generated release catalog. Profile files and that catalog, rather than a copied
count or component list in this document, own the exact inventory. Each
component declares its platform, version, archive location, byte length,
SHA-256, entrypoint, license, legal files, package descriptor, and per-file
digests. Setup extracts those bytes into Agent Host's private versioned package
root; active execution does not retain or execute paths from a `tools-dev`
checkout.

Codex receives a thin private host projection rather than a second copy of each
provider runtime. The projection contains marketplace/plugin identity, Skill
resources, small interface assets, and generated MCP configuration; its MCP
command and working directory still point to the verified package. A profile
that activates workspace-dependent tools must be installed or updated with an
explicit `--workspace-root` grant.

The ordinary App build stages only the selected release profile. The private
dogfood build opts into the Local profile explicitly; this larger catalog is
not the public default. Its Developer Kit remains Skill-only and adds no MCP
tool to the active catalog. The App contains a small native bootstrap and CLI shim,
not a second uncompressed Node distribution. On first use the shim extracts
and verifies the immutable Suite Node component into Agent Host's package
store, then reuses that package. Tool integration schema v0.2 also lets
eligible provider components select the same `suite-node` executor, while
their independently distributed provider artifacts remain self-contained.

Before signing, App packaging removes only unresolved links from the copied
dependency tree. This prevents development-workspace package links from
becoming dangling resources in the sealed App while preserving valid package
links; distribution checks then verify the complete signature and reject any
embedded `tools-dev` path.

Build and verify an internal Beta candidate with:

```text
AGENT_HOST_SUITE_VERSION=<package-json-version> \
AGENT_HOST_RELEASE_ID=<unique-internal-release-id> \
AGENT_HOST_RELEASE_CREATED_AT=<ISO-8601-instant> \
npm run build:internal-beta-artifacts
npm run probe:internal-beta-artifacts
npm run package:internal-beta
npm run check:internal-beta
```

`probe:internal-beta-artifacts` fails unless both the MCP catalog probes and
the exact BatchTicket 0.2.0 and File Vitals 0.3.3 Direct Capability calls run
from materialized Host component bytes, including path rejection and recovery.
The later application-profile projection rechecks every selected archive
against the release manifest both before and after copying, so distribution
packaging also fails if component bytes drift after that probe.
The distribution manifest also binds the complete sorted release-catalog tree;
DMG verification rejects a same-version catalog when its release identity,
file set, or any catalog or component byte differs from the embedded tree.
Application packaging removes the copied source `catalog/releases` directory
before installing that selected tree, so draft or historical catalog files
cannot survive beside the bound release.

`AGENT_HOST_SUITE_VERSION` must equal the current `package.json` version.

Every generated catalog carries `build-provenance.json`. The default
`build:internal-beta-artifacts` route accepts only clean local Git checkouts.
Use `build:development-artifacts` for an explicitly local-only build that may
include uncommitted work; it writes to a separate development catalog. Supply
the deliberately chosen compatibility version, unique release ID, and stable
creation instant explicitly. Replace every placeholder below:

```text
AGENT_HOST_SUITE_VERSION=<suite-version>-development.1 \
AGENT_HOST_RELEASE_ID=<unique-local-release-id> \
AGENT_HOST_RELEASE_CREATED_AT=<ISO-8601-instant> \
npm run build:development-artifacts
```

The command also requires every component source named by the selected Local
profile to be present (or supplied through its documented source-root/reuse
override); it fails closed rather than silently substituting an older artifact.
A
public or externally distributed candidate must use
`build:remote-release-artifacts` together with
`AGENT_HOST_RELEASE_SOURCE_LOCK`. That lock names the exact HTTPS repository,
release tag, and full commit SHA for every consumed source. The builder checks
each tag against its remote before and after component construction and rejects
dirty, moved, missing, or branch-based inputs. It also refuses to promote
components reused from a prior local catalog into a remote-confirmed build.

The provenance policy and record digest travel into the macOS and Windows
distribution manifests and the installed Agent Host state. Operations
snapshots distinguish `local-development`, `local-clean`, and `remote-tagged`;
only the last means the build inputs matched remote release tags at build time.
This is provenance, not a claim that a later remote tag or downloadable
artifact was rechecked at observation time.

The builder normally reads the sibling `calculator` checkout. When that
development checkout is intentionally absent, a clean, exact-revision Math
Anchor checkout can be supplied with `AGENT_HOST_MATH_ANCHOR_SOURCE_ROOT`.
The selected checkout revision, dirty state, source policy, and optional tag
are recorded in component metadata and the catalog-level provenance record;
an override does not turn an unbound source tree into a public compatibility
release.

Archive creation normalizes file ownership, component timestamps, ordering,
gzip metadata, and component-level SBOM identity independently of the suite
release ID. Unchanged component content therefore reuses one content-addressed
package across later suite releases instead of consuming another rollback copy.
Rebuilding an existing release ID must reproduce all component digests or stop
without replacing that release catalog.

Installed storage cleanup preserves current and rollback bytes plus any package
version still named by a live Agent process. This lets an open pre-update session
finish without the updater deleting its immutable runtime; after that process
exits, the old version becomes eligible on the next cleanup pass. Failure to
enumerate live processes blocks cleanup-candidate calculation. Content-addressed
runtime configurations are retained only while the current or rollback state
names them; cleanup removes older unreferenced configurations without touching
other runtime files.

The resulting DMG is deliberately ad-hoc signed and its adjacent distribution
manifest records that it is neither Developer ID signed nor notarized. It is an
internal validation artifact, not a public download.
The distribution writer derives `appVersion` from the Suite package only after
the source Manager Info.plist, release catalog, and build provenance all match
that identity. Distribution verification then compares the manifest, mounted
Manager bundle, bundled Host package/catalog/provenance, and an isolated
bundled-CLI `status` result before accepting the artifact.

## Source release

The source repository is Apache-2.0 and can be reviewed and built without
private infrastructure. A source revision is not an installable compatibility
release by itself.

## Compatibility release

A public compatibility release is an artifact intentionally made available
outside the controlled local or internal environment so an unrelated user can
obtain and install it without the implementation checkouts. It requires:

1. immutable revisions for Capability Contracts, Procedure Contracts, Direct
   Execution Runtime, and the architecture compatibility bill of materials;
2. versioned provider artifacts for Math Anchor and Migratory Time;
3. detached SHA-256 values and original legal/SBOM material for every binary
   or bundled runtime;
4. a suite manifest whose artifact URLs, versions, identities, and hashes match
   those releases;
5. a clean-device installation check through the released boundary;
6. hosted CI and security checks on every owning repository.

The tracked built-in release catalog remains `draft-unbound`; public setup
therefore fails closed instead of silently downloading `main`. The bound
internal catalog is generated beneath `.build/internal-beta` and embedded into
the Beta app without turning local artifacts into a public release.

The remote build accepts explicit source-root environment variables for each
independently released Provider and standards repository, so CI can use clean
temporary tag checkouts rather than the developer's sibling `tools-dev`
directories. After verifying each checkout, the builder exports the locked Git
revision into a temporary snapshot and reads only tracked bytes from that
snapshot. Ignored or untracked local build products therefore cannot enter a
remote-confirmed release. Provider release path overrides must remain inside
their locked repository and resolve into that tracked snapshot. Archived
source directories are never runtime inputs. Missing or untracked independent
inputs therefore block a remote build instead of falling back to an archive,
an ignored `dist` directory, or an older working tree.

Armorial is rebuilt inside that verified tracked-source snapshot: the Host
builder requires its lockfile, runs the repository-declared lockfile install
and `release:plugin` workflow under bounded execution, then validates the
archive inventory, manifests, version, checksum, and staged bytes. Its ignored
`.release` directory is never a remote-build input. A failed source build
removes its scratch publication and cannot publish a Host catalog.

File Vitals is likewise rebuilt through its tracked `build_plugin.sh` inside
the selected source tree. Prepare the Go toolchain and a Python environment
with that selected source's `scripts/requirements-check.txt` installed, and
put that environment's executables on `PATH` before starting the Host build.
The builder does not install Python dependencies into the operator's global
environment. Record the target and toolchain versions with any archive
reproducibility comparison.
The Host does not consume a pre-existing ignored
`dist` directory. It verifies the generated checksum, bounded archive
inventory, exact `0.3.3` Plugin and Provider identities, declared adapter
command/arguments/working directory, required runtime files, and extracted
bytes before component publication. The generated archive's type and compressed
size are rejected before Host copying or hashing. A development-only explicit artifact
override must name both the plugin root and its archive; supplying only one
fails closed, and the override is rejected by clean and remote-tagged builds.
Remote-tagged construction always rebuilds from the materialized tracked snapshot.
The generated archive is fully inventoried and hashed before its first private
copy, then the copy is inventoried and hashed again before extraction or
component publication.

Every Provider Plugin archive is first copied into one private build scratch
area and completely inspected before extraction. The shared inspection rejects
unsafe or duplicate normalized paths, links and special members, excessive
entry count, excessive per-entry or cumulative expanded bytes, excessive
compressed bytes, and total inspection timeout. Only that unchanged inspected
copy may be extracted; rejection occurs before any Provider bytes are published.
The archive inspector takes an explicit target-filesystem policy. The macOS
distribution path uses `macos-default`, which additionally rejects names that
collapse under the ordinary case-insensitive, Unicode-canonical-equivalent
macOS filename model (including case-only and composed/decomposed duplicates)
before extraction. A caller targeting a case-sensitive filesystem must select
`portable-case-sensitive`; the Host does not silently reinterpret those
otherwise legal archives as macOS-compatible.

A Provider fallback path is a development-mode source-owned candidate only.
Its filename does not establish the component version, artifact digest, or
source provenance. The builder reads the version from the copied Plugin
manifest, inventories and hashes the staged bytes, and binds provenance to the
applicable source observation. A stale filename can therefore neither
impersonate newer Provider bytes nor turn a local artifact into a
remote-confirmed source.

Host-owned Direct Runtime, HTTP bridge, Observer, and Context Surface modules
are canonical under this repository's `packages/` directory. Any remaining
sibling checkouts are legacy migration sources, not byte mirrors, release
fallbacks, or inputs to this builder; independent Provider repositories retain
their own release ownership.

The local development manifest derives `suiteVersion` from this repository's
current package identity. Install state and status therefore report the same
Suite version as the source package rather than a static development placeholder.

## macOS binary release

The app and every nested executable require hardened-runtime signing with a
Developer ID Application identity, notarization, stapling, Gatekeeper
assessment, and detached checksums. The release artifacts must be regenerated
after signing so their immutable digests describe the shipped bytes. The
presence or absence of credentials on one development machine is a current
release-campaign fact and must not be inferred from this document.

A public candidate must pass:

```text
scripts/check-macos-distribution.sh public /path/to/Agent-Host.dmg /path/to/distribution.json
```

The final acceptance run must occur on a separate Mac with no source checkouts
and no pre-existing Agent Host service. It must exercise the App UI, standard
tool installation, a fresh Codex session using both tools, diagnosis and
repair, update, rollback, keep-history uninstall, and full data removal.

## Windows binary release

The Windows distribution defines a current-user ZIP carrier, payload and
archive digests, bundled Node license, Start menu Manager/restore/uninstall
flows, named-pipe Direct Runtime, current-user scheduled tasks, source-independent
package CI, application rollback, and preserve-or-purge uninstall choices. See
`WINDOWS.md`.

The tracked catalog remains unbound. A real candidate therefore still requires
actual `win32-x64` or `win32-arm64` Provider artifacts with exact descriptors,
licenses, notices and SBOMs. The fixture catalog used by CI checks the carrier,
not Provider compatibility. The Windows CI job is effective only after it runs
on the hosted Windows runner; source changes on this Mac do not establish that
result.

The Windows packager requires `remote-tagged` provenance by default and binds
its digest into both payload and distribution manifests. The local-source
override exists only for the deterministic CI carrier fixture and is explicit
in that workflow. An unsigned candidate records `codeSigning: unsigned`. A
public download needs
an explicit Authenticode signing decision plus a clean Windows device run that
checks SmartScreen, install, ZCode/Codex/Claude binding as applicable, Standard,
monitoring and Developer Kit setup, named-pipe execution, scheduled collection,
update, both rollback layers, both uninstall choices, reboot/login recovery,
and residual files/processes. Cross-platform source tests and CI cannot replace
that runtime and experience acceptance.

## Linux

No Linux distribution is currently claimed. Cross-compilation is not runtime
acceptance.
