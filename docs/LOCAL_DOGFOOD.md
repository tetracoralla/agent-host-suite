# Local dogfood contract

Local dogfood makes this Mac behave like an external installation while it
remains the primary implementation workspace. It isolates executable
provenance, not Agent workspace access.

## Required behavior

- Agents may read, edit, build, test, and review any authorized repository
  beneath `tools-dev`.
- Installed tools load plugins, Skills, executables, Node, and services from
  immutable versioned Agent Host packages, never implementation checkouts.
- Codex caches only a Suite-owned thin projection of plugin identity, Skills,
  and small interface assets. MCP commands and working directories resolve to
  immutable packages, and tools that require a workspace receive only the
  explicitly configured `--workspace-root` grant.
- Historical state may retain displaced development bindings only for rollback
  or uninstall. Active marketplaces, MCP commands, runtime configuration, and
  LaunchAgents must not execute those paths.
- Observer remains metadata-only and model-free. It records bounded facts and
  deterministic correlations, not prompts, commands, arguments, results,
  causal explanations, expected opportunity, routing quality, or task quality.
- Active and rollback releases remain byte-verifiable. Unchanged component
  content must reuse one content-addressed package across suite releases.

## Admission checks

1. The release manifest binds version, platform, archive bytes, SHA-256,
   license, notices, SBOM, entrypoints, and identity files.
2. Components materialize beneath the private package root and remain runnable
   after their source checkout changes.
3. Active Codex, Claude, Direct Runtime, and LaunchAgent routes contain no
   implementation-checkout path.
4. A fresh Agent task can select an installed tool while implementing in any
   authorized repository; it must not read provider source to discover the
   tool entrypoint.
5. Deep health checks exercise installed carriers and typed results.
6. A real rollback and forward update preserve user bindings and installed
   health.
7. Observer correlates a call with a release only as a mechanical candidate:
   declared tool-name mapping plus a session start at or after activation.
   Older or unknown-start sessions remain ambiguous.

## Active installation

`local-dogfood-20260828.24` / `0.1.0-dogfood.24` is active, with dogfood.23 as
the verified component-identical rollback (the update reported zero changed
components). Twelve components
are installed from private packages. Eight tool components are Agent-visible:
Math Anchor, Migratory Time, BatchTicket, Armorial, Laniakea, Projective,
Equatorium, and File Vitals. Observer and Context Surface Analyzer remain
installed backstage; neither occupies the ordinary Agent catalog or starts an
MCP process per fresh session. Codex has eight managed provider plugins plus
one 12 KiB Skill-only Agent Host operations plugin; Claude Code has the Math
Anchor and Migratory Time routes plus one linked operations Skill projection.
The operations Skill adds no MCP server or Agent tool.

A real rollback from dogfood.11 to dogfood.10 and a forward update back to
dogfood.11 passed. The two release IDs have identical archive and descriptor
digests for all twelve components. The final update therefore reported no
changed components, and current plus rollback state share the same package
bytes. Dogfood.12 then changed only Agent Tool Observer for the stricter exact
operation mapping; the other eleven component packages were reused.
Dogfood.13 changes only Agent Host's generated Direct Runtime lifecycle: all
twelve component archive digests are identical to dogfood.12 and the update
reported no changed components.
Dogfood.16 changes only Observer. Dogfood.17 is component-identical to
dogfood.16 and changes only Suite-owned Codex projection/lifecycle behavior.
Dogfood.18 through dogfood.20 remain component-identical and add the packaged
operations Skill, bounded snapshot, low-context tool-usage summary, and the
explicit `currentSessionUptake: not-observed` boundary. The final update
reported no changed components. Dogfood.21 removes three duplicated Node
executables from Agent Host integration artifacts and uses the one verified
Suite Node runtime. Dogfood.22 adds whole-install storage measurement; after
the second activation, cleanup can remove the old expanded components while
retaining a complete small rollback. Dogfood.23 separates temporary tool
deactivation from full uninstall so displaced source-checkout plugins remain
suspended. Dogfood.22 and dogfood.23 are component-identical; rollback resolves
dogfood.22 without a second package set. Dogfood.24 is component-identical to
dogfood.23 and changes only the Suite manager CLI: the human-readable
`agent-host observability status` renderer crashed on every installed
invocation, and the fixed renderer now ships with a negative regression test.

