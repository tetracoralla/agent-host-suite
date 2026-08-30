# Changelog

All notable release changes will be recorded here.

## Unreleased

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
