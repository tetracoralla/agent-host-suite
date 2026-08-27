# Local dogfood contract

Local dogfood makes this Mac behave like an external installation while it
remains the primary implementation workspace. It isolates executable
provenance, not Agent workspace access.

## Required behavior

- Agents may read, edit, build, test, and review any authorized repository
  beneath `tools-dev`.
- An installed tool must load its plugin, Skill, executable, Node runtime, and
  background service from an immutable versioned directory beneath the owning
  private installation root.
- Editing a provider repository must not silently change the bytes used by an
  already-open or newly-started Agent session.
- Agent Host must not add a `tools-dev` denylist, sandbox rule, or path-based
  restriction to achieve installation isolation.
- Historical state may retain a displaced development binding solely so
  rollback or uninstall can restore it. Active marketplaces, MCP commands,
  runtime configuration, and LaunchAgents must not execute that historical
  path.
- Local observation remains metadata-only. It records deployment versions and
  bounded use measurements, not prompts, source paths, tool arguments, tool
  results, shell commands, or error text.

## Admission checks for an installed tool

Before a tool counts as stranger-equivalent local dogfood, all of these must be
current:

1. A release manifest binds its version, platform, archive bytes, SHA-256,
   license, notices, SBOM, entrypoints, and identity files.
2. The component materializes beneath a private content-addressed version
   directory and remains runnable after its source checkout changes.
3. Active Codex marketplace/plugin paths, Claude MCP commands, Direct Runtime
   configuration, and LaunchAgents contain no implementation-checkout path.
4. A fresh Agent task started from the tool's own implementation repository can
   select and call the installed tool without reading the repository to find an
   entrypoint.
5. Health checks exercise the real installed carrier and return typed results;
   a registered service without a ready socket is not healthy.
6. The previous complete version remains byte-verifiable, and a real rollback
   plus forward update succeeds without losing displaced user bindings.
7. The observer correlates later measurements with the active suite release
   and component versions without claiming task correctness.

## Current local installation

`local-dogfood-20260827.4` is active. Twelve components now run from Agent
Host's private content-addressed packages: Node, Direct Runtime, Agent Tool
Observer, Math Anchor, Migratory Time, Context Surface Analyzer, BatchTicket,
Armorial, Laniakea, Projective, Equatorium, and File Vitals. Codex exposes nine
managed plugins; Claude Code keeps the current Math Anchor and Migratory Time
route. A current inventory found no enabled Codex plugin whose active plugin or
marketplace path contains `tools-dev`.

A real rollback from `local-dogfood-20260827.4` to the retained dogfood.3 set
and a forward update back to dogfood.4 both passed their deep doctor checks.
An earlier dogfood.3-to-dogfood.2 rollback also restored all seven displaced
source bindings before the forward update replaced them with private release
packages again. Historical state still retains displaced paths so a later
profile reduction or uninstall can restore user-owned configuration. Rebuilding
the dogfood.4 component set twice produced the same twelve archive digests; the
builder now refuses to overwrite an existing release ID if any digest changes.

## Current catalog and routing observations

The controlled static comparison uses the exact installed release and reports
bytes rather than inferred tokens:

- Standard: 8 tools, 16 schemas, 20,505 canonical UTF-8 bytes.
- Standard + Local tools: 33 tools, 66 schemas, 201,876 bytes.
- Delta: 25 tools, 50 schemas, 181,371 bytes, with no hard tool-name
  collision.

The Local catalog exceeds the harness's current 65,536-byte reference budget.
That is a measured product-cost finding, not a hidden runtime PASS: the tools
remain usable, but future profile and schema work should reduce default context
before broader distribution. No attribution or user-accepted threshold has
been established from this one-machine baseline.

The fresh-task harness uses `gpt-5.6-luna`, read-only ephemeral tasks, and
temporary Codex profile overlays whose effective Skill presence is checked
before model execution. The base user configuration is not edited, and the
temporary profiles are removed afterward. In the first valid one-run corpus:

- both no-tool controls made zero tool calls;
- the Local condition selected Math Anchor and Migratory Time and returned the
  expected results;
- both file tasks returned the same correct value, while the Local run used
  File Vitals after shell exploration and the Standard run used one shell call;
- the Standard math condition returned the correct answer through four shell
  calls but did not adopt Math Anchor, so that row is a routing failure;
- token, cache, latency, and tool-call observations are retained in
  `.build/cost-experiment/latest.json`; one repetition is a baseline, not an
  attribution or performance threshold.

This closes the active source-path gap for the current enabled Codex catalog.
It does not establish universal automatic tool adoption: Math routing remains
a measured follow-up, and a larger repeated estimate should not start until
the routing row is stable.

Public download, Developer ID signing, notarization, Git tags, remote merge,
and repository publication remain separate owner-authorized work.