The final deep doctor reports 37 checks, zero failures. It covers immutable
component bytes, eight Codex plugins, two Claude routes, installed backstage
runtimes, both operations Skill carriers, Direct Runtime, contract projection,
Math, native batch, and time-zone probes. A controlled dogfood.23 tool-set
reduction left only package-backed File Vitals plus the Skill-only operations
plugin in Codex and zero Claude MCP bindings. A fresh Codex task called the
packaged snapshot and `mcp__file_vitals__file_inspect`, returning the exact
SHA-256 for `agent-host-suite/package.json`; after reset all eight Codex plugin
paths again resolve to Suite projections and none resolve to `tools-dev`.
On dogfood.24 the same lanes were re-exercised: a fresh Codex task discovered
the operations Skill directly, cross-verified an exact Math residue, converted
a DST-affected zone, hit `E_FILE_NOT_FOUND` for a workspace-relative File
Vitals path and succeeded with the absolute path, and the manager-app toggle
suspended and restored one tool end to end on the native accessibility
channel. These are observed Agent routing/recovery sequences, not product
correctness or adoption scores. The Claude fresh-session lane succeeded on
dogfood.24 after the earlier HTTP 502 block cleared: operations Skill, snapshot
first, and one Migratory Time conversion, tools only.

## Context and routing cost

The exact installed catalogs currently measure:

- Standard: 8 tools, 16 schemas, 20,505 canonical UTF-8 bytes.
- Standard + Local tools: 31 tools, 62 schemas, 191,032 bytes.
- Local delta: 23 tools, 46 schemas, 170,527 bytes; no hard name collision.
- File-Vitals-only active set: 3 tools, 6 schemas, 29,912 bytes.

Removing backstage Context Surface Analyzer from the active catalog saved two
tools and 10,844 bytes versus the previous Local profile, and avoids one
Analyzer MCP process per fresh task. The Local catalog still exceeds the
65,536-byte reference budget. This remains an optimization finding, not a
hidden PASS or a user-accepted threshold.

The fresh File Vitals task ran under a temporary one-tool binding activation.
Restoring the eight-tool set created a later binding activation, so the current
deployment summary correctly reports zero calls rather than attributing the
earlier call to the later set. Claude and ZCode also have none. Observer returns
zero bounded routing observations and explicitly reports that adoption is not
assessed and opportunity/task quality are unknown. Repeated refresh does not
increase the stored deployment-observation count for the same release and
activation. Observer records these mechanical facts automatically and uses
zero model calls; an external Agent must assess opportunity, alternatives,
errors, recovery, and task quality.

## Storage and process baseline

After verified cleanup:

- Agent Host private state is 526,139,392 allocated bytes (about 502 MiB), down
  from 864,395,264 bytes while retaining dogfood.22 as a complete verified
  rollback. Packages occupy 519,864,320 bytes and all host projections occupy
  1,101,824 bytes.
- Installed Agent Host.app is 187,988 KiB, down from 405,696 KiB. It carries
  159,684 KiB of compressed local-dogfood artifacts and 24,692 KiB of Suite
  dependencies, but no second uncompressed bootstrap Node executable.
- App plus private state is 718,639,104 allocated bytes, down 561,188,864 bytes
  (43.9%) from the dogfood.20 baseline.
- Current dogfood.23 DMG is 177,816 KiB, down 44.7% from the observed 321,804
  KiB dogfood.20 DMG. The current dogfood.24 DMG is the same size family; the
  superseded dogfood.23 DMG remains on disk as a cleanup candidate until
  dogfood.24 is accepted.
- Product cleanup removed six obsolete expanded component packages and
  reclaimed 511,610,880 allocated bytes while preserving rollback. Two
  superseded App backups and dogfood.20/.21 DMGs were then deleted, reclaiming
  another 1,093,400 KiB of reproducible local output; those exact old App/DMG
  copies are no longer locally recoverable.
- The largest remaining package costs are the shared Node component and the
  specialized Migratory Time package, which still carries its own Node for its
  Direct Runtime contract. Removing that final duplication requires a separate
  verified specialized-provider binding change, not a generic packaging edit.

Agent Host cleanup removed only unreferenced package versions and completed
downloads after verifying the active and rollback states. Weekly maintenance
refreshes Observer and catalog measurements, enforces retention, compacts the
database, and repeats the same storage cleanup.
The final dogfood.23 cleanup preview reports zero eligible package versions or
downloads after verifying current and rollback state.

Public download, Developer ID signing, notarization, tags, remote merge, and
repository publication remain separate owner-authorized work.
