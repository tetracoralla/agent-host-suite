# Discovery and projection honesty

This document records how Agent Host projects tools into Agent apps, which
status surfaces observe which facts, and where a Host-reported working set can
diverge from a live session. It is not a marketplace spec and does not
establish that a current session loaded the selected tools.

## Observed failure

A Host environment can list Armorial as selected/enabled while a live Agent
session receives a Skill path that does not exist and no MCP tools. A different
cache or Host projection path can still run the Provider CLI. That combination
is Host-state success plus session-path failure, not proof that the Provider
package is missing.

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
Armorial `active` immediately. An open session can still hold the previous
Skill-only cache or a path into a pruned digest: Skill 404, no MCP, while the
new cache or Host projection CLI still works. Binding changes set
`restartRequired`; they do not reload open tasks.

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
  reports one, otherwise the install receipt;
- treats a missing Host-owned cache as recopiable through public `plugin add`
  and a fresh marketplace identity, without conflict replacement.

Changed or unverifiable cache bytes still require `--replace-host-conflicts`.
Host still does not patch Codex private files.

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
```

Treat `active` as working-set intent. Treat `installedIdentityMatched` and
per-plugin doctor checks as current **binding** evidence. Treat a real new
Agent task as the only current **discovery** evidence. Do not read a CLI
success against a Host projection or a second cache path as proof that the
failing session path exists.
