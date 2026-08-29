# Release boundary

## Local dogfood release

The current operating target is a private release installation on the primary
development Mac, not anonymous public distribution. Agents retain normal
access to every authorized `tools-dev` repository; only installed execution
provenance is isolated. The active plugin, MCP, runtime, and LaunchAgent paths
must resolve to private versioned packages. See `LOCAL_DOGFOOD.md` for the
admission and whole-machine gap rules.

## Internal macOS Beta

The internal Beta channel is bound to twelve immutable local artifacts: Node,
Direct Execution Runtime, Agent Tool Observer, Context Surface Analyzer, and
eight Agent-visible tools. Each component declares its platform, version,
archive location, byte length,
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
not the public default. The App contains a small native bootstrap and CLI shim,
not a second uncompressed Node distribution. On first use the shim extracts
and verifies the immutable Suite Node component into Agent Host's package
store, then reuses that package. Tool integration schema v0.2 also lets
eligible provider components select the same `suite-node` executor, while
their independently distributed provider artifacts remain self-contained.

Build and verify the current internal Beta with:

```text
npm run build:internal-beta-artifacts
npm run probe:internal-beta-artifacts
npm run package:internal-beta
npm run check:internal-beta
```

The builder normally reads the sibling `calculator` checkout. When that
development checkout is intentionally absent, a clean, exact-revision Math
Anchor checkout can be supplied with `AGENT_HOST_MATH_ANCHOR_SOURCE_ROOT`.
The selected checkout revision and dirty state are still recorded in the
component SBOM; this override does not turn an unbound source tree into a
public compatibility release.

Archive creation normalizes file ownership, component timestamps, ordering,
gzip metadata, and component-level SBOM identity independently of the suite
release ID. Unchanged component content therefore reuses one content-addressed
package across later suite releases instead of consuming another rollback copy.
Rebuilding an existing release ID must reproduce all component digests or stop
without replacing that release catalog.

The resulting DMG is deliberately ad-hoc signed and its adjacent distribution
manifest records that it is neither Developer ID signed nor notarized. It is an
internal validation artifact, not a public download.

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

## macOS binary release

The app and every nested executable require hardened-runtime signing with a
Developer ID Application identity, notarization, stapling, Gatekeeper
assessment, and detached checksums. The release artifacts must be regenerated
after signing so their immutable digests describe the shipped bytes. The
current machine has no usable Developer ID identity, so those steps remain an
external release blocker rather than a hidden local success.

A public candidate must pass:

```text
scripts/check-macos-distribution.sh public /path/to/Agent-Host.dmg /path/to/distribution.json
```

The final acceptance run must occur on a separate Mac with no source checkouts
and no pre-existing Agent Host service. It must exercise the App UI, standard
tool installation, a fresh Codex session using both tools, diagnosis and
repair, update, rollback, keep-history uninstall, and full data removal.

## Other platforms

Linux and Windows packages can be produced by CI only after their own artifact
structure, legal material, install scope, service manager, and uninstall flow
are checked. Cross-compilation is not runtime acceptance on those platforms.
