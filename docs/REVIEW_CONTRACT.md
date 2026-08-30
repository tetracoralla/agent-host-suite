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
  conflicts, partial setup, and state corruption; known CLI options that do
  not belong to the selected operation are rejected rather than ignored;
- normalized Agent-visible tool-name conflicts fail in Agent Host before a
  deployment observation is written, using the same exact semantic key as the
  Observer contract;
- update and rollback retain one recoverable complete set;
- private component preview is read-only and binds archive digest and bytes,
  descriptor digest, id, version, platform, and SPDX; import accepts only an
  explicit absolute archive plus the exact binding, admits only a contained
  `agent-tool`, probes the real typed MCP catalog, defaults inactive, and never
  accepts a source directory or caller-supplied runtime command; preview
  rejects malformed SPDX syntax, repeated or control-character archive paths,
  undeclared files, and undeclared empty directories before extraction;
  archive inventory and extraction occur once per exact admission attempt; the
  preview records that it starts the selected component, changes no Agent Host
  state, and cannot establish absence of effects outside that state;
- private component activation uses immutable package bytes and the Codex thin
  projection, preserves Suite-only ownership, retains one component rollback,
  survives compatibility updates without entering the release profile, and
  remove/rollback cannot restore or delete unrelated user entries; import
  dry-run removes its newly created package version and empty component parent,
  while rollback verifies the retained content-addressed package, exact binding,
  descriptor, full file inventory, and current typed MCP health before any
  state or host transition;
- private component import, remove, and component rollback do not add snapshots
  to compatibility-release history; a post-commit activity-log failure returns
  the successful authoritative state transition with a stable warning and does
  not delete package bytes referenced by that state; post-commit stale
  projection cleanup failure has the same authoritative-success boundary and
  a distinct visible warning;
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
- Claude inspection and mutation commands stay at user setting scope with
  Skills and Chrome integration disabled; they do not intentionally load
  project or local settings while managing a Suite-owned user binding;
- lifecycle activity is bounded and contains actions and state, not prompts or
  tool inputs or results; the Manager translates known detail into product
  names and human labels while keeping raw state identifiers in CLI JSON;
- every Manager CLI action has a bounded termination path even if a child
  ignores graceful termination, and timeout leaves the interface recoverable;
- Manager startup and foreground refresh resolve connected Agent apps without
  launching their CLIs, retain deep installed-tool and direct semantic probes,
  and label bindings as configured but unverified until explicit Full Check;
  opening the Manager must not request access to an unrelated protected folder
  through project-scoped Agent-app configuration;
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
- leave the Manager open across an environment change, return it to the
  foreground, and verify stale catalog/health data is replaced and the visible
  status-check time advances without duplicating a just-completed refresh;
- verify the Manager's Tools and Environment counts exclude backstage
  observation components while context cost separately counts Agent-callable
  operations;
- change one Tool availability switch, verify a fresh-task notice and the
  corresponding installed-versus-active state, then restore it without
  exposing a displaced source plugin;
- verify the default manager refresh detects a broken direct route instead of
  promoting file/host presence to overall readiness;
- verify startup performs no Codex or Claude binding subprocess inspection and
  produces no Documents-folder request, while explicit Full Check still
  detects a broken Agent-app binding;
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
