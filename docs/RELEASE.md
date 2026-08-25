# Release boundary

## Source release

The source repository is Apache-2.0 and can be reviewed and built without
private infrastructure. A source revision is not an installable compatibility
release by itself.

## Compatibility release

A public compatibility release requires:

1. immutable revisions for Capability Contracts, Procedure Contracts, Direct
   Execution Runtime, and the architecture compatibility bill of materials;
2. versioned provider artifacts for Math Anchor and Migratory Time;
3. detached SHA-256 values and original legal/SBOM material for every binary
   or bundled runtime;
4. a suite manifest whose artifact URLs, versions, identities, and hashes match
   those releases;
5. a clean-device installation check through the released boundary;
6. hosted CI and security checks on every owning repository.

Until then, the built-in release catalog remains `draft-unbound` and public
setup fails closed instead of silently downloading `main`.

## macOS binary release

The app and nested executable code require hardened-runtime signing with a
Developer ID Application identity, notarization, stapling, Gatekeeper
assessment, and detached checksums. Local unsigned builds are development
artifacts and are not public distributables.

## Other platforms

Linux and Windows packages can be produced by CI only after their own artifact
structure, legal material, install scope, service manager, and uninstall flow
are checked. Cross-compilation is not runtime acceptance on those platforms.
