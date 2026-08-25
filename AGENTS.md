# Agent Host Suite repository contract

Read `docs/PRODUCT_MODEL.md`, `docs/ARCHITECTURE.md`, and
`docs/REVIEW_CONTRACT.md` before changing this repository.

This repository owns distribution, installation, host adapters, local service
lifecycle, user-consented observability, and a small management surface. It is
not a normative Capability or Procedure standard and does not own provider
source.

- Keep providers independently released. Consume verified artifacts; never
  copy a provider core into this repository.
- Use only public host extension points. Do not patch Codex, Claude Code,
  Gemini CLI, or another Agent shell installation.
- Never expose a model-facing generic provider invocation tool.
- Treat installed paths, credentials, availability, process state, and health
  as current local state. Do not commit them.
- Keep the default profile small. Observability is opt-in and evaluation tools
  are never part of the ordinary Agent catalog.
- Preserve user-owned host entries and data. Uninstall only entries recorded as
  suite-created unless the user explicitly requests purge.
- A compatibility manifest coordinates exact artifacts; it does not certify
  provider value, universal shell support, or runtime health.
- Use Apache-2.0 and the public author identity `openAdam`.

Run `npm run check` before proposing a change. Run the macOS app build and its
actual setup/status/recovery flow separately when that surface changes. Do not
commit, push, tag, publish, sign, or notarize without explicit owner authority.
