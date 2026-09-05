# Agent Tool Observer package contract

Read `docs/PRODUCT_MODEL.md` and `docs/REVIEW_CONTRACT.md` before changing
provider adapters, storage, automatic collection, privacy projection, or claim
language.

- This Agent Host package owns passive, owner-local observation of Agent tool-use and
  model-usage metadata from explicitly supported client stores.
- It must not modify observed client stores, evaluated tool repositories,
  plugin installations, prompts, routing rules, or Agent behavior.
- Keep the collector local-only. Production source must not import networking
  modules, open a listener, upload data, or call a model.
- Never persist prompts, message text, reasoning, tool arguments, tool results,
  shell commands, error messages, project paths, or source paths. Parse only
  long enough to project bounded metadata, then discard the source record.
- A user-confirmed Trace Analysis Pack is an explicit export, not passive
  collection. Keep metadata-only as its default; require a separate sensitive-
  content confirmation, exclude transport credentials and source paths, bound
  the complete output, and never write the pack into Observer state.
- Hash session, turn, call, message, and source identifiers before storage.
  Tool names and provider names are the only ordinary source strings retained.
- Provider adapters are read-only and failure-isolated. Codex and Claude JSONL
  readers skip symlinks, bound bytes and line sizes, retain partial-line
  cursors, and tolerate unknown records. ZCode opens its SQLite store read-only
  and must never copy raw provider metadata or error text.
- Automatic collection is a macOS LaunchAgent or current-user Windows scheduled
  task that invokes a short-lived incremental scan. It is not a network service
  and must not remain resident.
- Passive observations may identify use, runtime errors, latency, payload, and
  cost measurements. Their field names must remain neutral observations; they
  may not encode repair, Capability, Procedure, routing, ranking, redundancy,
  retirement, or other product-action candidates.
- `agent-tool-labs/packages/agent-tool-evals` remains a separate bounded causal
  evaluation package. This project
  neither recommends nor runs a targeted evaluation automatically. A user or
  user-selected Agent may interpret current observations and separately choose
  an evaluation.
- Treat `observed`, `completed`, `error`, and `cancelled` as transport/runtime
  states, not semantic correctness. Missing measurements remain `null`, never
  zero.
- The user or user-selected Agent owns semantic interpretation, productization,
  route changes, standardization, repair priority, and retirement decisions.
  The Observer owns collection safety, exact measurements, privacy, freshness,
  and stable neutral report contracts; do not shift those mechanical duties
  back to the user.
- Use one deterministic core for CLI reports and automatic collection. Do not
  add an MCP/plugin surface until repeated use proves shell access is a routing
  cost.
- Keep this component backstage and opt-in. Do not recreate it as an
  independently marketed repository or ordinary Agent-visible tool.
- Add the smallest negative regression for parser drift, truncation, symlink
  traversal, identifier leakage, duplicate ingestion, source mutation, lock
  overlap, report overclaiming, and installation changes.
- Shell adapters must publish versioned signal coverage and negotiate current
  runtime health. Prefer public events, official telemetry, or official hooks;
  never patch a shell or silently infer an unavailable signal from another
  provider. Bridge writers may write only Agent Host-owned metadata files.
- Do not restore the retired pre-release Procedure receipt or human-checkpoint
  importer. Current semantic execution observations come from Direct Runtime's
  closed metadata event; existing legacy database rows are migration residue,
  not a product input or report authority.
- Do not commit, push, publish, notify, delete history, or modify another
  repository without explicit owner authorization.

Review the current product before applying the review contract and include one
independent discovery route. Report development regression, installed automatic
runtime, provider coverage, and owner business acceptance separately.
