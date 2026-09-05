# Changelog

## Unreleased

- Wait briefly for Windows readers to release an already retired lifecycle lock
  before removing it; persistent file sharing still prevents the mutation.
- Preserve a completed browser Manager action when its status refresh fails,
  display lifecycle warnings, and offer a separate refresh without replaying
  the change. Prevent overlapping changes and empty or unchanged tool-set
  submissions.
- Verify installed package module imports through portable file URLs and
  check production dependencies against the npm registry in CI.

- Added path-free retained trace-session discovery and metadata-only Trace
  Analysis Pack v0.2 export for every session-bearing Agent-shell adapter.
  Provider/session/time selection is bounded and read-only, reports retention
  and unknown completeness, and is available through the CLI and bilingual
  Manager without depending on provider files that may have rotated away.
  Repeated offered-tool inventories are content-addressed once per pack and
  byte-bounded exports remove catalogs whose events were truncated.
- Shortened the Observer collection lease to a wall-time-derived bound and
  made the next run reclaim a dead process holder while closing its unfinished
  collection record, so an interrupted Manager refresh does not leave the
  dashboard stuck in a false running state for a full lease window.
- Added tool-integration v0.5 optional path grants with platform-native path
  lists and lifecycle revalidation. Private import and rollback now enforce one
  current overlay before mutation, rollback preserves path-grant errors, empty
  grants retain legacy Codex projection addresses, and the cost experiment
  requires the intended file tool while accepting exact quoted acknowledgments.
- Added the local, metadata-only Trace Plane with seven capability-negotiated
  Agent-shell adapters for Codex, Claude Code, ZCode, DeepSeek Harness, Gemini
  CLI, and GitHub Copilot CLI. Automatic records remain read-only; hook and
  telemetry setup is emitted only as a non-mutating plan. Observer report v0.8
  exposes adapter coverage and bounded normalized model/tool/turn facts without
  inferring non-use reason, correctness, adoption, quality, opportunity, or
  value.
- Added bounded, incremental ZCode model-I/O ingestion and an explicit Trace
  Analysis Pack export. Export is metadata-only by default; selected content
  requires two confirmations, excludes headers and provider options, and is
  never retained in Observer state. Added a public DeepSeek Harness session
  event bridge, local Gemini telemetry ingestion, stable hook launchers, and
  package-level source-independence, privacy, settled-cost, and hook-only
  provider checks.
- Extended the Developer Kit intake contract so a user can authorize arbitrary
  bounded material, including a Trace Analysis Pack, documentation, past work,
  Skills, or an open-source project. The Kit validates a user/Agent-authored
  proposal but does not generate or approve product opportunities itself.
- Hardened Observer removal: normal uninstall preserves the stable hook
  launcher and local observations, while purge requires separate confirmation
  that local data may be removed and external Agent-shell adapters have been
  disconnected.
- Added the Windows current-user distribution carrier: private Node payload,
  per-file integrity manifest, Start menu Manager/restore/uninstall, one-version
  application rollback, named-pipe Direct Runtime, scheduled collection and
  maintenance, portable host Skill launchers, Windows CI, and preserve-or-purge
  lifecycle boundaries.
- Added the bounded `agent-host usage` result and loopback browser Manager.
  Observer report v0.8 includes provider-specific Token peaks, bounded UTC
  daily activity, session/turn counts, active-day streaks, tool/runtime outcome
  summaries and Direct Runtime reliability while keeping Skill activation,
  non-use reason, semantic effect, adoption, correctness and value unknown.
- Added complete English and Simplified Chinese product copy, system-language
  selection by default, and a secondary persisted language setting in both the
  Windows browser Manager and the native macOS Manager. Published bilingual
  onboarding and Windows lifecycle guides in the distributable package.
- Reused one current Observer read across each browser Manager refresh and kept
  bounded daily activity out of the compact operations snapshot, avoiding
  duplicate collection-report work and protecting its 16 KiB response budget.

- Added ZCode as a first-class Agent app with atomic user MCP configuration,
  immutable Operations/Developer/Provider and active product Skill projections,
  explicit workspace grants, conflict-safe replacement, exact restoration,
  health inspection, and preservation of user changes after installation.
- Made the macOS Manager discover, set up, connect, inspect, and repair ZCode as
  the primary local Agent app while retaining Codex and optional Claude Code
  compatibility.
- Project active product Skills from sealed provider package bytes into ZCode
  and Claude so task discovery never depends on a source or archive checkout.
- Make whole-suite rollback skip same-release operational snapshots and select
  the most recent genuinely different compatibility set; storage and cleanup
  use the same selection rule.
- Separate each profile's immutable installed inventory from its small default
  Agent working set. Local dogfood now starts and resets to Math Anchor only,
  while additional products remain explicit, reversible activations protected
  by the catalog budget preflight.
- Publish the current profile v0.2 schema, including installed, Agent-facing,
  and default Agent component sets, and exercise the Local reset behavior in
  lifecycle regression coverage.
