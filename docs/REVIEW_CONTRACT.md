# Review contract

Review the suite as one installation and lifecycle product.

The lanes below are minimum coverage, not a completion runway. Reconstruct the
current environment, profiles, release channel, host bindings, service, and
manager surfaces from source and runtime before following them, keep at least
one discovery route that is not copied from these headings or the changed-file
list, and report out-of-contract findings and still-untested compositions;
completing every lane cannot by itself end the review.

## Required lanes

### Development regression

- syntax, tests, manifest/schema validation, package contents, legal files;
- fail-closed handling for unknown fields, hash mismatch, unsafe paths, host
  conflicts, partial setup, and state corruption;
- normalized Agent-visible tool-name conflicts fail in Agent Host before a
  deployment observation is written, using the same exact semantic key as the
  Observer contract;
- update and rollback retain one recoverable complete set;
- storage cleanup dry-run names exact eligible package/download bytes; actual
  cleanup verifies the active release and one complete rollback, preserves
  recent or staging artifacts, and removes no path outside private suite state;
- non-JSON `agent-host storage` output reports total and sectional allocated
  bytes plus exact cleanup candidates instead of only `ok`;
- `agent-host snapshot --json` remains path-free and within its 16 KiB final
  serialized budget, limits recent activity, preserves observation freshness
  and provider coverage, and states that it cannot establish causation,
  adoption, routing/task quality, user value, or an operational decision;
- a host's fresh-session requirement is reported as post-binding-change policy,
  never as evidence that a currently open process is stale; current session
  uptake remains `not-observed` until a real fresh host flow is exercised;
- the packaged operations Skill uses only published Agent Host routes. Codex
  carries it in a Skill-only plugin with no MCP server; Claude carries one
  immutable linked projection. Install/update fail closed on conflicts,
  uninstall restores deliberately displaced entries, and later user changes
  are preserved;
- active tool-set reduction removes only suite-created bindings outside the
  target set, keeps displaced user/source bindings suspended, preserves enough
  ownership to reactivate the managed package, and restores user bindings only
  on profile removal, host disconnect, or uninstall;
- installed and Agent-visible profile components remain distinct; backstage
  observation components do not enter the active catalog or spawn Agent-session
  MCP processes;
- v0.2 `suite-node` integrations run their contained script with the one
  verified Suite Node component, preserve provider Skill/plugin identity, and
  do not weaken v0.1 component-executable validation;
- workspace-dependent Codex tools fail setup without an explicit absolute
  workspace grant; their thin projections contain no provider runtime, bind
  every declared workspace variable to the canonical grant, and preserve
  package-backed commands, host ownership, update, rollback, and uninstall;
- storage inventory includes Suite-owned host projections, while current Codex
  cache measurements distinguish small Skill/identity copies from immutable
  package bytes;
- every admitted MCP tool has a closed input and output schema, and a component
  with both MCP and maintenance CLI routes preserves both entrypoints;
- host inspection failure cannot be mistaken for an absent entry, and a failed
  managed replacement restores the prior Claude binding;
- lifecycle activity is bounded and contains actions and state, not prompts or
  tool inputs or results;
- Observer retention is not shorter than its report lookback, preserves current
  deployment/catalog correlation, checkpoints the WAL, and releases deleted
  database pages;
- observability summaries preserve Codex, Claude, and ZCode session-start
  coverage and identify bounded routing records and truncation without calling
  the returned record count total turns or an adoption result;
- uninstall preserves pre-existing host entries and removes suite-created
  entries.

### Installed Agent flow

- use a fresh host session after install or update;
- ask an ordinary system-status question and verify the host discovers the
  packaged `agent-host-operations` Skill, calls `snapshot --json` before larger
  reports, does not read Agent Host/Observer source or private storage, and
  labels any resulting judgment as an external-Agent inference;
- reacquire the installed plugin path, version, and live tool registry;
- run ordinary Math Anchor and Migratory Time prompts plus one task relevant to
  a local-dogfood tool, and record selected tools, calls, retries, and fallbacks;
- for a workspace-dependent tool, verify the live Codex MCP entry has the
  configured workspace grant and a package-backed command, then call it from a
  nested implementation repository without a source or shell fallback;
- report Codex and Claude independently.

### Direct runtime flow

- reacquire provider schemas and bindings from installed artifacts;
- project one selected Math operation through its declared live schema lookup
  and verify the returned contract contains only that operation;
- run one selected Math operation, one two-item native Math batch, and one
  time-zone work order through the local service;
- exercise timeout/cancellation, replacement, overload, shutdown, and restart;
- after warmed probes, verify per-call provider processes have exited while the
  host service remains ready; report cold-call latency separately from idle
  resource cost;
- verify observations do not contain inputs or results.

### Human runtime flow

- complete setup, Environment, Tools, Agent Apps, Activity, doctor, update,
  rollback, observability-disable, and uninstall flows in the built macOS app;
- change one Tool availability switch, verify a fresh-task notice and the
  corresponding installed-versus-active state, then restore it without
  exposing a displaced source plugin;
- verify the default manager refresh detects a broken direct route instead of
  promoting file/host presence to overall readiness;
- verify error recovery and keyboard/accessibility paths;
- inspect the current rendered surface separately from build results.

### Distribution

- install on a clean supported machine from release artifacts, not sibling
  source checkouts;
- verify every detached digest, nested license, notice, SBOM, code signature,
  notarization ticket, and Gatekeeper assessment;
- distinguish macOS arm64, macOS x86_64, Linux, and Windows results.

## Claim boundary

Passing this repository's checks does not establish that provider semantics are
correct, that an Agent-app vendor adopted the standards, that every Agent will
select the tools, or that another device works. Report each observed host,
artifact, and flow exactly.
