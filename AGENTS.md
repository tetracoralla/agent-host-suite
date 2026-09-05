# Agent Host Suite repository contract

Start with `docs/PRODUCT_MODEL.md`, then read the documents that own the
boundary being changed:

- `docs/ARCHITECTURE.md` for Host, carrier, lifecycle, service, state, Direct
  Runtime, or observability architecture;
- `docs/PRIVACY.md` and `docs/TRACE_PLANE.md` for observation, collection, or
  trace export behavior;
- `docs/TOOL_INTEGRATION.md` for Provider admission and integration records;
- `docs/RELEASE.md`, `docs/LOCAL_DOGFOOD.md`, or the platform guide for build,
  installation, packaging, or release work;
- `docs/TERMINOLOGY.md` for product copy, naming, or stable identifiers; and
- `docs/REVIEW_CONTRACT.md` for any review and for changes that touch a listed
  high-risk seam.

Do not treat README prose, a dated history entry, a prior generated catalog, or
an earlier runtime report as current installation or release authority. Profile
files, bound manifests, current source/runtime, and rerun checks own those
facts.
These documents define boundaries; they are not a standing work queue. The
owner's current task controls what to build or review next.

This repository owns distribution, installation, host adapters, local service
lifecycle, Host-internal execution and transport packages, user-consented
observability, and a small management surface. It is not a normative
Capability or Procedure standard and does not own external domain-product
source.

- Keep independently useful external provider products independently
  releasable and consume their verified artifacts; never copy an external
  domain core into this repository.
- Keep Host-owned runtime, bridge, instance, observation, and routing-support
  modules in this source workspace with explicit package, protocol, version,
  and failure boundaries. Do not create a sibling product repository solely
  because an internal module implements a typed interface.
- Use `docs/TERMINOLOGY.md` for product copy. Preserve the stable repository,
  package, CLI, schema, state, service, and API identifiers it lists.
- Use only public host extension points. Do not patch Codex, Claude Code,
  Gemini CLI, or another Agent app installation.
- Never expose a model-facing generic provider invocation tool.
- Treat installed paths, credentials, availability, process state, and health
  as current local state. Do not commit them.
- Keep the default profile small. Observability is opt-in and evaluation tools
  are never part of the ordinary Agent catalog.
- Preserve user-owned host entries and data. Uninstall only entries recorded as
  suite-created unless the user explicitly requests purge.
- A compatibility manifest coordinates exact artifacts; it does not certify
  provider value, universal Agent-app support, or runtime health.
- Use Apache-2.0 and the public author identity `openAdam`.

Run `npm run check` before proposing a change. Run the macOS app build and its
actual setup/status/recovery flow separately when that surface changes. Do not
commit, push, tag, publish, sign, or notarize without explicit owner authority.