- Refresh status, host summaries, monitoring, activity, and the context snapshot
  after a Manager Full Check while preserving its explicit Agent-app results,
  so an external CLI update cannot leave the window showing a mixed old/new
  environment.

- Defined canonical product terminology for Agent Host, Agent environments,
  Agent apps, independent Agent tools, integrations, and infrastructure
  components while preserving stable technical identifiers.
- Added the development-channel manager, Codex and Claude host adapters,
  Direct Runtime service lifecycle, opt-in local observation, and a macOS
  management app.
- Added fail-closed compatibility catalogs, ownership-preserving uninstall,
  local catalog measurement, source/package checks, and release automation.
- Added a task-native macOS manager with first-run setup, Environment, Tools,
  Agent Apps, Activity, settings, repair, rollback, and privacy controls.
- Added exact installed-plugin identity checks, per-tool host health, deep
  direct semantic probes, bounded lifecycle activity, and recoverable Claude
  binding replacement.
- Added Math Anchor compact-schema projection through its declared read-only
  description tool while preserving typed direct and native-batch validation.
- Added the `local-dogfood` profile and a closed generic integration contract
  for immutable Codex plugin/MCP bindings, real health checks, and
  ownership-preserving removal.
- Added self-contained release artifacts for Context Surface Analyzer,
  BatchTicket, Armorial, Laniakea, Projective, Equatorium, and File Vitals;
  every admitted tool now publishes closed typed input and output schemas.
- Added profile-reduction cleanup, failed-update package retention, real
  dogfood.4-to-dogfood.3 rollback/forward-update coverage, and separate MCP/CLI
  entrypoints for tools that serve both Codex and local maintenance.
- Added a product identity, deterministic macOS icon assets, an internal Beta
  DMG, preview-confirm update/restore UI, and controlled Standard-versus-Local
  catalog and fresh-task measurement harnesses.
- Made component archives reproducible by normalizing metadata and made reuse
  of a release ID fail closed if any previously generated digest would change.
- Added CLI-only private `agent-tool` preview, exact-bound import, inactive or
  explicit Codex activation, path-free status, removal, one-version rollback,
  compatibility-update preservation, and storage-retention safeguards without
  adding a registry, source-checkout installer, or generic Agent invocation.
- Kept private component transitions out of compatibility-release rollback
  history and made a post-commit activity-log failure return a visible warning
  without misreporting or undoing the authoritative component state.
- Made component rollback reverify retained binding, descriptor, files, package
  location, and live MCP catalog before mutation; import dry-run now removes
  its empty package parent, and post-commit projection cleanup failures are
  reported as non-destructive warnings.
- Refresh Manager health and catalog state when a long-running app returns to
  the foreground, while suppressing duplicate refreshes and showing when the
  visible status was last checked.
- Keep backstage observation components out of the Manager's Agent-tool list
  and use host-neutral fresh-task guidance when either Codex or Claude is
  connected.
- Translate Manager activity details into product names and human labels while
  keeping raw lifecycle field identifiers in the CLI JSON diagnostic lane.
- Use product language for update-plan infrastructure changes instead of
  exposing internal catalog and component identifiers.
- Keep the Manager's environment subtitle and expanded-tool guidance accurate
  for the selected tool set without exposing internal dogfood terminology.
- Avoid extracting a bounded private component archive twice during preview or
  import while retaining a second exact observation before committed storage.
- Bind Manager checks and packaging builds to the declared macOS 14 target and
  current architecture so a newer command-line compiler does not select an
  incompatible SDK interface variant.
- Distinguish the number of installed Agent-tool products from the number of
  Agent-callable operations in context-cost summaries.
- Bound a Manager CLI action even when a child ignores graceful termination,
  and present a task-native timeout recovery message instead of leaving the UI
  busy indefinitely.
- Align the public state schema with current lifecycle fields and reject
  malformed or topologically inconsistent saved state before any lifecycle
  action begins.
- Represent private-component removal as an explicit one-step rollback target
  so rollback always returns to the immediately preceding installed-or-removed
  state.
- Make private preview explicit that SPDX syntax recording does not establish
  ownership, license compatibility, or redistribution rights.
- Propagate a failed post-action state reload to the Manager instead of
  silently falling back to the setup surface after a committed action.
- Keep startup and foreground health refreshes from launching Agent-app CLIs,
  because those CLIs can load project-scoped configuration and trigger
  unrelated macOS folder-permission prompts. Local package, Direct Runtime,
  semantic, monitoring, and catalog checks remain current; explicit Full Check
  retains Agent-app binding verification.
- Constrain every Claude Code integration command to user settings with Skills
  and Chrome integration disabled, so Agent Host does not intentionally load
  project-scoped configuration while inspecting or changing its user binding.
- Keep foreground refreshes navigable with an explicit refreshing label while
  mutations remain disabled.
- Consume Observer report v0.5, derive Procedure and Capability totals only
  from Direct Runtime semantic executions, and stop depending on retired
  pre-release receipt projections.
