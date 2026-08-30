# Local dogfood contract

Local dogfood makes this Mac behave like an external installation while it
remains the primary implementation workspace. It isolates executable
provenance, not Agent workspace access.

## Required behavior

- Agents may implement in authorized workspaces, while installed tools load
  plugins, Skills, executables, Node, and services from immutable versioned
  Agent Host packages rather than development checkouts.
- Codex receives thin Suite-owned projections. MCP commands and working
  directories resolve to verified packages; workspace-dependent tools receive
  only the explicit canonical `--workspace-root` grant.
- Historical state may retain displaced development bindings only for rollback
  or uninstall. Active bindings and LaunchAgents must not execute those paths.
- Observer remains local, metadata-only, bounded, model-free, and unable to
  turn completion or correlation into correctness, adoption, opportunity,
  routing quality, or task quality.
- Active and rollback releases remain byte-verifiable. Unchanged component
  content reuses one content-addressed package across Suite releases.

## Admission checks

1. The release binds version, platform, archive bytes and SHA-256, license,
   notices, SBOM, entrypoints, identity files, and closed operation schemas.
2. Components materialize beneath private Suite state and remain runnable when
   source checkouts move or change.
3. Active Codex, Claude, Direct Runtime, and LaunchAgent routes contain no
   provider-checkout path.
4. Deep health exercises installed carriers and typed results without reading
   source to discover an entrypoint.
5. Setup, update, rollback, tool-set change, cleanup, and uninstall preserve
   user ownership and one complete recovery target.
6. Default Manager inspection does not launch Agent-app CLIs or touch unrelated
   protected folders merely to prove configuration. Explicit Full Check owns
   effectful binding inspection.
7. Observer correlates a call with a release only as a bounded candidate using
   a declared tool binding and provider session-start metadata.

## Active installation

`local-dogfood-20260831.30` / `0.1.2-dogfood.30` is active, with dogfood.29 as
the rollback release. Twelve components are installed; eight are available
Agent tools. The current active set is Math Anchor, BatchTicket, and
Equatorium. Observer and Context Surface Analyzer remain backstage.

Dogfood.29 changes only Agent Tool Observer. Observer 0.2.0 publishes report
v0.5 and retires the unpublished receipt importer and its report projections.
Agent Host derives Procedure and Capability totals only from Direct Runtime
semantic observations. Legacy private database rows are not deleted during
the update and remain outside the current input/report contract. Dogfood.30
reuses all component artifacts and makes the Suite reject malformed semantic
summary target kinds, negative counts, and non-integer counts.

The installed Agent Host 0.1.2 build 30 and internal Beta DMG passed ad-hoc
signature, embedded-catalog, bootstrap, checksum, and distribution checks. A
deep installed doctor passed all 25 current package, MCP, Direct Runtime,
semantic, and catalog checks while intentionally skipping external Agent-app
CLI launch.

## Context and routing cost

The current active catalog measures 9 tools, 18 schemas, and 64,804 canonical
UTF-8 bytes. It is within the declared 65,536-byte reference budget and has no
hard name collision. This measurement applies to the selected three-tool set;
the larger set of all available local tools is not the default and must be
measured again before activation.

The current release has no observed fresh-session Agent-tool call yet.
Historical calls, direct doctor probes, installation, and catalog presence are
not current-release adoption. Observer reports provider coverage, record
bounds, and unknown opportunity/task quality explicitly.

## Storage and distribution boundary

At the dogfood.30 snapshot, private state uses 722,935,808 allocated bytes and
the installed App uses 192,745,472 bytes. Eight unreferenced package versions
are cleanup candidates totaling 197,271,552 allocated bytes. Cleanup is a
separate verified action; dogfood.29 and the replaced App remain recoverable
until owner acceptance.

The internal DMG is ad-hoc signed. Public download, Developer ID signing,
notarization, clean-machine distribution, tags, Releases, and owner
business/experience acceptance remain separate lanes.
