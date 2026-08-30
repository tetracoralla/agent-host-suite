# Review contract

Review the suite as one installation, lifecycle, direct-host, observability,
and management product. This contract records durable public boundaries and
reproduced high-risk seams; it is minimum coverage, not a feature inventory,
fixed test script, or completion runway.

Before applying the named checks, reconstruct the current environment,
profiles, release channel, component descriptors, host bindings, service,
catalog, and Manager surfaces from source and runtime. Perform and report at
least one independent discovery route derived from that model rather than from
this file, test names, prior findings, or the changed-file list. Completing
every item below cannot by itself end the review.

## Durable invariants

1. **Release and artifact authority.** Every component is independently
   released and admitted by exact archive bytes and digest, descriptor identity,
   version, platform, SPDX expression, complete inventory, and current typed
   entrypoints. Unknown fields, unsafe paths, malformed archives, undeclared
   files or directories, digest drift, and incomplete operation schemas fail
   before state mutation.
2. **Private component boundary.** Preview accepts one explicit absolute archive
   and exact binding, starts only the selected contained component, changes no
   Agent Host state, and discloses that it cannot rule out effects outside that
   state. Import stores immutable bytes, defaults inactive, never accepts a
   source directory or caller-supplied runtime command, and preserves Suite-only
   ownership. Tests own the exact archive/parser edge-case matrix.
3. **Atomic lifecycle.** Setup, import, activation, tool-set changes, update,
   rollback, remove, cleanup, and uninstall preflight the complete target state.
   Failure before commit restores the prior state; post-commit activity or stale
   projection cleanup failure returns authoritative success with a stable
   warning rather than deleting referenced package bytes.
4. **Recovery ownership.** One complete rollback is retained and reverified by
   content, descriptor, inventory, binding, and typed MCP health before
   transition. Remove, rollback, cleanup, and uninstall cannot restore or delete
   unrelated user entries. Deliberately displaced entries are restored only
   when Suite ownership ends and later user changes are preserved.
5. **Profile and tool truth.** Installed components, Agent-visible components,
   and the smaller active tool set remain distinct. Backstage observation
   components never enter the callable catalog or spawn Agent-session MCP
   processes. Normalized tool-name conflicts fail before deployment observation
   using the same semantic key as Observer.
6. **Thin host projection.** Host projections contain identity and invocation
   only, never provider runtime. Workspace-dependent tools require one explicit
   absolute grant whose variables all bind to that canonical root. Package-backed
   commands, component/Skill identity, lifecycle ownership, and auxiliary CLI
   entrypoints survive update, rollback, and uninstall.
7. **Host inspection and mutation.** Absence, unverified configuration, and
   failed inspection remain distinct. Claude management stays at user setting
   scope with Skills and Chrome integration disabled and without project/local
   settings. A failed managed replacement restores the prior binding.
8. **Default inspection effect budget.** Manager startup and foreground refresh
   resolve Agent apps without launching their CLIs, retain deep local package,
   catalog, and direct semantic probes, and label Agent bindings configured but
   unverified. Opening the Manager must not trigger access to an unrelated
   protected folder; explicit Full Check owns deep Agent-app binding inspection.
9. **Bounded management surface.** Every Manager CLI action has a termination
   path even when a child ignores graceful termination. Activity contains
   bounded actions and state, never prompts, tool inputs, or results. Human copy
   uses product labels while CLI JSON retains stable identifiers.
10. **Observability boundary.** Observer retention is not shorter than report
    lookback, preserves current deployment/catalog correlation, and performs WAL
    checkpoint and compaction. Reports preserve provider session-start bases,
    current-release separation, routing bounds, and uncertainty. Current
    Procedure/Capability execution totals derive from Direct Runtime metadata,
    not retired receipt projections.
11. **Snapshot and storage economy.** `snapshot --json` is path-free, bounded to
    16 KiB serialized output, limits recent activity, preserves freshness and
    provider coverage, and states its assessment boundary. Storage reports total
    and sectional allocated bytes plus exact cleanup candidates; cleanup retains
    active and rollback packages, recent/staging artifacts, and all paths outside
    private Suite state.
12. **Update and uninstall safety.** A compatibility update cannot silently add
    a private component to a release profile. Uninstall preserves pre-existing
    host entries and user data while removing Suite-created entries. A host's
    fresh-session requirement is policy after binding change, never evidence
    that an open process reloaded or remained stale.

## Installed Agent flow

- start a fresh supported Agent session after installation or binding change;
- ask an ordinary system-status question and verify the packaged
  `agent-host-operations` Skill calls `snapshot --json` before larger reports,
  avoids private storage/source, and labels any judgment as external-Agent
  inference;
- reacquire installed plugin/Skill paths, component versions, and live tool
  registry, then run ordinary prompts for current default tools plus one
  local-dogfood tool and record calls, retries, and generic fallbacks;
- for a workspace-dependent tool, verify the live host entry carries the
  explicit grant and package-backed command, then call it from a nested
  repository without source or shell fallback;
- report Codex and Claude independently.

## Direct runtime flow

- reacquire provider schemas and bindings from installed immutable artifacts;
- project and run one selected Math operation, one native Math batch, and one
  time-zone work order through the local service;
- exercise timeout/cancellation, overload/fairness, replacement, shutdown, and
  recovery, then verify per-call provider processes exited while the service
  remains ready;
- report cold latency, warm/idle resources, and zero-model execution separately;
- verify observations contain no input, result, or provider error message.

## Human runtime flow

- complete the current primary setup and environment inspection path, one tool
  availability change and restoration, explicit Full Check, update/rollback,
  error recovery, and the non-destructive observability-disable/uninstall
  previews relevant to the reviewed change;
- keep the Manager open across one environment change and foreground return;
  verify freshness advances without a duplicate just-completed refresh;
- verify visible Environment and Tools counts exclude backstage components while
  context cost counts only Agent-callable operations;
- verify default refresh detects a broken direct route rather than promoting
  file or binding presence to overall readiness;
- verify startup performs no Codex or Claude binding subprocess inspection and
  produces no protected-folder request, while Full Check still detects a broken
  Agent-app binding;
- exercise keyboard/accessibility and inspect the rendered surface separately
  from build results.

## Distribution

When a binary or installer release is in scope, install on a clean supported
machine from the declared artifacts rather than sibling source. Verify detached
digests, nested licenses/notices, SBOM, signature, notarization, Gatekeeper, and
each claimed platform separately. Record intentionally absent signed or
cross-platform artifacts rather than treating silence as parity.

## Claim boundary and reporting

Passing repository checks does not establish provider semantic correctness,
Agent-app vendor adoption, natural tool selection, another device, or owner
experience acceptance. Report development regression, installed Agent flow,
direct runtime, human runtime, distribution, and owner acceptance separately.
Every PASS names the current command or flow and observable. End with
`tools-dev workspace escalations`, including shared ABI/schema/error drift,
installed-host conflict, adjacent dependency, and aggregate catalog or resource
risk.
