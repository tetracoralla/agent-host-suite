# Discovery and projection honesty

This document records how Agent Host projects tools into Agent apps, which
status surfaces observe which facts, and where a Host-reported working set can
diverge from a live session. It is not a marketplace spec and does not
establish that a current session loaded the selected tools.

## Session Skill-path reports (unverified)

A previous write-up treated this combination as an **observed failure**: Host
lists Armorial as selected/enabled; a live session is given a Skill path that
does not exist and has no MCP tools; another cache or Host projection path
still runs the Provider CLI.

That specific session evidence is **not confirmed**. The checker joined the
Skill root with the wrong plugin directory (Armorial’s files live under its
own Host projection, not another plugin’s root). The files were present. That
was a verification mapping error, not a located Host defect, and this change
does not claim to have found or fixed that session’s root cause.

A **separate**, reproducible robustness case remains: Codex registration can
stay `enabled` after a Host-owned plugin cache directory is gone. Inspect
records that as `cacheStatus: missing`, and install may recopy through public
`plugin add` when Host still exclusively owns the marketplace. Cache recopy
is not evidence that a particular Agent session resolved a Skill path.

`plugin list` without `installedPath` only supports the registration fact. It
does not prove that an open session loaded MCP tools.

## Codex path generations

`install` / `tools set` / `host add` for Codex go through public extension
points only (`src/hosts/codex.mjs`, `src/hosts/codex-projection.mjs`,
`src/hosts/codex-config.mjs`). The bytes a session may see are not a single
directory:

1. **Immutable package.** Verified component root. MCP `command` / `cwd` in the
   projection point here. Direct CLI launchers also point here.
2. **Content-addressed Host projection.**
   `host-projections/codex/<component>/<digest>/marketplace`. Digest includes
   component fingerprint, command, args, cwd, workspace grant, path grants, and
   `skill-only` vs `mcp-active` (`projectionDigest` in
   `codex-projection.mjs`). Inactive Armorial is Skill-only (no `.mcp.json`);
   activating it writes a **new** digest with MCP.
3. **Native binding copy.**
   `<digest>/native-bindings/<uuid>/marketplace`. `freshBinding` copies the
   projection here and registers a Host-specific Codex marketplace identity
   through the public config API.
4. **Codex plugin cache.** `codex plugin add <selector> --json` returns
   `installedPath`. Host stores that receipt. Codex may copy the small
   projection into its own cache; it must not copy the provider runtime.

`pruneCodexProjections` keeps `dirname(entry.marketplaceRoot)` for current and
inactive Host entries. For Codex that is the digest folder, so native-bindings
inside an active digest stay. A previous digest (for example the Skill-only
generation after Armorial is activated) is eligible for removal.

Claude and ZCode do not use this Codex cache chain. They write public MCP
config and link Skills to Host-owned projections (`src/hosts/claude.mjs`,
`src/hosts/zcode.mjs`, `src/developer-kit-skill.mjs`).

## When status says enabled and the session does not

These surfaces are different facts:

| Surface | What it observes | What it does not observe |
| --- | --- | --- |
| `agent-host status` | Installed Host state, working set, recorded host entries | Agent-app caches, Skill paths, MCP catalogs, open sessions |
| `agent-host tools status` | Host working-set membership (`active`) | Agent-app enablement or session uptake |
| Manager refresh / `--quick` host status | App present on PATH; doctor `--deep --skip-agent-apps` | Codex/Claude/ZCode bindings |
| `host status` without `--quick`, `doctor --deep` without `--skip-agent-apps` | Public `plugin list` plus Host receipt/live cache identity | Whether an **already open** session loaded those bytes |
| A live Agent task | Whatever that session resolved at start | Host working-set intent |

`hostFacingManifest` sets `skillOnly: false` only for components in the active
working set. Codex then materializes a new digest and, when the projection
identity changed, a new marketplace and `plugin add`. Host state can show
Armorial `active` immediately. An already-open session **might** still hold a
previous Skill-only cache or a path into a pruned digest. That is a possible
divergence (Host `active` vs session catalog), not a confirmed observation
from a mis-joined Skill root. Binding changes set `restartRequired`; they do
not reload open tasks.

A second Host-visible case is Codex config `enabled: true` with a **missing**
cache. `plugin list` can still report `installed`/`enabled` from registration.
Until this change, inspect compared only the Host install receipt; a gone
receipt failed identity, and the same projection refused repair without
`--replace-host-conflicts` (`CODEX_PLUGIN_CHANGED`). That flag is for
user-modified or unverifiable caches, not a vanished Host-owned copy.

## Host repair and remaining Agent-app gap

Host-side, inspect now:

- records `cacheStatus` (`matched` / `missing` / `changed` / `unverifiable`);
- uses an absolute `installedPath` from public `plugin list` when Codex
  reports one (normalized, including a trailing separator), otherwise the
  install receipt; a present but non-absolute or unverifiable field is
  `unverifiable`, not an absent field and not a silent fallback to the
  older receipt;
- treats a missing Host-owned cache as recopiable through public `plugin add`
  and a fresh marketplace identity, without conflict replacement, only when
  Host still exclusively owns that marketplace. Another plugin on the same
  marketplace (including a disabled extra registration) fails closed before
  writes, the same way `remove()` does, so recopy cannot delete a source
  other registrations still reference.

Changed or unverifiable cache bytes still require `--replace-host-conflicts`.
Host still does not patch Codex private files. This recopy is a robustness
fix for a vanished Host-owned cache. It does not locate or resolve an
unverified session Skill-path report.

Out of this repository: Codex session Skill/MCP resolution is not a Host
public API. If `plugin list --json` omits the live cache path the session
will use, Host cannot prove that path exists. Codex should fail closed when
the cache is gone rather than leaving `enabled: true` pointing at a missing
Skill root, and should expose the live `installedPath` (and, if it has one,
the session Skill root) on the public plugin listing. Agent Host will not
write Codex private cache or config files to paper over that.

Claude/ZCode session uptake has the same fresh-task rule: linked Skill and
MCP files can be current while an open task still holds the previous catalog.

## How to reacquire the current facts

```text
agent-host tools status --json
agent-host status --json
agent-host host status codex --json
agent-host doctor --deep --json
agent-host doctor --featured-readiness --json
```

Treat `active` as working-set intent. Treat `installedIdentityMatched` and
per-plugin doctor checks as current **binding** evidence. Treat
`doctor --featured-readiness` as the featured working set plus projection
receipts only; it always reports `adoptionEvidence: false`. Treat a real new
Agent task as the only current **discovery** evidence. Unnamed adoption
scoring is a separate protocol in [`ADOPTION_ACCEPTANCE.md`](ADOPTION_ACCEPTANCE.md).
Do not read a CLI success against a Host projection or a second cache path as
proof that a session Skill path existed or failed.
