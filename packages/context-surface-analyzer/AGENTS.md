# Context Surface Analyzer package contract

This is a backstage Agent Host analysis package. Read `docs/PRODUCT_MODEL.md`
and `docs/REVIEW_CONTRACT.md` before changing behavior, schemas, limits, or
claims.

## Authority and boundaries

- Current source, executable tests, and current CLI/MCP/web runtime control
  factual claims. Generated reports do not certify utility, safety, adoption,
  or completeness.
- The shared core in `src/core.js` owns analysis and comparison semantics. CLI,
  MCP, and web routes are adapters and must not independently implement them.
- Inputs are explicit bounded snapshots. Do not add passive observation,
  filesystem crawling, host discovery, credentials, network calls, model calls,
  automatic routing, enable/disable actions, or retirement recommendations.
- Exact UTF-8 byte counts are for canonical JSON defined by this product. They
  are not token estimates. Token measurements are caller-supplied observations
  and remain labeled by source, provider, model, serialization, and tokenizer
  version when supplied.
- Name collisions are exact and case-sensitive. Duplicate schemas require exact
  canonical equality. Do not silently upgrade these observations into semantic
  similarity or product value judgments.
- This MVP declares no provider-neutral Capability Profile or Procedure
  Profile. Do not create one without a separate standardization decision.

## Change rules

- Keep snapshot fields and transport arguments closed and reject unknown keys.
- Keep all requests and complete responses cumulatively bounded. Every relaxed
  limit requires a current consumer and a negative regression test.
- Preserve one-call dominant Agent routes: `context.analyze` and `context.diff`.
- Keep MCP annotations read-only, non-destructive, idempotent, and closed-world.
- Keep the MCP carrier's 2025 legacy-era boundary explicit. Do not advertise
  2026 modern-era support without the required per-era negotiation and wire
  codec through a portable installed runtime.
- Keep the human surface local, narrow, and free of Agent protocol metadata.
- Do not install the Plugin into the ordinary Agent catalog or recreate this
  package as an independent product without a verified external consumer.
- Add the smallest negative regression for every repaired guard or ambiguity.
- Do not commit, push, publish, install globally, or edit a sibling repository
  without explicit owner authorization.

Run `npm run check` before handoff. Report development regression, runtime Agent
flow, runtime human flow, and owner business/experience acceptance separately.
